import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
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
import { MOBILE_TOUCH_TARGET_PX } from "@/constants/layout";
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

function StripFixture(props: { width: number; collapsible: boolean }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [selected, setSelected] = useState<TabType>("new");
  const [closed, setClosed] = useState<TabType[]>([]);
  const [order, setOrder] = useState<TabType[]>([
    "new",
    "instructions",
    "side:side-title",
    "terminal:long-title",
  ]);
  const close = (tab: TabType) => setClosed((prev) => [...prev, tab]);
  const definitions: Array<
    Pick<RightSidebarTabStripItem, "tab" | "label" | "tooltip" | "closeLabel">
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
                onAddNewTab={() => setSelected("new")}
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
    if (
      window.matchMedia("(pointer: coarse)").matches &&
      ["new", "instructions"].includes(tab.id)
    ) {
      await expect(closeRect.width).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_PX);
      await expect(closeRect.height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_PX);
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

/** "+" follows the last tab; tabs that overflow scroll in their row without pushing it away. */
async function checkNewTabButton(canvasElement: HTMLElement, overflowing: boolean) {
  const canvas = within(canvasElement);
  const row = canvas.getByRole("tablist");
  const tabs = within(row).getAllByRole("tab");
  const plusButton = canvas.getByRole("button", { name: "New tab" });
  const plus = plusButton.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  await expect(row.scrollWidth > row.clientWidth).toBe(overflowing);
  await expect(plus.left - rowRect.right).toBeGreaterThanOrEqual(0);
  await expect(plus.left - rowRect.right).toBeLessThanOrEqual(8);
  await expect(plus.right).toBeLessThanOrEqual(row.parentElement!.getBoundingClientRect().right);
  const hit = document.elementFromPoint(plus.left + plus.width / 2, plus.top + plus.height / 2);
  await expect(hit != null && plusButton.contains(hit)).toBe(true);
  if (!overflowing) {
    await expect(rowRect.right - tabs[tabs.length - 1].getBoundingClientRect().right).toBeLessThan(
      1
    );
  }
}

export const Narrow: Story = {
  // No collapse button, like the phone full-screen strip (the test-runner swipes this one at
  // phone width, see .storybook/test-runner.ts).
  args: { width: 300, collapsible: false },
  play: async ({ canvasElement }) => {
    await checkStableControls(canvasElement);
    await checkNewTabButton(canvasElement, true);
  },
};
export const Wide: Story = {
  // Wide enough for every tab beside "+" and the collapse button.
  args: { width: 1000, collapsible: true },
  play: async ({ canvasElement }) => {
    await checkStableControls(canvasElement);
    await checkNewTabButton(canvasElement, false);
    // The collapse button holds the strip's right end, past the free space after "+".
    const canvas = within(canvasElement);
    const plus = canvas.getByRole("button", { name: "New tab" }).getBoundingClientRect();
    const collapse = canvas
      .getByRole("button", { name: "Collapse sidebar" })
      .getBoundingClientRect();
    const strip = canvas.getByRole("tablist").parentElement!.getBoundingClientRect();
    await expect(collapse.left - plus.right).toBeGreaterThan(8);
    await expect(strip.right - collapse.right).toBeLessThanOrEqual(9);
  },
};
