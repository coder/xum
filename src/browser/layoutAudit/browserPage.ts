// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.
import { LAYOUT_AUDIT_THRESHOLDS as THRESHOLDS } from "@/common/constants/artifactLayoutAudit";
import type { Box, LayoutPage, PageMetrics, SettleSignals } from "./layoutPage";

/**
 * The only code that touches a window. Each function is one or two DOM calls, so the logic in
 * audit.ts and settle.ts runs unchanged under bun test against fixtures. The window is passed in
 * (not read from `globalThis`) so a test hands over a happy-dom window.
 */
export type BrowserWindow = Window & typeof globalThis;

/** The timer calls the quiet waits make: those of the window under audit. */
export type QuietClock = Pick<Window, "setTimeout" | "clearTimeout">;

const noop = () => undefined;

function readMetrics(win: BrowserWindow): PageMetrics {
  const root = win.document.documentElement;
  return {
    viewportWidth: win.innerWidth || root.clientWidth || 0,
    viewportHeight: win.innerHeight || 0,
    scrollY: win.scrollY || 0,
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
  };
}

// innerText is the rendered text (it skips what is not shown); SVG elements have none.
function readRenderedText(win: BrowserWindow, el: Element): string {
  const rendered = el instanceof win.HTMLElement ? el.innerText : "";
  return rendered || el.textContent || "";
}

function readTextLines(win: BrowserWindow, node: Text): Box[] {
  const range = win.document.createRange();
  range.selectNodeContents(node);
  return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
}

// An effect's target is the element; a pseudo-element animation may name it through `.element`.
function animationTarget(win: BrowserWindow, animation: Animation): Element | null {
  const effect = animation.effect;
  const target: unknown = effect !== null && "target" in effect ? effect.target : null;
  if (target instanceof win.Element) return target;
  const owner =
    typeof target === "object" && target !== null && "element" in target ? target.element : null;
  return owner instanceof win.Element ? owner : null;
}

// Upstream also matched playState "pending", which browsers no longer report: in Chromium 153 an
// animation still waiting to start reads "running" (with `pending` true) and one waiting to pause
// reads "paused", so "running" covers every case upstream's "pending" once did.
function runningAnimations(win: BrowserWindow): Animation[] {
  if (typeof win.document.getAnimations !== "function") return [];
  return win.document.getAnimations().filter((animation) => animation.playState === "running");
}

function readAnimatedElements(win: BrowserWindow): Element[] {
  const targets = runningAnimations(win).map((animation) => animationTarget(win, animation));
  return targets.filter((target) => target !== null);
}

// "instant" overrides a page's `scroll-behavior: smooth`, which would leave the scroll position
// unmoved when it is read back. The position reached is the real one: the end of the page limits it.
function scrollInstantly(win: BrowserWindow, top: number): number {
  win.scrollTo({ top, behavior: "instant" });
  return win.scrollY || 0;
}

// The same for a scrolling box: "instant" beats the box's own `scroll-behavior: smooth`.
function scrollElementInstantly(el: Element, top: number): number {
  el.scrollTo({ top, behavior: "instant" });
  return el.scrollTop;
}

export function createBrowserLayoutPage(win: BrowserWindow): LayoutPage {
  return {
    document: win.document,
    metrics: () => readMetrics(win),
    box: (el) => el.getBoundingClientRect(),
    style: (el) => win.getComputedStyle(el),
    renderedText: (el) => readRenderedText(win, el),
    textLines: (node) => readTextLines(win, node),
    elementAt: (x, y) => win.document.elementFromPoint(x, y),
    scrollTo: (top) => scrollInstantly(win, top),
    scrollTopOf: (el) => el.scrollTop,
    scrollElementTo: scrollElementInstantly,
    animatedElements: () => readAnimatedElements(win),
    escapeIdent: (value) => win.CSS.escape(value),
  };
}

/**
 * Resolves true after `quietMs` without a change, false when `maxMs` runs out first. `observe`
 * starts watching, calls `onChange` on each change and returns the stop function. One copy for
 * the resize wait and the DOM wait (upstream wrote it twice).
 */
export function observeUntilQuiet(
  clock: QuietClock,
  observe: (onChange: () => void) => () => void,
  quietMs: number,
  maxMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timers: { quiet?: number; max?: number } = {};
    let stop: () => void = noop;
    let done = false;
    const finish = (quiet: boolean) => {
      if (done) return;
      done = true;
      clock.clearTimeout(timers.quiet);
      clock.clearTimeout(timers.max);
      stop();
      resolve(quiet);
    };
    const restartQuietTimer = () => {
      clock.clearTimeout(timers.quiet);
      timers.quiet = clock.setTimeout(() => finish(true), quietMs);
    };
    stop = observe(restartQuietTimer);
    restartQuietTimer();
    timers.max = clock.setTimeout(() => finish(false), maxMs);
  });
}

// Upstream watches <html>, <body> and the first 800 elements. Observing fires once at the start,
// which restarts the quiet timer: the page counts as quiet only after the first layout is read.
function observeResizes(win: BrowserWindow, onChange: () => void): () => void {
  if (typeof win.ResizeObserver === "undefined") return noop;
  const observer = new win.ResizeObserver(onChange);
  const doc = win.document;
  const watched = [doc.documentElement, doc.body, ...doc.body.querySelectorAll("*")];
  for (const el of watched.slice(0, THRESHOLDS.maxAuditedElements)) observer.observe(el);
  return () => observer.disconnect();
}

function observeMutations(win: BrowserWindow, onChange: () => void): () => void {
  const observer = new win.MutationObserver(onChange);
  observer.observe(win.document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

// A failed font load must not stall the audit: ready is awaited for its timing, not its outcome.
// A page whose browser has no font set has nothing to wait for.
function waitForFonts(win: BrowserWindow): Promise<void> {
  return Promise.resolve(win.document.fonts?.ready).then(noop, noop);
}

function waitForFrames(win: BrowserWindow, count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (remaining: number) => {
      if (remaining <= 0) resolve();
      else win.requestAnimationFrame(() => step(remaining - 1));
    };
    step(count);
  });
}

// An infinite animation has no end time: it never holds the audit back (the rules skip the
// elements it moves instead).
function isFiniteAnimation(animation: Animation): boolean {
  return Number.isFinite(Number(animation.effect?.getComputedTiming().endTime));
}

async function waitForFiniteAnimations(win: BrowserWindow, maxMs: number): Promise<boolean> {
  const finite = runningAnimations(win).filter(isFiniteAnimation);
  if (finite.length === 0) return true;
  let settled = false;
  const finished = Promise.all(finite.map((animation) => animation.finished.catch(noop)));
  await Promise.race([
    finished.then(() => {
      settled = true;
    }),
    new Promise<void>((resolve) => win.setTimeout(resolve, maxMs)),
  ]);
  return settled;
}

export function createBrowserSettleSignals(win: BrowserWindow): SettleSignals {
  return {
    fontsReady: () => waitForFonts(win),
    layoutQuiet: (quietMs, maxMs) =>
      observeUntilQuiet(win, (onChange) => observeResizes(win, onChange), quietMs, maxMs),
    domQuiet: (quietMs, maxMs) =>
      observeUntilQuiet(win, (onChange) => observeMutations(win, onChange), quietMs, maxMs),
    finiteAnimationsSettled: (maxMs) => waitForFiniteAnimations(win, maxMs),
    frames: (count) => waitForFrames(win, count),
    sleep: (ms) => new Promise<void>((resolve) => win.setTimeout(resolve, ms)),
    documentComplete: () => win.document.readyState === "complete",
  };
}
