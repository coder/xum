import { describe, expect, test } from "bun:test";
import { rankByPaletteQuery } from "@/browser/utils/commandPaletteRanking";

describe("rankByPaletteQuery", () => {
  const items = [
    { name: "Show Output", section: "Navigation" },
    { name: "Toggle Layout", section: "Appearance" },
    { name: "Output Panel Settings", section: "Settings" },
  ];

  const toSearchDoc = (item: { name: string }) => ({ primaryText: item.name });
  const tieBreak = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

  test("exact match outranks weaker matches", () => {
    const result = rankByPaletteQuery({ items, query: "output", toSearchDoc, tieBreak });

    expect(result.map((item) => item.name)).toEqual(["Show Output", "Output Panel Settings"]);
  });

  test("no-match items are filtered out", () => {
    const result = rankByPaletteQuery({ items, query: "zzz", toSearchDoc, tieBreak });

    expect(result).toHaveLength(0);
  });

  test("empty query preserves tie-break ordering", () => {
    const result = rankByPaletteQuery({ items, query: "", toSearchDoc, tieBreak });

    expect(result.map((item) => item.name)).toEqual([
      "Output Panel Settings",
      "Show Output",
      "Toggle Layout",
    ]);
  });

  test("empty query with whitespace preserves tie-break ordering", () => {
    const result = rankByPaletteQuery({ items, query: "  ", toSearchDoc, tieBreak });

    expect(result.map((item) => item.name)).toEqual([
      "Output Panel Settings",
      "Show Output",
      "Toggle Layout",
    ]);
  });

  test("stable tie behavior for prompt-select options", () => {
    const options = [
      { label: "Alpha Model", idx: 0 },
      { label: "Alpha Provider", idx: 1 },
      { label: "Beta Model", idx: 2 },
    ];

    const result = rankByPaletteQuery({
      items: options,
      query: "alpha",
      toSearchDoc: (option) => ({ primaryText: option.label }),
      tieBreak: (a, b) => a.idx - b.idx,
    });

    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("Alpha Model");
    expect(result[1].label).toBe("Alpha Provider");
  });

  test("multi-term AND semantics", () => {
    const result = rankByPaletteQuery({ items, query: "output panel", toSearchDoc, tieBreak });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Output Panel Settings");
  });

  test("exact primary label beats shorter item with weaker match", () => {
    const docs = [
      {
        name: "my-app",
        secondary: ["my-app", "my-project", "/home/user/projects/my-project/my-app"],
      },
      { name: "myapp", secondary: [] },
    ];

    const result = rankByPaletteQuery({
      items: docs,
      query: "my-app",
      toSearchDoc: (item) => ({ primaryText: item.name, secondaryText: item.secondary }),
      tieBreak: (a, b) => a.name.localeCompare(b.name),
    });

    expect(result[0]?.name).toBe("my-app");
  });

  test("metadata-only query still matches", () => {
    const docs = [
      { name: "Show Output", secondary: ["output", "panel", "navigation"] },
      { name: "Toggle Layout", secondary: ["layout"] },
    ];

    const result = rankByPaletteQuery({
      items: docs,
      query: "panel",
      toSearchDoc: (item) => ({ primaryText: item.name, secondaryText: item.secondary }),
      tieBreak: (a, b) => a.name.localeCompare(b.name),
    });

    expect(result.map((item) => item.name)).toEqual(["Show Output"]);
  });

  test("multi-term query matches across fields", () => {
    const docs = [
      { name: "Show Output", secondary: ["panel"] },
      { name: "Toggle Layout", secondary: ["workspace"] },
    ];

    const result = rankByPaletteQuery({
      items: docs,
      query: "show panel",
      toSearchDoc: (item) => ({ primaryText: item.name, secondaryText: item.secondary }),
      tieBreak: (a, b) => a.name.localeCompare(b.name),
    });

    expect(result.map((item) => item.name)).toEqual(["Show Output"]);
  });
});
