import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  aggregateWindow,
  createSpeedSample,
  estimateOutputTokens,
  formatElapsed,
  formatPerMinuteRate,
  formatRate,
  formatTokenCount,
  latestSample,
  parseReportArguments,
  sampleRate,
  type SampleScope,
  type SpeedSample,
} from "../src/speed.ts";
import {
  createTranscriptReader,
  isSubagentSessionFile,
  listChildren,
  liveRate,
  notifyChildrenChanged,
  registerChild,
  subscribeToChildren,
  subagentTasksDir,
  unregisterChild,
  type ChildSession,
} from "../src/subagents.ts";

const STATUS_KEY = "pi-speed";
const STATUS_UPDATE_INTERVAL_MS = 250;
const SUBAGENT_REFRESH_INTERVAL_MS = 1_000;
const RECENT_SUBAGENT_WINDOW_MS = 300_000;

const WINDOW_COMPLETIONS = ["1m", "5m", "10m", "20m", "30m", "1h"];
const SCOPE_COMPLETIONS = ["main", "sub", "all"];

interface ActiveGeneration {
  startedAt: number;
  outputTokens: number;
  estimated: boolean;
  lastStatusUpdateAt: number;
}

/** Live subagent throughput, summed over every child that is streaming. */
interface StreamingChildren {
  count: number;
  tokensPerSecond: number;
}

export default function piSpeed(pi: ExtensionAPI) {
  /** Completed responses of this session. */
  let samples: SpeedSample[] = [];
  /** This session's in-flight response. */
  let active: ActiveGeneration | undefined;

  /** Set when this session is a subagent: its transcript path and bridge entry. */
  let childFile: string | undefined;
  let child: ChildSession | undefined;

  /** Set when this session is a top-level session: where its children write. */
  let tasksDir: string | undefined;
  let subagentSamples: SpeedSample[] = [];
  let lastSubagentRefreshAt = 0;
  const transcripts = createTranscriptReader();

  /** Root-only: bridge subscription and the context its status is rendered into. */
  let rootContext: ExtensionContext | undefined;
  let unsubscribeFromChildren: (() => void) | undefined;
  let lastBridgeRenderAt = 0;
  let pendingBridgeRender: ReturnType<typeof setTimeout> | undefined;

  const rebuildSamples = (ctx: ExtensionContext): void => {
    samples = [];

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message as AssistantMessage;
      if (message.stopReason === "aborted" || message.stopReason === "error") continue;

      const sample = createSpeedSample(
        message.timestamp,
        Date.parse(entry.timestamp),
        message.usage.output,
        estimateOutputTokens(message.content),
      );
      if (sample) samples.push(sample);
    }
  };

  /**
   * Subagent responses visible to a top-level session: transcripts of children
   * that are not on the bridge, plus the samples children published.
   */
  const refreshSubagentSamples = (now: number, force = false): SpeedSample[] => {
    if (!force && now - lastSubagentRefreshAt < SUBAGENT_REFRESH_INTERVAL_MS) return subagentSamples;
    lastSubagentRefreshAt = now;

    const children = listChildren();
    const registered = new Set(children.map((entry) => entry.file));
    subagentSamples = [...transcripts.read(tasksDir, registered), ...children.flatMap((entry) => entry.samples)];
    return subagentSamples;
  };

  const streamingChildren = (now: number): StreamingChildren | undefined => {
    let count = 0;
    let tokensPerSecond = 0;

    for (const entry of listChildren()) {
      const rate = liveRate(entry.live, now);
      if (rate === undefined) continue;
      count += 1;
      tokensPerSecond += rate;
    }

    return count > 0 ? { count, tokensPerSecond } : undefined;
  };

  const subagentSuffix = (now: number, subagent: readonly SpeedSample[]): string => {
    const streaming = streamingChildren(now);
    if (streaming) {
      const agents = streaming.count > 1 ? ` ×${streaming.count}` : "";
      return ` · sub ${formatRate(streaming.tokensPerSecond)} TPS${agents}`;
    }

    const cutoff = now - RECENT_SUBAGENT_WINDOW_MS;
    let recentTokens = 0;
    for (const sample of subagent) {
      if (sample.endedAt >= cutoff) recentTokens += sample.outputTokens;
    }
    if (recentTokens <= 0) return "";

    return ` · sub ${formatTokenCount(recentTokens)}/5m`;
  };

  const renderStatus = (ctx: ExtensionContext): void => {
    const now = Date.now();
    const subagent = childFile ? [] : refreshSubagentSamples(now);
    const suffix = childFile ? "" : subagentSuffix(now, subagent);

    if (active) {
      const elapsedMs = now - active.startedAt;
      if (active.outputTokens <= 0 || elapsedMs <= 0) {
        ctx.ui.setStatus(STATUS_KEY, `speed waiting…${suffix}`);
        return;
      }

      const prefix = active.estimated ? "~" : "";
      const rate = (active.outputTokens * 1_000) / elapsedMs;
      ctx.ui.setStatus(STATUS_KEY, `speed ${prefix}${formatRate(rate)} TPS${suffix}`);
      return;
    }

    const latest = latestSample(childFile ? samples : [...samples, ...subagent]);
    if (!latest) {
      ctx.ui.setStatus(STATUS_KEY, `speed —${suffix}`);
      return;
    }

    const prefix = latest.estimated ? "~" : "";
    ctx.ui.setStatus(STATUS_KEY, `speed ${prefix}${formatRate(sampleRate(latest))} TPS${suffix}`);
  };

  /**
   * Re-render on a bridge change, at most once per status interval. A change
   * that arrives inside the interval schedules a trailing render, so the last
   * state of a burst — a child that just stopped streaming — is never dropped.
   */
  const scheduleBridgeRender = (urgent: boolean): void => {
    const now = Date.now();

    // A child's session or response just ended: its samples changed, so the
    // cached subagent set is stale even if the refresh interval has not elapsed.
    if (urgent) lastSubagentRefreshAt = 0;

    if (urgent || now - lastBridgeRenderAt >= STATUS_UPDATE_INTERVAL_MS) {
      if (pendingBridgeRender) {
        clearTimeout(pendingBridgeRender);
        pendingBridgeRender = undefined;
      }
      lastBridgeRenderAt = now;
      if (rootContext) renderStatus(rootContext);
      return;
    }

    if (pendingBridgeRender) return;
    pendingBridgeRender = setTimeout(() => {
      pendingBridgeRender = undefined;
      lastBridgeRenderAt = Date.now();
      if (rootContext) renderStatus(rootContext);
    }, STATUS_UPDATE_INTERVAL_MS - (now - lastBridgeRenderAt));
    pendingBridgeRender.unref?.();
  };

  const clearBridgeRender = (): void => {
    if (!pendingBridgeRender) return;
    clearTimeout(pendingBridgeRender);
    pendingBridgeRender = undefined;
  };

  /** Mirror this session's in-flight response onto the bridge, for a parent to read. */
  const publishLive = (): void => {
    if (!child) return;
    child.live = active
      ? { startedAt: active.startedAt, outputTokens: active.outputTokens, estimated: active.estimated }
      : undefined;
    notifyChildrenChanged(false);
  };

  const scopedSamples = (scope: SampleScope, subagent: readonly SpeedSample[]): SpeedSample[] => {
    if (scope === "main") return samples;
    if (scope === "sub") return [...subagent];
    return [...samples, ...subagent];
  };

  pi.on("session_start", (_event, ctx) => {
    active = undefined;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();

    if (isSubagentSessionFile(sessionFile)) {
      childFile = sessionFile!;
      child = registerChild(childFile);
      tasksDir = undefined;
      rebuildSamples(ctx);
      child.samples = [...samples];
      child.live = undefined;
      notifyChildrenChanged(true);
      renderStatus(ctx);
      return;
    }

    childFile = undefined;
    child = undefined;
    tasksDir = subagentTasksDir(sessionFile);
    transcripts.reset();
    lastSubagentRefreshAt = 0;
    rebuildSamples(ctx);

    rootContext = ctx;
    lastBridgeRenderAt = 0;
    clearBridgeRender();
    unsubscribeFromChildren?.();
    unsubscribeFromChildren = subscribeToChildren(scheduleBridgeRender);

    renderStatus(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    active = undefined;
    rebuildSamples(ctx);

    if (child) {
      child.samples = [...samples];
      child.live = undefined;
      notifyChildrenChanged(true);
    } else {
      lastSubagentRefreshAt = 0;
    }

    renderStatus(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    active = {
      startedAt: event.message.timestamp,
      outputTokens: 0,
      estimated: true,
      lastStatusUpdateAt: 0,
    };
    publishLive();
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const now = Date.now();
    active ??= {
      startedAt: event.message.timestamp,
      outputTokens: 0,
      estimated: true,
      lastStatusUpdateAt: 0,
    };

    const reportedTokens = event.message.usage.output;
    active.outputTokens = reportedTokens > 0 ? reportedTokens : estimateOutputTokens(event.message.content);
    active.estimated = reportedTokens <= 0;
    publishLive();

    if (now - active.lastStatusUpdateAt < STATUS_UPDATE_INTERVAL_MS) return;
    active.lastStatusUpdateAt = now;

    renderStatus(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const message = event.message as AssistantMessage;
    const endedAt = Date.now();

    if (message.stopReason !== "aborted" && message.stopReason !== "error") {
      const sample = createSpeedSample(
        message.timestamp,
        endedAt,
        message.usage.output,
        estimateOutputTokens(message.content),
      );
      if (sample) {
        samples.push(sample);
        if (child) child.samples.push(sample);
      }
    }

    active = undefined;

    if (child) {
      child.live = undefined;
      notifyChildrenChanged(true);
    }

    renderStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = undefined;

    if (child && childFile) {
      child.live = undefined;
      unregisterChild(childFile);
      child = undefined;
      childFile = undefined;
      notifyChildrenChanged(true);
    }

    unsubscribeFromChildren?.();
    unsubscribeFromChildren = undefined;
    clearBridgeRender();
    rootContext = undefined;

    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("speed", {
    description: "Show current TPS and rolling TPS, TPM, and RPM (default: 5m and 20m, main + subagents)",
    getArgumentCompletions: (prefix) => {
      const options = [...WINDOW_COMPLETIONS, ...SCOPE_COMPLETIONS];
      const match = /^(.*[\s,])?([^\s,]*)$/.exec(prefix);
      const leading = match?.[1] ?? "";
      const current = match?.[2] ?? prefix;
      const matches = options.filter((option) => option.startsWith(current));
      return matches.length > 0
        ? matches.map((option) => ({ value: `${leading}${option}`, label: option }))
        : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseReportArguments(args);
      if (!parsed.ok) {
        ctx.ui.notify(`${parsed.error}\nUsage: /speed [30s] [5m] [2h] [main|sub|all]`, "warning");
        return;
      }

      const now = Date.now();
      const subagent = childFile ? [] : refreshSubagentSamples(now, true);
      const scoped = scopedSamples(parsed.scope, subagent);

      const scopeLabel =
        parsed.scope === "main" ? "main session" : parsed.scope === "sub" ? "subagents" : "main + subagents";
      const lines = [`Token speed (${scopeLabel})`];

      if (parsed.scope !== "sub" && active && active.outputTokens > 0 && now > active.startedAt) {
        const rate = (active.outputTokens * 1_000) / (now - active.startedAt);
        lines.push(
          `Current: ${active.estimated ? "~" : ""}${formatRate(rate)} TPS ` +
            `(${formatTokenCount(active.outputTokens)} tokens, streaming)`,
        );
      } else {
        const latest = latestSample(scoped);
        lines.push(
          latest
            ? `Current: ${latest.estimated ? "~" : ""}${formatRate(sampleRate(latest))} TPS ` +
                `(${formatTokenCount(latest.outputTokens)} tokens / ${formatElapsed(latest.endedAt - latest.startedAt)}, latest response)`
            : "Current: — (no completed responses)",
        );
      }

      if (!childFile) {
        const streaming = streamingChildren(now);
        if (streaming) {
          const agents = streaming.count === 1 ? "agent" : "agents";
          lines.push(
            `Subagents: ${streaming.count} ${agents} streaming · ${formatRate(streaming.tokensPerSecond)} TPS`,
          );
        }
      }

      for (const window of parsed.windows) {
        const aggregate = aggregateWindow(scoped, now, window.milliseconds);
        if (!aggregate) {
          lines.push(`Last ${window.label}: — (no completed responses)`);
          continue;
        }

        const responseWord = aggregate.sampleCount === 1 ? "response" : "responses";
        const estimatePrefix = aggregate.estimated ? "~" : "";
        lines.push(
          `Last ${window.label}: ` +
            `${estimatePrefix}${formatRate(aggregate.tokensPerSecond)} TPS · ` +
            `${estimatePrefix}${formatPerMinuteRate(aggregate.tokensPerMinute)} TPM · ` +
            `${formatPerMinuteRate(aggregate.requestsPerMinute)} RPM ` +
            `(${formatTokenCount(aggregate.outputTokens)} tokens / ${aggregate.sampleCount} ${responseWord})`,
        );

        if (parsed.scope !== "all") continue;
        const mainAggregate = aggregateWindow(samples, now, window.milliseconds);
        const subagentAggregate = aggregateWindow(subagent, now, window.milliseconds);
        if (!mainAggregate || !subagentAggregate) continue;

        const describe = (entry: typeof aggregate): string =>
          `${formatTokenCount(entry.outputTokens)} tokens / ${entry.sampleCount} ` +
          `${entry.sampleCount === 1 ? "response" : "responses"}`;
        lines.push(`  main ${describe(mainAggregate)} · subagents ${describe(subagentAggregate)}`);
      }

      lines.push(
        "TPS = generation throughput · TPM = rolling token volume · RPM = rolling completed responses. ~ means estimated tokens.",
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
