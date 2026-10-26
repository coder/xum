import { describe, expect, mock, spyOn, test } from "bun:test";
import * as ActualComlink from "comlink";
import * as ActualHighlights from "@pierre/highlights";
import { restoreModulesAfterSuite } from "../../../tests/ui/moduleMocks";
import { canHighlight, highlightToShikiHtml } from "../utils/highlighting/highlightsEngine";
import { SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "../utils/highlighting/shiki-shared";
import type { HighlightWorkerAPI } from "./highlightWorker";

// Snapshot the real exports before the mocks below replace the live namespace bindings.
const actualComlink = { ...ActualComlink };
const actualHighlights = { ...ActualHighlights };
restoreModulesAfterSuite([
  ["comlink", actualComlink],
  ["@pierre/highlights", actualHighlights],
]);

// The worker hands its API to Comlink.expose when it loads: keep it to call it directly.
let api: HighlightWorkerAPI | null = null;
void mock.module("comlink", () => ({
  ...actualComlink,
  expose: (exposed: HighlightWorkerAPI) => {
    api = exposed;
  },
}));

let highlightsThrows = false;
void mock.module("@pierre/highlights", () => ({
  ...actualHighlights,
  codeToTokens: (...args: Parameters<typeof ActualHighlights.codeToTokens>) => {
    if (highlightsThrows) throw new Error("lexer failed");
    return actualHighlights.codeToTokens(...args);
  },
}));

// Loaded after the mocks so that its Comlink.expose call reaches the stub above. No other module
// loads the worker (the client imports its type only), so this is the first load.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./highlightWorker");

function worker(): HighlightWorkerAPI {
  if (api === null) throw new Error("the worker did not call Comlink.expose");
  return api;
}

/** Shiki's codeToHtml names the theme on <pre>; the Highlights engine writes a bare class. */
const shikiPre = (theme: string) => `<pre class="shiki ${theme}"`;

describe("highlightWorker", () => {
  test("a language Highlights knows uses Highlights; any other uses Shiki", async () => {
    const code = "const x = 1;";
    expect(canHighlight("typescript")).toBe(true);
    await worker().prepare("typescript");
    expect(await worker().highlight(code, "typescript", "dark")).toBe(
      highlightToShikiHtml(code, "typescript", "dark")
    );
    expect(canHighlight("ini")).toBe(false);
    await worker().prepare("ini");
    expect(await worker().highlight("[a]\nb = 1", "ini", "light")).toStartWith(
      shikiPre(SHIKI_LIGHT_THEME)
    );
  });

  test("when Highlights throws, Shiki highlights the call and the worker warns once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    highlightsThrows = true;
    try {
      for (const code of ["const a = 1;", "const b = 2;"]) {
        expect(await worker().highlight(code, "typescript", "dark")).toStartWith(
          shikiPre(SHIKI_DARK_THEME)
        );
      }
      expect(warn).toHaveBeenCalledTimes(1);
      // A language with no Shiki grammar keeps the Highlights error.
      expect(canHighlight("c3")).toBe(true);
      const failure = await worker()
        .highlight("fn void main() {}", "c3", "dark")
        .catch((error: unknown) => error);
      expect(failure).toEqual(new Error("lexer failed"));
    } finally {
      highlightsThrows = false;
      warn.mockRestore();
    }
  });
});
