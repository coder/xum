// B3 (#5670): Ctrl+Shift+K opened the Artifacts tab but left focus in the chat, with no focus ring.
// Proves the shortcut moves focus to the panel and the panel marks its ring (data-shortcut-focus).
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "Ctrl+Shift+K focuses the Artifacts panel and shows its focus ring",
  { tags: ["bugbash", "B3"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    // The bug showed when the shortcut came from the chat input.
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");

    const panel = screen.getByTestId("artifacts-panel");
    await expect(panel).toBeFocused();
    await expect(panel).toHaveAttribute("data-shortcut-focus", "true");
  }
);

// User request (2026-10-26): while the Artifacts tab shows and focus is elsewhere, Ctrl+Shift+K
// moves focus into the tab instead of hiding the sidebar. Only a press from inside the tab hides it.
test(
  "Ctrl+Shift+K focuses the showing Artifacts tab first, and hides the sidebar from inside it",
  { tags: ["bugbash", "artifacts-key-focus-first"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const input = screen.getByRole("textbox", "Message");
    const panel = screen.getByTestId("artifacts-panel");
    await input.tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(panel).toBeFocused();

    // The tab shows, focus is back in the chat: the key only moves focus.
    await input.tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(panel).toBeFocused();
    await expect(screen.getByRole("button", "Collapse right sidebar")).toBeVisible();

    // Focus is in the tab: the key hides the sidebar, and focus moves to the header toggle. The
    // check reads DOM focus: in CI, toBeFocused on the accessibility tree sometimes missed the
    // focus that moved onto the toggle while its label changed.
    await browser.keyboard.press("Control+Shift+K");
    await expect
      .poll(() =>
        browser.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null)
      )
      .toBe("Expand right sidebar");
  }
);
