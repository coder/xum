import { describe, expect, test } from "bun:test";

import { parseKeyCombo } from "./keys";

describe("parseKeyCombo", () => {
  test.each([
    ["cmd+shift+4", { key: "4", modifiers: ["command", "shift"] }],
    ["Return", { key: "enter", modifiers: [] }],
    ["ctrl+c", { key: "c", modifiers: ["control"] }],
    ["Page_Down", { key: "pagedown", modifiers: [] }],
    ["F5", { key: "f5", modifiers: [] }],
    ["Option+ESC", { key: "escape", modifiers: ["alt"] }],
    ["super+space", { key: "space", modifiers: ["command"] }],
    ["ctrl++", { key: "+", modifiers: ["control"] }],
    ["A", { key: "a", modifiers: [] }],
  ])("%s", (combo, expected) => {
    expect(parseKeyCombo(combo)).toEqual(expected as ReturnType<typeof parseKeyCombo>);
  });

  test.each(["cmd+Enterr", "hyper+a", "", "cmd+"])("rejects %p", (combo) => {
    expect(() => parseKeyCombo(combo)).toThrow(/Accepted keys/);
  });
});
