import { afterEach, describe, expect, test } from "bun:test";
import { formatKeyLabel } from "./Keycap";

// isMac() reads the stub's window.api.platform. Restore the real window: Bun shares globals
// across the test files in a process.
const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.window = originalWindow;
});

function onPlatform(platform: string) {
  globalThis.window = { api: { platform } } as unknown as Window & typeof globalThis;
}

const labels = (keys: string[]) => keys.map((key) => formatKeyLabel(key));

describe("formatKeyLabel", () => {
  test("names modifiers the way each platform's keyboard does", () => {
    onPlatform("darwin");
    expect(labels(["Ctrl", "Cmd", "Alt"])).toEqual(["⌘", "⌘", "⌥"]);
    onPlatform("linux");
    expect(labels(["Ctrl", "Cmd", "Alt"])).toEqual(["Ctrl", "Ctrl", "Alt"]);
  });

  test("draws named keys as glyphs and uppercases single letters only", () => {
    onPlatform("linux");
    expect(labels(["ArrowUp", "Backspace", "Escape", "j", "Tab"])).toEqual([
      "↑",
      "⌫",
      "Esc",
      "J",
      "Tab",
    ]);
  });
});
