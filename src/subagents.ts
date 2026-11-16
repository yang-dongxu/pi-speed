/**
 * subagents.ts — subagent sample sources for pi-speed.
 *
 * A subagent runs as a child Pi session inside the parent's process, so its
 * responses never appear on the parent's session branch. Two sources recover
 * them:
 *
 * - Transcripts. Pi writes every child session to
 *   `<parent-dir>/<parent-basename>/tasks/<child>.jsonl`, in the same JSONL
 *   shape the parent's own branch uses.
 * - The live bridge. Child sessions share the parent's `globalThis`, so a
 *   pi-speed instance running inside a child publishes its streaming rate and
 *   its completed samples on a shared store the parent's instance reads.
 *
 * A registered child owns its samples and its transcript is skipped, so no
 * response is counted twice.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createSpeedSample, estimateOutputTokens, type SpeedSample } from "./speed.ts";

/** Streaming state of one in-flight response. */
export interface LiveGeneration {
  startedAt: number;
  outputTokens: number;
  estimated: boolean;
}

/** One child session's contribution to the parent's numbers. */
export interface ChildSession {
  /** The child's session JSONL path — also its identity on the bridge. */
  file: string;
  live?: LiveGeneration;
  samples: SpeedSample[];
}

const BRIDGE_KEY = Symbol.for("pi-speed:subagent-bridge");

interface Bridge {
  children: Map<string, ChildSession>;
  listeners: Set<(urgent: boolean) => void>;
}

function bridge(): Bridge {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[BRIDGE_KEY] as Bridge | undefined;
  if (existing) return existing;
  const created: Bridge = { children: new Map(), listeners: new Set() };
  store[BRIDGE_KEY] = created;
  return created;
}

/**
 * The directory Pi writes a parent session's subagent transcripts to.
 * `undefined` when the parent session is not persisted.
 */
export function subagentTasksDir(parentSessionFile: string | undefined): string | undefined {
  if (!parentSessionFile) return undefined;
  return join(dirname(parentSessionFile), basename(parentSessionFile, ".jsonl"), "tasks");
}

/** Whether a session file belongs to a subagent child rather than a top-level session. */
export function isSubagentSessionFile(sessionFile: string | undefined): boolean {
  if (!sessionFile) return false;
  return basename(dirname(sessionFile)) === "tasks";
}

/** Register a child session, returning its bridge entry. */
export function registerChild(file: string): ChildSession {
  const store = bridge();
  const existing = store.children.get(file);
  if (existing) return existing;
  const child: ChildSession = { file, samples: [] };
  store.children.set(file, child);
  return child;
}

/** Drop a child session from the bridge; its transcript takes over from here. */
export function unregisterChild(file: string): void {
  bridge().children.delete(file);
}

/** Every registered child session. */
export function listChildren(): ChildSession[] {
  return [...bridge().children.values()];
}

/**
 * Subscribe to bridge changes. `urgent` marks a change that ends a child's
 * streaming response or its session, which a throttled reader must not drop.
 * Returns an unsubscribe function.
 */
export function subscribeToChildren(listener: (urgent: boolean) => void): () => void {
  const store = bridge();
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

/** Tell subscribers a child changed. Called by pi-speed instances inside children. */
export function notifyChildrenChanged(urgent = false): void {
  for (const listener of [...bridge().listeners]) {
    try {
      listener(urgent);
    } catch {
      // A subscriber that throws must not break the child's turn loop.
    }
  }
}

/** Output-token rate of one in-flight response, or `undefined` when idle. */
export function liveRate(live: LiveGeneration | undefined, now: number): number | undefined {
  if (!live) return undefined;
  const elapsedMs = now - live.startedAt;
  if (live.outputTokens <= 0 || elapsedMs <= 0) return undefined;
  return (live.outputTokens * 1_000) / elapsedMs;
}

/** Parse the completed assistant responses out of one transcript's JSONL text. */
export function parseTranscriptSamples(text: string): SpeedSample[] {
  const samples: SpeedSample[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;

    const sample = createSpeedSample(
      message.timestamp,
      Date.parse(entry.timestamp),
      message.usage?.output ?? 0,
      estimateOutputTokens(message.content ?? []),
    );
    if (sample) samples.push(sample);
  }

  return samples;
}

export interface TranscriptReader {
  /** Samples from every transcript in `dir`, skipping the files in `skip`. */
  read(dir: string | undefined, skip?: ReadonlySet<string>): SpeedSample[];
  /** Drop cached parses — a session switch, or a test. */
  reset(): void;
}

/** A transcript reader that re-parses a file only when its size or mtime changed. */
export function createTranscriptReader(): TranscriptReader {
  const cache = new Map<string, { size: number; mtimeMs: number; samples: SpeedSample[] }>();

  return {
    read(dir, skip) {
      if (!dir) return [];

      let names: string[];
      try {
        names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      } catch {
        return [];
      }

      const samples: SpeedSample[] = [];
      const seen = new Set<string>();

      for (const name of names) {
        const file = join(dir, name);
        if (skip?.has(file)) continue;
        seen.add(file);

        let size: number;
        let mtimeMs: number;
        try {
          const stats = statSync(file);
          size = stats.size;
          mtimeMs = stats.mtimeMs;
        } catch {
          continue;
        }

        const cached = cache.get(file);
        if (!cached || cached.size !== size || cached.mtimeMs !== mtimeMs) {
          let text: string;
          try {
            text = readFileSync(file, "utf8");
          } catch {
            continue;
          }
          cache.set(file, { size, mtimeMs, samples: parseTranscriptSamples(text) });
        }

        samples.push(...cache.get(file)!.samples);
      }

      for (const key of [...cache.keys()]) {
        if (!seen.has(key)) cache.delete(key);
      }

      return samples;
    },

    reset() {
      cache.clear();
    },
  };
}
