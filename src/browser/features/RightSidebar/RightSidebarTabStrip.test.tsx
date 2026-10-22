import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { TabType } from "@/browser/types/rightSidebar";
import { RightSidebarTabStrip, type RightSidebarTabStripItem } from "./RightSidebarTabStrip";

const TABS: TabType[] = ["costs", "review", "instructions", "goal"];
const TAB_WIDTH = 140;
const TAB_PITCH = 150;
const ROW_WIDTH = 200;

function rect(left: number, width: number): DOMRect {
  const box = { left, right: left + width, width, top: 0, bottom: 24, height: 24, x: left, y: 0 };
  return { ...box, toJSON: () => box };
}

/** happy-dom has no layout: give the row and its tabs a fixed one-row geometry that scrolls. */
function stubRowLayout(row: HTMLElement): void {
  Object.defineProperty(row, "clientWidth", { configurable: true, value: ROW_WIDTH });
  Object.defineProperty(row, "scrollWidth", {
    configurable: true,
    value: TAB_PITCH * TABS.length,
  });
  row.getBoundingClientRect = () => rect(0, ROW_WIDTH);
  row.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab, index) => {
    tab.getBoundingClientRect = () => rect(index * TAB_PITCH - row.scrollLeft, TAB_WIDTH);
  });
}

describe("RightSidebarTabStrip keyboard (#7102)", () => {
  let cleanupDom: (() => void) | null = null;
  let resizeCallbacks: Array<() => void> = [];

  beforeEach(() => {
    cleanupDom = installDom();
    resizeCallbacks = [];
    // The row re-reveals a tab on size changes; the test fires those changes itself.
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe = mock(() => undefined);
      unobserve = mock(() => undefined);
      disconnect = mock(() => undefined);
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderStrip(options: { disabled?: TabType } = {}) {
    const onSelect = mock((_tab: TabType) => undefined);
    const items: RightSidebarTabStripItem[] = TABS.map((tab) => ({
      id: `tab-${tab}`,
      panelId: `panel-${tab}`,
      tab,
      selected: tab === "costs",
      disabled: tab === options.disabled,
      onSelect: () => onSelect(tab),
      label: tab,
      tooltip: null,
      onClose: () => undefined,
      closeLabel: `Close ${tab}`,
    }));
    const view = render(
      <TooltipProvider>
        <DndContext>
          <SortableContext items={TABS.map((tab) => `strip:${tab}`)}>
            <RightSidebarTabStrip items={items} tabsetId="strip" onAddNewTab={() => undefined} />
          </SortableContext>
        </DndContext>
      </TooltipProvider>
    );
    const row = view.getByRole("tablist");
    const tabs = view.getAllByRole("tab");
    return { view, row, tabs, onSelect };
  }

  test("arrow keys, Home and End move focus and wrap; only Enter selects", () => {
    const { tabs, onSelect } = renderStrip();
    const [first, second, , last] = tabs;
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Home" });
    expect(document.activeElement).toBe(first);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(first, { key: "ArrowRight" });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onSelect.mock.calls).toEqual([["review"]]);
  });

  test("modified keys and keys from a button inside a tab keep their own meaning", () => {
    const { view, tabs } = renderStrip();
    const [first] = tabs;
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(first, { key: "ArrowRight", ctrlKey: true });
    expect(document.activeElement).toBe(first);

    const close = view.getByRole("button", { name: "Close costs" });
    close.focus();
    fireEvent.keyDown(close, { key: "ArrowRight" });
    expect(document.activeElement).toBe(close);
  });

  test("arrow keys skip a disabled tab", () => {
    const { tabs } = renderStrip({ disabled: "review" });
    const [first, , third] = tabs;
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(third);
  });

  test("a size change keeps the focused tab in view, also while its button has focus", () => {
    const { view, row, tabs } = renderStrip();
    stubRowLayout(row);
    const last = tabs[tabs.length - 1];
    const resize = () => resizeCallbacks.forEach((callback) => callback());
    const lastFullyVisible = () => {
      const tab = last.getBoundingClientRect();
      return tab.left >= 0 && tab.right <= ROW_WIDTH;
    };

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(lastFullyVisible()).toBe(true);
    row.scrollLeft = 0;
    resize();
    expect(lastFullyVisible()).toBe(true);

    view.getByRole("button", { name: "Close goal" }).focus();
    row.scrollLeft = 0;
    resize();
    expect(lastFullyVisible()).toBe(true);

    // With focus outside the row, a size change shows the selected (first) tab again.
    (document.activeElement as HTMLElement).blur();
    resize();
    expect(row.scrollLeft).toBe(0);
  });
});
