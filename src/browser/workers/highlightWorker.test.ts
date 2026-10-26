import { describe, expect, mock, test } from "bun:test";
import * as ActualComlink from "comlink";
import { restoreModulesAfterSuite } from "../../../tests/ui/moduleMocks";
import { canHighlight, highlightToShikiHtml } from "../utils/highlighting/highlightsEngine";
import { SHIKI_LIGHT_THEME } from "../utils/highlighting/shiki-shared";
import type { HighlightWorkerAPI } from "./highlightWorker";

// Snapshot the real exports before the mocks below replace the live namespace bindings.
const actualComlink = { ...ActualComlink };
restoreModulesAfterSuite([["comlink", actualComlink]]);

// The worker hands its API to Comlink.expose when it loads: keep it to call it directly.
let api: HighlightWorkerAPI | null = null;
void mock.module("comlink", () => ({
  ...actualComlink,
  expose: (exposed: HighlightWorkerAPI) => {
    api = exposed;
  },
}));

// Loaded after the mock so that its Comlink.expose call reaches the stub above. No other module
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
});
