import React from "react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { TabType } from "@/browser/types/rightSidebar";
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
  /** Optional callback to close this tab (for closeable tabs like terminals) */
  onClose?: () => void;
}

interface RightSidebarTabStripProps {
  items: RightSidebarTabStripItem[];
  ariaLabel?: string;
  /** Unique ID of this tabset (for drag/drop) */
  tabsetId: string;
  /** Called when user clicks the "+" button to add a new terminal */
  onAddTerminal?: () => void;
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
              "flex min-w-0 max-w-[240px] items-baseline gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all duration-150",
              "cursor-grab touch-none active:cursor-grabbing",
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
            {item.label}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {item.tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export const RightSidebarTabStrip: React.FC<RightSidebarTabStripProps> = ({
  items,
  ariaLabel = "Sidebar views",
  tabsetId,
  onAddTerminal,
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

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border-border-light titlebar-safe-right titlebar-safe-right-gutter-2 flex min-w-0 items-center border-b px-2 py-1.5 transition-colors",
        isDesktop && DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS,
        showDropHighlight && "bg-accent/30",
        isDraggingFromHere && "bg-accent/10",
        // In desktop mode, make header draggable for window movement
        isDesktop && "titlebar-drag"
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {/* The tablist owns only tabs (aria-required-children, #5951), so the "+" button is its
            sibling. `contents` keeps the tabs and the button in one wrapping row, as before. */}
        <div className="contents" role="tablist" aria-label={ariaLabel}>
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
        {onAddTerminal && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "text-muted hover:bg-hover hover:text-foreground shrink-0 rounded-md p-1 transition-colors",
                  isDesktop && "titlebar-no-drag"
                )}
                onClick={onAddTerminal}
                aria-label="New terminal"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New terminal</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};
