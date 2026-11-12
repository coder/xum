import { describe, expect, test } from "bun:test";
import {
  filterListItems,
  splitFilterMatch,
  stepFilterListIndex,
  windowFilterListItems,
} from "./filterListItems";

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

describe("windowFilterListItems", () => {
  const many = Array.from({ length: 5 }, (_, index) => ({
    value: `b${index}`,
    label: `b${index}`,
  }));

  test("keeps the selected item when it falls outside the window", () => {
    const rows = windowFilterListItems(many, "b4", 3);
    expect(rows.map((item) => item.value)).toEqual(["b4", "b0", "b1"]);
  });

  test("a selection pulled to the front leaves its group, so no caption lands above the lead rows", () => {
    const grouped = [
      { value: "main", label: "main" },
      { value: "recent", label: "recent", section: "Recent" },
      { value: "old-1", label: "old-1", section: "All branches" },
      { value: "old-2", label: "old-2", section: "All branches" },
    ];
    const rows = windowFilterListItems(grouped, "old-2", 3);
    expect(rows.map((item) => `${item.section ?? "-"}:${item.value}`)).toEqual([
      "-:old-2",
      "-:main",
      "Recent:recent",
    ]);
  });

  test("leaves the order alone when the selection is already in the window or absent", () => {
    expect(windowFilterListItems(many, "b1", 3).map((item) => item.value)).toEqual([
      "b0",
      "b1",
      "b2",
    ]);
    expect(windowFilterListItems(many, "missing", 3).map((item) => item.value)).toEqual([
      "b0",
      "b1",
      "b2",
    ]);
  });
});
