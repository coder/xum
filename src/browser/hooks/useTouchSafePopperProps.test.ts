import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { useTouchSafePopperProps } from "./useTouchSafePopperProps";

describe("useTouchSafePopperProps", () => {
  let domWindow: Window & typeof globalThis;
  // happy-dom neither resolves env() nor lays out, so the tests stand in for the browser: the
  // probes' computed padding reports these insets, and reportInsets plays the ResizeObserver
  // that the probes' boxes trigger when the insets change, then the next animation frame.
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

  function reportInsets(next: typeof insets) {
    insets = next;
    act(() => {
      for (const observer of observers) {
        if (observer.targets.length > 0) observer.callback();
      }
      for (const frame of frames.splice(0)) frame(0);
    });
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
      value: () => {
        insetReads += 1;
        return {
          paddingTop: `${insets.top}px`,
          paddingRight: `${insets.right}px`,
          paddingLeft: `${insets.left}px`,
        };
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

  it("notices a change to any one inset", () => {
    const menu = renderHook(() => useTouchSafePopperProps());

    for (const next of [
      { top: 21, right: 0, left: 0 },
      { top: 21, right: 84, left: 0 },
      { top: 21, right: 84, left: 6 },
    ]) {
      reportInsets(next);
      expect(menu.result.current.collisionPadding).toEqual({ ...next, bottom: 0 });
    }
  });

  it("does not re-render menus when a report keeps the insets", () => {
    insets = { top: 21, right: 84, left: 0 };
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useTouchSafePopperProps();
    });

    // A ResizeObserver reports each box that has a size once when it starts observing it.
    reportInsets({ ...insets });

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
