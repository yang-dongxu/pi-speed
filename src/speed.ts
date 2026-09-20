export const DEFAULT_WINDOW_ARGUMENTS = ["5m", "20m"] as const;
export const MAX_WINDOWS = 8;

const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export interface SpeedSample {
  startedAt: number;
  endedAt: number;
  outputTokens: number;
  estimated: boolean;
}

export interface WindowSpec {
  label: string;
  milliseconds: number;
}

export interface SpeedAggregate {
  /** Output-token generation throughput during model response time. */
  tokensPerSecond: number;
  /** Output-token volume normalized over the full rolling window. */
  tokensPerMinute: number;
  /** Completed response volume normalized over the full rolling window. */
  requestsPerMinute: number;
  outputTokens: number;
  durationMs: number;
  sampleCount: number;
  estimated: boolean;
}

export type WindowParseResult =
  | { ok: true; windows: WindowSpec[] }
  | { ok: false; error: string };

export function parseWindowArguments(input: string): WindowParseResult {
  const parsedArguments = input.trim().split(/[\s,]+/).filter(Boolean);
  const arguments_ = parsedArguments.length > 0 ? parsedArguments : [...DEFAULT_WINDOW_ARGUMENTS];

  if (arguments_.length > MAX_WINDOWS) {
    return { ok: false, error: `Choose at most ${MAX_WINDOWS} time windows.` };
  }

  const windows: WindowSpec[] = [];
  const seen = new Set<number>();

  for (const argument of arguments_) {
    const match = /^(\d+(?:\.\d+)?)([smhd])?$/i.exec(argument);
    if (!match) {
      return {
        ok: false,
        error: `Invalid time window "${argument}". Use values such as 30s, 5m, 2h, or 1d.`,
      };
    }

    const amount = Number(match[1]);
    const unit = (match[2]?.toLowerCase() ?? "m") as keyof typeof UNIT_MS;
    const milliseconds = amount * UNIT_MS[unit];

    if (!Number.isFinite(milliseconds) || milliseconds < MIN_WINDOW_MS || milliseconds > MAX_WINDOW_MS) {
      return {
        ok: false,
        error: `Time window "${argument}" must be between 1s and 30d.`,
      };
    }

    if (!seen.has(milliseconds)) {
      seen.add(milliseconds);
      windows.push({ label: formatWindowLabel(amount, unit), milliseconds });
    }
  }

  return { ok: true, windows };
}

export function createSpeedSample(
  startedAt: number,
  endedAt: number,
  reportedOutputTokens: number,
  estimatedOutputTokens: number,
): SpeedSample | undefined {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) return undefined;

  const hasReportedUsage = Number.isFinite(reportedOutputTokens) && reportedOutputTokens > 0;
  const outputTokens = hasReportedUsage ? reportedOutputTokens : estimatedOutputTokens;
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;

  return {
    startedAt,
    endedAt,
    outputTokens,
    estimated: !hasReportedUsage,
  };
}

export function sampleRate(sample: SpeedSample): number {
  return (sample.outputTokens * 1_000) / (sample.endedAt - sample.startedAt);
}

export function aggregateWindow(
  samples: readonly SpeedSample[],
  now: number,
  windowMs: number,
): SpeedAggregate | undefined {
  const cutoff = now - windowMs;
  let outputTokens = 0;
  let durationMs = 0;
  let sampleCount = 0;
  let estimated = false;

  for (const sample of samples) {
    if (sample.endedAt < cutoff || sample.endedAt > now) continue;
    const sampleDuration = sample.endedAt - sample.startedAt;
    if (sampleDuration <= 0 || sample.outputTokens <= 0) continue;

    outputTokens += sample.outputTokens;
    durationMs += sampleDuration;
    sampleCount += 1;
    estimated ||= sample.estimated;
  }

  if (sampleCount === 0 || durationMs <= 0) return undefined;

  return {
    tokensPerSecond: (outputTokens * 1_000) / durationMs,
    tokensPerMinute: (outputTokens * 60_000) / windowMs,
    requestsPerMinute: (sampleCount * 60_000) / windowMs,
    outputTokens,
    durationMs,
    sampleCount,
    estimated,
  };
}

export function latestSample(samples: readonly SpeedSample[]): SpeedSample | undefined {
  let latest: SpeedSample | undefined;
  for (const sample of samples) {
    if (!latest || sample.endedAt > latest.endedAt) latest = sample;
  }
  return latest;
}

export function estimateOutputTokens(content: readonly unknown[]): number {
  let characters = 0;

  for (const value of content) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string") {
      characters += block.text.length;
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      characters += block.thinking.length;
    } else if (block.type === "toolCall") {
      if (typeof block.name === "string") characters += block.name.length;
      characters += safeJsonLength(block.arguments);
    }
  }

  return Math.ceil(characters / 4);
}

export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return "—";
  if (rate < 100) return rate.toFixed(1);
  return rate.toFixed(0);
}

export function formatPerMinuteRate(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return "—";
  if (rate < 1) return rate.toFixed(2);
  if (rate < 100) return rate.toFixed(1);
  return rate.toFixed(0);
}

export function formatTokenCount(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}

export function formatElapsed(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function formatWindowLabel(amount: number, unit: keyof typeof UNIT_MS): string {
  return `${Number.isInteger(amount) ? amount.toFixed(0) : amount}${unit}`;
}

function safeJsonLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "undefined").length;
  } catch {
    return "[unserializable]".length;
  }
}
