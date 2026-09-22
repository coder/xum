import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { KeyboardEvent, MouseEvent, MutableRefObject, UIEvent, WheelEvent } from "react";

import { installDom } from "../../../tests/ui/dom";
import { mockScrollMetrics as attachScrollMetrics } from "../../../tests/ui/scrollMetrics";
import { useAutoScroll } from "./useAutoScroll";

function createScrollEvent(element: HTMLDivElement): UIEvent<HTMLDivElement> {
  return { currentTarget: element } as unknown as UIEvent<HTMLDivElement>;
}

function createMouseEvent(
  element: HTMLDivElement,
  target: EventTarget = element,
  options: { buttons?: number } = {}
): MouseEvent<HTMLDivElement> {
  return {
    currentTarget: element,
    target,
    buttons: options.buttons ?? 0,
  } as unknown as MouseEvent<HTMLDivElement>;
}

function createWheelEvent(
  element: HTMLDivElement,
  options: { deltaX?: number; deltaY?: number } = {}
): WheelEvent<HTMLDivElement> {
  return {
    currentTarget: element,
    target: element,
    deltaX: options.deltaX ?? 0,
    deltaY: options.deltaY ?? 0,
  } as unknown as WheelEvent<HTMLDivElement>;
}

let resizeObserverCallback: ResizeObserverCallback | null = null;
const observedTargets: Element[] = [];

// Capture the hook's ResizeObserver so the safety-net pin can be driven directly.
// Bottom-stick no longer uses a requestAnimationFrame settle loop: native CSS
// scroll anchoring (not exercisable in happy-dom) holds the bottom, and this
// observer + handleScroll re-establish it on discrete layout/scroll signals.
class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe(target: Element): void {
    observedTargets.push(target);
  }
  disconnect(): void {
    resizeObserverCallback = null;
    observedTargets.length = 0;
  }
}

// Run the captured ResizeObserver callback (the layout-settled signal that
// re-establishes the bottom while locked).
function triggerResizeObserver(): void {
  resizeObserverCallback?.([], {} as ResizeObserver);
}

describe("useAutoScroll", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    resizeObserverCallback = null;
    observedTargets.length = 0;
    window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("layout growth under the lock re-pins to the bottom", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);

    // Content grows below the fold. Native anchoring holds the sentinel in a real
    // browser; here we drive the synchronous safety-net pin via the scroll signal
    // that growth produces.
    metrics.setScrollHeight(1500);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
  });

  test("the safety net observes the scrollport and each of its children", () => {
    // The in-flow composer dock sits BELOW the bottom sentinel, so native
    // anchoring cannot compensate when the dock grows (decorations mounting,
    // textarea growth). Observing every direct child of the scrollport is what
    // re-pins that growth before paint while locked.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const transcriptContent = document.createElement("div");
    const sentinel = document.createElement("div");
    const composerDock = document.createElement("div");
    element.append(transcriptContent, sentinel, composerDock);
    attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    // Toggle autoScroll after attaching the ref so the observer effect re-runs
    // (the effect bails when contentRef is null on mount).
    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.disableAutoScroll();
    });
    act(() => {
      result.current.jumpToBottom();
    });

    expect(observedTargets).toContain(element);
    expect(observedTargets).toContain(transcriptContent);
    expect(observedTargets).toContain(sentinel);
    expect(observedTargets).toContain(composerDock);
  });

  test("each layout growth re-pins to the bottom while locked", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    for (const next of [1100, 1180, 1240, 1300]) {
      metrics.setScrollHeight(next);
      act(() => {
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    }
  });

  test("user-owned scroll up disables the lock and survives later re-pins", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);
      // Toggle autoScroll after attaching the ref so the safety-net observer
      // attaches (the effect bails when contentRef is null on mount).
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.disableAutoScroll();
      });
      act(() => {
        result.current.jumpToBottom();
      });
      const stalePin = resizeObserverCallback;
      expect(stalePin).not.toBeNull();

      metrics.setScrollTop(600);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // The layout-driven safety-net pin must stay released-aware: a re-pin
      // firing after release is a no-op, so the user keeps their position.
      act(() => {
        stalePin?.([], {} as ResizeObserver);
      });
      expect(metrics.scrollTop).toBe(600);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("small wheel-up tick releases the lock on the first event without snap-back", () => {
    // Regression: a slow wheel-up gesture from the very bottom (~3-7 px per
    // notch) used to keep the lock engaged because the user-intent branch
    // treated "still ≤ USER_BOTTOM_RELOCK_THRESHOLD_PX from bottom" as
    // "relock". A re-pin would then write scrollTop = max, snapping the user
    // back to the bottom mid-gesture.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      // Toggle autoScroll after attaching the ref so the safety-net observer
      // attaches (the effect bails when contentRef is null on mount).
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.disableAutoScroll();
      });
      act(() => {
        result.current.jumpToBottom();
      });
      const stalePin = resizeObserverCallback;
      expect(stalePin).not.toBeNull();
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);

      // Single small wheel notch: scrollTop drops 5 px, well within the 8 px
      // relock threshold. Lock must release on the first event.
      metrics.setScrollTop(metrics.maxScrollTop - 5);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // A subsequent layout re-pin must not snap the user back to the bottom.
      act(() => {
        stalePin?.([], {} as ResizeObserver);
      });
      expect(metrics.scrollTop).toBe(595);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("continued slow wheel-up does not relock while still moving away from bottom", () => {
    // Even after the lock releases, geometry alone (≤ 8 px from bottom) must
    // not relock while the user is still scrolling upward in the same intent
    // window. Direction matters: the second tick lands at 6 px from bottom
    // but the user is moving away, so the lock must stay off.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      // Toggle autoScroll after attaching the ref so the safety-net observer
      // attaches (the effect bails when contentRef is null on mount).
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.disableAutoScroll();
      });
      act(() => {
        result.current.jumpToBottom();
      });
      const stalePin = resizeObserverCallback;
      expect(stalePin).not.toBeNull();

      // First tick: 3 px up. Releases the lock.
      metrics.setScrollTop(metrics.maxScrollTop - 3);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // Second tick: 3 px further up (still within 8 px of bottom, but moving
      // away). Lock must remain released.
      metrics.setScrollTop(metrics.maxScrollTop - 6);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      act(() => {
        stalePin?.([], {} as ResizeObserver);
      });
      expect(metrics.scrollTop).toBe(594);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("scrolling back toward bottom within user intent re-engages the lock", () => {
    // The release path must not regress the "scroll back to bottom and the
    // lock re-engages immediately" behavior. After the user scrolls up, a
    // direction reversal toward the bottom that lands within 8 px must relock
    // without waiting for the intent window to expire.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      // User scrolls up far enough to release.
      metrics.setScrollTop(400);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // User reverses direction and scrolls back within 8 px of the bottom
      // while the intent window is still open.
      metrics.setScrollTop(metrics.maxScrollTop - 4);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("disableAutoScroll seeds direction baseline so a later wheel-up does not relock", () => {
    // Regression: without seeding lastScrollTopRef inside disableAutoScroll,
    // the released-branch user-intent direction check compared the next
    // user-driven scroll event against a stale value (often 0 from cold-start
    // or the previous workspace's residue). A small wheel-up notch (~5 px)
    // landing within 8 px of the new bottom would then look like "moving
    // toward bottom" (e.g. 895 > 0) and spuriously relock the lock that the
    // explicit programmatic disable just turned off.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });
      // Pin lastScrollTopRef to 0 by skipping any prior handleScroll calls,
      // mimicking the pre-mount or workspace-switch cold-start path. Then
      // disableAutoScroll is invoked from a hypothetical "edit last user
      // message" or "navigate to message" flow.
      act(() => {
        result.current.disableAutoScroll();
      });
      expect(result.current.autoScroll).toBe(false);

      // User then bumps the trackpad: wheel handler primes intent (which
      // also clears programmaticDisableRef), and a small wheel-up notch
      // brings scrollTop to 595 — still within 8 px of the new bottom but
      // strictly moving away from it.
      metrics.setScrollTop(metrics.maxScrollTop - 5);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      // The released branch must read previousScrollTop = 600 (the seeded
      // value), see currentScrollTop = 595, and conclude the user is moving
      // away from bottom — no relock.
      expect(result.current.autoScroll).toBe(false);
      expect(metrics.scrollTop).toBe(595);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("delta-0 wheel events do not open a user-intent window", () => {
    // Modifier-key wheel (Cmd-wheel zoom on macOS), Shift-wheel for horizontal
    // scroll, and Bluetooth-mouse jitter all dispatch wheel events with
    // deltaY === 0 (and often deltaX === 0). These must not clear
    // programmaticDisableRef or refresh the 750 ms intent window — otherwise
    // any layout drift that follows takes the wrong branch in handleScroll.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      // Phantom wheel: zero deltas. Must be a no-op for the intent window.
      result.current.handleScrollContainerWheel(createWheelEvent(element, { deltaY: 0 }));
    });

    // Now produce a layout drift. With no intent window open, handleScroll
    // takes the no-intent locked branch and snaps back to bottom — proving
    // the wheel did not open an intent window (otherwise we'd see the
    // user-intent locked branch release the lock instead).
    metrics.setScrollTop(metrics.maxScrollTop - 5);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("non-zero wheel events do open a user-intent window", () => {
    // Sanity-check that the wheel filter doesn't over-block. A real wheel
    // event with deltaY != 0 must still mark intent and let the next scroll
    // event release the lock.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.handleScrollContainerWheel(createWheelEvent(element, { deltaY: -100 }));
      });

      metrics.setScrollTop(metrics.maxScrollTop - 5);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(result.current.autoScroll).toBe(false);
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop - 5);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("returning to bottom geometry re-acquires the lock and resumes pinning", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      // User scrolls up: lock releases.
      metrics.setScrollTop(500);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // User scrolls back to within 8px of bottom; intent expires.
      now += 1_000;
      metrics.setScrollTop(metrics.maxScrollTop - 4);
      act(() => {
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(true);

      // New layout growth lands; the re-acquired lock pins it on the next signal.
      metrics.setScrollHeight(1500);
      act(() => {
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("interactive content mousedown does not release the lock", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("div");
    child.dataset.scrollIntent = "ignore";
    element.append(child);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScrollContainerMouseDown(createMouseEvent(element, child));
    });

    metrics.setScrollHeight(1500);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("non-interactive content click does not release the lock without drag", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("span");
    element.append(child);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.handleScrollContainerMouseDown(createMouseEvent(element, child));
      });

      metrics.setScrollTop(500);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("non-interactive content drag preserves selection autoscroll intent", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("span");
    element.append(child);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.handleScrollContainerMouseDown(createMouseEvent(element, child));
        result.current.handleScrollContainerMouseMove(
          createMouseEvent(element, child, { buttons: 1 })
        );
      });

      metrics.setScrollTop(500);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(metrics.scrollTop).toBe(500);
      expect(result.current.autoScroll).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("scroll keys mark intent even when focus is on a transcript descendant", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("button");
    element.append(child);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      // PageUp pressed while focus is on a transcript-internal button. Browsers
      // still scroll the scrollport in that case, so the lock must release.
      act(() => {
        result.current.handleScrollContainerKeyDown({
          target: child,
          currentTarget: element,
          key: "PageUp",
        } as unknown as KeyboardEvent<HTMLDivElement>);
        now += 1;
        metrics.setScrollTop(500);
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(result.current.autoScroll).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("Space on a transcript button activates it without marking scroll intent", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const toggle = document.createElement("button");
    element.append(toggle);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.handleScrollContainerKeyDown({
          target: toggle,
          currentTarget: element,
          key: " ",
        } as unknown as KeyboardEvent<HTMLDivElement>);
      });

      // The expanded card's layout growth reports a stale, off-bottom scrollTop
      // before the re-pin runs; it must be corrected, not treated as user scroll.
      metrics.setScrollTop(500);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("scroll keys inside editable transcript controls do not mark intent", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const textarea = document.createElement("textarea");
    element.append(textarea);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.handleScrollContainerKeyDown({
          target: textarea,
          currentTarget: element,
          key: "PageUp",
        } as unknown as KeyboardEvent<HTMLDivElement>);
      });

      metrics.setScrollTop(500);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("non-scroll keys do not affect lock state", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScrollContainerKeyDown({
        target: element,
        currentTarget: element,
        key: "Tab",
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });

    metrics.setScrollHeight(1600);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });
    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("scrollport mousedown marks scroll intent (scrollbar drag)", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScrollContainerMouseDown(createMouseEvent(element));
    });

    metrics.setScrollTop(500);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(500);
    expect(result.current.autoScroll).toBe(false);
  });

  test("handleScroll corrects non-user drift while the lock is held", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    // Browser anchoring or programmatic scroll moves us off-bottom without user
    // intent. The next scroll event should return us to the bottom synchronously.
    metrics.setScrollTop(300);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("jumpToBottom re-arms the lock and ignores stale user telemetry", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1600,
      clientHeight: 400,
      initialScrollTop: 1000,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      dateNowSpy.mockImplementation(() => 1_000_000);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.markUserScrollIntent();
        result.current.jumpToBottom();
      });

      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);

      // Even if the browser emits a synthetic scroll event right after the jump
      // (e.g. composer resize), the stale intent must not relock the user state.
      metrics.setScrollTop(800);
      act(() => {
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("disableAutoScroll keeps later layout user-owned across re-pins", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 900,
      clientHeight: 400,
      initialScrollTop: 100,
    });

    // Toggle autoScroll after attaching the ref so the safety-net observer
    // attaches (the effect bails when contentRef is null on mount).
    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.disableAutoScroll();
    });
    act(() => {
      result.current.jumpToBottom();
    });
    const stalePin = resizeObserverCallback;
    expect(stalePin).not.toBeNull();

    act(() => {
      result.current.disableAutoScroll();
    });

    metrics.setScrollHeight(1500);
    act(() => {
      stalePin?.([], {} as ResizeObserver);
    });

    expect(metrics.scrollTop).toBe(500);
    expect(result.current.autoScroll).toBe(false);
  });

  test("programmatic disable stays unlocked even when geometry is at bottom", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.disableAutoScroll();
    });

    metrics.setScrollTop(metrics.maxScrollTop);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(result.current.autoScroll).toBe(false);
  });

  test("the ResizeObserver re-pins the bottom while locked and stays released-aware", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.disableAutoScroll();
    });
    act(() => {
      result.current.jumpToBottom();
    });
    expect(resizeObserverCallback).not.toBeNull();

    metrics.setScrollHeight(1500);
    act(() => {
      triggerResizeObserver();
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);

    const queuedResizeObserverCallback = resizeObserverCallback;
    act(() => {
      result.current.disableAutoScroll();
    });
    metrics.setScrollTop(100);
    metrics.setScrollHeight(1600);
    act(() => {
      queuedResizeObserverCallback?.([], {} as ResizeObserver);
    });

    expect(metrics.scrollTop).toBe(100);
  });

  test("the safety-net observer disconnects on unmount", () => {
    const { result, unmount } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    // Toggle autoScroll after attaching the ref so the observer effect re-runs and
    // captures the callback (the effect bails when contentRef is null on mount).
    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.disableAutoScroll();
    });
    act(() => {
      result.current.jumpToBottom();
    });
    expect(resizeObserverCallback).not.toBeNull();

    unmount();

    // disconnect() nulls the captured callback, so no stray pin can fire after teardown.
    expect(resizeObserverCallback).toBeNull();
  });
});
