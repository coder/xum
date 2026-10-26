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

    // Focus is in the tab: the key hides the sidebar.
    await browser.keyboard.press("Control+Shift+K");
    await expect(screen.getByRole("button", "Expand right sidebar")).toBeFocused();
  }
);

// artifacts-key-focus-race (#7599 CI): a press right after the focus step collapsed the sidebar and
// moved focus to the header toggle, then the panel's pending autofocus ran again and took focus
// back, and the collapse dropped it on <body>. CI's fast key presses hit it on every run.
test(
  "Ctrl+Shift+K right after the focus step hides the sidebar and keeps focus on the toggle",
  { tags: ["bugbash", "artifacts-key-focus-race"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const input = screen.getByRole("textbox", "Message");
    const panel = screen.getByTestId("artifacts-panel");
    await input.tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(panel).toBeFocused();
    await input.tap();
    // Queue the next press for the moment the focus step focuses the panel, before React renders
    // the panel's low-priority "autofocus consumed" update.
    await browser.evaluate(() => {
      const el = document.querySelector('[data-testid="artifacts-panel"]');
      const chord = { key: "K", code: "KeyK", ctrlKey: true, shiftKey: true, bubbles: true };
      el?.addEventListener(
        "focus",
        () => queueMicrotask(() => el.dispatchEvent(new KeyboardEvent("keydown", chord))),
        { once: true }
      );
      return null;
    });
    await browser.keyboard.press("Control+Shift+K");
    await expect(screen.getByRole("button", "Expand right sidebar")).toBeFocused();
  }
);
