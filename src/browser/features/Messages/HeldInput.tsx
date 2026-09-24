import React, { useEffect, useRef, useState } from "react";
import { CircleSlash, Loader2, Send, Trash2 } from "lucide-react";
import { ChatDockSurface } from "@/browser/components/ChatPane/chatDockColumn";
import { useAPI } from "@/browser/contexts/API";
import type { HeldInput as HeldInputData } from "@/common/orpc/types";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, type CustomEventType } from "@/common/constants/events";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { cn } from "@/common/lib/utils";

interface HeldInputProps {
  workspaceId: string;
  heldInput: HeldInputData;
  /** The composer's held-input shortcuts act on this banner (the oldest held input). */
  isShortcutTarget: boolean;
}

const SHORTCUT_HINT_CLASS =
  "bg-background-secondary text-muted border-border-medium rounded border px-1 py-px font-mono text-[10px] whitespace-nowrap [@media(max-width:768px)]:hidden";

/** Banner wording per refusal reason: only `reported` may say a report happened. */
const HELD_INPUT_REASON_LABELS: Record<HeldInputData["reason"], string> = {
  reported: "Not sent — the task reported before this ran",
  indeterminate: "Not sent — the task's outcome was not confirmed before this ran",
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A manual queued message the backend refused to dispatch because the task reported before it
 * ran. The backend keeps the full send; this banner only offers the two explicit outcomes. There
 * is deliberately no "edit"/move-to-composer action: that would hand the only copy to renderer
 * draft storage, which can fail to persist it.
 */
export const HeldInput: React.FC<HeldInputProps> = (props) => {
  const { api } = useAPI();
  const [pendingAction, setPendingAction] = useState<"send" | "discard" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Synchronous guard: a second click can land before the disabled state renders.
  const actionInFlightRef = useRef(false);
  const counts = [
    props.heldInput.attachmentCount > 0
      ? pluralize(props.heldInput.attachmentCount, "attachment")
      : null,
    props.heldInput.reviewCount > 0 ? pluralize(props.heldInput.reviewCount, "review") : null,
  ].filter((count): count is string => count != null);

  // The shortcut listener below depends on runAction. React Compiler memoizes it (AGENTS.md: no
  // manual useCallback), so its identity only changes with its inputs; the lint rule cannot see it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runAction = (action: "send" | "discard") => {
    // One action at a time: a double-click must not send the held input twice (the backend also
    // refuses a second concurrent send of the same held input).
    if (actionInFlightRef.current || !api) return;
    actionInFlightRef.current = true;
    setActionError(null);
    setPendingAction(action);
    const request = { workspaceId: props.workspaceId, heldInputId: props.heldInput.id };
    const run = async (): Promise<string | null> => {
      if (action === "send") {
        const result = await api.workspace.sendHeldInput(request);
        return result.success ? null : formatSendMessageError(result.error).message;
      }
      const result = await api.workspace.discardHeldInput(request);
      return result.success ? null : result.error;
    };
    run().then(
      // On success the backend's held-inputs-changed event unmounts this banner.
      (error) => {
        actionInFlightRef.current = false;
        setActionError(error);
        setPendingAction(null);
      },
      (error: unknown) => {
        actionInFlightRef.current = false;
        setActionError(error instanceof Error ? error.message : String(error));
        setPendingAction(null);
      }
    );
  };

  // The composer's shortcuts (see ChatInput) arrive as an event so they share this banner's
  // in-flight guard and error display with the buttons.
  useEffect(() => {
    const handler = (event: Event) => {
      const { detail } = event as CustomEventType<typeof CUSTOM_EVENTS.HELD_INPUT_ACTION>;
      if (detail.workspaceId !== props.workspaceId || detail.heldInputId !== props.heldInput.id) {
        return;
      }
      runAction(detail.action);
    };
    window.addEventListener(CUSTOM_EVENTS.HELD_INPUT_ACTION, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.HELD_INPUT_ACTION, handler);
  }, [props.workspaceId, props.heldInput.id, runAction]);

  return (
    <ChatDockSurface>
      <div className="bg-surface-primary py-1.5" data-component="HeldInputBanner">
        <div className="ml-auto w-fit max-w-full">
          <div className="border-warning/30 overflow-hidden rounded-lg border bg-[color-mix(in_srgb,var(--color-user-surface)_85%,var(--color-surface-primary)_15%)] shadow-sm">
            <div
              role="status"
              className="text-secondary border-warning/20 flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px]"
            >
              <CircleSlash className="text-warning size-3 shrink-0" />
              <span className="min-w-0">{HELD_INPUT_REASON_LABELS[props.heldInput.reason]}</span>
            </div>
            <div className="max-h-[20vh] overflow-y-auto px-3 py-2">
              <p
                className={cn(
                  "text-sm break-words whitespace-pre-wrap",
                  props.heldInput.displayText.length === 0 && "text-muted italic"
                )}
              >
                {props.heldInput.displayText || "No text"}
              </p>
              {counts.length > 0 && (
                <p className="text-muted mt-1 text-[11px]">{counts.join(" · ")}</p>
              )}
            </div>
            {actionError && (
              <div
                role="alert"
                className="border-toast-error-border/50 bg-toast-error-bg/50 text-toast-error-text border-t px-3 py-2 text-xs break-words"
              >
                {actionError}
              </div>
            )}
          </div>
          <div className="mt-1.5 flex max-w-full flex-wrap items-center justify-end gap-1 text-[11px]">
            <button
              type="button"
              aria-label="Discard unsent message"
              disabled={pendingAction != null}
              onClick={() => runAction("discard")}
              className="text-muted hover:bg-hover hover:text-foreground flex h-6 items-center gap-1 rounded-md px-1.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pendingAction === "discard" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
              Discard
              {props.isShortcutTarget && (
                <kbd className={SHORTCUT_HINT_CLASS}>
                  {formatKeybind(KEYBINDS.DISCARD_HELD_INPUT)}
                </kbd>
              )}
            </button>
            <button
              type="button"
              aria-label="Send unsent message"
              disabled={pendingAction != null}
              onClick={() => runAction("send")}
              className="text-secondary bg-muted/10 hover:bg-hover hover:text-foreground flex h-6 items-center gap-1 rounded-md px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pendingAction === "send" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Send className="size-3" />
              )}
              Send
              {props.isShortcutTarget && (
                <kbd className={SHORTCUT_HINT_CLASS}>{formatKeybind(KEYBINDS.SEND_HELD_INPUT)}</kbd>
              )}
            </button>
          </div>
        </div>
      </div>
    </ChatDockSurface>
  );
};
