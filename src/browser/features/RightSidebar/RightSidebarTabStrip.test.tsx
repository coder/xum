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
  let observers: Array<{ callback: () => void; connected: boolean }> = [];
  // Fire every connected observer, as a size change in the row does.
  const resize = () => observers.filter((o) => o.connected).forEach((o) => o.callback());

  beforeEach(() => {
    cleanupDom = installDom();
    observers = [];
    // The row re-reveals a tab on size changes; the test fires those changes itself. A real
    // observer also reports once right after it starts: `renderStrip` and `select` send that.
    globalThis.ResizeObserver = class {
      private readonly entry: { callback: () => void; connected: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, connected: true };
        observers.push(this.entry);
      }
      observe = mock(() => undefined);
      unobserve = mock(() => undefined);
      disconnect = () => {
        this.entry.connected = false;
      };
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderStrip(options: { disabled?: TabType } = {}) {
    const onSelect = mock((_tab: TabType) => undefined);
    const strip = (selected: TabType) => {
      const items: RightSidebarTabStripItem[] = TABS.map((tab) => ({
        id: `tab-${tab}`,
        panelId: `panel-${tab}`,
        tab,
        selected: tab === selected,
        disabled: tab === options.disabled,
        onSelect: () => onSelect(tab),
        label: tab,
        tooltip: null,
        onClose: () => undefined,
        closeLabel: `Close ${tab}`,
      }));
      return (
        <TooltipProvider>
          <DndContext>
            <SortableContext items={TABS.map((tab) => `strip:${tab}`)}>
              <RightSidebarTabStrip items={items} tabsetId="strip" onAddNewTab={() => undefined} />
            </SortableContext>
          </DndContext>
        </TooltipProvider>
      );
    };
    const view = render(strip("costs"));
    const row = view.getByRole("tablist");
    stubRowLayout(row);
    resize();
    const tabs = view.getAllByRole("tab");
    // Selection from outside the strip (a keyboard shortcut, the launcher). The effect then
    // starts a new observer, whose first report follows.
    const select = (tab: TabType) => {
      view.rerender(strip(tab));
      stubRowLayout(row);
      resize();
    };
    return { view, row, tabs, onSelect, select };
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
    const last = tabs[tabs.length - 1];
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

  test("a shortcut selection while focus stays on another tab keeps the new tab in view", () => {
    const { tabs, select } = renderStrip();
    const fullyVisible = (tab: HTMLElement) => {
      const box = tab.getBoundingClientRect();
      return box.left >= 0 && box.right <= ROW_WIDTH;
    };

    // Focus moves to the last tab without selecting it.
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(fullyVisible(tabs[3])).toBe(true);

    // A shortcut selects the second tab; focus stays on the last one. The new observer's
    // first report (sent by `select`) is no size change and must not scroll back.
    select("review");
    expect(document.activeElement).toBe(tabs[3]);
    expect(fullyVisible(tabs[1])).toBe(true);

    // A real size change after that keeps the focused tab in view again.
    resize();
    expect(fullyVisible(tabs[3])).toBe(true);
  });
});
