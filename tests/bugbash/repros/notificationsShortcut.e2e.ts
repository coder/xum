// N5 (#5670): Ctrl+Shift+N was bound to both "New scratch chat" and "Toggle notifications".
// Notifications moved to Ctrl/Cmd+Shift+Comma; this repro fails if the shortcut stops toggling it.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "Ctrl+Shift+Comma toggles notifications in a workspace",
  { tags: ["bugbash", "N5"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    const bell = screen.getByRole("button", "Notify on all responses");
    await expect(bell).toHaveAttribute("aria-pressed", "false");

    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+Comma");
    await expect(bell).toHaveAttribute("aria-pressed", "true");

    await browser.keyboard.press("Control+Shift+Comma");
    await expect(bell).toHaveAttribute("aria-pressed", "false");
  }
);
