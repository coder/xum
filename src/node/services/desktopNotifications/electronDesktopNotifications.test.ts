import { expect, test } from "bun:test";
import { electronDesktopNotifications } from "./electronDesktopNotifications";

// bun test runs outside Electron: the Node layer must refuse before it imports electron, with
// the error that notify.ts returned before the move, so the tool still falls back to the browser.
test("outside Electron the Node layer shows nothing and says why", async () => {
  expect(await electronDesktopNotifications.show({ title: "t", workspaceId: "ws" })).toEqual({
    success: false,
    error: "System notifications not supported (not running in Electron)",
  });
});
