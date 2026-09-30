import { describe, expect, test } from "bun:test";
import {
  buildTimeFilterPredicate,
  substituteTimeFilter,
  TIME_FILTER_PLACEHOLDER,
} from "./sqlTimeFilter";

describe("buildTimeFilterPredicate", () => {
  test("returns a tautology when no boundaries are set (All time)", () => {
    expect(buildTimeFilterPredicate(null, null)).toBe("TRUE");
  });

  test("builds a from-only predicate", () => {
    expect(buildTimeFilterPredicate(new Date(Date.UTC(2026, 5, 5)), null)).toBe(
      "(date >= DATE '2026-06-05')"
    );
  });

  test("builds a bounded predicate when both boundaries are set", () => {
    expect(
      buildTimeFilterPredicate(new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 5, 11)))
    ).toBe("(date >= DATE '2026-06-01' AND date <= DATE '2026-06-11')");
  });

  test("throws on invalid date boundaries", () => {
    expect(() => buildTimeFilterPredicate(new Date(NaN), null)).toThrow();
  });
});

describe("substituteTimeFilter", () => {
  test("replaces every placeholder occurrence", () => {
    const sql = `SELECT * FROM events WHERE ${TIME_FILTER_PLACEHOLDER} AND model IS NOT NULL AND ${TIME_FILTER_PLACEHOLDER}`;
    expect(substituteTimeFilter(sql, "TRUE")).toBe(
      "SELECT * FROM events WHERE TRUE AND model IS NOT NULL AND TRUE"
    );
  });

  test("tolerates casing and inner whitespace", () => {
    expect(substituteTimeFilter("WHERE {{ TIME_FILTER }}", "TRUE")).toBe("WHERE TRUE");
  });

  test("leaves SQL without a placeholder untouched", () => {
    const sql = "SELECT model FROM events GROUP BY model";
    expect(substituteTimeFilter(sql, "TRUE")).toBe(sql);
  });

  test("rejects a blank predicate", () => {
    expect(() => substituteTimeFilter("SELECT 1", "   ")).toThrow();
  });
});
