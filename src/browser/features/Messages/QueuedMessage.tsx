import React, { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "@/common/types/message";
import { AlertCircle, Check, ChevronDown, Clock3, Loader2, Pencil, Send } from "lucide-react";
import { ChatDockSurface } from "@/browser/components/ChatPane/chatDockColumn";
import { SEND_DISPATCH_MODES } from "@/browser/features/ChatInput/sendDispatchModes";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";

interface QueuedMessageProps {
  message: QueuedMessageType;
  className?: string;
  onEdit?: () => void;
  onChangeDispatchMode?: (mode: QueueDispatchMode) => Promise<void>;
  onActionError?: (error: unknown) => void;
  actionError?: string | null;
  onActionStart?: () => void;
  onSendImmediately?: () => Promise<void>;
}

interface QueuedPreview {
  sanitizedText: string;
  fallbackLabel: string;
}

function deriveQueuedPreview(message: QueuedMessageType): QueuedPreview {
  const hasReviews = (message.reviews?.length ?? 0) > 0;
  const sanitizedText = hasReviews
    ? message.content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : message.content;

  return {
    sanitizedText,
    fallbackLabel: "Queued message ready",
  };
}

export const QueuedMessage: React.FC<QueuedMessageProps> = (props) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"mode" | "send-now" | null>(null);
  const preview = deriveQueuedPreview(props.message);
  const queueDispatchMode = props.message.queueDispatchMode ?? "tool-end";
  const queueStatusLabel =
    queueDispatchMode === "turn-end" ? "Sends after this turn" : "Sends after this step";
  const isDispatching = props.message.isDispatching === true;
  const isActionPending = pendingAction != null;

  const handleDispatchModeChange = (mode: QueueDispatchMode) => {
    setIsMenuOpen(false);
    if (isActionPending || !props.onChangeDispatchMode) return;
    props.onActionStart?.();
    setPendingAction("mode");
    props.onChangeDispatchMode(mode).then(
      () => setPendingAction(null),
      (error: unknown) => {
        props.onActionError?.(error);
        setPendingAction(null);
      }
    );
  };

  const handleSendImmediately = () => {
    setIsMenuOpen(false);
    if (isActionPending || !props.onSendImmediately) return;
    props.onActionStart?.();
    setPendingAction("send-now");
    props.onSendImmediately().then(
      () => setPendingAction(null),
      (error: unknown) => {
        // Keep failures visible at the action that caused them while leaving the queued draft intact
        // for a retry; consuming this rejection without feedback makes IPC failures look like no-ops.
        props.onActionError?.(error);
        setPendingAction(null);
      }
    );
  };

  // Mirror the sent user-message shape so dispatching the queued draft removes temporary status
  // chrome instead of making the content jump from a full-width banner into a right-aligned bubble.
  return (
    <ChatDockSurface>
      <div
        className={cn("bg-surface-primary py-1.5", props.className)}
        data-component="QueuedMessageBanner"
      >
        <div className="ml-auto w-fit max-w-full" data-component="QueuedMessageGroup">
          <div
            className="border-pending/20 overflow-hidden rounded-lg border bg-[color-mix(in_srgb,var(--color-user-surface)_85%,var(--color-surface-primary)_15%)] shadow-sm"
            data-component="QueuedMessageCard"
          >
            {/* Keep queued drafts bounded so long content never pushes the composer off-screen. */}
            <div className="max-h-[40vh] overflow-y-auto px-3 py-2">
              <UserMessageContent
                content={preview.sanitizedText || preview.fallbackLabel}
                reviews={props.message.reviews}
                fileParts={props.message.fileParts}
                variant="sent"
              />
            </div>

            {props.actionError && (
              <div
                role="alert"
                className="border-toast-error-border/50 bg-toast-error-bg/50 text-toast-error-text flex items-start gap-1.5 border-t px-3 py-2 text-xs"
              >
                <AlertCircle className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 break-words">{props.actionError}</span>
              </div>
            )}
          </div>

          <div
            className="mt-1.5 flex max-w-full flex-wrap items-center justify-end gap-1 text-[11px]"
            data-component="QueuedMessageActions"
          >
            {!isDispatching && props.onEdit && (
              <button
                type="button"
                onClick={props.onEdit}
                className="text-muted hover:bg-hover hover:text-foreground flex h-6 items-center gap-1 rounded-md px-1.5 font-medium transition-colors"
              >
                <Pencil className="size-3" />
                Edit
              </button>
            )}

            <div
              className="relative"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setIsMenuOpen(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !isMenuOpen) return;
                event.preventDefault();
                stopKeyboardPropagation(event);
                setIsMenuOpen(false);
              }}
            >
              <button
                type="button"
                onClick={() => {
                  if (!isDispatching) setIsMenuOpen((open) => !open);
                }}
                aria-haspopup={isDispatching ? undefined : "menu"}
                aria-expanded={isDispatching ? undefined : isMenuOpen}
                disabled={isDispatching}
                className="text-secondary bg-muted/10 hover:bg-hover hover:text-foreground flex h-6 max-w-full items-center gap-1.5 rounded-md px-2 font-medium transition-colors disabled:cursor-default"
                data-component="QueuedMessageStatus"
              >
                {pendingAction === "mode" ? (
                  <Loader2 className="size-3 shrink-0 animate-spin" />
                ) : (
                  <Clock3 className="text-pending size-3 shrink-0" />
                )}
                <span className="text-foreground shrink-0">
                  {isDispatching ? "Sending" : "Queued"}
                </span>
                {!isDispatching && <span className="truncate">{queueStatusLabel}</span>}
                {!isDispatching && <ChevronDown className="size-3 shrink-0" />}
              </button>

              {!isDispatching && isMenuOpen && (
                <div
                  role="menu"
                  className="bg-separator border-border-light absolute right-0 bottom-full z-[1020] mb-1 min-w-[12rem] rounded-md border p-1.5 shadow-md"
                  data-component="QueuedMessageDispatchMenu"
                >
                  {SEND_DISPATCH_MODES.map((entry) => (
                    <button
                      key={entry.mode}
                      type="button"
                      role="menuitem"
                      aria-label={entry.label}
                      disabled={isActionPending || !props.onChangeDispatchMode}
                      className="hover:bg-hover focus-visible:bg-hover text-foreground flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1 text-left text-xs whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => handleDispatchModeChange(entry.mode)}
                    >
                      <span>{entry.label}</span>
                      <span className="flex items-center gap-1.5">
                        <kbd className="bg-background-secondary text-muted border-border-medium rounded border px-1.5 py-px font-mono text-[10px] whitespace-nowrap [@media(max-width:768px)]:hidden">
                          {formatKeybind(entry.keybind)}
                        </kbd>
                        {queueDispatchMode === entry.mode && <Check className="size-3" />}
                      </span>
                    </button>
                  ))}
                  <div className="border-border-light my-1 border-t" />
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="Send now"
                    disabled={isActionPending || !props.onSendImmediately}
                    className="hover:bg-hover focus-visible:bg-hover text-foreground flex w-full items-center gap-2 rounded-sm px-2.5 py-1 text-left text-xs whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={handleSendImmediately}
                  >
                    {pendingAction === "send-now" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Send className="size-3" />
                    )}
                    <span className="flex-1 whitespace-nowrap">Send now</span>
                    <kbd className="bg-background-secondary text-muted border-border-medium rounded border px-1.5 py-px font-mono text-[10px] whitespace-nowrap [@media(max-width:768px)]:hidden">
                      {formatKeybind(KEYBINDS.SEND_QUEUED_MESSAGE_NOW)}
                    </kbd>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </ChatDockSurface>
  );
};
