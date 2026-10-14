/**
 * The early script of the static first-run view (T3 #5971, C step 2, plan section 5.6, PR 4a),
 * run in happy-dom with a fake fetch, timers and frames, so every path is deterministic.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import {
  AUTH_TOKEN_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  ONBOARDING_VIEWED_KEY,
} from "@/common/constants/storage";
import { VERSION } from "@/version";
import { FIRST_RUN_MODULES_ID } from "../../../scripts/perf/firstLoadJs";
import {
  FIRST_RUN_EARLY_SCRIPT,
  FIRST_RUN_TEMPLATE_ID,
  FIRST_RUN_VIEW_HTML,
  firstRunViewHtml,
} from "./firstRunView";

interface Call {
  url: string;
  headers: Record<string, string>;
  settle: (status: number, body?: unknown) => void;
  fail: () => void;
}

let dom: GlobalWindow | undefined;

afterEach(async () => {
  await dom?.happyDOM.close();
  dom = undefined;
});

/** Runs the script on a served "/" (the module list, then the template), with fakes for its inputs. */
function run(
  o: {
    sidebar?: string;
    url?: string;
    viewed?: boolean;
    token?: string;
    hidden?: boolean;
    list?: string;
    loading?: boolean;
  } = {}
) {
  const window = new GlobalWindow({
    url: o.url ?? "http://127.0.0.1/",
    settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
  });
  dom = window;
  const doc = window.document as unknown as Document;
  const list = { script: "./main-A.js", preload: ["./api-B.js"] };
  doc.head.innerHTML = `<script type="application/json" id="${FIRST_RUN_MODULES_ID}">${o.list ?? JSON.stringify(list)}</script>`;
  doc.body.innerHTML = `<div id="root"></div><template id="${FIRST_RUN_TEMPLATE_ID}">${FIRST_RUN_VIEW_HTML}</template>`;
  if (o.viewed) window.localStorage.setItem(ONBOARDING_VIEWED_KEY, "true");
  if (o.token) window.localStorage.setItem(AUTH_TOKEN_KEY, o.token);
  if (o.sidebar) window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, o.sidebar);
  let visibility = o.hidden ? "hidden" : "visible";
  let readyState = o.loading ? "loading" : "complete";
  Object.defineProperty(doc, "visibilityState", { get: () => visibility, configurable: true });
  Object.defineProperty(doc, "readyState", { get: () => readyState, configurable: true });
  const calls: Call[] = [];
  const timers: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
  const frames: Array<() => void> = [];
  const fetchFake = (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      const settle = (status: number, body?: unknown) =>
        resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
      const fail = () => reject(new Error("offline"));
      calls.push({ url: String(url), headers: init.headers, settle, fail });
    });
  const inputs = {
    document: doc,
    location: window.location,
    localStorage: window.localStorage,
    fetch: fetchFake,
    setTimeout: (fn: () => void, ms: number) => timers.push({ ms, fn, cleared: false }) - 1,
    clearTimeout: (id: number) => timers[id] && (timers[id].cleared = true),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped script string itself
  const script = new Function(...Object.keys(inputs), FIRST_RUN_EARLY_SCRIPT) as (
    ...a: unknown[]
  ) => void;
  script(...Object.values(inputs)); // element checks below compare to null: a failing element dumps MBs
  // happy-dom's Event, typed as the DOM's for the Document-typed nodes.
  const event = (type: string) => new (window.Event as unknown as typeof Event)(type);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    calls,
    timers,
    frames,
    settled,
    view: () => doc.getElementById(FIRST_RUN_VIEW_ID),
    apps: () => doc.querySelectorAll('script[type="module"]'),
    preloads: () =>
      [...doc.querySelectorAll("link[rel=modulepreload]")].map((l) => l.getAttribute("href")),
    event,
    hide: () => ((visibility = "hidden"), doc.dispatchEvent(event("visibilitychange"))),
    parsed: () => ((readyState = "interactive"), doc.dispatchEvent(event("DOMContentLoaded"))),
    flushFrames: () => frames.splice(0).forEach((fn) => fn()),
    /** Answers both POSTs: the viewed list, then the provider config. */
    answer: async (viewedIds: string[], config: Record<string, unknown>) => {
      calls[0].settle(200, viewedIds);
      calls[1].settle(200, config);
      await settled();
    },
  };
}

describe("the early script", () => {
  // Catches the app loading before the frame that paints the view (no or one requestAnimationFrame),
  // POSTs sent one after the other, a missing bearer token, and any safety timer besides the abort.
  test("shows the view, starts both POSTs together, and loads the app two frames later", async () => {
    const page = run({ url: "http://127.0.0.1/?token=from-url", token: "stored" });
    expect(page.calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1/api/splashScreens/getViewedSplashScreens",
      "http://127.0.0.1/api/providers/getConfig",
    ]);
    expect(page.calls.map((c) => c.headers.Authorization)).toEqual([
      "Bearer from-url",
      "Bearer from-url",
    ]);
    await page.answer([], { anthropic: { isConfigured: false } });
    expect(page.view()?.hasAttribute("inert")).toBe(true);
    expect(page.apps()).toHaveLength(0);
    page.flushFrames();
    expect(page.apps()).toHaveLength(0);
    page.flushFrames();
    expect([...page.apps()].map((s) => s.getAttribute("src"))).toEqual(["./main-A.js"]);
    expect(page.preloads()).toEqual(["./api-B.js"]);
    expect(page.timers.map((t) => [t.ms, t.cleared])).toEqual([[1000, true]]);
  });

  // Each row catches the removal of its own branch: the view would show, or the app never loads.
  test.each([
    ["the wizard was viewed", (p: Page) => p.answer(["onboarding-wizard-v1"], {})],
    ["a provider is configured", (p: Page) => p.answer([], { openai: { isConfigured: true } })],
    [
      "a gateway coupon is set",
      (p: Page) => p.answer([], { "mux-gateway": { couponCodeSet: true } }),
    ],
    ["a POST returns 401", (p: Page) => (p.calls[0].settle(401), p.settled())],
    ["a POST fails", (p: Page) => (p.calls[1].fail(), p.settled())],
    ["the POSTs take over 1,000 ms", (p: Page) => (p.timers[0].fn(), p.settled())],
  ])("shows no view and loads the app at once when %s", async (_name, arrange) => {
    const page = run();
    await arrange(page);
    expect(page.view() === null).toBe(true);
    expect(page.apps()).toHaveLength(1);
  });

  // Catches the paint-cache key or the hidden check running after the POSTs start.
  test.each([
    ["the paint-cache key is set", { viewed: true }],
    ["the tab is hidden", { hidden: true }],
  ])("makes no API call and loads the app at once when %s", (_name, options) => {
    const page = run(options);
    expect(page.calls).toHaveLength(0);
    expect(page.timers).toHaveLength(0);
    expect(page.apps()).toHaveLength(1);
    expect(page.view() === null).toBe(true);
  });

  // Catches a missing visibilitychange listener: a hidden tab runs no frames, so the app never loads.
  test("loads the app at once when the tab turns hidden while the view waits for its frames", async () => {
    const page = run();
    await page.answer([], {});
    expect(page.view() === null).toBe(false);
    page.hide();
    expect(page.apps()).toHaveLength(1);
    page.flushFrames();
    expect(page.apps()).toHaveLength(1); // loaded once
  });

  // Catches a module script without an error listener: a failed app load would leave the view up.
  test("removes the view when the app's module script fails to load", async () => {
    const page = run();
    await page.answer([], {});
    page.flushFrames();
    page.flushFrames();
    page.apps()[0].dispatchEvent(page.event("error"));
    expect(page.view() === null).toBe(true);
  });

  // Catches an insert that does not wait for the parser (in the <head>, the <template> comes later),
  // and an untrimmed URL token (a blank one must fall back to the stored token, as the app does).
  test("waits for DOMContentLoaded when the POSTs answer before the template is parsed", async () => {
    const page = run({ url: "http://127.0.0.1/?token=%20", token: "stored", loading: true });
    expect(page.calls[0].headers.Authorization).toBe("Bearer stored");
    const template = dom!.document.getElementById(FIRST_RUN_TEMPLATE_ID)!;
    template.remove();
    await page.answer([], {});
    expect([page.view() === null, page.apps().length]).toEqual([true, 0]);
    dom!.document.body.append(template);
    page.parsed();
    expect(page.view() === null).toBe(false);
  });

  // Catches a module script added while the HTML still parses: it can run before #root exists.
  test("adds the app's module script only once the HTML is parsed", () => {
    const page = run({ viewed: true, loading: true });
    expect([page.preloads().length, page.apps().length]).toEqual([1, 0]);
    page.parsed();
    expect(page.apps()).toHaveLength(1);
  });

  // Catches an unguarded module list: the throw would leave the view up with no app behind it.
  test("drops the view when the module list is unusable", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const page = run({ list: '{"script": 1}' });
    await page.answer([], {});
    page.flushFrames();
    page.flushFrames();
    expect([page.view() === null, page.apps().length, error.mock.calls.length]).toEqual([
      true,
      0,
      1,
    ]);
    error.mockRestore();
  });

  // Option A (owner decision 10-14): the view takes the app's saved sidebar choice, a JSON boolean.
  // Catches a missing copy, swapped states, and a copy of a value the app would not read (also an
  // object-key lookup, which finds "toString" on the prototype).
  test.each([
    ["true", "collapsed"],
    ["false", "expanded"],
    ["1", undefined],
    ["toString", undefined],
  ])("marks the view with a saved sidebar value of %s", async (saved, state) => {
    const page = run({ sidebar: saved });
    await page.answer([], {});
    expect(page.view()?.dataset.sidebar).toBe(state);
  });

  // Catches a script that runs on a slashless URL, which the redirect script navigates away from.
  test("does nothing on a slashless URL", () => {
    const page = run({ url: "http://127.0.0.1/xum" });
    expect([page.calls.length, page.timers.length, page.apps().length]).toEqual([0, 0, 0]);
  });
});

type Page = ReturnType<typeof run>;

// Catches a hard-coded version in the static title bar, and one inserted without HTML escaping.
test("the static title bar shows the build's version, escaped", () => {
  const version = (html: string) => {
    const window = new GlobalWindow();
    window.document.body.innerHTML = html;
    const text = window.document.querySelector("[data-pre-version]")?.textContent;
    void window.happyDOM.close();
    return text;
  };
  expect(version(FIRST_RUN_VIEW_HTML)).toBe(VERSION.git_describe);
  expect(version(firstRunViewHtml("v1 <b>&"))).toBe("v1 <b>&");
});
