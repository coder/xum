import React from "react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { Plus, X } from "lucide-react";
import type { TabType } from "@/browser/types/rightSidebar";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  isDesktopMode,
  DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS,
} from "@/browser/hooks/useDesktopTitlebar";

// Re-export for consumers that import from this file
export { getTabName } from "./Tabs";

/** Data attached to dragged sidebar tabs */
export interface TabDragData {
  tab: TabType;
  sourceTabsetId: string;
  index: number;
}

export interface RightSidebarTabStripItem {
  id: string;
  panelId: string;
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  tooltip: React.ReactNode;
  disabled?: boolean;
  /** The tab type (used for drag identification) */
  tab: TabType;
  /** Closes this tab (X button, middle-click). Absent when closing would do nothing. */
  onClose?: () => void;
  /**
   * Accessible name of the strip-rendered X button. Unset for labels that render their own
   * close button (terminal, side chat), so the tab never shows two.
   */
  closeLabel?: string;
}

interface RightSidebarTabStripProps {
  items: RightSidebarTabStripItem[];
  ariaLabel?: string;
  /** Unique ID of this tabset (for drag/drop) */
  tabsetId: string;
  /** Called when user clicks the "+" button to open (or show) this tabset's New tab */
  onAddNewTab?: () => void;
}

/**
 * Individual sortable tab button using @dnd-kit.
 * Uses useSortable for drag + drop within the same tabset.
 */
const SortableTab: React.FC<{
  item: RightSidebarTabStripItem;
  index: number;
  tabsetId: string;
  isDesktop: boolean;
}> = ({ item, index, tabsetId, isDesktop }) => {
  // Create a unique sortable ID that encodes tabset + tab
  const sortableId = `${tabsetId}:${item.tab}`;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: {
      tab: item.tab,
      sourceTabsetId: tabsetId,
      index,
    } satisfies TabDragData,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const sortableOnKeyDown = listeners?.onKeyDown;

  return (
    <div className={cn("relative shrink-0", isDesktop && "titlebar-no-drag")} style={style}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            ref={setNodeRef}
            {...attributes}
            {...(listeners ?? {})}
            className={cn(
              "group relative flex min-w-0 max-w-[240px] items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150",
              "cursor-grab touch-none active:cursor-grabbing",
              // Reserve the X's space even while hidden: hovering/focusing/selecting a tab must
              // neither cover its text nor change its label width (especially for long titles).
              // Reserve the existing mobile CSS's larger hit target too, so it can't cover text.
              item.closeLabel != null &&
                item.onClose &&
                "pr-6 [@media(max-width:768px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:768px)_and_(pointer:coarse)]:pr-12",
              item.selected
                ? "bg-hover text-foreground"
                : "bg-transparent text-muted hover:bg-hover/50 hover:text-foreground",
              item.disabled && "pointer-events-none opacity-50",
              isDragging && "cursor-grabbing opacity-50"
            )}
            onClick={item.onSelect}
            onKeyDown={(e) => {
              // Ignore bubbled key events from nested elements (e.g. close/pop-out buttons)
              // so Enter/Space still activates those buttons instead of selecting the tab.
              if (e.currentTarget !== e.target) {
                return;
              }

              sortableOnKeyDown?.(e);
              if (e.defaultPrevented) {
                return;
              }

              if (!item.disabled && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                item.onSelect();
              }
            }}
            onAuxClick={(e) => {
              // Middle-click (button 1) closes closeable tabs
              if (e.button === 1 && item.onClose) {
                e.preventDefault();
                item.onClose();
              }
            }}
            id={item.id}
            role="tab"
            aria-selected={item.selected}
            aria-controls={item.panelId}
            aria-disabled={item.disabled ? true : undefined}
            tabIndex={item.disabled ? -1 : (attributes.tabIndex ?? 0)}
          >
            {/* Long labels truncate inside the tab instead of stretching the strip. */}
            <span className="flex min-w-0 items-center gap-1.5 truncate">{item.label}</span>
            {item.onClose && item.closeLabel != null && (
              <TabCloseButton
                label={item.closeLabel}
                selected={item.selected}
                onClose={item.onClose}
              />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {item.tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

/**
 * X button for tabs whose label has no close button of its own. Absolutely positioned so it
 * takes no room: all closeable tabs reserve the same padding for it, whether it is visible or
 * not. Keyboard focus on the tab reveals the X before Tab reaches it. Touch shows it always,
 * since touch users cannot hover. `invisible` keeps a hidden X from catching label clicks.
 */
const TabCloseButton: React.FC<{
  label: string;
  selected: boolean;
  onClose: () => void;
}> = (props) => (
  <button
    type="button"
    className={cn(
      "text-muted hover:text-foreground absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5",
      props.selected
        ? "bg-hover"
        : "bg-hover invisible group-focus-within:visible group-hover:visible [@media(pointer:coarse)]:visible"
    )}
    onClick={(e) => {
      e.stopPropagation();
      props.onClose();
    }}
    aria-label={props.label}
  >
    <X className="h-3 w-3" />
  </button>
);

/** Width of the `.scroll-fade-x` edge fade (scrollbar-none.css): a tab under it looks cut off. */
const SCROLL_FADE_PX = 24;

/**
 * Scroll the row (only as far as needed) so its selected tab is fully visible and clear of the
 * edge fades. Computed against the row instead of `scrollIntoView`, which also scrolls
 * overflow-hidden ancestors and ignores the fades.
 */
function revealSelectedTab(row: HTMLElement): void {
  const tab = row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (tab == null) return;
  const rowRect = row.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const tabStart = tabRect.left - rowRect.left + row.scrollLeft;
  const tabEnd = tabStart + tabRect.width;
  const maxScroll = row.scrollWidth - row.clientWidth;
  let next = row.scrollLeft;
  // A fade only shows on a side with more content past it, so the first and last tabs need
  // no margin (the clamp below lets them reach the very edge).
  if (tabEnd + SCROLL_FADE_PX > row.scrollLeft + row.clientWidth) {
    next = tabEnd + SCROLL_FADE_PX - row.clientWidth;
  }
  if (tabStart - SCROLL_FADE_PX < next) {
    next = tabStart - SCROLL_FADE_PX;
  }
  next = Math.max(0, Math.min(maxScroll, next));
  if (Math.abs(next - row.scrollLeft) >= 1) row.scrollLeft = next;
}

export const RightSidebarTabStrip: React.FC<RightSidebarTabStripProps> = ({
  items,
  ariaLabel = "Sidebar views",
  tabsetId,
  onAddNewTab,
}) => {
  const { active } = useDndContext();
  const activeData = active?.data.current as TabDragData | undefined;

  // Track if we're dragging from this tabset (for visual feedback)
  const isDraggingFromHere = activeData?.sourceTabsetId === tabsetId;

  // Make the tabstrip a drop target for tabs from OTHER tabsets
  const { setNodeRef, isOver } = useDroppable({
    id: `tabstrip:${tabsetId}`,
    data: { tabsetId },
  });

  const canDrop = activeData !== undefined && activeData.sourceTabsetId !== tabsetId;
  const showDropHighlight = isOver && canDrop;

  // In desktop mode, add right padding for Windows/Linux titlebar overlay buttons
  const isDesktop = isDesktopMode();

  // The strip is a single scrolling row, so the selected tab can sit past the visible edge:
  // selected by a shortcut, the launcher, or an event, or pushed out when tabs before it grow
  // (Stats gains its cost badge, counts load) or the pane narrows. Keep it fully visible,
  // clear of the edge fades, whenever the selection or any size in the row changes. An effect
  // because it syncs with layout; the ResizeObserver supplies the size changes.
  const scrollRowRef = React.useRef<HTMLDivElement>(null);
  const selectedItemId = items.find((item) => item.selected)?.id;
  const itemIdsKey = items.map((item) => item.id).join("|");
  React.useEffect(() => {
    const row = scrollRowRef.current;
    if (row == null || selectedItemId == null) return;
    const reveal = () => revealSelectedTab(row);
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [selectedItemId, itemIdsKey]);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        // Capped inset: the tabs live in one scrolling row, so the full overlay inset on a
        // narrow pane would shrink that row to zero and hide every tab.
        "border-border-light titlebar-safe-right-capped titlebar-safe-right-gutter-2 flex min-w-0 items-center gap-1 border-b px-2 py-1.5 transition-colors",
        isDesktop && DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS,
        showDropHighlight && "bg-accent/30",
        isDraggingFromHere && "bg-accent/10",
        // In desktop mode, make header draggable for window movement
        isDesktop && "titlebar-drag"
      )}
    >
      {/* One row that never wraps: extra tabs scroll sideways (hidden scrollbar, faded edges). */}
      <div
        ref={scrollRowRef}
        data-tab-scroll-row
        role="tablist"
        aria-label={ariaLabel}
        className="scrollbar-none scroll-fade-x flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto"
      >
        {items.map((item, index) => (
          <SortableTab
            key={item.id}
            item={item}
            index={index}
            tabsetId={tabsetId}
            isDesktop={isDesktop}
          />
        ))}
      </div>
      {/* Outside the scrolling row so it stays visible however many tabs are open. */}
      {onAddNewTab && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "text-muted hover:bg-hover hover:text-foreground shrink-0 rounded-md p-1 transition-colors",
                isDesktop && "titlebar-no-drag"
              )}
              onClick={onAddNewTab}
              aria-label="New tab"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            New tab
            <span className="mobile-hide-shortcut-hints">
              {" "}
              ({formatKeybind(KEYBINDS.NEW_SIDEBAR_TAB)})
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
