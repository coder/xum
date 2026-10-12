import "../../tests/ui/dom";

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { installDom } from "../../tests/ui/dom";

// When the workspace page's module was requested, in order.
const loads: string[] = [];
void mock.module("@/browser/components/AIView/AIView", () => {
  loads.push(window.location.pathname);
  return { AIView: () => null };
});

let cleanupDom: (() => void) | null = null;
beforeAll(() => {
  cleanupDom = installDom();
});
afterAll(() => {
  // Bun shares mock.module state across test files: give later suites the real module back. Loaded
  // here, not at the top, because an eager import would run the mock factory before the test.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("@/browser/components/AIView/AIView?real=1") as Record<string, unknown>;
  void mock.module("@/browser/components/AIView/AIView", () => real);
  cleanupDom?.();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// T3 #5971: AppLoader renders App only after the workspace metadata loads, so the workspace page's
// chunk starts while App's module is evaluated, from the URL alone. `/` (first run) must not start it.
test("the workspace page's chunk starts on a workspace URL before App renders, and never on /", async () => {
  window.history.replaceState(null, "", "/");
  // A fresh copy of the module per URL (query string), evaluated as the entry would.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@/browser/App?earlyImport=root");
  await settle();
  expect(loads).toEqual([]);

  window.history.replaceState(null, "", "/workspace/abc123");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@/browser/App?earlyImport=workspace");
  await settle();
  expect(loads).toEqual(["/workspace/abc123"]);
});
