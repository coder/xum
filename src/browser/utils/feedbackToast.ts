import {
  CUSTOM_EVENTS,
  createCustomEvent,
  type CustomEventPayloads,
} from "@/common/constants/events";
import { copyToClipboard } from "@/browser/utils/clipboard";
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
  // A composer behind an open modal (Settings, Analytics) cannot show its toast, nor can one
  // under an inert page: the phone full-screen right sidebar covers the composer and makes the
  // rest of the page inert, so its toast would be neither visible nor clickable.
  const composer =
    typeof document !== "undefined"
      ? document.querySelector('[data-component="ChatInputSection"]')
      : null;
  const hasChatInputToastHost =
    composer !== null && !isDialogOpen() && composer.closest("[inert]") === null;

  if (hasChatInputToastHost) {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, feedback));
    return;
  }

  showNativeFeedback(
    feedback.title ? `${feedback.title}\n\n${feedback.message}` : feedback.message,
    feedback.copyText
  );
}

/**
 * Feedback where no toast can show: a native dialog. A native alert's text cannot be selected,
 * so copyable text (a server-side report path) goes into a prompt's prefilled field instead.
 * Electron does not implement prompt(), so the desktop app (which has `window.api`) copies the
 * text to the clipboard and says so: its folder reveal can fail, and then the alert is the only
 * place the path appears (#5561).
 */
function showNativeFeedback(message: string, copyText: string | undefined): void {
  if (copyText !== undefined && !window.api && typeof window.prompt === "function") {
    window.prompt(message, copyText);
    return;
  }
  if (typeof window.alert !== "function") return;
  if (copyText === undefined || !window.api) {
    window.alert(message);
    return;
  }
  // The alert waits for the copy, so it never claims a copy that failed.
  void copyToClipboard(copyText).then(
    () => window.alert(`${message}\n\nThe path is copied to the clipboard.`),
    () => window.alert(message)
  );
}
