import {
  CUSTOM_EVENTS,
  createCustomEvent,
  type CustomEventPayloads,
} from "@/common/constants/events";
import { isDialogOpen } from "@/browser/utils/ui/keybinds";

export type FeedbackToast = CustomEventPayloads[typeof CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST];

/**
 * Show a success or error toast from code that has no toast host of its own (palette actions,
 * copy buttons, terminal pop-outs). ChatInput renders the toast; where it is not mounted, a
 * native alert keeps the message from being lost.
 */
export function showFeedbackToast(feedback: FeedbackToast): void {
  if (typeof window === "undefined") {
    return;
  }

  // Analytics view does not mount ChatInput, so keep a basic alert fallback
  // for command palette actions that need user feedback.
  // A composer behind an open modal (Settings, Analytics) cannot show its toast.
  const hasChatInputToastHost =
    typeof document !== "undefined" &&
    !isDialogOpen() &&
    document.querySelector('[data-component="ChatInputSection"]') !== null;

  if (hasChatInputToastHost) {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, feedback));
    return;
  }

  const alertMessage = feedback.title
    ? `${feedback.title}\n\n${feedback.message}`
    : feedback.message;
  // A native alert's text cannot be selected, so copyable text (a server-side report path)
  // goes into a prompt's prefilled field instead. Electron does not implement prompt(),
  // so the desktop app (which has `window.api` and reveals the folder itself) keeps alert.
  if (feedback.copyText !== undefined && !window.api && typeof window.prompt === "function") {
    window.prompt(alertMessage, feedback.copyText);
    return;
  }
  if (typeof window.alert === "function") {
    window.alert(alertMessage);
  }
}
