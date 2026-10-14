/**
 * The early script of the static first-run view (T3 #5971, C step 2, plan section 5.6, PR 4a),
 * run in happy-dom with a fake fetch, timers and frames, so every path is deterministic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import { AUTH_TOKEN_KEY, ONBOARDING_VIEWED_KEY } from "@/common/constants/storage";
import { FIRST_RUN_MODULES_ID } from "../../../scripts/perf/firstLoadJs";
import { FIRST_RUN_EARLY_SCRIPT, FIRST_RUN_TEMPLATE_ID, FIRST_RUN_VIEW_HTML } from "./firstRunView";

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
function run(o: { url?: string; viewed?: boolean; token?: string; hidden?: boolean } = {}) {
  dom = new GlobalWindow({
    url: o.url ?? "http://127.0.0.1/",
    settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
  });
  const doc = dom.document as unknown as Document;
  const list = { script: "./main-A.js", preload: ["./api-B.js"] };
  doc.head.innerHTML = `<script type="application/json" id="${FIRST_RUN_MODULES_ID}">${JSON.stringify(list)}</script>`;
  doc.body.innerHTML = `<div id="root"></div><template id="${FIRST_RUN_TEMPLATE_ID}">${FIRST_RUN_VIEW_HTML}</template>`;
  if (o.viewed) dom.localStorage.setItem(ONBOARDING_VIEWED_KEY, "true");
  if (o.token) dom.localStorage.setItem(AUTH_TOKEN_KEY, o.token);
  let visibility = o.hidden ? "hidden" : "visible";
  Object.defineProperty(doc, "visibilityState", { get: () => visibility, configurable: true });
  const calls: Call[] = [];
  const timers: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
  const frames: Array<() => void> = [];
  const fetchFake = (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      const settle = (status: number, body?: unknown) =>
        resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
      calls.push({
        url: String(url),
        headers: init.headers,
        settle,
        fail: () => reject(new Error("offline")),
      });
    });
  const names = ["document", "location", "localStorage", "fetch", "setTimeout", "clearTimeout"];
  const fakes = [
    doc,
    dom.location,
    dom.localStorage,
    fetchFake,
    (fn: () => void, ms: number) => timers.push({ ms, fn, cleared: false }) - 1,
    (id: number) => timers[id] && (timers[id].cleared = true),
  ];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped script string itself
  new Function(...names, "requestAnimationFrame", FIRST_RUN_EARLY_SCRIPT)(
    ...fakes,
    (fn: () => void) => frames.push(fn)
  );
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
    hide: () => ((visibility = "hidden"), doc.dispatchEvent(new dom!.Event("visibilitychange"))),
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
    expect(page.calls.map((c) => c.headers.Authorization)).toEqual(
      Array(2).fill("Bearer from-url")
    );
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

  // Catches a stored token that is not sent when the URL has none.
  test("sends the stored token when the URL has none", () => {
    const page = run({ token: "stored" });
    expect(page.calls[0].headers.Authorization).toBe("Bearer stored");
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
    expect(page.view()).toBeNull();
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
    expect(page.view()).toBeNull();
  });

  // Catches a missing visibilitychange listener: a hidden tab runs no frames, so the app never loads.
  test("loads the app at once when the tab turns hidden while the view waits for its frames", async () => {
    const page = run();
    await page.answer([], {});
    expect(page.view()).not.toBeNull();
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
    page.apps()[0].dispatchEvent(new dom!.Event("error"));
    expect(page.view()).toBeNull();
  });

  // Catches a script that runs on a slashless URL, which the redirect script navigates away from.
  test("does nothing on a slashless URL", () => {
    const page = run({ url: "http://127.0.0.1/xum" });
    expect([page.calls.length, page.timers.length, page.apps().length]).toEqual([0, 0, 0]);
  });
});

type Page = ReturnType<typeof run>;
