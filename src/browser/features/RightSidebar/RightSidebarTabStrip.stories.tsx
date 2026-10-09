import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
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

function StripFixture(props: { width: number }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [selected, setSelected] = useState<TabType>("new");
  const [closed, setClosed] = useState<TabType[]>([]);
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
  const items = definitions
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
          <DndContext sensors={sensors}>
            <SortableContext
              items={items.map((item) => `fixture:${item.tab}`)}
              strategy={horizontalListSortingStrategy}
            >
              <RightSidebarTabStrip
                items={items}
                tabsetId="fixture"
                onAddNewTab={() => setSelected("new")}
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

export const Narrow: Story = {
  args: { width: 300 },
  play: async ({ canvasElement }) => checkStableControls(canvasElement),
};
export const Wide: Story = {
  args: { width: 900 },
  play: async ({ canvasElement }) => checkStableControls(canvasElement),
};
