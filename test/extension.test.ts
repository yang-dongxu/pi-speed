import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piSpeed from "../extensions/pi-speed.ts";

type EventHandler = (event: any, context: any) => void | Promise<void>;

function createHarness(branch: any[] = []) {
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
});

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
