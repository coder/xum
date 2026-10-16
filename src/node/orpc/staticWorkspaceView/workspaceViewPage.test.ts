/**
 * The static workspace view's early script, run as the shipped string in happy-dom with fakes for
 * fetch, timers, frames, the width and the pointer, so every path is deterministic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { AUTH_TOKEN_KEY, LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import {
  WORKSPACE_VIEW_APP_STARTED_ATTR,
  WORKSPACE_VIEW_ID,
} from "@/common/constants/workspaceView";
import { FIRST_RUN_MODULES_ID } from "@/node/orpc/firstRunView";
import { WORKSPACE_VIEW_EARLY_SCRIPT } from "./workspaceViewPage";

let dom: GlobalWindow | undefined;
afterEach(async () => {
  await dom?.happyDOM.close();
  dom = undefined;
});

const ROW = (
  role: string,
  tree: unknown = ["div", { class: "markdown-content" }, ["div", {}, ["p", {}, "hi"]]]
) => ({ id: role, role, text: "hi", timestamp: 0, model: null, tree });
const TAIL = { title: "seed", project: "p", rows: [ROW("user"), ROW("assistant")] };

function run(
  o: { path?: string; width?: number; coarse?: boolean; hidden?: boolean; sidebar?: string } = {}
) {
  const window = new GlobalWindow({
    url: `http://127.0.0.1${o.path ?? "/workspace/ws1?token=t1"}`,
  });
  dom = window;
  const doc = window.document as unknown as Document;
  // The server injects the view only after a <base>, which the POST URL resolves against.
  doc.head.innerHTML = `<base href="../"><script type="application/json" id="${FIRST_RUN_MODULES_ID}">{"script":"./main-A.js","preload":["./api-B.js"]}</script>`;
  window.localStorage.setItem(AUTH_TOKEN_KEY, "saved");
  if (o.sidebar) window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, o.sidebar);
  Object.defineProperty(doc, "visibilityState", { get: () => (o.hidden ? "hidden" : "visible") });
  Object.defineProperty(doc, "readyState", { get: () => "complete" });
  let width = o.width ?? 412;
  const calls: Array<{
    url: string;
    init: RequestInit;
    settle: (status: number, body?: unknown) => void;
    fail: () => void;
  }> = [];
  const timers: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
  const frames: Array<() => void> = [];
  const resize: Array<() => void> = [];
  const scope = {
    document: doc,
    location: window.location,
    localStorage: window.localStorage,
    get innerWidth() {
      return width;
    },
    matchMedia: () => ({ matches: o.coarse ?? true }),
    addEventListener: (type: string, fn: () => void) => type === "resize" && resize.push(fn),
    fetch: (url: URL, init: RequestInit) =>
      new Promise((resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        const settle = (status: number, body?: unknown) =>
          resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
        calls.push({ url: String(url), init, settle, fail: () => reject(new Error("offline")) });
      }),
    setTimeout: (fn: () => void, ms: number) => timers.push({ ms, fn, cleared: false }) - 1,
    clearTimeout: (id: number) => timers[id] && (timers[id].cleared = true),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
  };
  // `with` gives the script live globals (innerWidth) as a page has them.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped script string itself
  const script = new Function("scope", `with (scope) { ${WORKSPACE_VIEW_EARLY_SCRIPT} }`);
  (script as (scope: object) => void)(scope);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    calls,
    timers,
    settled,
    view: () => doc.getElementById(WORKSPACE_VIEW_ID),
    apps: () => doc.querySelectorAll('script[type="module"]').length,
    flushFrames: () => frames.splice(0).forEach((fn) => fn()),
    resizeTo: (w: number) => ((width = w), resize.forEach((fn) => fn())),
    started: () => doc.documentElement.setAttribute(WORKSPACE_VIEW_APP_STARTED_ATTR, ""),
    answer: async (status: number, body?: unknown) => (calls[0].settle(status, body), settled()),
    script: () => doc.querySelector('script[type="module"]')!,
    preloads: () =>
      [...doc.querySelectorAll("link[rel=modulepreload]")].map((l) => l.getAttribute("href")),
  };
}

type Page = ReturnType<typeof run>;

describe("the workspace view's early script", () => {
  test("shows the view from the tail, then loads the app two frames later", async () => {
    const page = run();
    expect(page.calls.map((c) => [c.url, c.init.body])).toEqual([
      ["http://127.0.0.1/api/workspace/history/tail", '{"workspaceId":"ws1"}'],
    ]);
    expect((page.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer t1");
    // The app downloads while the tail is in flight; it runs only after the view paints.
    expect(page.preloads()).toEqual(["./api-B.js", "./main-A.js"]);
    expect(page.apps()).toBe(0);
    await page.answer(200, TAIL);
    expect(page.view()?.getAttribute("data-workspace-id")).toBe("ws1");
    expect(page.view()?.hasAttribute("inert")).toBe(true);
    expect(page.view()!.querySelectorAll("[data-transcript-message]")).toHaveLength(2);
    page.flushFrames();
    expect(page.apps()).toBe(0);
    page.flushFrames();
    expect(page.apps()).toBe(1);
    expect(page.timers.map((t) => [t.ms, t.cleared])).toEqual([
      [1600, true],
      [1000, true],
    ]);
  });

  test.each([
    ["a 401", (p: Page) => p.answer(401, TAIL)],
    ["a null tail", (p: Page) => p.answer(200, null)],
    ["a row without a tree", (p: Page) => p.answer(200, { ...TAIL, rows: [ROW("user", null)] })],
    ["an abort", (p: Page) => (p.timers[0].fn(), p.settled())],
    // Offline, the service worker serves the cached HTML and the POST fails. The fake fires no
    // timer by itself, so the app loads with no wait for the abort or the 1,000 ms timer.
    ["a failed request (offline)", (p: Page) => (p.calls[0].fail(), p.settled())],
    ["an answer after the app started", (p: Page) => (p.started(), p.answer(200, TAIL))],
  ])("shows no view and loads the app after %s", async (_name, arrange) => {
    const page = run();
    await arrange(page);
    expect(page.view() === null).toBe(true);
    expect(page.apps()).toBe(1);
  });

  test.each([
    // The service worker serves one cached HTML for every route and window, so the script decides
    // from location, the width and the pointer at run time, never from what the server saw.
    ["the app root", { path: "/" }],
    ["a non-workspace page", { path: "/project?path=x" }],
    ["a desktop window", { width: 1280, coarse: false }],
    ["a hidden tab", { hidden: true }],
    ["a narrow window", { width: 359 }],
    ["a wide window", { width: 481 }],
    ["a fine pointer", { coarse: false }],
    ["a saved expanded sidebar", { sidebar: "false" }],
  ])("makes no request and loads the app at once on %s", (_name, options) => {
    const page = run(options);
    expect([page.calls.length, page.apps()]).toEqual([0, 1]);
  });

  test("a slow tail loads the app at 1,000 ms, and still shows the view before the app starts", async () => {
    const page = run();
    page.timers[1].fn();
    expect(page.apps()).toBe(1);
    await page.answer(200, TAIL);
    expect(page.view() === null).toBe(false);
  });

  test("a resize out of the phone widths and a failed app module remove the view", async () => {
    for (const remove of [
      (p: Page) => p.resizeTo(600),
      (p: Page) => (
        p.flushFrames(),
        p.flushFrames(),
        p.script().dispatchEvent(new (dom!.Event as unknown as typeof Event)("error"))
      ),
    ]) {
      const page = run();
      await page.answer(200, TAIL);
      page.resizeTo(400); // still a phone width
      expect(page.view() === null).toBe(false);
      remove(page);
      expect(page.view() === null).toBe(true);
    }
  });
});
