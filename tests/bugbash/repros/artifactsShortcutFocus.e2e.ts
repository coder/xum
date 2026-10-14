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
