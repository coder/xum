import { cn } from "@/common/lib/utils";
import type { DisplayedMessage, MuxMessage, QueuedMessage } from "@/common/types/message";
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

  return (
    <div
      className={cn(
        "mt-4 mb-1 flex flex-col relative isolate",
        variant === "user" && "ml-auto w-fit max-w-full",
        variant === "assistant" && "w-full text-foreground",
        // Pair the extra bottom margin with the meta row so the surrounding transcript
        // space only changes at the same (settled) moment as the meta row appearing,
        // avoiding a second separate tear step.
        showAssistantMetaRow && "mb-4",
        // Caller-supplied classes apply to the outer message block.
        className
      )}
      data-message-block
    >
      <div
        className={cn(
          variant === "user" &&
            "bg-[var(--color-user-surface)] border border-[var(--color-user-border)] rounded-lg px-3 py-2 overflow-x-auto shadow-sm",
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
            "mt-2 flex flex-wrap items-center justify-between gap-3 text-[11px]",
            variant === "user" ? "ml-auto text-muted" : "text-muted"
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
          <div
            className="text-muted flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs"
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
