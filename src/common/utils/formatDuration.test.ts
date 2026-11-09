import { describe, expect, test } from "bun:test";
import { formatDuration, formatElapsed } from "./formatDuration";

describe("formatDuration", () => {
  test("coarse style keeps boundary outputs byte-identical", () => {
    const cases: Array<[number, string]> = [
      [Number.NaN, "—"],
      [Infinity, "—"],
      [-Infinity, "—"],
      [-42.6, "-43ms"],
      [0, "0ms"],
      [427.3, "427ms"],
      [999.4, "999ms"],
      [999.5, "1000ms"],
      [1000, "1s"],
      [9_999, "10s"],
      [10_000, "10s"],
      [59_999, "60s"],
      [60_000, "1m"],
      [3_599_999, "60m"],
      [3_600_000, "1h"],
    ];

    for (const [ms, expected] of cases) {
      expect(formatDuration(ms, "coarse")).toBe(expected);
    }
  });

  test("precise style keeps boundary outputs byte-identical", () => {
    const cases: Array<[number, string]> = [
      [Number.NaN, "—"],
      [Infinity, "—"],
      [-Infinity, "—"],
      [-42.6, "-43ms"],
      [0, "0ms"],
      [427.3, "427ms"],
      [999.4, "999ms"],
      [999.5, "1000ms"],
      [1000, "1.0s"],
      [9_999, "10.0s"],
      [10_000, "10s"],
      [59_999, "60s"],
      [60_000, "1m 0s"],
      [119_500, "1m 60s"],
      [3_600_000, "60m 0s"],
    ];

    for (const [ms, expected] of cases) {
      expect(formatDuration(ms, "precise")).toBe(expected);
    }
  });

  test("decimal style keeps boundary outputs byte-identical", () => {
    const cases: Array<[number, string]> = [
      [Number.NaN, "—"],
      [Infinity, "—"],
      [-Infinity, "—"],
      [-42.6, "-42.6ms"],
      [0, "0ms"],
      [427.3, "427.3ms"],
      [999.4, "999.4ms"],
      [999.5, "999.5ms"],
      [1000, "1.0s"],
      [9_999, "10.0s"],
      [10_000, "10.0s"],
      [59_999, "60.0s"],
      [60_000, "1.0m"],
      [3_600_000, "60.0m"],
    ];

    for (const [ms, expected] of cases) {
      expect(formatDuration(ms, "decimal")).toBe(expected);
    }
  });

  test("defaults to coarse style", () => {
    const inputs = [Number.NaN, Infinity, -42.6, 0, 427.3, 999.5, 1000, 60_000, 3_600_000];

    for (const ms of inputs) {
      expect(formatDuration(ms)).toBe(formatDuration(ms, "coarse"));
    }
  });
});

describe("formatElapsed", () => {
  test("ticks through seconds, minutes and hours with the smaller unit padded", () => {
    const cases: Array<[number, string]> = [
      // A start time slightly ahead of this clock reads as just started.
      [-1500, "0s"],
      [999, "0s"],
      [59_999, "59s"],
      [60_000, "1m 00s"],
      [724_000, "12m 04s"],
      [3_599_999, "59m 59s"],
      [3_600_000, "1h 00m"],
      [3_720_000, "1h 02m"],
    ];

    for (const [ms, expected] of cases) {
      expect(formatElapsed(ms)).toBe(expected);
    }
  });
});
