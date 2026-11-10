// Bug bash of the install methods (charter install-as-keyboard, finding IM-2): picking a choice
// in "Install as" with Space or Enter previewed again, the picker turned disabled while it loaded, and the
// focused choice lost focus to the dialog. Arrow keys then did nothing, so a keyboard user could
// not switch back. The seed writes claude-review-kit (tests/bugbash/pluginInstallFixtures.ts),
// which fits "Claude Code plugin" and "Skills".
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, pluginSourcePath } from "./helpers";

test(
  "The Install as choice keeps focus after a keyboard pick",
  { tags: ["bugbash", "IM-2"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(app);
    const source = await pluginSourcePath(app, "claude-review-kit");
    await app.open();
    await browser.locator('[data-testid="settings-button"]').tap();
    const settings = screen.getByRole("dialog", "Settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("button", "Plugins").tap();
    await settings.getByRole("button", "Add plugin").tap();
    await settings.getByRole("textbox", "Git URL or owner/repo").fill(source);
    await browser.keyboard.press("Enter");

    // The Claude Code plugin preview has the command as a third skill.
    await expect(settings.getByText("Skills (3 of 3 selected)")).toBeVisible({ timeout: 30_000 });
    // A tap focuses the choice like the keyboard does. (This e2e keyboard's Space and Enter do
    // not activate the Radix toggle item, so the pick itself is a tap.)
    await settings.getByRole("radio", "Skills").tap();
    // The Skills preview has only the two SKILL.md folders.
    await expect(settings.getByText("Skills (2 of 2 selected)")).toBeVisible({ timeout: 30_000 });
    await expect(settings.getByRole("radio", "Skills")).toBeFocused();
    // With focus kept, the arrow keys move between the choices again.
    await browser.keyboard.press("ArrowLeft");
    await expect(settings.getByRole("radio", "Claude Code plugin")).toBeFocused();
  }
);
