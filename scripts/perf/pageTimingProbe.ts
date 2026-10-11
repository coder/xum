/**
 * The in-page probe of the page-timing runner (T3 #5971, plan section 2.3). It runs before any page script
 * and must stay self-contained: the runner serializes it into the page.
 */
import type { ProbeRecord, TARGET } from "./pageTimingCore";
import type { Signal } from "./pageTimingStats";

/** A static first view carries this id (plan section 4.3). Its copies count for UCS, never for UCS-live. */
export const STATIC_VIEW_ID = "xum-pre";

export interface ProbeArg {
  target: (typeof TARGET)[keyof typeof TARGET];
  mode: Signal;
  page: keyof typeof TARGET;
  staticViewId: string;
}

export function probe(arg: ProbeArg) {
  delete (Navigator.prototype as { serviceWorker?: unknown }).serviceWorker; // the auditor's method
  const rec: ProbeRecord = { elementTiming: [], visible: null, visibleLive: null, ir: null };
  Object.assign(window, { __pageTiming: rec });
  const live = (el: Element) => !el.closest(`#${arg.staticViewId}`);
  const targets = () =>
    [...document.querySelectorAll(arg.target.selector)].filter((el) =>
      el.textContent?.startsWith(arg.target.text)
    );
  // Element Timing needs the attribute before the first paint, so it is set as soon as the node exists.
  new MutationObserver(() => {
    for (const el of targets().filter((e) => !e.hasAttribute("elementtiming"))) {
      el.setAttribute("elementtiming", live(el) ? "live" : "static");
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Array<
      PerformanceEntry & { identifier: string; renderTime: number }
    >) {
      rec.elementTiming.push({ live: e.identifier === "live", renderTime: e.renderTime });
    }
  }).observe({ type: "element", buffered: true });
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    const onScreen =
      box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    if (box.width <= 0 || box.height <= 0 || !onScreen) return false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 1) {
        return false;
      }
    }
    return true;
  };
  const liveOne = <T extends HTMLElement>(sel: string) =>
    [...document.querySelectorAll<T>(sel)].find(live);
  // IR. P1: a click on the wizard's enabled Next reaches step 2. P2: typed text stays and Send is enabled.
  const act = (now: number) => {
    if (arg.page === "p1") {
      const dialog = liveOne("[role=dialog]");
      const next = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Next" && !b.disabled
      );
      if (dialog && next && dialog.dataset.timingClicked !== "1") {
        dialog.dataset.timingClicked = "1";
        next.click();
      }
      if (dialog?.querySelector('[role=img][aria-label^="Step 2 of"]')) rec.ir = now;
      return;
    }
    const box = liveOne<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (box && !box.disabled && box.value !== "hi") {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, "hi");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const send = liveOne<HTMLButtonElement>('button[aria-label="Send message"]');
    if (box?.value === "hi" && send && !send.disabled) rec.ir = now;
  };
  const frame = () => {
    const now = performance.now();
    const shown = targets().filter(visible);
    if (rec.visible === null && shown.length > 0) rec.visible = now;
    if (rec.visibleLive === null && shown.some(live)) rec.visibleLive = now;
    if (arg.mode === "ir") act(now);
    if (arg.mode === "ucs" ? rec.visibleLive === null : rec.ir === null)
      requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
