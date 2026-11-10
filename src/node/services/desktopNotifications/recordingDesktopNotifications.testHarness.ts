import type { DesktopNotificationRequest, DesktopNotifications } from "./desktopNotifications";

/** The test layer of DesktopNotifications: it shows nothing and records each request. */
export interface RecordingDesktopNotifications extends DesktopNotifications {
  readonly requests: DesktopNotificationRequest[];
}

/** result: what show() answers, as an OS notification would (default: shown). */
export function createRecordingDesktopNotifications(
  result: { success: boolean; error?: string } = { success: true }
): RecordingDesktopNotifications {
  const requests: DesktopNotificationRequest[] = [];
  return {
    requests,
    show: (request) => {
      requests.push(request);
      return Promise.resolve(result);
    },
  };
}
