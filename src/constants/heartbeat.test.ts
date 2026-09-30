import { describe, expect, test } from "bun:test";

import {
  formatHeartbeatInterval,
  formatHeartbeatIntervalShort,
  resolveHeartbeatSchedulePolicy,
} from "./heartbeat";

describe("resolveHeartbeatSchedulePolicy", () => {
  test.each([null, undefined, {}])("falls back to idle/skip for %p", (settings) => {
    expect(resolveHeartbeatSchedulePolicy(settings)).toEqual({ trigger: "idle", whenBusy: "skip" });
  });

  test("falls back to defaults for null and invalid values", () => {
    expect(resolveHeartbeatSchedulePolicy({ trigger: null, whenBusy: null })).toEqual({
      trigger: "idle",
      whenBusy: "skip",
    });
    expect(resolveHeartbeatSchedulePolicy({ trigger: "hourly", whenBusy: "interrupt" })).toEqual({
      trigger: "idle",
      whenBusy: "skip",
    });
  });

  test("interval trigger defaults whenBusy to turn-end", () => {
    expect(resolveHeartbeatSchedulePolicy({ trigger: "interval" })).toEqual({
      trigger: "interval",
      whenBusy: "turn-end",
    });
    // Invalid whenBusy under interval trigger falls back to the interval default, not skip.
    expect(resolveHeartbeatSchedulePolicy({ trigger: "interval", whenBusy: "bogus" })).toEqual({
      trigger: "interval",
      whenBusy: "turn-end",
    });
  });

  test("explicit values win over conditional defaults", () => {
    expect(resolveHeartbeatSchedulePolicy({ trigger: "interval", whenBusy: "skip" })).toEqual({
      trigger: "interval",
      whenBusy: "skip",
    });
    expect(resolveHeartbeatSchedulePolicy({ trigger: "idle", whenBusy: "tool-end" })).toEqual({
      trigger: "idle",
      whenBusy: "tool-end",
    });
    expect(resolveHeartbeatSchedulePolicy({ whenBusy: "turn-end" })).toEqual({
      trigger: "idle",
      whenBusy: "turn-end",
    });
  });
});

describe("formatHeartbeatInterval", () => {
  test("renders whole hours and pluralizes minutes", () => {
    expect(formatHeartbeatInterval(60_000)).toBe("1 minute");
    expect(formatHeartbeatInterval(30 * 60_000)).toBe("30 minutes");
    expect(formatHeartbeatInterval(3_600_000)).toBe("1 hour");
    expect(formatHeartbeatInterval(2 * 3_600_000)).toBe("2 hours");
  });

  test("rounds in-range non-whole-minute intervals instead of emitting raw ms", () => {
    expect(formatHeartbeatInterval(5 * 60_000 + 1)).toBe("5 minutes");
    expect(formatHeartbeatIntervalShort(5 * 60_000 + 1)).toBe("5m");
  });
});

describe("formatHeartbeatIntervalShort", () => {
  test("uses the largest whole unit", () => {
    expect(formatHeartbeatIntervalShort(30 * 60_000)).toBe("30m");
    expect(formatHeartbeatIntervalShort(3_600_000)).toBe("1h");
    expect(formatHeartbeatIntervalShort(2 * 3_600_000)).toBe("2h");
  });
});
