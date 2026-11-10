import { describe, expect, test } from "bun:test";
import {
  createBrowserLayoutPage,
  createBrowserSettleSignals,
  observeUntilQuiet,
  type BrowserWindow,
} from "./browserPage";
import { createFakeBrowserWindow } from "./fakeLayoutPage.testHarness";

const noop = () => undefined;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An `observe` hook whose changes the test fires by hand. */
function manualObserver() {
  const state = { onChange: noop, stops: 0 };
  const observe = (onChange: () => void) => {
    state.onChange = onChange;
    return () => {
      state.stops += 1;
    };
  };
  return { observe, state };
}

describe("observeUntilQuiet", () => {
  test("resolves true once nothing changed for the quiet time, and stops watching once", async () => {
    const { observe, state } = manualObserver();
    expect(await observeUntilQuiet(observe, 20, 2_000)).toBe(true);
    expect(state.stops).toBe(1);
  });

  test("each change restarts the quiet time", async () => {
    const { observe, state } = manualObserver();
    let changes = 0;
    const quiet = observeUntilQuiet(observe, 60, 2_000);
    // Four changes 15 ms apart: the first quiet timer (60 ms) would expire before the last.
    for (let i = 0; i < 4; i += 1) {
      await delay(15);
      changes += 1;
      state.onChange();
    }
    let changesWhenResolved = -1;
    await quiet.then(() => {
      changesWhenResolved = changes;
    });
    expect(changesWhenResolved).toBe(4);
    expect(await quiet).toBe(true);
  });

  test("resolves false when changes keep coming until the maximum wait", async () => {
    const { observe, state } = manualObserver();
    const ticker = setInterval(() => state.onChange(), 5);
    try {
      expect(await observeUntilQuiet(observe, 40, 120)).toBe(false);
    } finally {
      clearInterval(ticker);
    }
    expect(state.stops).toBe(1);
  });

  test("a change after the wait is over does not restart anything", async () => {
    const { observe, state } = manualObserver();
    await observeUntilQuiet(observe, 10, 1_000);
    // A late change starts a quiet timer that must not stop the watcher a second time. Waiting
    // out a longer quiet time of another watcher lets that timer fire first.
    state.onChange();
    await observeUntilQuiet(manualObserver().observe, 40, 1_000);
    expect(state.stops).toBe(1);
  });
});

describe("createBrowserLayoutPage", () => {
  test("reads the viewport and document sizes, falling back to the root's width", () => {
    using fake = createFakeBrowserWindow({ width: 390, height: 844 });
    const root = fake.win.document.documentElement;
    Object.defineProperty(root, "scrollWidth", { value: 642, configurable: true });
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(fake.win, "scrollY", { value: 120, configurable: true });
    expect(createBrowserLayoutPage(fake.win).metrics()).toEqual({
      viewportWidth: 390,
      viewportHeight: 844,
      scrollY: 120,
      scrollWidth: 642,
      scrollHeight: 2000,
    });
    Object.defineProperty(fake.win, "innerWidth", { value: 0, configurable: true });
    Object.defineProperty(root, "clientWidth", { value: 375, configurable: true });
    expect(createBrowserLayoutPage(fake.win).metrics().viewportWidth).toBe(375);
  });

  test("reads rendered text from innerText, and from textContent where an element has none", () => {
    using fake = createFakeBrowserWindow({ bodyHtml: '<p id="p">visible <i>words</i></p><svg><text id="t">label</text></svg>' });
    const page = createBrowserLayoutPage(fake.win);
    const paragraph = fake.win.document.getElementById("p") as Element;
    expect(page.renderedText(paragraph)).toBe("visible words");
    Object.defineProperty(paragraph, "innerText", { value: "", configurable: true });
    expect(page.renderedText(paragraph)).toBe("visible words");
    expect(page.renderedText(fake.win.document.getElementById("t") as Element)).toBe("label");
  });

  test("keeps only the line rectangles of a text node that have an area", () => {
    using fake = createFakeBrowserWindow({ bodyHtml: "<p>text</p>" });
    const rects = [
      { left: 0, top: 0, right: 40, bottom: 10, width: 40, height: 10 },
      { left: 0, top: 0, right: 0, bottom: 10, width: 0, height: 10 },
      { left: 0, top: 0, right: 40, bottom: 0, width: 40, height: 0 },
    ];
    Object.assign(fake.win.document, {
      createRange: () => ({ selectNodeContents: noop, getClientRects: () => rects }),
    });
    const text = fake.win.document.querySelector("p")?.firstChild as Text;
    expect(createBrowserLayoutPage(fake.win).textLines(text)).toEqual([rects[0]]);
  });

  test("names the targets of running animations, through a pseudo-element's owner too", () => {
    using fake = createFakeBrowserWindow({ bodyHtml: "<a id='a'></a><b id='b'></b><i id='c'></i>" });
    const get = (id: string) => fake.win.document.getElementById(id) as Element;
    const running = (target: unknown) => ({ playState: "running", effect: { target } });
    Object.assign(fake.win.document, {
      getAnimations: () => [
        running(get("a")),
        { playState: "paused", effect: { target: get("b") } },
        running({ element: get("c") }),
        { playState: "running", effect: null },
        running(null),
      ],
    });
    const animated = createBrowserLayoutPage(fake.win).animatedElements();
    expect(animated.map((el) => el.id)).toEqual(["a", "c"]);
  });

  test("has no animated elements when the browser cannot list animations", () => {
    using fake = createFakeBrowserWindow();
    Object.assign(fake.win.document, { getAnimations: undefined });
    expect(createBrowserLayoutPage(fake.win).animatedElements()).toEqual([]);
  });
});

function stubAnimations(win: BrowserWindow, animations: unknown[]) {
  Object.assign(win.document, { getAnimations: () => animations });
}

describe("createBrowserSettleSignals", () => {
  test("fonts: resolves with or without a font set, and when font loading fails", async () => {
    using fake = createFakeBrowserWindow();
    const signals = createBrowserSettleSignals(fake.win);
    Object.defineProperty(fake.win.document, "fonts", { value: undefined, configurable: true });
    await signals.fontsReady();
    Object.defineProperty(fake.win.document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
    await signals.fontsReady();
    Object.defineProperty(fake.win.document, "fonts", { value: { ready: Promise.reject(new Error("no font")) }, configurable: true });
    await signals.fontsReady();
  });

  test("frames: waits for as many animation frames as asked", async () => {
    using fake = createFakeBrowserWindow();
    let frames = 0;
    Object.assign(fake.win, {
      requestAnimationFrame: (callback: () => void) => {
        frames += 1;
        setTimeout(callback, 0);
        return frames;
      },
    });
    await createBrowserSettleSignals(fake.win).frames(2);
    expect(frames).toBe(2);
    await createBrowserSettleSignals(fake.win).frames(0);
    expect(frames).toBe(2);
  });

  test("documentComplete follows the document's readyState", () => {
    using fake = createFakeBrowserWindow();
    const signals = createBrowserSettleSignals(fake.win);
    Object.defineProperty(fake.win.document, "readyState", { value: "interactive", configurable: true });
    expect(signals.documentComplete()).toBe(false);
    Object.defineProperty(fake.win.document, "readyState", { value: "complete", configurable: true });
    expect(signals.documentComplete()).toBe(true);
  });

  test("sleep resolves after the time given", async () => {
    using fake = createFakeBrowserWindow();
    const started = performance.now();
    await createBrowserSettleSignals(fake.win).sleep(30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  describe("finiteAnimationsSettled", () => {
    const finite = (finished: Promise<unknown>) => ({
      playState: "running",
      effect: { getComputedTiming: () => ({ endTime: 500 }) },
      finished,
    });
    const infinite = {
      playState: "running",
      effect: { getComputedTiming: () => ({ endTime: Number.POSITIVE_INFINITY }) },
      finished: new Promise<never>(noop),
    };

    test("is settled at once when nothing finite is running, infinite loops included", async () => {
      using fake = createFakeBrowserWindow();
      stubAnimations(fake.win, [infinite]);
      expect(await createBrowserSettleSignals(fake.win).finiteAnimationsSettled(50)).toBe(true);
    });

    test("is settled when every finite animation finishes in time, even one that is cancelled", async () => {
      using fake = createFakeBrowserWindow();
      stubAnimations(fake.win, [finite(delay(10)), finite(Promise.reject(new Error("cancelled"))), infinite]);
      expect(await createBrowserSettleSignals(fake.win).finiteAnimationsSettled(1_000)).toBe(true);
    });

    test("is not settled when a finite animation outlasts the wait", async () => {
      using fake = createFakeBrowserWindow();
      stubAnimations(fake.win, [finite(new Promise<never>(noop))]);
      expect(await createBrowserSettleSignals(fake.win).finiteAnimationsSettled(30)).toBe(false);
    });
  });

  describe("layoutQuiet", () => {
    class FakeResizeObserver {
      static observed: Element[] = [];
      static disconnects = 0;
      constructor(readonly callback: () => void) {}
      observe(el: Element) {
        FakeResizeObserver.observed.push(el);
      }
      disconnect() {
        FakeResizeObserver.disconnects += 1;
      }
    }

    test("watches <html>, <body> and the first 798 elements, then lets go", async () => {
      using fake = createFakeBrowserWindow({ bodyHtml: "<i></i>".repeat(900) });
      FakeResizeObserver.observed = [];
      FakeResizeObserver.disconnects = 0;
      Object.assign(fake.win, { ResizeObserver: FakeResizeObserver });
      expect(await createBrowserSettleSignals(fake.win).layoutQuiet(10, 1_000)).toBe(true);
      const { documentElement, body } = fake.win.document;
      expect(FakeResizeObserver.observed).toHaveLength(800);
      expect(FakeResizeObserver.observed.slice(0, 2)).toEqual([documentElement, body]);
      expect(FakeResizeObserver.disconnects).toBe(1);
    });

    test("counts the page as quiet after the quiet time when the browser cannot observe resizes", async () => {
      using fake = createFakeBrowserWindow();
      Object.assign(fake.win, { ResizeObserver: undefined });
      expect(await createBrowserSettleSignals(fake.win).layoutQuiet(10, 1_000)).toBe(true);
    });
  });

  describe("domQuiet", () => {
    test("is quiet when the DOM stays unchanged", async () => {
      using fake = createFakeBrowserWindow({ bodyHtml: "<p>text</p>" });
      expect(await createBrowserSettleSignals(fake.win).domQuiet(30, 1_000)).toBe(true);
    });

    test("is not quiet while the DOM keeps changing until the maximum wait", async () => {
      using fake = createFakeBrowserWindow({ bodyHtml: "<p>text</p>" });
      const paragraph = fake.win.document.querySelector("p") as Element;
      let tick = 0;
      const ticker = setInterval(() => paragraph.setAttribute("data-tick", String((tick += 1))), 5);
      try {
        expect(await createBrowserSettleSignals(fake.win).domQuiet(60, 200)).toBe(false);
      } finally {
        clearInterval(ticker);
      }
    });
  });
});
