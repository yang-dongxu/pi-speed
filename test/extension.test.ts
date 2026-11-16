import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piSpeed from "../extensions/pi-speed.ts";
import { listChildren, unregisterChild } from "../src/subagents.ts";

type EventHandler = (event: any, context: any) => void | Promise<void>;

function createHarness(branch: any[] = [], sessionFile?: string) {
  const handlers = new Map<string, EventHandler[]>();
  let command: any;
  const statuses = new Map<string, string | undefined>();
  const notifications: Array<{ message: string; type: string }> = [];

  const pi = {
    on(name: string, handler: EventHandler) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
      return () => {};
    },
    registerCommand(name: string, definition: any) {
      if (name === "speed") command = definition;
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      notify: (message: string, type: string) => notifications.push({ message, type }),
    },
  };

  piSpeed(pi);

  return {
    command,
    context,
    statuses,
    notifications,
    async emit(name: string, event: any) {
      for (const handler of handlers.get(name) ?? []) await handler(event, context);
    },
  };
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "1234567890123456789012345678901234567890" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 1_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const child of listChildren()) unregisterChild(child.file);
});

/** One completed assistant response as a session-branch entry. */
function branchEntry(startedAt: number, endedAt: number, output: number) {
  return {
    type: "message",
    timestamp: new Date(endedAt).toISOString(),
    message: assistantMessage({
      timestamp: startedAt,
      stopReason: "stop",
      usage: {
        input: 10,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: output + 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
  };
}

/** The same response as a subagent transcript line. */
function transcriptLine(startedAt: number, endedAt: number, output: number) {
  return JSON.stringify(branchEntry(startedAt, endedAt, output));
}

/** A parent session file plus the tasks directory Pi writes its children to. */
function createSessionTree() {
  const root = mkdtempSync(join(tmpdir(), "pi-speed-extension-"));
  const parentFile = join(root, "2026-01-01T00-00-00Z_parent.jsonl");
  const tasks = join(root, "2026-01-01T00-00-00Z_parent", "tasks");
  mkdirSync(tasks, { recursive: true });
  return { root, parentFile, tasks };
}

describe("pi-speed extension", () => {
  it("reconstructs completed responses and reports default windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const message = assistantMessage({
      stopReason: "stop",
      usage: {
        input: 10,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const harness = createHarness([
      { type: "message", timestamp: new Date(3_000).toISOString(), message },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command.handler("", harness.context);

    expect(harness.statuses.get("pi-speed")).toBe("speed 50.0 TPS");
    expect(harness.notifications.at(-1)?.message).toContain("Current: 50.0 TPS");
    expect(harness.notifications.at(-1)?.message).toContain("Last 5m: 50.0 TPS · 20.0 TPM · 0.20 RPM");
    expect(harness.notifications.at(-1)?.message).toContain("Last 20m: 50.0 TPS · 5.0 TPM · 0.05 RPM");
  });

  it("shows estimated live speed and switches to exact final usage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness();
    const streaming = assistantMessage();

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("message_start", { type: "message_start", message: streaming });

    vi.setSystemTime(3_000);
    await harness.emit("message_update", {
      type: "message_update",
      message: streaming,
      assistantMessageEvent: { type: "text_delta", delta: "1234" },
    });
    expect(harness.statuses.get("pi-speed")).toBe("speed ~5.0 TPS");

    vi.setSystemTime(4_000);
    const completed = assistantMessage({
      stopReason: "stop",
      usage: {
        input: 10,
        output: 30,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 40,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    await harness.emit("message_end", { type: "message_end", message: completed });
    expect(harness.statuses.get("pi-speed")).toBe("speed 10.0 TPS");

    await harness.command.handler("1m", harness.context);
    expect(harness.notifications.at(-1)?.message).toContain("Last 1m: 10.0 TPS · 30.0 TPM · 1.0 RPM");
  });

  it("excludes aborted responses and clears its status on shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const harness = createHarness();
    const aborted = assistantMessage({ stopReason: "aborted" });

    await harness.emit("message_start", { type: "message_start", message: aborted });
    await harness.emit("message_end", { type: "message_end", message: aborted });
    await harness.command.handler("5m", harness.context);
    expect(harness.notifications.at(-1)?.message).toContain("no completed responses");

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(harness.statuses.get("pi-speed")).toBeUndefined();
  });

  it("preserves earlier arguments in multi-window autocomplete", () => {
    const harness = createHarness();
    expect(harness.command.getArgumentCompletions("5m 2")).toContainEqual({
      value: "5m 20m",
      label: "20m",
    });
  });
});

describe("pi-speed subagent accounting", () => {
  it("counts subagent transcripts in the rolling windows and the status", async () => {
    const { root, parentFile, tasks } = createSessionTree();
    try {
      const now = 100_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);
      writeFileSync(join(tasks, "child.jsonl"), `${transcriptLine(now - 10_000, now - 8_000, 100)}\n`);

      const harness = createHarness([branchEntry(now - 7_000, now - 4_000, 300)], parentFile);
      await harness.emit("session_start", { type: "session_start", reason: "startup" });

      expect(harness.statuses.get("pi-speed")).toBe("speed 100 TPS · sub 100/5m");

      await harness.command.handler("", harness.context);
      const report = harness.notifications.at(-1)?.message ?? "";
      expect(report).toContain("Token speed (main + subagents)");
      expect(report).toContain("Last 5m: 80.0 TPS · 80.0 TPM · 0.40 RPM (400 tokens / 2 responses)");
      expect(report).toContain("main 300 tokens / 1 response · subagents 100 tokens / 1 response");

      await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes subagent responses from the main scope", async () => {
    const { root, parentFile, tasks } = createSessionTree();
    try {
      const now = 100_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);
      writeFileSync(join(tasks, "child.jsonl"), `${transcriptLine(now - 10_000, now - 8_000, 100)}\n`);

      const harness = createHarness([branchEntry(now - 7_000, now - 4_000, 300)], parentFile);
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      await harness.command.handler("main", harness.context);

      const report = harness.notifications.at(-1)?.message ?? "";
      expect(report).toContain("Token speed (main session)");
      expect(report).toContain("Last 5m: 100 TPS · 60.0 TPM · 0.20 RPM (300 tokens / 1 response)");
      expect(report).not.toContain("subagents");

      await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers a registered child's published samples over its transcript", async () => {
    const { root, parentFile, tasks } = createSessionTree();
    try {
      const now = 100_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const childFile = join(tasks, "child.jsonl");
      writeFileSync(childFile, `${transcriptLine(now - 10_000, now - 8_000, 200)}\n`);

      const parent = createHarness([], parentFile);
      await parent.emit("session_start", { type: "session_start", reason: "startup" });

      const child = createHarness([], childFile);
      await child.emit("session_start", { type: "session_start", reason: "startup" });
      expect(listChildren()).toHaveLength(1);

      await child.emit("message_start", {
        type: "message_start",
        message: assistantMessage({ timestamp: now - 2_000 }),
      });
      await child.emit("message_end", {
        type: "message_end",
        message: assistantMessage({
          timestamp: now - 2_000,
          stopReason: "stop",
          usage: {
            input: 10,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 60,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      });

      await parent.command.handler("sub", parent.context);
      const registered = parent.notifications.at(-1)?.message ?? "";
      expect(registered).toContain("Token speed (subagents)");
      expect(registered).toContain("Last 5m: 25.0 TPS · 10.0 TPM · 0.20 RPM (50 tokens / 1 response)");

      // Once the child session ends, its transcript takes over as the source.
      await child.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      expect(listChildren()).toHaveLength(0);

      await parent.command.handler("sub", parent.context);
      expect(parent.notifications.at(-1)?.message).toContain("(200 tokens / 1 response)");

      await parent.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows live subagent throughput in the parent's status", async () => {
    const { root, parentFile, tasks } = createSessionTree();
    try {
      const now = 100_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const parent = createHarness([], parentFile);
      await parent.emit("session_start", { type: "session_start", reason: "startup" });
      expect(parent.statuses.get("pi-speed")).toBe("speed —");

      const child = createHarness([], join(tasks, "child.jsonl"));
      await child.emit("session_start", { type: "session_start", reason: "startup" });

      await child.emit("message_start", {
        type: "message_start",
        message: assistantMessage({ timestamp: now }),
      });

      vi.setSystemTime(now + 2_000);
      await child.emit("message_update", {
        type: "message_update",
        message: assistantMessage({
          timestamp: now,
          usage: {
            input: 10,
            output: 40,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 50,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      });

      // The bridge throttles re-renders, so the trailing render has to run.
      vi.advanceTimersByTime(300);
      expect(parent.statuses.get("pi-speed")).toBe("speed — · sub 20.0 TPS");

      vi.setSystemTime(now + 2_000);
      await parent.command.handler("", parent.context);
      expect(parent.notifications.at(-1)?.message).toContain("Subagents: 1 agent streaming · 20.0 TPS");

      await child.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await parent.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
