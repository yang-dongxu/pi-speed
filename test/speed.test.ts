import { describe, expect, it } from "vitest";
import {
  aggregateWindow,
  createSpeedSample,
  estimateOutputTokens,
  formatElapsed,
  formatPerMinuteRate,
  formatRate,
  latestSample,
  parseWindowArguments,
  sampleRate,
  type SpeedSample,
} from "../src/speed.ts";

describe("parseWindowArguments", () => {
  it("uses 5m and 20m by default", () => {
    expect(parseWindowArguments("")).toEqual({
      ok: true,
      windows: [
        { label: "5m", milliseconds: 300_000 },
        { label: "20m", milliseconds: 1_200_000 },
      ],
    });
  });

  it("accepts seconds, bare minutes, hours, days, decimals, and commas", () => {
    expect(parseWindowArguments("30s, 2 1.5h 1d")).toEqual({
      ok: true,
      windows: [
        { label: "30s", milliseconds: 30_000 },
        { label: "2m", milliseconds: 120_000 },
        { label: "1.5h", milliseconds: 5_400_000 },
        { label: "1d", milliseconds: 86_400_000 },
      ],
    });
  });

  it("deduplicates equivalent windows", () => {
    expect(parseWindowArguments("60s 1m")).toEqual({
      ok: true,
      windows: [{ label: "60s", milliseconds: 60_000 }],
    });
  });

  it("uses defaults for separator-only input", () => {
    expect(parseWindowArguments(", ,")).toEqual(parseWindowArguments(""));
  });

  it("rejects invalid and out-of-range windows", () => {
    expect(parseWindowArguments("soon").ok).toBe(false);
    expect(parseWindowArguments("0m").ok).toBe(false);
    expect(parseWindowArguments("31d").ok).toBe(false);
  });
});

describe("speed samples", () => {
  it("prefers reported usage and computes response speed", () => {
    const sample = createSpeedSample(1_000, 3_000, 100, 20);
    expect(sample).toEqual({ startedAt: 1_000, endedAt: 3_000, outputTokens: 100, estimated: false });
    expect(sampleRate(sample!)).toBe(50);
  });

  it("falls back to estimated tokens when reported usage is unavailable", () => {
    expect(createSpeedSample(1_000, 3_000, 0, 20)).toEqual({
      startedAt: 1_000,
      endedAt: 3_000,
      outputTokens: 20,
      estimated: true,
    });
  });

  it("rejects empty tokens and invalid durations", () => {
    expect(createSpeedSample(2_000, 1_000, 10, 10)).toBeUndefined();
    expect(createSpeedSample(1_000, 2_000, 0, 0)).toBeUndefined();
  });

  it("finds the latest completed sample", () => {
    const samples: SpeedSample[] = [
      { startedAt: 0, endedAt: 2_000, outputTokens: 10, estimated: false },
      { startedAt: 0, endedAt: 5_000, outputTokens: 20, estimated: false },
    ];
    expect(latestSample(samples)).toBe(samples[1]);
  });
});

describe("aggregateWindow", () => {
  const samples: SpeedSample[] = [
    { startedAt: 80_000, endedAt: 90_000, outputTokens: 100, estimated: false },
    { startedAt: 94_000, endedAt: 99_000, outputTokens: 100, estimated: true },
    { startedAt: 0, endedAt: 20_000, outputTokens: 1_000, estimated: false },
  ];

  it("uses completed samples inside the window and weights by generation time", () => {
    expect(aggregateWindow(samples, 100_000, 15_000)).toEqual({
      tokensPerSecond: 200_000 / 15_000,
      tokensPerMinute: 800,
      requestsPerMinute: 8,
      outputTokens: 200,
      durationMs: 15_000,
      sampleCount: 2,
      estimated: true,
    });
  });

  it("returns undefined when the window has no samples", () => {
    expect(aggregateWindow(samples, 200_000, 10_000)).toBeUndefined();
  });
});

describe("output estimation and formatting", () => {
  it("estimates text, thinking, and tool-call content at four characters per token", () => {
    const content = [
      { type: "text", text: "12345678" },
      { type: "thinking", thinking: "1234" },
      { type: "toolCall", name: "read", arguments: { path: "a" } },
    ];
    const expectedCharacters = 8 + 4 + 4 + JSON.stringify({ path: "a" }).length;
    expect(estimateOutputTokens(content)).toBe(Math.ceil(expectedCharacters / 4));
  });

  it("formats rates and elapsed time compactly", () => {
    expect(formatRate(12.345)).toBe("12.3");
    expect(formatRate(123.45)).toBe("123");
    expect(formatPerMinuteRate(0.05)).toBe("0.05");
    expect(formatPerMinuteRate(12.34)).toBe("12.3");
    expect(formatPerMinuteRate(123.45)).toBe("123");
    expect(formatElapsed(2_345)).toBe("2.35s");
    expect(formatElapsed(12_345)).toBe("12.3s");
    expect(formatElapsed(90_000)).toBe("1.5m");
  });
});
