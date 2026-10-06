// Known failure, open issue #5671: after Ctrl+Shift+D and Escape, focus returns to the Workspace
// details button, which stops every key, so global shortcuts do nothing. Fails until #5671 is fixed.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "global shortcuts still work after the Workspace details popover closes",
  { tags: ["bugbash", "known-failure", "5671"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the bug is a
    // desktop keyboard flow.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const bell = screen.getByRole("button", "Notify on all responses");
    await expect(bell).toHaveAttribute("aria-pressed", "false");

    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+D");
    const details = screen.getByRole("dialog");
    await expect(details).toBeVisible();
    await browser.keyboard.press("Escape");
    await expect(details).toBeHidden();
    // The precondition of the bug: Radix returns focus to the trigger.
    await expect(screen.getByRole("button", "Workspace details")).toBeFocused();

    // Any global shortcut shows it; this one toggles notifications (see notificationsShortcut).
    await browser.keyboard.press("Control+Shift+Comma");
    await expect(bell).toHaveAttribute("aria-pressed", "true");
  }
);
