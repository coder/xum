/**
 * The OS notification that the notify tool shows. Loop code (notify.ts) reads this interface
 * from ToolConfiguration instead of importing electron (local/no-host-imports). The Node layer
 * is electronDesktopNotifications; tests pass a recording one
 * (recordingDesktopNotifications.testHarness.ts).
 */

/** Maximum notification body length (macOS limit is 256 bytes) */
export const MAX_NOTIFICATION_BODY_LENGTH = 200;

/** Maximum notification title length */
export const MAX_NOTIFICATION_TITLE_LENGTH = 64;

/**
 * Truncates text to a maximum length, adding ellipsis if truncated
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "…";
}

export interface DesktopNotificationRequest {
  title: string;
  body?: string;
  /** Clicking the notification navigates to this workspace. */
  workspaceId?: string;
}

export interface DesktopNotifications {
  /** success false: no OS notification; the notify tool then falls back to the browser. */
  show(request: DesktopNotificationRequest): Promise<{ success: boolean; error?: string }>;
}
