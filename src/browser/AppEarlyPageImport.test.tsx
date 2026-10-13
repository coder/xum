import "../../tests/ui/dom";

import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../../tests/ui/dom";
// Type only: a value import would evaluate App before the mock below.
import type * as AppModule from "@/browser/App";

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

// #6255: the desktop app often starts off a workspace route, so its first workspace click waited for
// the page chunk. Desktop starts it once the shell is up and the renderer is idle. The browser does
// not: there it would add page-code evaluation to the first-run page's Lighthouse window.
// The test above already loaded the (mocked) page module, so a spy, not `loads`, sees these imports.
test("desktop starts the workspace page's chunk once the shell is up and idle, the browser never", () => {
  const idle: IdleRequestCallback[] = [];
  globalThis.requestIdleCallback = (callback) => idle.push(callback);
  const flushIdle = () => {
    for (const callback of idle.splice(0)) callback({ didTimeout: false, timeRemaining: () => 50 });
  };
  const setUrl = (url: string) =>
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);
  try {
    setUrl("http://localhost/");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const browser = require("@/browser/App?prefetch=browser") as typeof AppModule;
    const browserLoad = spyOn(browser, "loadAIView");
    browser.appShellRef(document.createElement("div"));
    flushIdle();
    expect(browserLoad).not.toHaveBeenCalled();

    setUrl("file:///opt/xum/index.html"); // no persisted route: a start off a workspace route
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const desktop = require("@/browser/App?prefetch=desktop") as typeof AppModule;
    const desktopLoad = spyOn(desktop, "loadAIView");
    desktop.appShellRef(document.createElement("div"));
    expect(desktopLoad).not.toHaveBeenCalled(); // not before the renderer is idle
    flushIdle();
    expect(desktopLoad).toHaveBeenCalledTimes(1);
  } finally {
    setUrl("http://localhost/");
    // happy-dom has no requestIdleCallback: remove the stub for later suites.
    Reflect.deleteProperty(globalThis, "requestIdleCallback");
  }
});
