import React from "react";
import { cn } from "@/common/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable, useDndContext } from "@dnd-kit/core";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import type { TabType } from "@/browser/types/rightSidebar";
import { formatKeybind, formatKeybindForAria, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  isDesktopMode,
  DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS,
} from "@/browser/hooks/useDesktopTitlebar";
import { RightSidebarToggleSpacer } from "@/browser/components/SidebarCollapseButton/SidebarCollapseButton";

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
  /** The "+" button after the tabs: open (or show) this tabset's New tab */
  onAddNewTab: () => void;
  /**
   * Ends with room for WorkspaceShell's right sidebar toggle, which sits over the sidebar's
   * top-right corner. Only the strip in that corner reserves it.
   */
  reservesSidebarToggle?: boolean;
}

/**
 * Individual sortable tab button using @dnd-kit.
 * Uses useSortable for drag + drop within the same tabset.
 */
const SortableTab: React.FC<{
  item: RightSidebarTabStripItem;
  index: number;
  tabsetId: string;
  /** The one tab that Tab reaches (roving tabindex); arrow keys reach the others. */
  isTabStop: boolean;
}> = ({ item, index, tabsetId, isTabStop }) => {
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
              // Arrow keys move focus without selecting (#7102), so the focused tab needs a mark of
              // its own, like the strip's icon buttons. Inset: the scrolling row clips an outer ring.
              "focus-visible:ring-accent outline-none focus-visible:ring-1 focus-visible:ring-inset",
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
            tabIndex={!item.disabled && isTabStop ? 0 : -1}
          >
            {/* Long labels truncate inside the tab instead of stretching the strip. */}
            <span className="flex min-w-0 items-center gap-1.5 truncate">{item.label}</span>
            {item.onClose && item.closeLabel != null && (
              <TabCloseButton
                label={item.closeLabel}
                selected={item.selected}
                tabbable={isTabStop}
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
  /** Only the tab stop's X is in the Tab order, so Shift+Tab from it leaves the row (#7102). */
  tabbable: boolean;
  onClose: () => void;
}> = (props) => (
  <button
    type="button"
    tabIndex={props.tabbable ? undefined : -1}
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

/**
 * Icon buttons after the tabs ("+", All tabs). Coarse pointers get a 24px target: tablets have no
 * global touch floor (phones get 44px from it).
 */
function stripIconButtonClassName(isDesktop: boolean): string {
  return cn(
    "text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent flex shrink-0 items-center justify-center rounded-md p-1 transition-colors focus-visible:ring-1 [@media(pointer:coarse)]:min-h-6 [@media(pointer:coarse)]:min-w-6",
    isDesktop && "titlebar-no-drag"
  );
}

const TAB_LIST_LABEL = "All tabs";
const NEW_TAB_LABEL = "New tab";

/**
 * Opens (or shows) this tabset's New tab. It sits right after the tabs, like a browser's "+",
 * so it follows the last tab; once the tabs overflow, the row scrolls while "+" stays in view.
 */
const NewTabButton: React.FC<{ isDesktop: boolean; onAddNewTab: () => void }> = (props) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        className={stripIconButtonClassName(props.isDesktop)}
        aria-label={NEW_TAB_LABEL}
        aria-keyshortcuts={formatKeybindForAria(KEYBINDS.NEW_SIDEBAR_TAB)}
        onClick={props.onAddNewTab}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">
      {NEW_TAB_LABEL}
      {/* Phones have no keyboard: hidden there. */}
      <span className="mobile-hide-shortcut-hints">
        {" "}
        ({formatKeybind(KEYBINDS.NEW_SIDEBAR_TAB)})
      </span>
    </TooltipContent>
  </Tooltip>
);

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
  onPick: () => void;
}> = (props) => (
  <button
    type="button"
    disabled={props.disabled}
    aria-current={props.selected || undefined}
    className="text-content-secondary hover:bg-hover focus:bg-hover flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none disabled:opacity-50"
    onClick={props.onPick}
  >
    <Check className={cn("h-3 w-3 shrink-0", !props.selected && "invisible")} />
    <span className="flex min-w-0 items-center gap-1.5 truncate">{props.label}</span>
  </button>
);

/**
 * Lists every tab in the strip, so a tab scrolled out of the row is one pick away (a narrow
 * pane shows only a tab or two, and touch users may not know the row scrolls). An open New tab
 * is listed like any other tab; the strip's "+" button opens one.
 */
const TabListMenu: React.FC<{
  items: RightSidebarTabStripItem[];
  isDesktop: boolean;
}> = (props) => {
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // A pick moves focus out of the menu (to the tab), so Radix does not send it back to this
  // button on close.
  const pick = (item: RightSidebarTabStripItem) => {
    setOpen(false);
    item.onSelect();
    // The strip scrolls the selected tab into view itself; focus() would also scroll the
    // sidebar's overflow-hidden ancestors.
    document.getElementById(item.id)?.focus({ preventScroll: true });
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
        {props.items.map((item) => (
          <TabListMenuRow
            key={item.id}
            label={item.menuLabel ?? item.label}
            selected={item.selected}
            disabled={item.disabled}
            onPick={() => pick(item)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
};

/** The strip's right end, past the free space after the tabs: All tabs and the toggle's room. */
const StripEndControls: React.FC<{
  items: RightSidebarTabStripItem[];
  isDesktop: boolean;
  reservesSidebarToggle: boolean;
}> = (props) => (
  <div
    className="ml-auto flex shrink-0 items-center gap-1"
    data-sidebar-toggle-room={props.reservesSidebarToggle || undefined}
  >
    <TabListMenu items={props.items} isDesktop={props.isDesktop} />
    {props.reservesSidebarToggle && <RightSidebarToggleSpacer />}
  </div>
);

/** Where each tab-moving key sends focus, from the focused tab's index among `count` tabs. */
const TAB_STRIP_FOCUS_MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

function hasModifierKey(event: React.KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * ArrowLeft/ArrowRight (wrapping), Home and End move focus between the tabs, per the WAI-ARIA
 * tabs pattern (#7102). They do not select the tab: Enter or Space does (manual activation), so
 * passing over a tab does not mount its panel (a terminal, the review diff).
 */
function handleTabStripKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  const move = TAB_STRIP_FOCUS_MOVES[event.key];
  // Keys from controls inside a tab (close, pop-out) and modified keys keep their own meaning.
  if (move == null || hasModifierKey(event)) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") return;
  const row = event.currentTarget;
  const tabs = Array.from(
    row.querySelectorAll<HTMLElement>('[role="tab"]:not([aria-disabled="true"])')
  );
  const index = tabs.indexOf(target);
  if (index < 0) return;
  event.preventDefault();
  const next = tabs[move(index, tabs.length)];
  // Like the All tabs menu: focus() would also scroll the sidebar's overflow-hidden ancestors.
  next.focus({ preventScroll: true });
  revealTab(row, next);
}

/**
 * The roving tab stop: the one tab that Tab and Shift+Tab reach. While focus is in the row, it is
 * the focused tab, so Shift+Tab from a tab reached by the arrow keys leaves the row instead of
 * going back to the selected tab. Otherwise it is the selected tab, or the first enabled one.
 */
function useRovingTabStop(items: RightSidebarTabStripItem[]): {
  tabStopId: string | undefined;
  onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLElement>) => void;
} {
  const [focusedTabId, setFocusedTabId] = React.useState<string | null>(null);
  return {
    tabStopId: pickTabStopId(items, focusedTabId),
    // Focus on a control inside a tab (its close button) keeps that tab as the stop.
    onFocus: (event) => {
      if (event.target.getAttribute("role") === "tab") setFocusedTabId(event.target.id);
    },
    onBlur: (event) => {
      if (!focusStaysIn(event)) setFocusedTabId(null);
    },
  };
}

function pickTabStopId(
  items: RightSidebarTabStripItem[],
  focusedTabId: string | null
): string | undefined {
  const enabled = items.filter((item) => !item.disabled);
  return (
    enabled.find((item) => item.id === focusedTabId)?.id ??
    enabled.find((item) => item.selected)?.id ??
    enabled[0]?.id
  );
}

function focusStaysIn(event: React.FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget;
  return next instanceof Node && event.currentTarget.contains(next);
}

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
}> = ({ rowRef, ...props }) => {
  const rovingTabStop = useRovingTabStop(props.items);
  return (
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
        onKeyDown={handleTabStripKeyDown}
        onFocus={rovingTabStop.onFocus}
        onBlur={rovingTabStop.onBlur}
      >
        {props.items.map((item, index) => (
          <SortableTab
            key={item.id}
            item={item}
            index={index}
            tabsetId={props.tabsetId}
            isTabStop={item.id === rovingTabStop.tabStopId}
          />
        ))}
      </div>
    </div>
  );
};

/** Width of the `.scroll-fade-x` edge fade (scrollbar-none.css): a tab under it looks cut off. */
const SCROLL_FADE_PX = 24;

/**
 * After a size change in the row (a badge loads, a font swaps), keep the selected tab in view. If
 * the arrow keys hold focus on another tab (#7102), keep that one in view instead: scrolling back
 * to the selected tab would hide where the user is.
 */
function revealSelectedTabOnResize(row: HTMLElement): void {
  const active = row.ownerDocument.activeElement;
  if (
    active instanceof HTMLElement &&
    row.contains(active) &&
    active.getAttribute("role") === "tab" &&
    active.getAttribute("aria-selected") !== "true"
  ) {
    revealTab(row, active);
  } else {
    revealSelectedTab(row);
  }
}

/** Keep the row's selected tab fully visible, clear of the edge fades (see `revealTab`). */
function revealSelectedTab(row: HTMLElement): void {
  const tab = row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (tab != null) revealTab(row, tab);
}

/**
 * Scroll the row (only as far as needed) so `tab` is fully visible and clear of the edge fades.
 * Computed against the row instead of `scrollIntoView`, which also scrolls overflow-hidden
 * ancestors and ignores the fades.
 */
function revealTab(row: HTMLElement, tab: HTMLElement): void {
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
  reservesSidebarToggle,
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
    const observer = new ResizeObserver(() => revealSelectedTabOnResize(row));
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
        "border-border-light titlebar-safe-right-capped titlebar-safe-right-gutter-2 relative flex min-w-0 items-center gap-1 border-b px-2 transition-colors",
        // As tall as the workspace header, so the right sidebar toggle over this strip's end and
        // over the header's end sit on one line in both states. Phones keep their taller rows
        // (44px touch tabs); only the full-screen sidebar shows the strip there.
        "[@media(max-width:768px)_and_(pointer:coarse)]:py-1.5",
        // The desktop title bar also takes no text selection, as `.titlebar-drag` areas have.
        isDesktop ? [DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS, "select-none"] : "min-h-8",
        // With the toggle's room, a pane at its minimum width cannot fit all controls: overflow on
        // the left (the Panel clips it) so the room under the toggle stays at the end. With room
        // to spare, the right-end group's ml-auto takes the free space and this has no effect.
        "has-[[data-sidebar-toggle-room]]:justify-end",
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
      <NewTabButton isDesktop={isDesktop} onAddNewTab={onAddNewTab} />
      <StripEndControls
        items={items}
        isDesktop={isDesktop}
        reservesSidebarToggle={reservesSidebarToggle === true}
      />
    </div>
  );
};
