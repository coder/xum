import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { useTouchSafePopperProps } from "./useTouchSafePopperProps";

describe("useTouchSafePopperProps", () => {
  let domWindow: Window & typeof globalThis;
  // happy-dom does not resolve env(), so the tests stand in for the safe-area insets that a
  // browser reports as the probe element's padding.
  let insets = { top: 0, right: 0, left: 0 };
  let insetReads = 0;
  let coarsePointer = false;

  function resizeWindow() {
    act(() => {
      domWindow.dispatchEvent(new domWindow.Event("resize"));
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

    const uniform = renderHook(() => useTouchSafePopperProps(10));
    const perSide = renderHook(() => useTouchSafePopperProps({ top: 4 }));

    expect(uniform.result.current.collisionPadding).toEqual({
      top: 31,
      right: 94,
      bottom: 10,
      left: 16,
    });
    expect(perSide.result.current.collisionPadding).toEqual({
      top: 25,
      right: 84,
      bottom: 0,
      left: 6,
    });
  });

  it("measures the insets once, not on every render", () => {
    const { rerender } = renderHook(() => useTouchSafePopperProps(10));
    rerender();
    rerender();
    renderHook(() => useTouchSafePopperProps());

    // Reading the probe forces layout, and every closed menu renders this hook too.
    expect(insetReads).toBe(1);
  });

  it("re-reads the insets after a resize, including one while no menu is mounted", () => {
    const menu = renderHook(() => useTouchSafePopperProps(10));
    expect(menu.result.current.collisionPadding).toMatchObject({ top: 10, right: 10 });

    // Folding to the iPhone Duo cover display resizes the window and brings in the insets.
    insets = { top: 21, right: 84, left: 0 };
    resizeWindow();
    expect(menu.result.current.collisionPadding).toMatchObject({ top: 31, right: 94 });
    menu.unmount();

    // Unfolding while every menu is closed and unmounted.
    insets = { top: 0, right: 0, left: 0 };
    resizeWindow();
    const reopened = renderHook(() => useTouchSafePopperProps(10));
    expect(reopened.result.current.collisionPadding).toMatchObject({ top: 10, right: 10 });
  });

  it("re-measures menu positions every frame only on touch screens", () => {
    const mouse = renderHook(() => useTouchSafePopperProps());
    coarsePointer = true;
    const touch = renderHook(() => useTouchSafePopperProps());

    expect(mouse.result.current.updatePositionStrategy).toBe("optimized");
    expect(touch.result.current.updatePositionStrategy).toBe("always");
  });
});
