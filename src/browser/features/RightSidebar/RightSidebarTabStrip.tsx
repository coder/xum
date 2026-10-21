import React from "react";
import { cn } from "@/common/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { Check, ChevronDown, PanelRightClose, X } from "lucide-react";
import { isNewTab, type TabType } from "@/browser/types/rightSidebar";
import { formatKeybind, formatKeybindForAria, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  isDesktopMode,
  DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS,
} from "@/browser/hooks/useDesktopTitlebar";
import { NewTabLabel } from "./Tabs/TabLabels";

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
  /** Row content in the All tabs menu when `label` holds buttons of its own. Default: `label`. */
  menuLabel?: React.ReactNode;
}

interface RightSidebarTabStripProps {
  items: RightSidebarTabStripItem[];
  ariaLabel?: string;
  /** Unique ID of this tabset (for drag/drop) */
  tabsetId: string;
  /** The All tabs menu's New tab row: open (or show) this tabset's New tab */
  onAddNewTab: () => void;
  /** Collapses the sidebar. Only the strip at the sidebar's top-right corner gets it. */
  onCollapseSidebar?: () => void;
}

/**
 * Individual sortable tab button using @dnd-kit.
 * Uses useSortable for drag + drop within the same tabset.
 */
const SortableTab: React.FC<{
  item: RightSidebarTabStripItem;
  index: number;
  tabsetId: string;
}> = ({ item, index, tabsetId }) => {
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
    <div className="relative shrink-0" style={style}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            ref={setNodeRef}
            {...attributes}
            {...(listeners ?? {})}
            className={cn(
              "group relative flex min-w-0 max-w-[240px] items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150",
              // Let touch users pan the overflowing strip; mouse pointers still drag/reorder.
              "cursor-grab touch-pan-x active:cursor-grabbing",
              // Reserve the X's space even while hidden: hovering/focusing/selecting a tab must
              // neither cover its text nor change its label width (especially for long titles).
              // Phones reserve row height/padding for the 44px touch X. Tablets keep the desktop
              // row height (44px rows made the strip far taller than the header) and reserve
              // the X's 24px touch target.
              item.closeLabel != null &&
                item.onClose &&
                "pr-6 [@media(min-width:769px)_and_(pointer:coarse)]:pr-7 [@media(max-width:768px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:768px)_and_(pointer:coarse)]:pr-12",
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
        {/* No tooltip, no empty bubble: tabs without a shortcut (or with shortcuts hidden). */}
        {item.tooltip != null && (
          <TooltipContent side="bottom" align="center">
            {item.tooltip}
          </TooltipContent>
        )}
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
      // Touch grows the X to a 24px target (44px on phones, from the global phone floor). Its
      // fill would then paint a grey square beside every unselected tab label, so touch keeps
      // the larger target but drops the fill.
      "text-muted hover:text-foreground absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-0.5 [@media(pointer:coarse)]:min-h-6 [@media(pointer:coarse)]:min-w-6 [@media(pointer:coarse)]:bg-transparent",
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

/** True inside a strip control that acts on the whole sidebar: using it must not focus its pane. */
export function isSidebarControlTarget(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-sidebar-control]") != null;
}

/**
 * Icon buttons after the tabs (All tabs, collapse). Coarse pointers get a 24px target:
 * tablets have no global touch floor (phones get 44px from it).
 */
function stripIconButtonClassName(isDesktop: boolean): string {
  return cn(
    "text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent flex shrink-0 items-center justify-center rounded-md p-1 transition-colors focus-visible:ring-1 [@media(pointer:coarse)]:min-h-6 [@media(pointer:coarse)]:min-w-6",
    isDesktop && "titlebar-no-drag"
  );
}

const StripIconButton: React.FC<{
  label: string;
  isDesktop: boolean;
  sidebarControl?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = (props) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        data-sidebar-control={props.sidebarControl ? "" : undefined}
        className={stripIconButtonClassName(props.isDesktop)}
        onClick={props.onClick}
        aria-label={props.label}
      >
        {props.children}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">{props.label}</TooltipContent>
  </Tooltip>
);

const TAB_LIST_LABEL = "All tabs";

/** Arrow keys move between the menu's rows, like a menu (Tab works too). */
function handleTabListArrowKeys(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:enabled"));
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = event.key === "ArrowDown" ? index + 1 : index - 1;
  rows[Math.min(Math.max(next, 0), rows.length - 1)]?.focus();
}

/** A row of the All tabs menu; a check marks the selected tab. */
const TabListMenuRow: React.FC<{
  label: React.ReactNode;
  selected: boolean;
  disabled?: boolean;
  keyShortcuts?: string;
  onPick: () => void;
  children?: React.ReactNode;
}> = (props) => (
  <button
    type="button"
    disabled={props.disabled}
    aria-current={props.selected || undefined}
    aria-keyshortcuts={props.keyShortcuts}
    className="text-content-secondary hover:bg-hover focus:bg-hover flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none disabled:opacity-50"
    onClick={props.onPick}
  >
    <Check className={cn("h-3 w-3 shrink-0", !props.selected && "invisible")} />
    <span className="flex min-w-0 items-center gap-1.5 truncate">{props.label}</span>
    {props.children}
  </button>
);

/**
 * Lists every tab in the strip, so a tab scrolled out of the row is one pick away (a narrow
 * pane shows only a tab or two, and touch users may not know the row scrolls). Its last row
 * opens (or shows) the New tab, which therefore has no row among the tabs.
 */
const TabListMenu: React.FC<{
  items: RightSidebarTabStripItem[];
  isDesktop: boolean;
  onAddNewTab: () => void;
}> = (props) => {
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  const tabRows = props.items.filter((item) => !isNewTab(item.tab));
  const newTabSelected = props.items.some((item) => isNewTab(item.tab) && item.selected);

  // A pick moves focus out of the menu (to the tab, or into the New tab's launcher), so Radix
  // does not send it back to this button on close.
  const pick = (item: RightSidebarTabStripItem) => {
    setOpen(false);
    item.onSelect();
    // The strip scrolls the selected tab into view itself; focus() would also scroll the
    // sidebar's overflow-hidden ancestors.
    document.getElementById(item.id)?.focus({ preventScroll: true });
  };
  const pickNewTab = () => {
    setOpen(false);
    props.onAddNewTab();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={tooltipOpen && !open} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={stripIconButtonClassName(props.isDesktop)}
              aria-label={TAB_LIST_LABEL}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{TAB_LIST_LABEL}</TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        side="bottom"
        align="end"
        aria-label={TAB_LIST_LABEL}
        className="max-h-(--radix-popover-content-available-height) w-max max-w-[min(20rem,calc(100vw-1rem))] !min-w-[10rem] overflow-y-auto p-1"
        onOpenAutoFocus={(event) => {
          // Open on the selected tab's row, like a select.
          event.preventDefault();
          contentRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
        }}
        onKeyDown={handleTabListArrowKeys}
      >
        {tabRows.map((item) => (
          <TabListMenuRow
            key={item.id}
            label={item.menuLabel ?? item.label}
            selected={item.selected}
            disabled={item.disabled}
            onPick={() => pick(item)}
          />
        ))}
        {tabRows.length > 0 && (
          <div role="separator" className="border-separator-light my-1 border-t" />
        )}
        <TabListMenuRow
          label={<NewTabLabel />}
          selected={newTabSelected}
          keyShortcuts={formatKeybindForAria(KEYBINDS.NEW_SIDEBAR_TAB)}
          onPick={pickNewTab}
        >
          {/* Screen readers get it from aria-keyshortcuts. Phones have no keyboard: hidden. */}
          <span
            aria-hidden="true"
            className="text-muted mobile-hide-shortcut-hints ml-auto shrink-0 pl-2 text-[10px]"
          >
            ({formatKeybind(KEYBINDS.NEW_SIDEBAR_TAB)})
          </span>
        </TabListMenuRow>
      </PopoverContent>
    </Popover>
  );
};

/** The strip's right end, past the free space after the tabs: All tabs and the collapse button. */
const StripEndControls: React.FC<{
  items: RightSidebarTabStripItem[];
  isDesktop: boolean;
  onAddNewTab: () => void;
  onCollapseSidebar?: () => void;
}> = (props) => (
  <div className="ml-auto flex shrink-0 items-center gap-1">
    <TabListMenu items={props.items} isDesktop={props.isDesktop} onAddNewTab={props.onAddNewTab} />
    {props.onCollapseSidebar && (
      <StripIconButton
        label="Collapse sidebar"
        isDesktop={props.isDesktop}
        sidebarControl
        onClick={props.onCollapseSidebar}
      >
        <PanelRightClose className="h-3.5 w-3.5" />
      </StripIconButton>
    )}
  </div>
);

/**
 * One row that never wraps: extra tabs scroll sideways (hidden scrollbar, faded edges) while the
 * controls after it stay in view. Its wrapper holds the desktop no-drag box over the row's
 * visible part (see the strip's drag regions). `rowRef` is destructured on purpose: React
 * Compiler rejects reading a ref prop as `props.rowRef` during render ("Cannot access refs
 * during render") and would leave this row uncompiled.
 */
const TabScrollRow: React.FC<{
  rowRef: React.RefObject<HTMLDivElement>;
  ariaLabel: string;
  items: RightSidebarTabStripItem[];
  tabsetId: string;
  isDesktop: boolean;
}> = ({ rowRef, ...props }) => (
  <div className="relative flex min-w-0">
    {props.isDesktop && (
      <div aria-hidden className="titlebar-no-drag pointer-events-none absolute inset-0" />
    )}
    <div
      ref={rowRef}
      data-tab-scroll-row
      role="tablist"
      aria-label={props.ariaLabel}
      className="scrollbar-none scroll-fade-x flex min-w-0 flex-initial flex-nowrap items-center gap-1 overflow-x-auto"
    >
      {props.items.map((item, index) => (
        <SortableTab key={item.id} item={item} index={index} tabsetId={props.tabsetId} />
      ))}
    </div>
  </div>
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
  // A tab too wide for both fade margins gets smaller ones, so it fits whole (its X included)
  // when the row can hold it. A tab wider than the row keeps its start clear of the fade.
  const spare = row.clientWidth - tabRect.width;
  const margin = spare < 0 ? SCROLL_FADE_PX : Math.min(SCROLL_FADE_PX, spare / 2);
  let next = row.scrollLeft;
  // A fade only shows on a side with more content past it, so the first and last tabs need
  // no margin (the clamp below lets them reach the very edge).
  if (tabEnd + margin > row.scrollLeft + row.clientWidth) {
    next = tabEnd + margin - row.clientWidth;
  }
  if (tabStart - margin < next) {
    next = tabStart - margin;
  }
  next = Math.max(0, Math.min(maxScroll, next));
  if (Math.abs(next - row.scrollLeft) >= 1) row.scrollLeft = next;
}

export const RightSidebarTabStrip: React.FC<RightSidebarTabStripProps> = ({
  items,
  ariaLabel = "Sidebar views",
  tabsetId,
  onAddNewTab,
  onCollapseSidebar,
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
        "border-border-light titlebar-safe-right-capped titlebar-safe-right-gutter-2 relative flex min-w-0 items-center gap-1 border-b px-2 py-1.5 transition-colors",
        // With the collapse button, a pane at its minimum width cannot fit all buttons: overflow
        // on the left (the Panel clips it) so the collapse button stays visible. With room to
        // spare, the right-end group's ml-auto takes the free space and this has no effect.
        "has-[[data-sidebar-control]]:justify-end",
        // Desktop title bar: its height, and no text selection, as `.titlebar-drag` areas have.
        isDesktop && [DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS, "select-none"],
        showDropHighlight && "bg-accent/30",
        isDraggingFromHere && "bg-accent/10"
      )}
    >
      {/* Desktop drag regions. Chromium does not clip region rects to the scrolling row, Electron
          lets the later rect win, and app-region inherits (an explicit `none` still reports a
          no-drag rect). So no ancestor of the tabs may set a region, or a scrolled-out tab's own
          rect would cover the workspace header and the strip's empty space. Instead, a drag
          backdrop fills the strip, and a no-drag sibling of the row covers exactly the row's
          visible box, which keeps the visible tabs clickable. */}
      {isDesktop && (
        <div aria-hidden className="titlebar-drag pointer-events-none absolute inset-0" />
      )}
      <TabScrollRow
        rowRef={scrollRowRef}
        ariaLabel={ariaLabel}
        items={items}
        tabsetId={tabsetId}
        isDesktop={isDesktop}
      />
      <StripEndControls
        items={items}
        isDesktop={isDesktop}
        onAddNewTab={onAddNewTab}
        onCollapseSidebar={onCollapseSidebar}
      />
    </div>
  );
};
