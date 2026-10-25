import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { Ghostty } from "ghostty-web";
import { writeScreenState } from "./TerminalView";

// From the file: the test DOM's URL rejects the long data: URL that Ghostty.load() uses by default.
const WASM_PATH = join(dirname(Bun.resolveSync("ghostty-web", import.meta.dir)), "ghostty-vt.wasm");

/** Every non-empty line of a real ghostty VT, scrollback first. */
function visibleLines(term: ReturnType<Ghostty["createTerminal"]>, rows: number): string[] {
  const text = (cells: Array<{ codepoint: number }> | null) =>
    (cells ?? [])
      .map((cell) => String.fromCodePoint(cell.codepoint || 32))
      .join("")
      .trimEnd();
  const lines: string[] = [];
  for (let i = 0; i < term.getScrollbackLength(); i++) lines.push(text(term.getScrollbackLine(i)));
  for (let row = 0; row < rows; row++) lines.push(text(term.getLine(row)));
  return lines.filter((line) => line.length > 0);
}

// Runs on the real VT (WASM), so a ghostty-web change to how RIS treats the scrollback fails here.
describe("writeScreenState on the ghostty VT", () => {
  test("a replacing screen leaves no line of the old screen or scrollback behind", async () => {
    const ghostty = await Ghostty.load(WASM_PATH);
    const term = ghostty.createTerminal(80, 24);
    try {
      let before = "";
      for (let i = 1; i <= 60; i++) before += `line-${i}\r\n`;
      term.write(before);

      // The server's screen state after a reconnect: its own copy of the same scrollback.
      writeScreenState({ write: (data) => term.write(data) }, before + "after-reconnect\r\n", true);

      const lines = visibleLines(term, 24);
      expect(lines.filter((line) => line === "line-1")).toHaveLength(1);
      expect(lines.filter((line) => line === "line-60")).toHaveLength(1);
      expect(lines.at(-1)).toBe("after-reconnect");
    } finally {
      term.free();
    }
  });

  test("a first screen is written as is", async () => {
    const ghostty = await Ghostty.load(WASM_PATH);
    const term = ghostty.createTerminal(80, 24);
    try {
      term.write("kept\r\n");
      writeScreenState({ write: (data) => term.write(data) }, "first\r\n", false);
      expect(visibleLines(term, 24)).toEqual(["kept", "first"]);
    } finally {
      term.free();
    }
  });
});
