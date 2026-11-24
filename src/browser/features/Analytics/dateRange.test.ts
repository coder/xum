import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
import { computeDateRange } from "./dateRange";

describe("computeDateRange month-utc", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("starts at 00:00 UTC on the 1st of the current UTC month", () => {
    setSystemTime(new Date("2026-10-14T18:08:00.000Z"));

    const range = computeDateRange("month-utc", "UTC");

    expect(range.from?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(range.to).toBeNull();
    expect(range.granularity).toBe("day");
  });

  test("follows the UTC month when the display zone is still in the previous month", () => {
    // 2026-10-31 23:30 in Los Angeles is already November in UTC.
    setSystemTime(new Date("2026-11-01T06:30:00.000Z"));

    expect(computeDateRange("month-utc", "America/Los_Angeles").from?.toISOString()).toBe(
      "2026-11-01T00:00:00.000Z"
    );
  });

  test("follows the UTC month when the display zone is already in the next month", () => {
    // 2026-11-01 01:00 in Tokyo is still October in UTC.
    setSystemTime(new Date("2026-10-31T16:00:00.000Z"));

    expect(computeDateRange("month-utc", "Asia/Tokyo").from?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z"
    );
  });

  test("bounds UTC dates in a local display zone, where rolling ranges bound local dates", () => {
    expect(computeDateRange("month-utc", "America/Los_Angeles").filterTimeZone).toBe("UTC");
    expect(computeDateRange("30d", "America/Los_Angeles").filterTimeZone).toBe(
      "America/Los_Angeles"
    );
  });
});
