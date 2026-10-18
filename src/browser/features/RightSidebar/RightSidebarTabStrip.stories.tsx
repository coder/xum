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

function StripFixture(props: { width: number; collapsible: boolean; tabs?: TabType[] }) {
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
                onCollapseSidebar={props.collapsible ? () => undefined : undefined}
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

/** Tabs that overflow scroll in their row without pushing All tabs out of the strip. */
async function checkAllTabsButton(canvasElement: HTMLElement, overflowing: boolean) {
  const canvas = within(canvasElement);
  const row = canvas.getByRole("tablist");
  const tabs = within(row).getAllByRole("tab");
  const menuButton = canvas.getByRole("button", { name: "All tabs" });
  const menu = menuButton.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  await expect(row.scrollWidth > row.clientWidth).toBe(overflowing);
  await expect(menu.left - rowRect.right).toBeGreaterThanOrEqual(0);
  await expect(menu.right).toBeLessThanOrEqual(row.parentElement!.getBoundingClientRect().right);
  const hit = document.elementFromPoint(menu.left + menu.width / 2, menu.top + menu.height / 2);
  await expect(hit != null && menuButton.contains(hit)).toBe(true);
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

/** A tab scrolled out of the row is one pick away in the All tabs menu, and so is the New tab. */
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

  let menu = await openTabListMenu(canvasElement);
  // One row per tab but the New tab, which the last row stands for.
  const rows = within(menu).getAllByRole("button");
  await expect(rows).toHaveLength(tabs.length);
  await expect(rows[rows.length - 1]).toHaveAccessibleName("New tab");
  // It opens on the selected (last) tab's row, like a select, and arrow keys move between rows.
  const selectedRow = rows[rows.length - 2];
  await waitFor(() => expect(selectedRow).toHaveFocus());
  await expect(selectedRow).toHaveAttribute("aria-current", "true");
  await userEvent.keyboard("{ArrowUp}");
  await expect(rows[rows.length - 3]).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await expect(rows[rows.length - 1]).toHaveFocus();

  await userEvent.click(rows[0]);
  await waitForTabListMenuClosed();
  await expect(target).toHaveAttribute("aria-selected", "true");
  // Focus moves to the picked tab, not back to the menu button.
  await expect(target).toHaveFocus();
  await expectFullyInRow(row, target);

  menu = await openTabListMenu(canvasElement);
  await userEvent.click(within(menu).getByRole("button", { name: "New tab" }));
  await waitForTabListMenuClosed();
  await expect(newTab).toHaveAttribute("aria-selected", "true");
  await expectFullyInRow(row, newTab);
}

export const Narrow: Story = {
  // No collapse button, like the phone full-screen strip (the test-runner swipes this one at
  // phone width, see .storybook/test-runner.ts).
  args: { width: 300, collapsible: false },
  play: async ({ canvasElement }) => {
    await checkStableControls(canvasElement);
    await checkAllTabsButton(canvasElement, true);
    await checkTabListMenu(canvasElement);
  },
};
export const SingleTab: Story = {
  // All tabs stays with one tab: its menu holds the New tab.
  args: { width: 300, collapsible: true, tabs: ["instructions"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("tab")).toHaveLength(1);
    await expect(canvas.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    const menu = await openTabListMenu(canvasElement);
    await expect(within(menu).getAllByRole("button")).toHaveLength(2);
    await userEvent.click(within(menu).getByRole("button", { name: "New tab" }));
    await waitForTabListMenuClosed();
    await expect(canvas.getAllByRole("tab")).toHaveLength(2);
    await expect(canvas.getByRole("tab", { name: /^New tab/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  },
};
export const Wide: Story = {
  // Wide enough for every tab beside All tabs and the collapse button.
  args: { width: 1000, collapsible: true },
  play: async ({ canvasElement }) => {
    await checkStableControls(canvasElement);
    await checkAllTabsButton(canvasElement, false);
    // All tabs and the collapse button hold the strip's right end, past the free space after
    // the tabs. They are its only buttons outside the tabs: New tab lives in the All tabs menu.
    const canvas = within(canvasElement);
    const tablist = canvas.getByRole("tablist");
    const stripButtons = within(tablist.parentElement!)
      .getAllByRole("button")
      .filter((button) => !tablist.contains(button))
      .map((button) => button.getAttribute("aria-label"));
    await expect(stripButtons).toEqual(["All tabs", "Collapse sidebar"]);
    const row = tablist.getBoundingClientRect();
    const allTabs = canvas.getByRole("button", { name: "All tabs" }).getBoundingClientRect();
    const collapse = canvas
      .getByRole("button", { name: "Collapse sidebar" })
      .getBoundingClientRect();
    const strip = tablist.parentElement!.getBoundingClientRect();
    await expect(allTabs.left - row.right).toBeGreaterThan(8);
    await expect(collapse.left - allTabs.right).toBeGreaterThanOrEqual(0);
    await expect(collapse.left - allTabs.right).toBeLessThanOrEqual(8);
    await expect(strip.right - collapse.right).toBeLessThanOrEqual(9);
  },
};
export const Cramped: Story = {
  // A split pane at its minimum width (15% of a 300 px sidebar) has no room for all buttons.
  args: { width: 45, collapsible: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const collapse = canvas
      .getByRole("button", { name: "Collapse sidebar" })
      .getBoundingClientRect();
    const strip = canvas.getByRole("tablist").parentElement!.getBoundingClientRect();
    await expect(collapse.left).toBeGreaterThanOrEqual(strip.left);
    await expect(collapse.right).toBeLessThanOrEqual(strip.right);
  },
};
