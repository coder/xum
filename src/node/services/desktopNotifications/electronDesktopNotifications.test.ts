import { describe, expect, test } from "bun:test";
import {
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
} from "./desktopNotifications";
import {
  createElectronDesktopNotifications,
  electronDesktopNotifications,
  type ElectronNotificationApi,
} from "./electronDesktopNotifications";

// bun test runs outside Electron: the Node layer must refuse before it imports electron, with
// the error that notify.ts returned before the move, so the tool still falls back to the browser.
test("outside Electron the Node layer shows nothing and says why", async () => {
  expect(await electronDesktopNotifications.show({ title: "t", workspaceId: "ws" })).toEqual({
    success: false,
    error: "System notifications not supported (not running in Electron)",
  });
});

interface FakeWindow {
  minimized: boolean;
  calls: string[];
  sent: Array<[string, { workspaceId: string }]>;
}

/** A fake electron module that records what the layer does with it. */
function fakeElectron(options: { supported?: boolean; windows?: FakeWindow[] } = {}) {
  const shown: Array<{ title: string; body?: string; silent: boolean }> = [];
  const clickListeners: Array<() => void> = [];
  const windows = options.windows ?? [];
  const api: ElectronNotificationApi = {
    Notification: class {
      static isSupported() {
        return options.supported ?? true;
      }
      constructor(private readonly notificationOptions: (typeof shown)[number]) {}
      on(_event: "click", listener: () => void) {
        clickListeners.push(listener);
      }
      show() {
        shown.push(this.notificationOptions);
      }
    },
    BrowserWindow: {
      getAllWindows: () =>
        windows.map((window) => ({
          isMinimized: () => window.minimized,
          restore: () => window.calls.push("restore"),
          focus: () => window.calls.push("focus"),
          webContents: { send: (channel, payload) => window.sent.push([channel, payload]) },
        })),
    },
  };
  const notifications = createElectronDesktopNotifications({
    isElectron: () => true,
    loadElectron: () => Promise.resolve(api),
  });
  return { notifications, shown, click: () => clickListeners.forEach((listener) => listener()) };
}

function fakeWindow(minimized: boolean): FakeWindow {
  return { minimized, calls: [], sent: [] };
}

describe("the Node layer in Electron", () => {
  test("shows one notification with the title and body cut to the OS limits", async () => {
    const electron = fakeElectron();
    const result = await electron.notifications.show({
      title: "t".repeat(MAX_NOTIFICATION_TITLE_LENGTH + 5),
      body: "b".repeat(MAX_NOTIFICATION_BODY_LENGTH + 5),
    });
    expect(result).toEqual({ success: true });
    expect(electron.shown).toEqual([
      {
        title: `${"t".repeat(MAX_NOTIFICATION_TITLE_LENGTH - 1)}…`,
        body: `${"b".repeat(MAX_NOTIFICATION_BODY_LENGTH - 1)}…`,
        silent: false,
      },
    ]);
  });

  test("shows nothing on a platform without notifications", async () => {
    const electron = fakeElectron({ supported: false });
    expect(await electron.notifications.show({ title: "t" })).toEqual({
      success: false,
      error: "System notifications not supported on this platform",
    });
    expect(electron.shown).toEqual([]);
  });

  test("reports a failed electron import as an error", async () => {
    const notifications = createElectronDesktopNotifications({
      isElectron: () => true,
      loadElectron: () => Promise.reject(new Error("no electron")),
    });
    expect(await notifications.show({ title: "t" })).toEqual({
      success: false,
      error: "Failed to send notification: no electron",
    });
  });

  test("a click restores and focuses the first window, then opens the workspace", async () => {
    const first = fakeWindow(true);
    const second = fakeWindow(false);
    const electron = fakeElectron({ windows: [first, second] });
    await electron.notifications.show({ title: "t", workspaceId: "ws-1" });
    electron.click();
    expect(first.calls).toEqual(["restore", "focus"]);
    expect(first.sent).toEqual([["mux:notification-clicked", { workspaceId: "ws-1" }]]);
    expect(second.calls).toEqual([]);
  });

  test("a click without a workspace only focuses, and a click with no window does nothing", async () => {
    const window = fakeWindow(false);
    const electron = fakeElectron({ windows: [window] });
    await electron.notifications.show({ title: "t" });
    electron.click();
    expect(window.calls).toEqual(["focus"]);
    expect(window.sent).toEqual([]);

    const noWindow = fakeElectron();
    await noWindow.notifications.show({ title: "t", workspaceId: "ws-1" });
    expect(() => noWindow.click()).not.toThrow();
  });
});
