import { useRef } from "react";
import type { KeyboardEvent, KeyboardEventHandler, ReactNode, Ref } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { useChatDockColumnWidthClass } from "./chatDockColumn";
import {
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

/**
 * The chip and its panel. The panel is positioned against the live line (the nearest positioned
 * ancestor), so every chip's list opens at the same place: full column width, just above the line,
 * over the transcript, which keeps the composer from moving when a list opens.
 */
function ChatActivityChip(props: ChatInputDecorationProps) {
  const chipRef = useRef<HTMLButtonElement>(null);
  useReleaseChatActivityPanelOnUnmount(props.activityId);
  const renderPanel = props.expanded ? props.renderExpanded : undefined;
  const close = () => {
    props.onToggle();
    // mutation-equivalent: close only runs from the chip's or its panel's handlers, so the chip is mounted
    chipRef.current?.focus();
  };

  return (
    <div className="contents" data-component={props.dataComponent}>
      <ChatActivityChipButton
        chipRef={chipRef}
        hasPanel={props.renderExpanded !== undefined}
        open={renderPanel !== undefined}
        label={props.chipLabel}
        tooltip={props.chipTooltip}
        className={props.chipClassName}
        onToggle={props.onToggle}
        onClose={close}
      >
        {/* mutation-equivalent: chip is an element or absent, never another falsy node */}
        {props.chip ?? props.summary}
      </ChatActivityChipButton>
      {renderPanel && (
        <div
          data-activity-panel=""
          onKeyDown={(event) => closeOnEscape(event, close)}
          className="bg-surface-primary border-border-medium absolute inset-x-0 bottom-full z-30 mb-1 flex max-h-[min(55vh,26rem)] flex-col overflow-hidden rounded-lg border shadow-lg"
        >
          <div className="border-border-light flex h-8 shrink-0 items-center gap-2 border-b pr-1 pl-3 text-xs leading-none">
            {props.summary}
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="text-muted hover:text-foreground ml-auto inline-flex size-6 items-center justify-center rounded-sm transition-colors"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {/* The content's own key handler runs before the panel's (events bubble from it). */}
          <div
            ref={props.contentRef}
            onKeyDown={props.onContentKeyDown}
            className={cn("min-h-0 overflow-y-auto px-1", props.contentClassName)}
          >
            {renderPanel()}
          </div>
        </div>
      )}
    </div>
  );
}

function ChatActivityChipButton(props: {
  chipRef: Ref<HTMLButtonElement>;
  /** False for link-style chips (Chat Instructions) that navigate instead of opening a panel. */
  hasPanel: boolean;
  open: boolean;
  label?: string;
  tooltip?: ReactNode;
  className?: string;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipIfPresent tooltip={props.tooltip} side="top">
      <button
        ref={props.chipRef}
        type="button"
        data-activity-chip=""
        aria-expanded={props.hasPanel ? props.open : undefined}
        aria-label={props.label}
        onClick={props.onToggle}
        onKeyDown={props.open ? (event) => closeOnEscape(event, props.onClose) : undefined}
        // The button is the touch target (globals.css grows buttons to 44px on touch phones);
        // the inner span draws the 24px chip, so the line does not turn into 44px boxes.
        className={cn(
          "group/chip inline-flex min-w-0 shrink-0 items-center justify-center",
          props.className
        )}
      >
        <span
          className={cn(
            "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs leading-none whitespace-nowrap transition-colors",
            props.open
              ? "text-foreground border-[var(--color-exec-mode)] bg-[color-mix(in_srgb,var(--color-exec-mode)_16%,transparent)]"
              : "border-border-light text-secondary group-hover/chip:bg-hover group-hover/chip:text-foreground"
          )}
        >
          {props.children}
        </span>
      </button>
    </TooltipIfPresent>
  );
}
