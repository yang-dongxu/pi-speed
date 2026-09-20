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
  parseWindowArguments,
  sampleRate,
  type SpeedSample,
} from "../src/speed.ts";

const STATUS_KEY = "pi-speed";
const STATUS_UPDATE_INTERVAL_MS = 250;

interface ActiveGeneration {
  startedAt: number;
  outputTokens: number;
  estimated: boolean;
  lastStatusUpdateAt: number;
}

export default function piSpeed(pi: ExtensionAPI) {
  let samples: SpeedSample[] = [];
  let active: ActiveGeneration | undefined;

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

  const setIdleStatus = (ctx: ExtensionContext): void => {
    const latest = latestSample(samples);
    if (!latest) {
      ctx.ui.setStatus(STATUS_KEY, "speed —");
      return;
    }

    const prefix = latest.estimated ? "~" : "";
    ctx.ui.setStatus(STATUS_KEY, `speed ${prefix}${formatRate(sampleRate(latest))} TPS`);
  };

  pi.on("session_start", (_event, ctx) => {
    active = undefined;
    rebuildSamples(ctx);
    setIdleStatus(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    active = undefined;
    rebuildSamples(ctx);
    setIdleStatus(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    active = {
      startedAt: event.message.timestamp,
      outputTokens: 0,
      estimated: true,
      lastStatusUpdateAt: 0,
    };
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

    if (now - active.lastStatusUpdateAt < STATUS_UPDATE_INTERVAL_MS) return;
    active.lastStatusUpdateAt = now;

    const elapsedMs = now - active.startedAt;
    if (active.outputTokens <= 0 || elapsedMs <= 0) {
      ctx.ui.setStatus(STATUS_KEY, "speed waiting…");
      return;
    }

    const prefix = active.estimated ? "~" : "";
    const rate = (active.outputTokens * 1_000) / elapsedMs;
    ctx.ui.setStatus(STATUS_KEY, `speed ${prefix}${formatRate(rate)} TPS`);
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
      if (sample) samples.push(sample);
    }

    active = undefined;
    setIdleStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("speed", {
    description: "Show current TPS and rolling TPS, TPM, and RPM (default: 5m and 20m)",
    getArgumentCompletions: (prefix) => {
      const options = ["1m", "5m", "10m", "20m", "30m", "1h"];
      const match = /^(.*[\s,])?([^\s,]*)$/.exec(prefix);
      const leading = match?.[1] ?? "";
      const current = match?.[2] ?? prefix;
      const matches = options.filter((option) => option.startsWith(current));
      return matches.length > 0
        ? matches.map((option) => ({ value: `${leading}${option}`, label: option }))
        : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseWindowArguments(args);
      if (!parsed.ok) {
        ctx.ui.notify(`${parsed.error}\nUsage: /speed [30s] [5m] [2h]`, "warning");
        return;
      }

      const now = Date.now();
      const lines = ["Token speed"];

      if (active && active.outputTokens > 0 && now > active.startedAt) {
        const rate = (active.outputTokens * 1_000) / (now - active.startedAt);
        lines.push(
          `Current: ${active.estimated ? "~" : ""}${formatRate(rate)} TPS ` +
            `(${formatTokenCount(active.outputTokens)} tokens, streaming)`,
        );
      } else {
        const latest = latestSample(samples);
        lines.push(
          latest
            ? `Current: ${latest.estimated ? "~" : ""}${formatRate(sampleRate(latest))} TPS ` +
                `(${formatTokenCount(latest.outputTokens)} tokens / ${formatElapsed(latest.endedAt - latest.startedAt)}, latest response)`
            : "Current: — (no completed responses)",
        );
      }

      for (const window of parsed.windows) {
        const aggregate = aggregateWindow(samples, now, window.milliseconds);
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
      }

      lines.push("TPS = generation throughput · TPM = rolling token volume · RPM = rolling completed responses. ~ means estimated tokens.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
