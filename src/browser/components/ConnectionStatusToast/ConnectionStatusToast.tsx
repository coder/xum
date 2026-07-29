import React from "react";
import { useAPI } from "@/browser/contexts/API";
import { CHAT_DOCK_TOAST_OVERLAY_CLASS } from "@/constants/layout";

/**
 * Connection status banner that uses the same *overlay placement* as ChatInputToast.
 *
 * This avoids layout shifts in:
 * - the creation screen (new chat)
 * - the workspace chat window
 */
interface ConnectionStatusToastProps {
  /**
   * When false, render only the toast content (no absolute-positioned wrapper).
   * Useful for stacking multiple toasts under a single overlay container.
   */
  wrap?: boolean;
}

export const ConnectionStatusToast: React.FC<ConnectionStatusToastProps> = ({ wrap = true }) => {
  const apiState = useAPI();

  // Don't show anything when connected or during initial connection.
  // Auth required is handled by a separate modal flow.
  if (
    apiState.status === "connected" ||
    apiState.status === "connecting" ||
    apiState.status === "auth_required"
  ) {
    return null;
  }

  if (apiState.status === "degraded" || apiState.status === "reconnecting") {
    const content = (
      <div
        role="status"
        aria-live="polite"
        className="bg-background-secondary border-warning text-warning flex animate-[toastSlideIn_0.2s_ease-out] items-center gap-2 rounded border px-3 py-1.5 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
      >
        <span className="bg-warning inline-block h-2 w-2 animate-pulse rounded-full" />
        <span>
          {apiState.status === "degraded" ? (
            "Connection unstable — messages may be delayed"
          ) : (
            <>
              Reconnecting to server
              {apiState.attempt > 1 && ` (attempt ${apiState.attempt})`}…
            </>
          )}
        </span>
      </div>
    );

    if (!wrap) return content;

    return <div className={CHAT_DOCK_TOAST_OVERLAY_CLASS}>{content}</div>;
  }

  if (apiState.status === "error") {
    const content = (
      <div
        role="alert"
        aria-live="assertive"
        className="bg-toast-error-bg border-toast-error-border text-toast-error-text flex animate-[toastSlideIn_0.2s_ease-out] items-center gap-2 rounded border px-3 py-1.5 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
      >
        <span className="bg-danger inline-block h-2 w-2 rounded-full" />
        <span>Connection lost</span>
        <button type="button" onClick={apiState.retry} className="underline hover:no-underline">
          Retry
        </button>
      </div>
    );

    if (!wrap) return content;

    return <div className={CHAT_DOCK_TOAST_OVERLAY_CLASS}>{content}</div>;
  }

  return null;
};
