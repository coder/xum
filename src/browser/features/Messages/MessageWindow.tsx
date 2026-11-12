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
 * one the user acts on. A quiet row keeps its place in the layout, so nothing moves when it
 * shows. Touch has no hover: there every row is always shown.
 */
const QUIET_META_ROW_CLASS =
  "opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * A prompt's row sits beside its bubble (to the left, on the bubble's line), so a hidden row
 * reserves no height and the prompt stays next to the work it started. It drops below the bubble
 * when the two do not fit on one line. It must never float over the row below: when one prompt
 * follows another, that row is the next prompt's bubble, which then takes the clicks meant for
 * Edit. On touch the row is always shown, so it keeps its own line below the bubble.
 */
const USER_BLOCK_CLASS = cn(
  "ml-auto w-fit max-w-full flex-row-reverse flex-wrap items-center gap-x-2 gap-y-0.5",
  "[@media(hover:none)]:flex-col [@media(hover:none)]:flex-nowrap [@media(hover:none)]:items-stretch [@media(hover:none)]:gap-y-2"
);

interface MessageWindowProps {
  label: ReactNode;
  variant?: "assistant" | "user";
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

  const showMetaRow = variant === "user" || showAssistantMetaRow;

  // Without a message list (a transcript dialog, a test) no row is known to be the latest, and
  // every reply keeps its row in view.
  const messageList = useOptionalMessageListContext();
  const isLatestRow = messageList === null || messageList.latestMessageId === message.id;
  const isQuietMetaRow = !isShowingJson && (variant === "user" || !isLatestRow);

  return (
    <div
      className={cn(
        "group/message mt-4 mb-1 flex relative isolate",
        variant === "user" && USER_BLOCK_CLASS,
        variant === "assistant" && "flex-col w-full text-foreground",
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
          variant === "assistant" && "px-1 py-1"
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
        <div
          className={cn(
            "text-muted flex flex-wrap items-center justify-between gap-3 text-[11px]",
            // A prompt's block spaces its row itself (see USER_BLOCK_CLASS).
            variant === "user" ? "ml-auto" : "mt-1",
            isQuietMetaRow && QUIET_META_ROW_CLASS
          )}
          data-message-meta
        >
          <div className="flex flex-wrap items-center gap-0.5" data-message-meta-actions>
            {buttons.map((button, index) => (
              <IconActionButton key={index} button={button} />
            ))}
            {canShowJson && (
              <IconActionButton
                button={{
                  label: isShowingJson ? "Hide JSON" : "Show JSON",
                  icon: <Code2Icon />,
                  active: isShowingJson,
                  onClick: () => setShowJson(!isShowingJson),
                  tooltip: isShowingJson ? "Hide raw JSON" : "Show raw JSON",
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
            {rightLabel}
            {label && (
              <div className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap">
                {label}
              </div>
            )}
            {formattedTimestamp && <span data-message-timestamp>{formattedTimestamp}</span>}
          </div>
        </div>
      )}
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
