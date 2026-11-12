import { cn } from "@/common/lib/utils";
import type { DisplayedMessage, MuxMessage, QueuedMessage } from "@/common/types/message";
import { useOptionalMessageListContext } from "./MessageListContext";
import { TranscriptQuoteRoot } from "./TranscriptQuoteBoundary";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import { Code2Icon } from "lucide-react";
import type { ReactNode } from "react";
import React, { useState } from "react";
import { useChatHostContext } from "@/browser/contexts/ChatHostContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { Button } from "@/browser/components/Button/Button";

export interface ButtonConfig {
  label: string;
  onClick?: () => void;
  icon?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  tooltip?: string; // Optional tooltip text
  /** Custom component to render instead of default button */
  component?: ReactNode;
}

/**
 * A message's actions and time are there when the pointer or the keyboard is on the message, and
 * out of sight otherwise: repeated under every prompt and every reply they were the loudest
 * thing in a quiet transcript. Only the latest reply keeps its row in view, since that is the
 * one the user acts on. A hidden row takes no clicks. Touch has no hover: there every row is
 * always shown.
 */
const QUIET_META_ROW_CLASS = cn(
  "pointer-events-none opacity-0 transition-opacity",
  "group-hover/message:pointer-events-auto group-hover/message:opacity-100",
  "focus-within:pointer-events-auto focus-within:opacity-100",
  "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
);

/**
 * Where a hover device puts the row of a prompt or a step: floating, so a hidden row reserves
 * no line. A reserved line under every prompt pushed the prompt away from the work it started,
 * further than it sat from the turn before, and one under every step broke the pitch of the
 * steps around it.
 *  - "under": below the bubble, at its right edge, like a reply's row sits under the reply.
 *    (Beside the bubble, to its left, it read as a stray label in the middle of the page.)
 *  - "beside": at the right end of a step's one line.
 * The row has the transcript's surface, so it covers what it floats over while it shows, and
 * its block rises above the rows around it then (see FLOATING_BLOCK_CLASS): when one prompt
 * follows another, the row would otherwise sit under the next prompt's bubble, which would
 * take the clicks meant for Edit. On touch the row is always shown, so it keeps its own line.
 */
const FLOATING_META_ROW_CLASS = cn(
  "[@media(hover:hover)]:absolute [@media(hover:hover)]:right-0 [@media(hover:hover)]:mt-0",
  "[@media(hover:hover)]:w-max [@media(hover:hover)]:max-w-[90cqw] [@media(hover:hover)]:rounded-sm",
  "[@media(hover:hover)]:bg-surface-primary"
);
const FLOATING_META_ROW_PLACEMENT_CLASS: Record<MetaRowPlacement, string | undefined> = {
  "in-flow": undefined,
  under: cn(FLOATING_META_ROW_CLASS, "[@media(hover:hover)]:top-full [@media(hover:hover)]:pt-0.5"),
  beside: cn(FLOATING_META_ROW_CLASS, "[@media(hover:hover)]:top-0 [@media(hover:hover)]:pl-2"),
};
const FLOATING_BLOCK_CLASS = "hover:z-10 focus-within:z-10";

type MetaRowPlacement = "in-flow" | "under" | "beside";
const META_ROW_PLACEMENT: Record<NonNullable<MessageWindowProps["variant"]>, MetaRowPlacement> = {
  assistant: "in-flow",
  user: "under",
  step: "beside",
};

/** A prompt: its bubble at the right, and on touch its row on a line of its own below. */
const USER_BLOCK_CLASS = cn(
  "ml-auto w-fit max-w-full flex-col items-end",
  "[@media(hover:none)]:items-stretch [@media(hover:none)]:gap-y-2"
);

interface MessageWindowProps {
  label: ReactNode;
  /**
   * "step" is a row the machine wrote in the middle of the agent's work (a sub-agent's report):
   * it lies where a reply lies (left, full width, no bubble), since the user did not say it,
   * and keeps a prompt's action row, which is there whenever the row is.
   */
  variant?: "assistant" | "user" | "step";
  message: MuxMessage | DisplayedMessage | QueuedMessage;
  buttons?: ButtonConfig[];
  children: ReactNode;
  className?: string;
  rightLabel?: ReactNode;
  backgroundEffect?: ReactNode; // Optional background effect (e.g., animation)
}

export const MessageWindow: React.FC<MessageWindowProps> = ({
  label,
  variant = "assistant",
  message,
  buttons = [],
  children,
  className,
  rightLabel,
  backgroundEffect,
}) => {
  const [showJson, setShowJson] = useState(false);

  const { uiSupport } = useChatHostContext();
  const canShowJson = uiSupport.jsonRawView === "supported";
  const isShowingJson = canShowJson && showJson;

  const timestamp =
    "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : null;
  const formattedTimestamp = timestamp ? formatTimestamp(timestamp) : null;

  // Keep assistant meta chrome hidden until the terminal part is settled. Stream-start rows
  // are usually both streaming and "last", so rendering the meta row immediately makes it
  // tear out of the transcript when the next part arrives.
  const showAssistantMetaRow =
    "isLastPartOfMessage" in message &&
    message.isLastPartOfMessage &&
    !message.isPartial &&
    !("isStreaming" in message && message.isStreaming);

  const showMetaRow = variant !== "assistant" || showAssistantMetaRow;

  const isLatestRow = useIsLatestRow(message.id);
  const isQuietMetaRow = !isShowingJson && (variant !== "assistant" || !isLatestRow);

  return (
    <div
      className={cn(
        "group/message mt-4 mb-1 flex relative isolate",
        variant === "user" && USER_BLOCK_CLASS,
        variant !== "assistant" && FLOATING_BLOCK_CLASS,
        variant !== "user" && "flex-col w-full text-foreground",
        // A step keeps the pitch of the tool rows it sits among.
        variant === "step" && "my-2",
        // On touch the row always shows, so the gap to the next turn starts under it, not
        // under the reply: without more room there the next prompt reads as part of this turn.
        showAssistantMetaRow && "[@media(hover:none)]:mb-4",
        // Caller-supplied classes apply to the outer message block.
        className
      )}
      data-message-block
    >
      <div
        className={cn(
          variant === "user" &&
            "min-w-0 bg-[var(--color-user-surface)] border border-[var(--color-user-border)] rounded-lg px-3 py-2 overflow-x-auto shadow-sm",
          variant !== "user" && "px-1 py-1"
        )}
      >
        {backgroundEffect}
        <div className="relative z-10 flex flex-col gap-2">
          <TranscriptQuoteRoot data-message-content>
            {isShowingJson ? (
              <pre className="m-0 overflow-x-auto rounded-xl border border-[var(--color-message-debug-border)] bg-[var(--color-message-debug-bg)] p-3 text-[12px] leading-snug whitespace-pre-wrap text-[var(--color-message-debug-text)]">
                {JSON.stringify(message, null, 2)}
              </pre>
            ) : (
              children
            )}
          </TranscriptQuoteRoot>
        </div>
      </div>
      {showMetaRow && (
        <MessageMetaRow
          placement={META_ROW_PLACEMENT[variant]}
          quiet={isQuietMetaRow}
          buttons={buttons}
          jsonToggle={
            canShowJson
              ? { shown: isShowingJson, onToggle: () => setShowJson(!isShowingJson) }
              : undefined
          }
          rightLabel={rightLabel}
          label={label}
          timestampLabel={formattedTimestamp}
        />
      )}
    </div>
  );
};

/**
 * Whether this row is the latest of its message list. Without a list (a transcript dialog, a
 * test) no row is known to be the latest, and every row counts as it: each reply keeps its
 * action row in view.
 */
function useIsLatestRow(messageId: string): boolean {
  const messageList = useOptionalMessageListContext();
  return messageList === null || messageList.latestMessageId === messageId;
}

interface MessageMetaRowProps {
  /** In the flow under the message, or floating on hover devices (see FLOATING_META_ROW_CLASS). */
  placement: MetaRowPlacement;
  /** Out of sight until the pointer or the keyboard is on the message (see QUIET_META_ROW_CLASS). */
  quiet: boolean;
  buttons: ButtonConfig[];
  /** The raw-JSON toggle, on hosts that support the view. */
  jsonToggle: { shown: boolean; onToggle: () => void } | undefined;
  rightLabel: ReactNode;
  label: ReactNode;
  timestampLabel: string | null;
}

/** A message's action row: its buttons, then its model label and time. */
const MessageMetaRow: React.FC<MessageMetaRowProps> = (props) => {
  const jsonToggle = props.jsonToggle;
  return (
    <div
      className={cn(
        "text-muted flex flex-wrap items-center justify-between gap-3 text-[11px]",
        // A prompt's block spaces its row itself on touch (see USER_BLOCK_CLASS).
        props.placement === "under" ? "ml-auto" : "mt-1",
        FLOATING_META_ROW_PLACEMENT_CLASS[props.placement],
        props.quiet && QUIET_META_ROW_CLASS
      )}
      data-message-meta
    >
      <div className="flex flex-wrap items-center gap-0.5" data-message-meta-actions>
        {props.buttons.map((button, index) => (
          <IconActionButton key={index} button={button} />
        ))}
        {jsonToggle && (
          <IconActionButton
            button={{
              label: jsonToggle.shown ? "Hide JSON" : "Show JSON",
              icon: <Code2Icon />,
              active: jsonToggle.shown,
              onClick: jsonToggle.onToggle,
              tooltip: jsonToggle.shown ? "Hide raw JSON" : "Show raw JSON",
            }}
          />
        )}
      </div>
      {/* flex-auto, not flex-1: with a zero basis this block shrank beside the action buttons
          (44px each on touch phones) and wrapped the model and time onto two lines that sat off
          the buttons' line. A content basis lets the row wrap the whole block below instead. */}
      <div
        className="text-muted flex min-w-0 flex-auto flex-wrap items-center gap-2 text-xs"
        data-message-meta-right
      >
        {props.rightLabel}
        {props.label && (
          <div className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap">
            {props.label}
          </div>
        )}
        {props.timestampLabel && <span data-message-timestamp>{props.timestampLabel}</span>}
      </div>
    </div>
  );
};

interface IconActionButtonProps {
  button: ButtonConfig;
}

export const IconActionButton: React.FC<IconActionButtonProps> = ({ button }) => {
  // If a custom component is provided, render it directly
  if (button.component) {
    return <>{button.component}</>;
  }

  const content = (
    <Button
      onClick={button.onClick}
      disabled={button.disabled}
      aria-label={button.label}
      variant="ghost"
      size="icon"
      className="text-placeholder flex h-6 w-6 items-center justify-center [&_svg]:size-3.5"
    >
      {button.icon ?? (
        <span className="text-[10px] font-semibold tracking-wide uppercase">{button.label}</span>
      )}
    </Button>
  );

  if (button.tooltip || button.label) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent align="center">{button.tooltip ?? button.label}</TooltipContent>
      </Tooltip>
    );
  }

  return content;
};
