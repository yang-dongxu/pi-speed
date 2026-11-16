import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTranscriptReader,
  isSubagentSessionFile,
  listChildren,
  liveRate,
  notifyChildrenChanged,
  parseTranscriptSamples,
  registerChild,
  subscribeToChildren,
  subagentTasksDir,
  unregisterChild,
} from "../src/subagents.ts";

function assistantLine(startedAt: number, endedAt: number, output: number, stopReason = "stop") {
  return JSON.stringify({
    type: "message",
    timestamp: new Date(endedAt).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "z".repeat(40) }],
      stopReason,
      timestamp: startedAt,
      usage: { input: 5, output, cacheRead: 0, cacheWrite: 0, totalTokens: output },
    },
  });
}

afterEach(() => {
  for (const child of listChildren()) unregisterChild(child.file);
});

describe("subagent session paths", () => {
  it("derives the tasks directory from a parent session file", () => {
    expect(subagentTasksDir("/sessions/--p--/2026-01-01T00-00-00Z_abc.jsonl")).toBe(
      "/sessions/--p--/2026-01-01T00-00-00Z_abc/tasks",
    );
  });

  it("has no tasks directory without a persisted parent session", () => {
    expect(subagentTasksDir(undefined)).toBeUndefined();
  });

  it("recognizes a child session by its tasks directory", () => {
    expect(isSubagentSessionFile("/s/--p--/2026-01-01T00-00-00Z_abc/tasks/child.jsonl")).toBe(true);
    expect(isSubagentSessionFile("/s/--p--/2026-01-01T00-00-00Z_abc.jsonl")).toBe(false);
    expect(isSubagentSessionFile(undefined)).toBe(false);
  });
});

describe("parseTranscriptSamples", () => {
  it("reads completed assistant responses", () => {
    const samples = parseTranscriptSamples(`${assistantLine(1_000, 3_000, 100)}\n`);
    expect(samples).toEqual([{ startedAt: 1_000, endedAt: 3_000, outputTokens: 100, estimated: false }]);
  });

  it("estimates tokens when the provider reported none", () => {
    const [sample] = parseTranscriptSamples(`${assistantLine(1_000, 2_000, 0)}\n`);
    expect(sample?.estimated).toBe(true);
    expect(sample?.outputTokens).toBe(10);
  });

  it("skips aborted and errored responses, other roles, and unparsable lines", () => {
    const text = [
      assistantLine(1_000, 2_000, 50, "aborted"),
      assistantLine(2_000, 3_000, 50, "error"),
      JSON.stringify({ type: "message", timestamp: new Date(4_000).toISOString(), message: { role: "user" } }),
      "{ not json",
      "",
      assistantLine(5_000, 6_000, 70),
    ].join("\n");

    expect(parseTranscriptSamples(text)).toEqual([
      { startedAt: 5_000, endedAt: 6_000, outputTokens: 70, estimated: false },
    ]);
  });
});

describe("createTranscriptReader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speed-transcripts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing for a missing or undefined directory", () => {
    const reader = createTranscriptReader();
    expect(reader.read(undefined)).toEqual([]);
    expect(reader.read(join(dir, "absent"))).toEqual([]);
  });

  it("merges every transcript and skips the files it is told to", () => {
    const first = join(dir, "a.jsonl");
    const second = join(dir, "b.jsonl");
    writeFileSync(first, `${assistantLine(1_000, 2_000, 100)}\n`);
    writeFileSync(second, `${assistantLine(2_000, 4_000, 200)}\n`);
    writeFileSync(join(dir, "ignored.txt"), "not a transcript");

    const reader = createTranscriptReader();
    expect(reader.read(dir).map((sample) => sample.outputTokens)).toEqual([100, 200]);
    expect(reader.read(dir, new Set([first])).map((sample) => sample.outputTokens)).toEqual([200]);
  });

  it("re-parses a transcript only after it changes", () => {
    const file = join(dir, "a.jsonl");
    writeFileSync(file, `${assistantLine(1_000, 2_000, 100)}\n`);

    const reader = createTranscriptReader();
    expect(reader.read(dir).map((sample) => sample.outputTokens)).toEqual([100]);

    writeFileSync(file, `${assistantLine(1_000, 2_000, 100)}\n${assistantLine(2_000, 3_000, 30)}\n`);
    expect(reader.read(dir).map((sample) => sample.outputTokens)).toEqual([100, 30]);

    reader.reset();
    expect(reader.read(dir).map((sample) => sample.outputTokens)).toEqual([100, 30]);
  });

  it("forgets transcripts that disappeared", () => {
    const file = join(dir, "a.jsonl");
    writeFileSync(file, `${assistantLine(1_000, 2_000, 100)}\n`);

    const reader = createTranscriptReader();
    expect(reader.read(dir)).toHaveLength(1);

    rmSync(file);
    expect(reader.read(dir)).toEqual([]);
  });
});

describe("child bridge", () => {
  it("registers, lists, and unregisters child sessions", () => {
    const child = registerChild("/tasks/a.jsonl");
    child.samples.push({ startedAt: 0, endedAt: 1_000, outputTokens: 10, estimated: false });

    expect(registerChild("/tasks/a.jsonl")).toBe(child);
    expect(listChildren()).toEqual([child]);

    unregisterChild("/tasks/a.jsonl");
    expect(listChildren()).toEqual([]);
  });

  it("notifies subscribers and marks urgent changes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToChildren((urgent) => seen.push(urgent));

    notifyChildrenChanged(false);
    notifyChildrenChanged(true);
    unsubscribe();
    notifyChildrenChanged(true);

    expect(seen).toEqual([false, true]);
  });

  it("keeps notifying after a subscriber throws", () => {
    const seen: string[] = [];
    const unsubscribeThrower = subscribeToChildren(() => {
      throw new Error("boom");
    });
    const unsubscribe = subscribeToChildren(() => seen.push("ok"));

    expect(() => notifyChildrenChanged(true)).not.toThrow();
    expect(seen).toEqual(["ok"]);

    unsubscribeThrower();
    unsubscribe();
  });

  it("rates a live generation and ignores an idle or empty one", () => {
    expect(liveRate({ startedAt: 1_000, outputTokens: 50, estimated: false }, 3_000)).toBe(25);
    expect(liveRate({ startedAt: 1_000, outputTokens: 0, estimated: true }, 3_000)).toBeUndefined();
    expect(liveRate({ startedAt: 3_000, outputTokens: 50, estimated: false }, 3_000)).toBeUndefined();
    expect(liveRate(undefined, 3_000)).toBeUndefined();
  });
});

describe("subagent transcript layout", () => {
  it("matches the directory Pi derives for a parent session", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-speed-layout-"));
    try {
      const parentFile = join(root, "2026-01-01T00-00-00Z_parent.jsonl");
      const tasks = subagentTasksDir(parentFile)!;
      mkdirSync(tasks, { recursive: true });

      const childFile = join(tasks, "child.jsonl");
      writeFileSync(childFile, `${assistantLine(1_000, 2_000, 100)}\n`);

      expect(isSubagentSessionFile(childFile)).toBe(true);
      expect(createTranscriptReader().read(tasks)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
