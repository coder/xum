// #6117: closing the Artifacts tab with the keyboard dropped focus on <body>, so the next Tab
// started over from the top of the page. Proves focus moves to the tab the close revealed.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "closing the Artifacts tab by keyboard focuses the revealed tab",
  { tags: ["bugbash", "6117"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar, so it has no tab to close.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(screen.getByTestId("artifacts-panel")).toBeFocused();

    // The issue's steps: two Shift+Tabs reach the tab's X.
    await browser.keyboard.press("Shift+Tab");
    await browser.keyboard.press("Shift+Tab");
    const close = screen.getByRole("button", "Close Artifacts");
    await expect(close).toBeFocused();
    await browser.keyboard.press("Enter");

    await expect(close).toBeHidden();
    // The revealed tab is selected and holds focus; the page body does not.
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const active = document.activeElement;
          return active?.getAttribute("role") === "tab"
            ? `tab selected=${active.getAttribute("aria-selected")}`
            : (active?.tagName ?? "none");
        })
      )
      .toBe("tab selected=true");
  }
);
