import { describe, expect, test } from "bun:test";

import { summarizeComputerAction } from "./ComputerToolCall";

describe("summarizeComputerAction", () => {
  test("counts typed characters by code point, not UTF-16 units", () => {
    expect(summarizeComputerAction({ action: "type", text: "hi 👋" })).toMatch(/\b4\b/);
  });

  test("names both drag endpoints in order", () => {
    const summary = summarizeComputerAction({
      action: "left_click_drag",
      startX: 10,
      startY: 20,
      x: 30,
      y: 40,
    });
    expect(summary.indexOf("(10, 20)")).toBeGreaterThanOrEqual(0);
    expect(summary.indexOf("(10, 20)")).toBeLessThan(summary.indexOf("(30, 40)"));
  });

  test("distinguishes click buttons at the same point", () => {
    const clicks = (["left_click", "right_click", "middle_click", "double_click"] as const).map(
      (action) => summarizeComputerAction({ action, x: 5, y: 6 })
    );
    expect(new Set(clicks).size).toBe(4);
    for (const summary of clicks) expect(summary).toContain("(5, 6)");
  });
});
