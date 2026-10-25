import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { useTouchSafePopperProps } from "./useTouchSafePopperProps";

describe("useTouchSafePopperProps", () => {
  let domWindow: Window & typeof globalThis;
  // happy-dom neither resolves env() nor lays out, so the tests stand in for the browser. The
  // probe's outer element is padded by the top and left insets and its child by the right one.
  let insets = { top: 0, right: 0, left: 0 };
  let insetReads = 0;
  let coarsePointer = false;
  let observers: FakeResizeObserver[] = [];
  let frames: FrameRequestCallback[] = [];

  class FakeResizeObserver {
    readonly targets: Element[] = [];
    readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
  }

  function probePadding(element: Element) {
    const outer = element.firstElementChild != null;
    return {
      paddingTop: `${outer ? insets.top : 0}px`,
      paddingRight: `${outer ? 0 : insets.right}px`,
      paddingLeft: `${outer ? insets.left : 0}px`,
    };
  }

  // Plays the ResizeObserver callbacks for the observed boxes that `resized` picks, then the
  // next animation frame.
  function runObservers(resized: (target: Element) => boolean) {
    act(() => {
      for (const observer of observers) {
        if (observer.targets.some(resized)) observer.callback();
      }
      for (const frame of frames.splice(0)) frame(0);
    });
  }

  // A browser reports the probe boxes whose padding the new insets change.
  function reportInsets(next: typeof insets) {
    const box = (target: Element) => JSON.stringify(probePadding(target));
    const before = new Map(observers.flatMap((o) => o.targets).map((t) => [t, box(t)]));
    insets = next;
    runObservers((target) => box(target) !== before.get(target));
  }

  beforeEach(() => {
    saveDomGlobals();
    domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    insets = { top: 0, right: 0, left: 0 };
    insetReads = 0;
    coarsePointer = false;
    observers = [];
    frames = [];
    Object.defineProperty(domWindow, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    Object.defineProperty(domWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => frames.push(callback),
    });
    Object.defineProperty(domWindow, "getComputedStyle", {
      configurable: true,
      value: (element: Element) => {
        insetReads += 1;
        return probePadding(element);
      },
    });
    Object.defineProperty(domWindow, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: coarsePointer && query === "(pointer: coarse)" }),
    });
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  it("adds the top and side safe-area insets to the caller's padding, never the bottom one", () => {
    insets = { top: 21, right: 84, left: 6 };

    const none = renderHook(() => useTouchSafePopperProps());
    const uniform = renderHook(() => useTouchSafePopperProps(10));
    const top = renderHook(() => useTouchSafePopperProps({ top: 4 }));
    const bottom = renderHook(() => useTouchSafePopperProps({ bottom: 8 }));

    expect(none.result.current.collisionPadding).toEqual({
      top: 21,
      right: 84,
      bottom: 0,
      left: 6,
    });
    expect(uniform.result.current.collisionPadding).toEqual({
      top: 31,
      right: 94,
      bottom: 10,
      left: 16,
    });
    expect(top.result.current.collisionPadding).toEqual({ top: 25, right: 84, bottom: 0, left: 6 });
    expect(bottom.result.current.collisionPadding).toEqual({
      top: 21,
      right: 84,
      bottom: 8,
      left: 6,
    });
  });

  it("measures the insets once, not on every render", () => {
    const { rerender } = renderHook(() => useTouchSafePopperProps(10));
    const firstReads = insetReads;
    rerender();
    rerender();
    renderHook(() => useTouchSafePopperProps());

    // Reading the probes forces layout, and every closed menu renders this hook too.
    expect(firstReads).toBeGreaterThan(0);
    expect(insetReads).toBe(firstReads);
  });

  it("re-reads the insets when they change, including while no menu is mounted", () => {
    const menu = renderHook(() => useTouchSafePopperProps(10));
    expect(menu.result.current.collisionPadding).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    });

    // Folding to the iPhone Duo cover display brings in the insets, after any window resize.
    reportInsets({ top: 21, right: 84, left: 0 });
    expect(menu.result.current.collisionPadding).toEqual({
      top: 31,
      right: 94,
      bottom: 10,
      left: 10,
    });
    menu.unmount();

    // Unfolding while every menu is closed and unmounted.
    reportInsets({ top: 0, right: 0, left: 0 });
    const reopened = renderHook(() => useTouchSafePopperProps(10));
    expect(reopened.result.current.collisionPadding).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    });
  });

  it("follows a change to any one inset and a swap of the side insets", () => {
    const menu = renderHook(() => useTouchSafePopperProps());

    for (const next of [
      { top: 21, right: 0, left: 0 },
      // Only the right inset changes when the iPhone Duo moves between its displays.
      { top: 21, right: 84, left: 0 },
      { top: 21, right: 84, left: 6 },
      // A half turn of a landscape phone swaps the side insets.
      { top: 21, right: 6, left: 84 },
    ]) {
      reportInsets(next);
      expect(menu.result.current.collisionPadding).toEqual({ ...next, bottom: 0 });
    }
  });

  it("tells mounted menus in the next frame, not inside the observer callback", () => {
    const menu = renderHook(() => useTouchSafePopperProps());
    insets = { top: 21, right: 84, left: 0 };

    // A menu that re-renders inside the callback resizes during the browser's observer loop.
    act(() => {
      for (const observer of observers) observer.callback();
    });
    expect(menu.result.current.collisionPadding.top).toBe(0);

    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(menu.result.current.collisionPadding.top).toBe(21);
  });

  it("does not re-render menus when a report keeps the insets", () => {
    insets = { top: 21, right: 84, left: 0 };
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useTouchSafePopperProps();
    });

    // A ResizeObserver reports each box that has a size once when it starts observing it.
    runObservers(() => true);

    expect(renders).toBe(1);
  });

  it("still measures the insets where ResizeObserver is missing", () => {
    Object.defineProperty(domWindow, "ResizeObserver", { configurable: true, value: undefined });
    insets = { top: 21, right: 84, left: 6 };

    const menu = renderHook(() => useTouchSafePopperProps());

    expect(menu.result.current.collisionPadding).toEqual({
      top: 21,
      right: 84,
      bottom: 0,
      left: 6,
    });
  });

  it("re-measures menu positions every frame only on touch screens", () => {
    const mouse = renderHook(() => useTouchSafePopperProps());
    coarsePointer = true;
    const touch = renderHook(() => useTouchSafePopperProps());

    expect(mouse.result.current.updatePositionStrategy).toBe("optimized");
    expect(touch.result.current.updatePositionStrategy).toBe("always");
  });
});
