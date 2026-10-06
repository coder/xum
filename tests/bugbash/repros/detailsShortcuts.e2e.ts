// #5671: after Ctrl+Shift+D and Escape, focus returns to the Workspace details button. The button
// stopped every key, so global shortcuts did nothing until you clicked elsewhere.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  armLayerProbe,
  expectNotifyOnAllResponses,
  openPlayground,
  waitForLayerEscapeReady,
} from "./helpers";

test(
  "global shortcuts still work after the Workspace details popover closes",
  { tags: ["bugbash", "5671"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the bug is a
    // desktop keyboard flow.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    // A fresh workspace starts with "Notify on all responses" off. The check opens the bell's
    // popover, so it runs only at the end: it would move focus away from the details button.
    await screen.getByRole("textbox", "Message").tap();
    // The details popover is the only Radix popover open here.
    await armLayerProbe(browser, "[data-radix-popper-content-wrapper] [role=dialog]");
    await browser.keyboard.press("Control+Shift+D");
    const details = screen.getByRole("dialog");
    await expect(details).toBeVisible();
    // Focus inside the popover does not prove that Radix takes Escape yet (see layerProbeInit).
    await waitForLayerEscapeReady(browser);
    await browser.keyboard.press("Escape");
    await expect(details).toBeHidden();
    // The precondition of the bug: Radix returns focus to the trigger.
    await expect(screen.getByRole("button", "Workspace details")).toBeFocused();

    // Any global shortcut shows it; this one toggles notifications (see notificationsShortcut).
    await browser.keyboard.press("Control+Shift+Comma");
    await expectNotifyOnAllResponses(screen, browser, true);
  }
);
