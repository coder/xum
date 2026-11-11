import { describe, expect, test } from "bun:test";
import { filterListItems, splitFilterMatch, stepFilterListIndex } from "./filterListItems";

const items = [
  { value: "a", label: "coder", detail: "/src/coder" },
  { value: "b", label: "Signal-iOS", detail: "/src/signal" },
  { value: "c", label: "mux" },
];

describe("filterListItems", () => {
  test("a blank query keeps every item", () => {
    expect(filterListItems(items, "  ").map((item) => item.value)).toEqual(["a", "b", "c"]);
  });

  test("matches the label or the detail, ignoring case", () => {
    expect(filterListItems(items, "SIGNAL").map((item) => item.value)).toEqual(["b"]);
    expect(filterListItems(items, "/src/c").map((item) => item.value)).toEqual(["a"]);
    expect(filterListItems(items, "zzz")).toEqual([]);
  });
});

describe("splitFilterMatch", () => {
  test("keeps the text's own casing around the first match", () => {
    expect(splitFilterMatch("fix/Fetch-timeout", "fe")).toEqual({
      before: "fix/",
      match: "Fe",
      after: "tch-timeout",
    });
  });

  test("returns the whole text when nothing matches or the query is blank", () => {
    expect(splitFilterMatch("main", "x")).toEqual({ before: "main", match: "", after: "" });
    expect(splitFilterMatch("main", "")).toEqual({ before: "main", match: "", after: "" });
  });
});

describe("stepFilterListIndex", () => {
  test("wraps at both ends", () => {
    expect(stepFilterListIndex(2, 1, 3)).toBe(0);
    expect(stepFilterListIndex(0, -1, 3)).toBe(2);
  });

  test("enters from the matching end when no row is active", () => {
    expect(stepFilterListIndex(-1, 1, 3)).toBe(0);
    expect(stepFilterListIndex(-1, -1, 3)).toBe(2);
  });

  test("has no active row in an empty list", () => {
    expect(stepFilterListIndex(0, 1, 0)).toBe(-1);
  });
});
