import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";

import { installDom } from "../../../tests/ui/dom";
import { RIGHT_SIDEBAR_WIDTH_KEY } from "@/common/constants/storage";
import { resolveInitialResizableSidebarWidth, useResizableSidebar } from "./useResizableSidebar";

describe("resolveInitialResizableSidebarWidth", () => {
  test("clamps stored widths above the temporary max instead of falling back to default", () => {
    expect(
      resolveInitialResizableSidebarWidth({
        storedValue: "900",
        defaultWidth: 400,
        minWidth: 300,
        maxWidth: 650,
      })
    ).toBe(650);
  });

  test("falls back to the default width when the stored value is malformed", () => {
    expect(
      resolveInitialResizableSidebarWidth({
        storedValue: '{"bad":true}',
        defaultWidth: 400,
        minWidth: 300,
        maxWidth: 650,
      })
    ).toBe(400);
  });

  test("clamps stored widths below the minimum", () => {
    expect(
      resolveInitialResizableSidebarWidth({
        storedValue: "200",
        defaultWidth: 400,
        minWidth: 300,
        maxWidth: 650,
      })
    ).toBe(300);
  });
});

describe("useResizableSidebar drag", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // A right-side sidebar 400px wide whose handle starts at x=1000: moving right narrows it.
  function renderSidebar(onDragCollapseChange?: (collapsed: boolean) => void) {
    const hook = renderHook(() =>
      useResizableSidebar({
        enabled: true,
        defaultWidth: 400,
        minWidth: 300,
        maxWidth: 1000,
        storageKey: RIGHT_SIDEBAR_WIDTH_KEY,
        side: "right",
        onDragCollapseChange,
      })
    );
    act(() => {
      hook.result.current.startResize({ clientX: 1000, pointerId: 1 } as React.PointerEvent);
    });
    const dragTo = (clientX: number, pointerId = 1) =>
      act(() => {
        document.dispatchEvent(new window.PointerEvent("pointermove", { clientX, pointerId }));
      });
    const endDrag = (type: "pointerup" | "pointercancel", pointerId = 1) =>
      act(() => {
        document.dispatchEvent(new window.PointerEvent(type, { pointerId }));
      });
    return { hook, dragTo, endDrag };
  }

  test("snaps closed past half the minimum width and reopens when dragged back", () => {
    const changes: boolean[] = [];
    const { hook, dragTo } = renderSidebar((collapsed) => changes.push(collapsed));

    // Below the minimum but above the snap point the sidebar holds at its minimum.
    dragTo(1200);
    expect(hook.result.current.width).toBe(300);
    expect(changes).toEqual([]);

    // Past the snap point it collapses once, however far the pointer keeps going, and keeps
    // the width it had before the drag so reopening restores that size.
    dragTo(1300);
    dragTo(1400);
    expect(changes).toEqual([true]);
    expect(hook.result.current.width).toBe(400);

    // Dragging back out within the same gesture reopens it at the pointer's width.
    dragTo(1050);
    expect(changes).toEqual([true, false]);
    expect(hook.result.current.width).toBe(350);
  });

  test("only clamps to the minimum width when the caller does not opt in", () => {
    const { hook, dragTo } = renderSidebar();
    dragTo(1400);
    expect(hook.result.current.width).toBe(300);
  });

  test("follows only the pointer that grabbed the handle", () => {
    const { hook, dragTo, endDrag } = renderSidebar();
    // A second finger moving or lifting elsewhere neither resizes nor ends the drag.
    dragTo(900, 2);
    endDrag("pointerup", 2);
    expect(hook.result.current.width).toBe(400);
    dragTo(900);
    expect(hook.result.current.width).toBe(500);
  });

  test("a cancelled touch ends the drag", () => {
    const { hook, dragTo, endDrag } = renderSidebar();
    dragTo(950);
    endDrag("pointercancel");
    expect(hook.result.current.isResizing).toBe(false);
    dragTo(800);
    expect(hook.result.current.width).toBe(450);
  });
});
