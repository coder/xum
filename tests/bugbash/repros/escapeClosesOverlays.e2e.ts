// #5676, #5685, #5691, #5701: Escape closes the agent picker, the narrow-screen sidebar drawer,
// the notifications popover (once) and the tutorial tooltip. Each test fails on the old code.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { expectNotifyOnAllResponses, openPlayground, WORKSPACE_TITLE } from "./helpers";

test(
  "Escape closes the agent picker opened with Ctrl+Shift+A",
  { tags: ["bugbash", "5676"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const picker = screen.getByRole("button", "Select agent");
    // The old frame-deferred focus missed on every other open, so try twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      await screen.getByRole("textbox", "Message").tap();
      await browser.keyboard.press("Control+Shift+A");
      await expect(picker).toBeExpanded();
      await browser.keyboard.press("Escape");
      await expect(picker).not.toBeExpanded();
    }
  }
);

test(
  "Escape closes the narrow-screen sidebar drawer",
  { tags: ["bugbash", "5685"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await openPlayground(app, screen, browser);
    const drawerBackdrop = browser.locator(".mobile-overlay");
    const openMenu = screen.getByRole("button", "Open sidebar menu");
    if (await openMenu.isVisible()) await openMenu.tap();
    await expect(drawerBackdrop).toHaveCount(1);
    await expect(
      screen.getByRole("navigation", "Projects").getByText(WORKSPACE_TITLE)
    ).toBeVisible();

    await browser.keyboard.press("Escape");
    await expect(drawerBackdrop).toHaveCount(0);
  }
);

test(
  "A click on the notifications bell does not change the setting",
  { tags: ["bugbash", "5691"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    // The helper clicks the bell, reads the checkbox and closes the popover. The click used to
    // turn the setting on as well.
    await expectNotifyOnAllResponses(screen, browser, false);
    await expectNotifyOnAllResponses(screen, browser, false);
  }
);

test(
  "One Escape closes the notifications popover without a second copy of the settings",
  { tags: ["bugbash", "5691"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const bell = screen.getByRole("button", "Notifications");
    await bell.tap();
    await expect(screen.getByRole("checkbox", /^Notify on all responses/)).toBeVisible();
    await browser.keyboard.press("Escape");
    // Radix returns focus to the bell, and its tooltip opens on that focus. The tooltip used to
    // repeat the settings, checkbox included.
    await expect(bell).toBeFocused();
    const layer = browser.locator("[data-radix-popper-content-wrapper]");
    await expect(layer).toBeVisible();
    await expect(
      browser.locator("[data-radix-popper-content-wrapper] [role=checkbox]")
    ).toHaveCount(0);
  }
);

test(
  "Escape closes the tutorial tooltip while the composer has focus",
  { tags: ["bugbash", "5701"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    // Tutorials stay on: the first-run creation tutorial shows over the new-workspace screen.
    await app.open();
    const skip = screen.getByRole("button", "Skip");
    await expect(skip).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByRole("textbox", "Message")).toBeFocused();

    await browser.keyboard.press("Escape");
    await expect(skip).toBeHidden();
  }
);
