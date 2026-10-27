import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, KeyboardEventHandler, ReactNode, Ref, RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useChatPaneScope } from "@/browser/contexts/ChatPaneScopeContext";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { formatKeybind, formatKeybindForAria, type Keybind } from "@/browser/utils/ui/keybinds";
import { useChatDockColumnWidthClass } from "./chatDockColumn";
import {
  acceptsActivityPanelChord,
  CHAT_ACTIVITY_ORDER,
  useChatActivityOverflow,
  useChatActivitySheet,
  useCloseChatActivityPanelOnBodyEscape,
  useInChatActivityLine,
  useReleaseChatActivityPanelOnUnmount,
  type ChatActivityId,
} from "./chatActivityPanels";

interface ChatInputDecorationProps {
  expanded: boolean;
  onToggle: () => void;
  summary: ReactNode;
  renderExpanded?: () => ReactNode;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
  dataComponent?: string;
  /**
   * Optional icon rendered in the trailing slot of the collapsed row. When
   * omitted the component shows the default expand/collapse chevron. Pass a
   * custom icon (e.g. an external-link / arrow) for "link-style" decorations
   * whose `onToggle` navigates elsewhere instead of expanding inline.
   */
  trailingIcon?: ReactNode;
  /** Ref and key handler for the expanded content, for decorations with keyboard navigation. */
  contentRef?: Ref<HTMLDivElement>;
  onContentKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  /** Which shared panel slot this decoration uses when it renders as a live-line chip. */
  activityId?: ChatActivityId;
  /** Compact chip content in the live line; the full `summary` heads the open panel instead. */
  chip?: ReactNode;
  /** Accessible name for the chip, whose compact content is often just an icon and a count. */
  chipLabel?: string;
  chipClassName?: string;
  chipTooltip?: ReactNode;
  /**
   * "plain" draws the chip without a border and lets it take the line's free width (the TODO
   * chip, which names the current step); other chips sit at the line's end, next to Stop.
   */
  chipVariant?: "plain";
  /** Panel heading, also the panel's accessible name; without it the `summary` heads the panel. */
  panelTitle?: string;
  /** Muted detail after the title, e.g. "2 running". */
  panelMeta?: ReactNode;
  /** Formatted shortcut that toggles this panel, shown in its heading (desktop only). */
  panelShortcut?: string;
  /**
   * Chord that opens this panel from anywhere in the chat pane and focuses it; again, or Esc,
   * closes it and returns focus to where it was. The chip's tooltip and the panel heading show it.
   */
  panelKeybind?: Keybind;
  /** Key hints under the list (desktop only: phones have no keyboard to hint at). */
  panelFooter?: ReactNode;
  /**
   * The chip by name (icon, name and count): its panel's tab in the phone activity sheet, and its
   * entry in the "+N" chip's list when the line has no room for the chip.
   */
  tab?: ReactNode;
}

/**
 * One activity summary above the composer (TODO, sub-agents, background bashes, reviews, Chat
 * Instructions). Inside the composer's live line it renders as a compact chip whose list opens in
 * a panel over the transcript; elsewhere (the VS Code webview's tray) it keeps the full-width row.
 */
export function ChatInputDecoration(props: ChatInputDecorationProps) {
  return useInChatActivityLine() ? (
    <ChatActivityChip {...props} />
  ) : (
    <ChatInputDecorationRow {...props} />
  );
}

// Keep collapsible decorations aligned with the chat input gutter so swapping
// between pending reviews, queued messages, and background bash banners does
// not make the stack jump horizontally in collapsed state. Encapsulating the
// shared wrapper/button structure here also prevents the collapsed chrome from
// drifting again as individual decorations evolve, while `renderExpanded`
// keeps large hidden detail trees out of collapsed rerenders.
function ChatInputDecorationRow(props: ChatInputDecorationProps) {
  const columnWidthClass = useChatDockColumnWidthClass();

  return (
    <div
      className={cn("bg-surface-primary", CHAT_DOCK_GUTTER_CLASS, props.className)}
      data-component={props.dataComponent}
    >
      <button
        type="button"
        onClick={props.onToggle}
        className={cn(
          // Use a fixed collapsed row height so every decoration reads with the
          // same top/bottom breathing room regardless of icon/text mix.
          "group mobile-touch-row flex h-6 items-center gap-2 text-xs leading-none transition-colors",
          columnWidthClass,
          props.summaryClassName
        )}
      >
        {props.summary}
        <div className="ml-auto">
          {/* mutation-equivalent: trailingIcon is an icon element or absent, never another falsy node */}
          {props.trailingIcon ??
            (props.expanded ? (
              <ChevronDown className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
            ) : (
              <ChevronRight className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
            ))}
        </div>
      </button>
      {props.expanded && props.renderExpanded && (
        <div
          ref={props.contentRef}
          onKeyDown={props.onContentKeyDown}
          className={cn(columnWidthClass, props.contentClassName)}
        >
          {props.renderExpanded()}
        </div>
      )}
    </div>
  );
}

/** Escape closes an open panel instead of reaching the global handler that interrupts the stream. */
function closeOnEscape(event: KeyboardEvent<HTMLElement>, close: () => void): void {
  // A list that handles Escape itself (by preventing default) keeps it.
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  stopKeyboardPropagation(event);
  close();
}

/** A shortcut in a chip's tooltip; hidden on phones, which have no keyboard to hint at. */
export const ACTIVITY_SHORTCUT_HINT_CLASS =
  "ml-1.5 font-mono text-[10px] opacity-70 [@media(max-width:768px)]:hidden";

/** A running indicator inside a chip (bashes running, sub-agents working). */
export function ActivityChipLiveDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--color-success)]" />;
}

/** Focus for a closing panel: its chip, or the "+N" chip while the line has no room for it. */
function focusChip(chip: HTMLButtonElement | null, overflowed: boolean): void {
  if (overflowed) {
    chip
      ?.closest("[data-activity-strip]")
      ?.querySelector<HTMLElement>("[data-activity-overflow-chip]")
      ?.focus();
  } else {
    chip?.focus();
  }
}

const PANEL_FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The open panel's first control, else the panel itself (a TODO list has no controls). */
function focusPanel(panelId: string): void {
  const panel = document.getElementById(panelId);
  const content = panel?.querySelector("[data-activity-panel-content]");
  (content?.querySelector<HTMLElement>(PANEL_FOCUSABLE) ?? panel)?.focus();
}

/**
 * The chip's `panelKeybind`. The chord opens the panel and moves focus into it, recording where
 * focus was (usually the composer) so closing returns there; with focus in the open panel, the
 * chord closes it. With the panel open and focus elsewhere (Tab back to the composer), it moves
 * focus back in rather than closing, as the background bashes shortcut does: the chord is how the
 * keyboard reaches the list.
 */
function usePanelChord(options: {
  keybind: Keybind | undefined;
  open: boolean;
  panelId: string;
  chipRef: RefObject<HTMLButtonElement | null>;
  returnFocusRef: { current: HTMLElement | null };
  onOpen: () => void;
  onClose: () => void;
}): void {
  const { keybind, open, panelId, chipRef, returnFocusRef, onOpen, onClose } = options;
  const paneScope = useChatPaneScope();
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (keybind === undefined) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!acceptsActivityPanelChord(event, keybind, paneScope, chipRef.current)) return;
      event.preventDefault();
      if (event.repeat) return;
      const panel = document.getElementById(panelId);
      const active = document.activeElement;
      if (open && panel?.contains(active)) {
        onClose();
        return;
      }
      if (active instanceof HTMLElement && active !== document.body) {
        returnFocusRef.current = active;
      }
      if (!open) onOpen();
      setFocusRequest((request) => request + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybind, open, panelId, paneScope, chipRef, returnFocusRef, onOpen, onClose]);
  // After the commit that renders the panel. On phones the sheet then keeps this focus.
  useEffect(() => {
    if (focusRequest > 0) focusPanel(panelId);
  }, [focusRequest, panelId]);
}

/** The chip, its tab in the phone activity sheet, and its panel while open. */
function ChatActivityChip(props: ChatInputDecorationProps) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useReleaseChatActivityPanelOnUnmount(props.activityId);
  const { overflow, moreList } = useChatActivityOverflow();
  const overflowed = props.activityId !== undefined && overflow.includes(props.activityId);
  const renderPanel = props.expanded ? props.renderExpanded : undefined;
  const open = renderPanel !== undefined;
  // mutation-equivalent: chip is an element or absent, never another falsy node
  const chipContent = props.chip ?? props.summary;
  // Where focus was when the chord opened the panel; closing returns there instead of the chip.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Closed another way (the chip, a press outside): the next close starts from the chip again.
    if (!open) returnFocusRef.current = null;
  }, [open]);
  const close = () => {
    const origin = returnFocusRef.current;
    props.onToggle();
    if (origin?.isConnected === true) {
      origin.focus();
    } else {
      // mutation-equivalent: close runs only from the chip's own handlers and listener, so the chip is mounted
      focusChip(chipRef.current, overflowed);
    }
  };
  useCloseChatActivityPanelOnBodyEscape(open, close);
  usePanelChord({
    keybind: props.renderExpanded === undefined ? undefined : props.panelKeybind,
    open,
    panelId,
    chipRef,
    returnFocusRef,
    onOpen: props.onToggle,
    onClose: close,
  });
  const shortcut = props.panelKeybind === undefined ? undefined : formatKeybind(props.panelKeybind);
  const tooltip =
    shortcut === undefined ? (
      props.chipTooltip
    ) : (
      <>
        {props.chipTooltip ?? props.panelTitle}
        <kbd className={ACTIVITY_SHORTCUT_HINT_CLASS}>{shortcut}</kbd>
      </>
    );

  return (
    <div className="contents" data-component={props.dataComponent}>
      <ChatActivityChipButton
        chipRef={chipRef}
        hasPanel={props.renderExpanded !== undefined}
        open={open}
        panelId={panelId}
        label={props.chipLabel}
        tooltip={tooltip}
        keyShortcuts={
          props.panelKeybind === undefined ? undefined : formatKeybindForAria(props.panelKeybind)
        }
        variant={props.chipVariant}
        activityId={props.activityId}
        overflowed={overflowed}
        className={props.chipClassName}
        onToggle={props.onToggle}
        onClose={close}
      >
        {chipContent}
      </ChatActivityChipButton>
      {overflowed &&
        moreList !== null &&
        createPortal(
          <ChatActivityMoreEntry activityId={props.activityId} onOpen={props.onToggle}>
            {/* mutation-equivalent: tab is an element or absent, never another falsy node */}
            {props.tab ?? chipContent}
          </ChatActivityMoreEntry>,
          moreList
        )}
      {props.renderExpanded !== undefined && (
        <ChatActivitySheetTab
          activityId={props.activityId}
          open={open}
          panelId={panelId}
          onOpen={props.onToggle}
        >
          {/* mutation-equivalent: tab is an element or absent, never another falsy node */}
          {props.tab ?? chipContent}
        </ChatActivitySheetTab>
      )}
      {renderPanel && (
        <ChatActivityChipPanel
          {...props}
          panelShortcut={props.panelShortcut ?? shortcut}
          panelId={panelId}
          onClose={close}
          renderPanel={renderPanel}
        />
      )}
    </div>
  );
}

interface ChatActivityPanelProps extends ChatInputDecorationProps {
  panelId: string;
  /** Closes the panel and returns focus to its chip. */
  onClose: () => void;
  renderPanel: () => ReactNode;
}

/**
 * The open panel. On wide viewports it is a popover positioned against the live line (the nearest
 * positioned ancestor), just above it and over the transcript, so the composer does not move when
 * a list opens: anchored to the line's start for the TODO chip, which sits at the start, and to
 * its end for the chips beside Stop. On phones (narrow or short viewports) it opens in the line's
 * activity sheet instead (see ChatActivityPanelsProvider).
 */
function ChatActivityChipPanel(props: ChatActivityPanelProps) {
  const sheet = useChatActivitySheet();
  return sheet === null ? (
    <ChatActivityPopover {...props} />
  ) : (
    createPortal(<ChatActivitySheetPanel {...props} />, sheet.body)
  );
}

function ChatActivityPopover(props: ChatActivityPanelProps) {
  return (
    <div
      id={props.panelId}
      // A group, not a dialog: the popover is a non-modal disclosure of its chip, and a dialog
      // opened from one of its rows (bash output) stays the page's only dialog.
      role="group"
      aria-label={props.panelTitle ?? props.chipLabel}
      data-activity-panel=""
      // Its shortcut focuses the panel itself when the list has no controls.
      tabIndex={-1}
      onKeyDown={(event) => closeOnEscape(event, props.onClose)}
      className={cn(
        "bg-surface-primary border-border-medium absolute outline-none bottom-full z-30 mb-1 flex max-h-[min(55vh,26rem)] w-[min(30rem,100%)] flex-col overflow-hidden rounded-lg border shadow-lg",
        props.chipVariant === "plain" ? "left-0" : "right-0"
      )}
    >
      {/* min-h, not h: touch phones grow the Close button to 44px (globals.css), and the panel
          clips overflow, so a fixed 32px header would cut its touch target. */}
      <div className="border-border-light flex min-h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-3 text-xs leading-none">
        <PanelHeading {...props} />
        <kbd className="border-border-medium text-muted ml-auto rounded border px-1 py-[1px] font-sans text-[10px] leading-none">
          {props.panelShortcut ?? "Esc"}
        </kbd>
        <button
          type="button"
          aria-label="Close"
          onClick={props.onClose}
          className="text-muted hover:text-foreground inline-flex size-6 items-center justify-center rounded-sm transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {/* The content's own key handler runs before the panel's (events bubble from it). */}
      <div
        ref={props.contentRef}
        data-activity-panel-content=""
        onKeyDown={props.onContentKeyDown}
        className={cn("min-h-0 overflow-y-auto px-1", props.contentClassName)}
      >
        {props.renderPanel()}
      </div>
      {props.panelFooter !== undefined && (
        <div className="border-border-light text-muted shrink-0 border-t px-3 py-2 text-[11px] leading-none">
          {props.panelFooter}
        </div>
      )}
    </div>
  );
}

function ChatActivitySheetPanel(props: ChatActivityPanelProps) {
  return (
    <div
      id={props.panelId}
      role="tabpanel"
      aria-label={props.panelTitle ?? props.chipLabel}
      data-activity-panel=""
      tabIndex={-1}
      onKeyDown={(event) => closeOnEscape(event, props.onClose)}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <div className="text-muted shrink-0 px-4 pt-3 pb-1 text-xs">
        {props.panelMeta ?? props.summary}
      </div>
      <div
        ref={props.contentRef}
        data-activity-panel-content=""
        onKeyDown={props.onContentKeyDown}
        // The sheet sets the height; the inline row's max height would waste the room.
        className={cn("min-h-0 overflow-y-auto px-2", props.contentClassName, "max-h-none")}
      >
        {props.renderPanel()}
      </div>
    </div>
  );
}

function PanelHeading(props: ChatInputDecorationProps) {
  if (props.panelTitle === undefined) {
    return <>{props.summary}</>;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="text-foreground shrink-0 text-[13px] font-semibold">{props.panelTitle}</span>
      {props.panelMeta !== undefined && (
        <span className="text-muted min-w-0 truncate">{props.panelMeta}</span>
      )}
    </span>
  );
}

function revealSheetTab(tab: HTMLButtonElement | null): void {
  tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The chip's tab in the activity sheet, while the line opens its panels in one (phones). */
function ChatActivitySheetTab(props: {
  activityId?: ChatActivityId;
  open: boolean;
  panelId: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  const sheet = useChatActivitySheet();
  if (sheet === null) {
    return null;
  }
  return createPortal(
    <button
      // The tab strip scrolls when the tabs do not fit, so a chip late in the line (Reviews)
      // would otherwise open the sheet on a tab cut off at the strip's edge.
      ref={props.open ? revealSheetTab : undefined}
      type="button"
      role="tab"
      aria-selected={props.open}
      aria-controls={props.open ? props.panelId : undefined}
      onClick={props.open ? undefined : props.onOpen}
      // A tab never shrinks below its label and count, which would overlap the next tab's: when
      // the tabs do not fit (four on a phone), the tab strip scrolls instead. Inline, because the
      // touch rule in globals.css gives every button a 44px min-width, which beats a utility class
      // and would let the tab shrink to it.
      style={{
        minWidth: "max-content",
        order: props.activityId === undefined ? undefined : CHAT_ACTIVITY_ORDER[props.activityId],
      }}
      // 44px on touch, as the sheet's Close button (also in landscape, past globals.css's phone
      // width).
      className={cn(
        "inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap transition-colors pointer-coarse:h-11",
        props.open ? "bg-hover text-foreground" : "text-secondary hover:text-foreground"
      )}
    >
      {props.children}
    </button>,
    sheet.tabs
  );
}

function ChatActivityChipButton(props: {
  chipRef?: Ref<HTMLButtonElement>;
  /** False for link-style chips (Chat Instructions) that navigate instead of opening a panel. */
  hasPanel: boolean;
  open: boolean;
  panelId: string;
  label?: string;
  tooltip?: ReactNode;
  keyShortcuts?: string;
  variant?: "plain";
  activityId?: ChatActivityId;
  /**
   * The line has no room for the chip: the "+N" chip lists it instead. It stays laid out, out of
   * the flow and invisible, so the line can measure it when room comes back.
   */
  overflowed?: boolean;
  /** The "+N" chip itself, marked apart: `data-activity-chip` tells the line a real chip exists. */
  more?: boolean;
  /** Drawn as open while not expanded itself: the "+N" chip while a hidden chip's panel is open. */
  lit?: boolean;
  className?: string;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const plain = props.variant === "plain";
  return (
    <TooltipIfPresent tooltip={props.tooltip} side="top">
      <button
        ref={props.chipRef}
        type="button"
        data-activity-chip={props.more === true ? undefined : ""}
        data-activity-overflow-chip={props.more === true ? "" : undefined}
        data-activity-id={props.activityId}
        data-chip-variant={props.variant}
        aria-expanded={props.hasPanel ? props.open : undefined}
        aria-controls={props.open ? props.panelId : undefined}
        aria-label={props.label}
        aria-keyshortcuts={props.keyShortcuts}
        onClick={props.onToggle}
        onKeyDown={props.open ? (event) => closeOnEscape(event, props.onClose) : undefined}
        // The button is the touch target (globals.css grows buttons to 44px on touch phones) and
        // the inner span draws the chip: 28px in a wide line, and in a phone-width line the 44px
        // box of the approved phone design.
        // The order classes put a spacer (in StreamingBarrierView) between the plain TODO chip at
        // the line's start and the bordered chips, which end the line next to Stop.
        className={cn(
          "group/chip inline-flex min-w-0 items-center justify-center",
          plain ? "order-0" : props.more === true ? "order-3 shrink-0" : "order-2 shrink-0",
          props.overflowed === true && "invisible absolute top-0 left-0",
          props.className
        )}
      >
        <span
          className={cn(
            "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs leading-none whitespace-nowrap transition-colors",
            // The live line is the nearest @container.
            "@max-md:h-11 @max-md:rounded-[10px] @max-md:text-sm @max-md:[&_svg]:size-4",
            !plain && "@max-md:px-2.5",
            props.open || props.lit === true
              ? "text-foreground border-[var(--color-exec-mode)] bg-[color-mix(in_srgb,var(--color-exec-mode)_16%,transparent)]"
              : plain
                ? "text-foreground group-hover/chip:bg-hover border-transparent"
                : "border-border-light text-secondary group-hover/chip:bg-hover group-hover/chip:text-foreground"
          )}
        >
          {props.children}
        </span>
      </button>
    </TooltipIfPresent>
  );
}

/** A hidden chip's entry in the "+N" chip's list: its sheet-tab content, which names it. */
function ChatActivityMoreEntry(props: {
  activityId?: ChatActivityId;
  onOpen: () => void;
  children: ReactNode;
}) {
  const { setOpenId } = useChatActivityOverflow();
  return (
    <button
      type="button"
      style={
        props.activityId === undefined
          ? undefined
          : { order: CHAT_ACTIVITY_ORDER[props.activityId] }
      }
      onClick={(event) => {
        // The entry leaves with the list, so focus goes to the "+N" chip first: the phone sheet
        // returns focus to what had it when it opened.
        event.currentTarget
          .closest("[data-activity-strip]")
          ?.querySelector<HTMLElement>("[data-activity-overflow-chip]")
          ?.focus();
        props.onOpen();
        // A chip without a panel (Chat Instructions) navigates instead, so the list closes.
        setOpenId?.((current) => (current === "more" ? null : current));
      }}
      className="text-secondary hover:bg-hover hover:text-foreground inline-flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-sm whitespace-nowrap transition-colors"
    >
      {props.children}
    </button>
  );
}

/**
 * The "+N" chip: it stands in for the chips the line has no room for (a phone with every kind of
 * activity), and lists them above the line. It is always laid out, invisible while every chip
 * fits, so the line can measure it before deciding whether it needs it.
 */
export function ChatActivityOverflowChip() {
  const chipRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const { overflow, openId, setOpenId, setMoreList } = useChatActivityOverflow();
  const open = openId === "more" && overflow.length > 0;
  // A hidden chip's panel open from the list keeps the "+N" chip lit, as an open chip is.
  const lit = openId !== null && openId !== "more" && overflow.includes(openId);
  const toggle = () => setOpenId?.((current) => (current === "more" ? null : "more"));
  const close = () => {
    setOpenId?.((current) => (current === "more" ? null : current));
    chipRef.current?.focus();
  };
  useCloseChatActivityPanelOnBodyEscape(open, close);

  return (
    <>
      <ChatActivityChipButton
        chipRef={chipRef}
        more
        hasPanel
        open={open}
        lit={lit}
        panelId={listId}
        label={`${overflow.length} more`}
        overflowed={overflow.length === 0}
        onToggle={toggle}
        onClose={close}
      >
        <span className="counter-nums">+{Math.max(overflow.length, 1)}</span>
      </ChatActivityChipButton>
      {open && (
        <div
          id={listId}
          ref={setMoreList}
          role="group"
          aria-label="More activity"
          data-activity-panel=""
          onKeyDown={(event) => closeOnEscape(event, close)}
          className="bg-surface-primary border-border-medium absolute right-0 bottom-full z-30 mb-1 flex w-max max-w-full min-w-44 flex-col gap-0.5 rounded-lg border p-1 shadow-lg"
        />
      )}
    </>
  );
}
