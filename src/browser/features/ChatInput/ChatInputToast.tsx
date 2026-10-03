import type { ReactNode } from "react";
import { AlertTriangle, Check } from "lucide-react";
import React, { useEffect, useCallback } from "react";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import { cn } from "@/common/lib/utils";

const toastTypeStyles: Record<"success" | "error", string> = {
  success: "bg-toast-success-bg border border-accent-dark text-toast-success-text",
  error: "bg-toast-error-bg border border-toast-error-border text-toast-error-text",
};

export interface Toast {
  id: string;
  type: "success" | "error";
  title?: string;
  message: string;
  solution?: ReactNode;
  duration?: number;
  /** Adds a copy button (e.g. a saved file path); the toast then stays until dismissed. */
  copyText?: string;
}

interface ChatInputToastProps {
  toast: Toast | null;
  onDismiss: () => void;
  /**
   * When false, render only the toast content (no absolute-positioned wrapper).
   * Useful for stacking multiple toasts under a single overlay container.
   */
  wrap?: boolean;
}

export const SolutionLabel: React.FC<{ children: ReactNode }> = ({ children }) => (
  <div className="text-muted-light mb-1 text-[10px] uppercase">{children}</div>
);

const wrapperClassName =
  "pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 [&>*]:pointer-events-auto";

export const ChatInputToast: React.FC<ChatInputToastProps> = ({
  toast,
  onDismiss,
  wrap = true,
}) => {
  const [isLeaving, setIsLeaving] = React.useState(false);

  // Avoid carrying the fade-out animation state across toast changes.
  // If we auto-dismiss or manually dismiss a toast, `isLeaving` becomes true.
  // Without resetting it on new toasts, subsequent toasts can render in a permanent
  // fade-out state and appear invisible.
  useEffect(() => {
    setIsLeaving(false);
  }, [toast?.id]);

  const handleDismiss = useCallback(() => {
    setIsLeaving(true);
    setTimeout(onDismiss, 200); // Wait for fade animation
  }, [onDismiss]);

  useEffect(() => {
    if (!toast) return;

    // Use longer duration in E2E tests to give assertions time to observe the toast
    const e2eDuration = 10_000;
    const defaultSuccessDuration = window.api?.isE2E ? e2eDuration : 3000;

    // Auto-dismiss when duration is explicitly provided, regardless of toast type.
    // Otherwise, only success toasts without copyable text auto-dismiss: the user needs
    // time to copy (e.g. the only place a "Report slowness" bundle path is shown).
    const duration =
      toast.duration ??
      (toast.type === "success" && toast.copyText === undefined ? defaultSuccessDuration : null);
    if (duration !== null) {
      const timer = setTimeout(() => {
        handleDismiss();
      }, duration);

      return () => {
        clearTimeout(timer);
      };
    }

    // Error toasts stay until manually dismissed
    return () => {
      setIsLeaving(false);
    };
  }, [toast, handleDismiss]);

  if (!toast) return null;

  // Use rich error style when there's a title or solution
  const isRichError = toast.type === "error" && (toast.title ?? toast.solution);

  const content = isRichError ? (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-toast-fatal-bg border-toast-fatal-border text-danger-soft animate-[toastSlideIn_0.2s_ease-out] rounded border px-3 py-2.5 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1">
          {toast.title && <div className="mb-1.5 font-semibold">{toast.title}</div>}
          <div className="text-light mt-1.5 leading-[1.4]">{toast.message}</div>
          {toast.solution && (
            <div className="bg-dark font-monospace text-code-type mt-2 rounded px-2 py-1.5 text-[11px]">
              {toast.solution}
            </div>
          )}
        </div>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="flex h-4 w-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-base leading-none text-inherit opacity-60 transition-opacity hover:opacity-100"
        >
          ×
        </button>
      </div>
    </div>
  ) : (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      className={cn(
        "px-3 py-2 rounded text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]",
        isLeaving
          ? "animate-[toastFadeOut_0.2s_ease-out_forwards]"
          : "animate-[toastSlideIn_0.2s_ease-out]",
        toastTypeStyles[toast.type]
      )}
    >
      {/* Header row: icon + optional title + dismiss */}
      <div className="flex items-center gap-2">
        {toast.type === "success" ? (
          <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : (
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
        )}
        {toast.title && <span className="flex-1 text-[11px] font-semibold">{toast.title}</span>}
        {!toast.title && <span className="flex-1" />}
        {toast.copyText !== undefined && <CopyButton text={toast.copyText} className="h-4" />}
        {(toast.type === "error" || toast.copyText !== undefined) && (
          <button
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="flex h-4 w-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-base leading-none text-inherit opacity-60 transition-opacity hover:opacity-100"
          >
            ×
          </button>
        )}
      </div>
      {/* Message on its own line */}
      {/* wrap-anywhere: a saved report path is one long unbroken token on narrow screens. */}
      <div className="mt-1.5 wrap-anywhere opacity-90">{toast.message}</div>
    </div>
  );

  if (!wrap) return content;

  return <div className={wrapperClassName}>{content}</div>;
};
