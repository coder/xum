import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useState } from "react";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
  type WorkspaceMetadataContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import {
  rectContains,
  windowDragsAt,
  withDesktopTitlebar,
} from "@/browser/stories/helpers/windowDrag";
import { PIXEL_DISABLED } from "@/browser/stories/meta.js";
import type { TabType } from "@/browser/types/rightSidebar";
import {
  MOBILE_TOUCH_TARGET_PX,
  NARROW_VIEWPORT_MAX_WIDTH_PX,
  TABLET_TOUCH_TARGET_PX,
} from "@/constants/layout";
import { RightSidebarTabStrip, type RightSidebarTabStripItem } from "./RightSidebarTabStrip";
import {
  NewTabLabel,
  SideChatTabLabel,
  SideChatTabTitle,
  TerminalTabLabel,
} from "./Tabs/TabLabels";

const LONG_TITLE =
  "Investigate the long-running background task and its unexpected startup behaviour";
const SIDE_WORKSPACE = createWorkspace({
  id: "side-title",
  name: "internal-side-name",
  projectName: "demo",
  title: LONG_TITLE,
});
// Only the metadata half of the public provider is read by these isolated label fixtures.
const METADATA: WorkspaceMetadataContextValue = {
  workspaceMetadata: new Map([[SIDE_WORKSPACE.id, SIDE_WORKSPACE]]),
  loading: false,
  loaded: true,
  loadError: null,
};

function StripFixture(props: { width: number; reservesToggle: boolean; tabs?: TabType[] }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [selected, setSelected] = useState<TabType>(props.tabs?.[0] ?? "new");
  const [closed, setClosed] = useState<TabType[]>([]);
  const [order, setOrder] = useState<TabType[]>(
    props.tabs ?? ["new", "instructions", "side:side-title", "terminal:long-title"]
  );
  const close = (tab: TabType) => setClosed((prev) => [...prev, tab]);
  const definitions: Array<
    Pick<RightSidebarTabStripItem, "tab" | "label" | "menuLabel" | "tooltip" | "closeLabel">
  > = [
    { tab: "new", label: <NewTabLabel />, tooltip: "Open a tool", closeLabel: "Close New tab" },
    {
      tab: "instructions",
      label: <span className="truncate">A long instructions tab label that should never jump</span>,
      tooltip: "Instructions",
      closeLabel: "Close Instructions",
    },
    {
      tab: "side:side-title",
      label: (
        <SideChatTabLabel
          workspaceId={SIDE_WORKSPACE.id}
          onClose={() => close("side:side-title")}
        />
      ),
      menuLabel: <SideChatTabLabel workspaceId={SIDE_WORKSPACE.id} />,
      tooltip: <SideChatTabTitle workspaceId={SIDE_WORKSPACE.id} />,
    },
    {
      tab: "terminal:long-title",
      label: (
        <TerminalTabLabel
          dynamicTitle={LONG_TITLE}
          terminalIndex={0}
          onPopOut={() => undefined}
          onClose={() => close("terminal:long-title")}
        />
      ),
      menuLabel: <TerminalTabLabel dynamicTitle={LONG_TITLE} terminalIndex={0} />,
      tooltip: LONG_TITLE,
    },
  ];
  const items = order
    .map((tab) => definitions.find((item) => item.tab === tab)!)
    .filter((item) => !closed.includes(item.tab))
    .map((item) => ({
      ...item,
      id: item.tab,
      panelId: `panel-${item.tab}`,
      selected: selected === item.tab,
      onSelect: () => setSelected(item.tab),
      onClose: () => close(item.tab),
    }));
  return (
    <WorkspaceContext.Provider value={METADATA as WorkspaceContextValue}>
      <TooltipProvider>
        <div
          className="bg-surface-primary border-border text-foreground border"
          style={{ width: props.width, maxWidth: "100%" }}
        >
          <DndContext
            sensors={sensors}
            onDragEnd={({ active, over }) => {
              if (!over) return;
              setOrder((prev) =>
                arrayMove(
                  prev,
                  prev.findIndex((tab) => `fixture:${tab}` === active.id),
                  prev.findIndex((tab) => `fixture:${tab}` === over.id)
                )
              );
            }}
          >
            <SortableContext
              items={items.map((item) => `fixture:${item.tab}`)}
              strategy={horizontalListSortingStrategy}
            >
              <RightSidebarTabStrip
                items={items}
                tabsetId="fixture"
                onAddNewTab={() => {
                  // Like the sidebar: show the New tab, adding it first when the strip has none.
                  setOrder((prev) => (prev.includes("new") ? prev : [...prev, "new"]));
                  setClosed((prev) => prev.filter((tab) => tab !== "new"));
                  setSelected("new");
                }}
                reservesSidebarToggle={props.reservesToggle}
              />
            </SortableContext>
          </DndContext>
          <div className="text-muted p-3 text-xs">
            Long titles; hover, focus, and selection keep the close controls in place.
          </div>
        </div>
      </TooltipProvider>
    </WorkspaceContext.Provider>
  );
}

const meta = {
  title: "App/RightSidebar/Stable tab controls",
  component: StripFixture,
  parameters: { layout: "padded", pixel: PIXEL_DISABLED },
} satisfies Meta<typeof StripFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

function rect(element: Element) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}
/** The strip around a tab row (the row sits in a wrapper that holds its desktop no-drag region). */
function stripOf(tablist: HTMLElement): HTMLElement {
  return tablist.parentElement!.parentElement!;
}
async function frame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function checkStableControls(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const tabs = canvas.getAllByRole("tab");
  for (const tab of tabs) {
    tab.scrollIntoView({ inline: "nearest", block: "nearest" });
    await userEvent.unhover(tab);
    await frame();
    const label = tab.firstElementChild!;
    const beforeTab = rect(tab);
    const beforeLabel = rect(label);
    await userEvent.hover(tab);
    await frame();
    await expect(rect(tab)).toEqual(beforeTab);
    await expect(rect(label)).toEqual(beforeLabel);

    // A visible X must not obscure the reserved text area, even with a truncated title.
    // userEvent sends hover events without moving the browser's actual pointer, so query the
    // reserved (possibly still CSS-hidden) X directly; real pointer hover is checked separately.
    const close = tab.querySelector<HTMLButtonElement>('button[aria-label^="Close "]')!;
    await expect(close).not.toBeNull();
    const closeRect = close.getBoundingClientRect();
    const rowRect = tab.closest('[role="tablist"]')!.getBoundingClientRect();
    await expect(closeRect.top).toBeGreaterThanOrEqual(rowRect.top);
    await expect(closeRect.bottom).toBeLessThanOrEqual(rowRect.bottom);
    // Pixel does not emulate touch. This contract also runs in a coarse-pointer browser at
    // phone and wide tablet widths: static/New targets must fit even beyond mobile CSS's cap.
    // Phones get the 44px touch floor. Tablets keep desktop-height rows (44px rows made the
    // strip far taller than the header), so their X only has to meet the 24px minimum.
    if (
      window.matchMedia("(pointer: coarse)").matches &&
      ["new", "instructions"].includes(tab.id)
    ) {
      const minTarget = window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`).matches
        ? MOBILE_TOUCH_TARGET_PX
        : TABLET_TOUCH_TARGET_PX;
      await expect(closeRect.width).toBeGreaterThanOrEqual(minTarget);
      await expect(closeRect.height).toBeGreaterThanOrEqual(minTarget);
    }
    const text = label.querySelector("span.truncate") ?? label;
    await expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
      close.getBoundingClientRect().left
    );
    const width = tab.getBoundingClientRect().width;
    const labelWidth = label.getBoundingClientRect().width;
    await userEvent.click(tab);
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    await expect(tab.getBoundingClientRect().width).toBe(width);
    await expect(label.getBoundingClientRect().width).toBe(labelWidth);
    tab.focus();
    await userEvent.unhover(tab);
    await frame();
    await expect(getComputedStyle(close).visibility).toBe("visible");
  }
  // Side-chat text is the user-visible metadata title, not the internal workspace name.
  await expect(canvas.getAllByText(LONG_TITLE).length).toBeGreaterThanOrEqual(2);
}

/**
 * Tabs that overflow scroll in their row without pushing "+" or All tabs out of the strip, and
 * "+" comes right after the row (so after the last tab when they fit).
 */
async function checkStripButtons(canvasElement: HTMLElement, overflowing: boolean) {
  const canvas = within(canvasElement);
  const row = canvas.getByRole("tablist");
  const tabs = within(row).getAllByRole("tab");
  const newTabButton = canvas.getByRole("button", { name: "New tab" });
  const menuButton = canvas.getByRole("button", { name: "All tabs" });
  const plus = newTabButton.getBoundingClientRect();
  const menu = menuButton.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  await expect(row.scrollWidth > row.clientWidth).toBe(overflowing);
  await expect(plus.left - rowRect.right).toBeGreaterThanOrEqual(0);
  await expect(plus.left - rowRect.right).toBeLessThanOrEqual(8);
  await expect(menu.left - plus.right).toBeGreaterThanOrEqual(0);
  await expect(menu.right).toBeLessThanOrEqual(stripOf(row).getBoundingClientRect().right);
  for (const [button, box] of [
    [newTabButton, plus],
    [menuButton, menu],
  ] as const) {
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    await expect(hit != null && button.contains(hit)).toBe(true);
  }
  if (!overflowing) {
    await expect(rowRect.right - tabs[tabs.length - 1].getBoundingClientRect().right).toBeLessThan(
      1
    );
  }
}

async function openTabListMenu(canvasElement: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(within(canvasElement).getByRole("button", { name: "All tabs" }));
  // The menu renders in a portal, outside the canvas.
  return within(document.body).findByRole("dialog", { name: "All tabs" });
}

async function waitForTabListMenuClosed() {
  await waitFor(() =>
    expect(within(document.body).queryByRole("dialog", { name: "All tabs" })).toBeNull()
  );
}

async function expectFullyInRow(row: HTMLElement, tab: HTMLElement) {
  await waitFor(async () => {
    const bounds = row.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 0.5);
    await expect(rect.right).toBeLessThanOrEqual(bounds.right + 0.5);
  });
}

/** A tab scrolled out of the row is one pick away in the All tabs menu; "+" shows the New tab. */
async function checkTabListMenu(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const row = canvas.getByRole("tablist");
  const tabs = within(row).getAllByRole("tab");
  const [newTab, target] = tabs;
  await userEvent.click(tabs[tabs.length - 1]);
  await waitFor(() =>
    expect(target.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().left
    )
  );

  const menu = await openTabListMenu(canvasElement);
  // One row per tab, the New tab included.
  const rows = within(menu).getAllByRole("button");
  await expect(rows).toHaveLength(tabs.length);
  // It opens on the selected (last) tab's row, like a select, and arrow keys move between rows.
  const selectedRow = rows[rows.length - 1];
  await waitFor(() => expect(selectedRow).toHaveFocus());
  await expect(selectedRow).toHaveAttribute("aria-current", "true");
  await userEvent.keyboard("{ArrowUp}");
  await expect(rows[rows.length - 2]).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await expect(rows[rows.length - 1]).toHaveFocus();

  await userEvent.click(rows[1]);
  await waitForTabListMenuClosed();
  await expect(target).toHaveAttribute("aria-selected", "true");
  // Focus moves to the picked tab, not back to the menu button.
  await expect(target).toHaveFocus();
  await expectFullyInRow(row, target);

  await userEvent.click(canvas.getByRole("button", { name: "New tab" }));
  await expect(newTab).toHaveAttribute("aria-selected", "true");
  await expectFullyInRow(row, newTab);
}

export const Narrow: Story = {
  // No room for the sidebar toggle, like the phone full-screen strip (the test-runner swipes this
  // one at phone width, see .storybook/test-runner.ts). Wide enough that the longest tab (240px)
  // fits beside "+" and All tabs, so a picked tab can show whole.
  args: { width: 330, reservesToggle: false },
  play: async ({ canvasElement }) => {
    await checkStableControls(canvasElement);
    await checkStripButtons(canvasElement, true);
    await checkTabListMenu(canvasElement);
  },
};
export const SingleTab: Story = {
  // "+" after the only tab adds the New tab after it.
  args: { width: 300, reservesToggle: true, tabs: ["instructions"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("tab")).toHaveLength(1);
    await userEvent.click(canvas.getByRole("button", { name: "New tab" }));
    await expect(canvas.getAllByRole("tab")).toHaveLength(2);
    await expect(canvas.getByRole("tab", { name: /^New tab/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  },
};
/** The inert room the strip keeps under WorkspaceShell's right sidebar toggle. */
function toggleRoom(canvasElement: HTMLElement): HTMLElement {
  const strip = stripOf(within(canvasElement).getByRole("tablist"));
  return strip.querySelector<HTMLElement>('button[aria-hidden="true"]')!;
}

export const Wide: Story = {
  // Wide enough for every tab beside "+", All tabs and the toggle's room.
  args: { width: 1000, reservesToggle: true },
  play: async ({ canvasElement }) => {
    await checkStableControls(canvasElement);
    await checkStripButtons(canvasElement, false);
    // "+" follows the last tab. All tabs and the toggle's room hold the strip's right end, past
    // the free space after "+".
    const canvas = within(canvasElement);
    const tablist = canvas.getByRole("tablist");
    const stripButtons = within(stripOf(tablist))
      .getAllByRole("button")
      .filter((button) => !tablist.contains(button))
      .map((button) => button.getAttribute("aria-label"));
    await expect(stripButtons).toEqual(["New tab", "All tabs"]);
    const plus = canvas.getByRole("button", { name: "New tab" }).getBoundingClientRect();
    const allTabs = canvas.getByRole("button", { name: "All tabs" }).getBoundingClientRect();
    const room = toggleRoom(canvasElement).getBoundingClientRect();
    const strip = stripOf(tablist).getBoundingClientRect();
    await expect(allTabs.left - plus.right).toBeGreaterThan(8);
    await expect(room.left - allTabs.right).toBeGreaterThanOrEqual(0);
    await expect(room.left - allTabs.right).toBeLessThanOrEqual(8);
    await expect(strip.right - room.right).toBeLessThanOrEqual(9);
  },
};
export const Cramped: Story = {
  // A split pane at its minimum width (15% of a 300 px sidebar) has no room for all controls:
  // the toggle's room stays at the end, under the toggle.
  args: { width: 45, reservesToggle: true },
  play: async ({ canvasElement }) => {
    const room = toggleRoom(canvasElement).getBoundingClientRect();
    const strip = stripOf(within(canvasElement).getByRole("tablist")).getBoundingClientRect();
    await expect(room.left).toBeGreaterThanOrEqual(strip.left);
    await expect(room.right).toBeLessThanOrEqual(strip.right);
  },
};

/**
 * Arrow keys, Home and End move focus between the tabs (WAI-ARIA tabs pattern, #7102). Only Enter
 * or Space selects, and only the selected tab is in the Tab order.
 */
export const ArrowKeys: Story = {
  // Narrow enough that the tabs overflow: a tab reached by a key scrolls into view.
  args: { width: 330, reservesToggle: false },
  play: async ({ canvasElement }) => {
    const row = within(canvasElement).getByRole("tablist");
    const tabs = within(row).getAllByRole("tab");
    const [first, second] = tabs;
    const last = tabs[tabs.length - 1];
    const tabStops = () => tabs.filter((tab) => tab.tabIndex === 0);
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(tabStops()).toEqual([first]);

    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(second).toHaveFocus();
    // Focus moves; the selection stays until Enter or Space.
    await expect(first).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{End}");
    await expect(last).toHaveFocus();
    await expectFullyInRow(row, last);
    // A size change in the row (a badge loads, a font swaps) must not scroll it back to the
    // selected tab, away from the focused one. The row's ResizeObserver runs within a frame.
    first.style.paddingLeft = "32px";
    await frame();
    await frame();
    await expectFullyInRow(row, last);
    first.style.paddingLeft = "";
    await userEvent.keyboard("{ArrowRight}");
    await expect(first).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(last).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect(first).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}{Enter}");
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(tabStops()).toEqual([second]);
  },
};

function center(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Along the strip's center line, from the header stand-in to the strip's right end, every point
 * outside the tab row and the strip buttons moves the window, and the controls do not.
 */
async function checkStripDragRegions(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const row = canvas.getByRole("tablist").getBoundingClientRect();
  const strip = stripOf(canvas.getByRole("tablist")).getBoundingClientRect();
  const standIn = canvas.getByTestId("header-stand-in").getBoundingClientRect();
  // The toggle's room drags here: WorkspaceShell keeps the toggle over it clickable.
  const buttons = ["New tab", "All tabs"].map((name) =>
    canvas.getByRole("button", { name }).getBoundingClientRect()
  );
  const y = strip.top + strip.height / 2;
  const dead: number[] = [];
  for (let x = Math.ceil(standIn.left); x < strip.right; x += 2) {
    // The fixture's border between the stand-in and the strip is not part of the title bar.
    if (!rectContains(standIn, x, y) && !rectContains(strip, x, y)) continue;
    if ([row, ...buttons].some((rect) => rectContains(rect, x, y))) continue;
    if (!windowDragsAt(x, y)) dead.push(x);
  }
  await expect(dead, "points that do not drag").toEqual([]);
  const visibleTabs = canvas
    .getAllByRole("tab")
    .map((tab) => center(tab.getBoundingClientRect()))
    .filter((point) => rectContains(row, point.x, point.y));
  await expect(visibleTabs.length).toBeGreaterThan(0);
  for (const point of [...visibleTabs, ...buttons.map(center)]) {
    await expect(windowDragsAt(point.x, point.y)).toBe(false);
  }
}

export const DesktopDragRegions: Story = {
  // In Electron the strip sits after the workspace header in DOM order, and Electron lets the
  // later region rect win, so a tab scrolled out of the row must not block dragging the header.
  args: { width: 300, reservesToggle: true },
  beforeEach: withDesktopTitlebar,
  render: (args) => (
    <div className="flex">
      <div data-testid="header-stand-in" className="titlebar-drag flex-1" />
      <StripFixture {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole("tablist");
    const tabs = within(row).getAllByRole("tab");
    const standIn = canvas.getByTestId("header-stand-in");

    await userEvent.click(tabs[tabs.length - 1]);
    await waitFor(() =>
      expect(tabs[0].getBoundingClientRect().right).toBeLessThanOrEqual(
        row.getBoundingClientRect().left
      )
    );
    const scrolledOut = tabs[0].getBoundingClientRect();
    await expect(scrolledOut.left).toBeLessThan(standIn.getBoundingClientRect().right);
    await expect(scrolledOut.right).toBeGreaterThan(standIn.getBoundingClientRect().left);
    await checkStripDragRegions(canvasElement);

    await userEvent.click(tabs[0]);
    await waitFor(() =>
      expect(tabs[tabs.length - 1].getBoundingClientRect().right).toBeGreaterThan(
        row.getBoundingClientRect().right
      )
    );
    await checkStripDragRegions(canvasElement);
  },
};
