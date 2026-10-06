import { describe, expect, test } from "bun:test";
import {
  formatBucketLabel,
  formatBucketTooltipLabel,
  formatResultNumber,
  formatUsdAxisTick,
} from "./analyticsUtils";

describe("formatBucketLabel", () => {
  test("formats date-only bucket as short date", () => {
    expect(formatBucketLabel("2026-02-23")).toBe("Feb 23");
  });

  test("formats time-containing bucket with hour", () => {
    const result = formatBucketLabel("2026-02-23 14:00:00");
    expect(result).toContain("Feb");
    expect(result).toContain("23");
  });

  test("keeps the hour in a localized hourly bucket", () => {
    const result = formatBucketLabel("2026-02-23 14:00:00");
    expect(result).toMatch(/Feb 23, 2:00 PM/);
  });

  test("returns raw string for unparseable input", () => {
    expect(formatBucketLabel("not-a-date")).toBe("not-a-date");
  });
});

describe("formatBucketTooltipLabel", () => {
  test("renders week range for weekly buckets", () => {
    const result = formatBucketTooltipLabel("2026-02-23", "week");
    // Start of week → end of week (Mon–Sun): Feb 23 – Mar 1
    expect(result).toContain("Feb 23");
    expect(result).toContain("Mar 1");
    expect(result).toContain("–");
  });

  test("renders range spanning same month for weekly buckets", () => {
    const result = formatBucketTooltipLabel("2026-02-02", "week");
    expect(result).toContain("Feb 2");
    expect(result).toContain("Feb 8");
    expect(result).toContain("–");
  });

  test("falls back to single bucket label for daily granularity", () => {
    expect(formatBucketTooltipLabel("2026-02-23", "day")).toBe("Feb 23");
  });

  test("falls back to single bucket label for hourly granularity", () => {
    const result = formatBucketTooltipLabel("2026-02-23 14:00:00", "hour");
    expect(result).toContain("Feb");
    expect(result).toContain("23");
  });

  test("returns raw string for unparseable input in week mode", () => {
    expect(formatBucketTooltipLabel("not-a-date", "week")).toBe("not-a-date");
  });
});

// #5768: small spend axes repeated labels ("$0.01, $0.01, $0.00") because ticks rounded to cents.
describe("formatUsdAxisTick", () => {
  test("gives distinct labels to sub-cent ticks", () => {
    const ticks = [0, 0.0035, 0.007, 0.0105, 0.014];
    const labels = ticks.map(formatUsdAxisTick);
    expect(new Set(labels).size).toBe(ticks.length);
    expect(labels).toEqual(["$0.00", "$0.0035", "$0.007", "$0.0105", "$0.014"]);
  });

  test("keeps cents for amounts of a dollar or more", () => {
    expect(formatUsdAxisTick(1.5)).toBe("$1.50");
    expect(formatUsdAxisTick(1250)).toBe("$1,250.00");
  });
});

// #5768: SQL Explorer showed epoch-millisecond timestamps as "1.8T".
describe("formatResultNumber", () => {
  test("shows epoch-millisecond timestamp columns as a local date and time", () => {
    const epochMs = new Date(2026, 9, 6, 14, 5, 9).getTime();
    expect(formatResultNumber("timestamp", epochMs)).toBe("2026-10-06 14:05:09");
    expect(formatResultNumber("last_timestamp", epochMs)).toBe("2026-10-06 14:05:09");
    expect(formatResultNumber("created_at", epochMs)).toBe("2026-10-06 14:05:09");
  });

  test("leaves numbers that are not epoch milliseconds to the other formats", () => {
    // A timestamp-named column with a small value (a count or seconds) is not a date.
    expect(formatResultNumber("timestamp", 1500)).toBe("1.5K");
    expect(formatResultNumber("duration_ms", 1.8e12)).toBe("1.8T");
    expect(formatResultNumber("total_cost_usd", 0.5)).toBe("$0.50");
    expect(formatResultNumber("input_tokens", 1234567)).toBe("1,234,567");
  });
});
