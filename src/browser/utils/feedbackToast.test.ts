import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { showFeedbackToast } from "./feedbackToast";

let cleanupDom: (() => void) | undefined;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanupDom?.();
  cleanupDom = undefined;
});

/**
 * The desktop app with no composer mounted: `window.api` exists, Electron has no prompt(),
 * and the only feedback is an alert. Resolves with the alert text once it is shown.
 */
function desktopAlert(writeText: (text: string) => Promise<void>): Promise<string> {
  (window as unknown as { api: object }).api = {};
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return new Promise((resolve) => {
    window.alert = (message?: unknown) => resolve(String(message));
  });
}

describe("showFeedbackToast desktop fallback", () => {
  test("copies the copy text to the clipboard and says so in the alert", async () => {
    const copied: string[] = [];
    const alerted = desktopAlert((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    showFeedbackToast({ type: "success", message: "Saved report", copyText: "/tmp/report-1" });
    expect(await alerted).toBe("Saved report\n\nThe path is copied to the clipboard.");
    expect(copied).toEqual(["/tmp/report-1"]);
  });

  test("shows the plain alert when the copy fails", async () => {
    const attempts: string[] = [];
    const alerted = desktopAlert((text) => {
      attempts.push(text);
      return Promise.reject(new Error("denied"));
    });
    showFeedbackToast({ type: "success", message: "Saved report", copyText: "/tmp/report-1" });
    expect(await alerted).toBe("Saved report");
    expect(attempts).toEqual(["/tmp/report-1"]);
  });
});
