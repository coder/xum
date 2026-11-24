// Bug bash of the install methods (charters claude-plugin-install and claude-plugin-composer,
// finding IM-3): the hook review of a Claude Code plugin said "A hook runs only after you trust
// it" above hooks that all read "Never runs" and offer no trust control. The seed writes
// claude-review-kit (tests/bugbash/pluginInstallFixtures.ts), whose only hook is a Claude hook.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, pluginSourcePath } from "./helpers";

test(
  "The hook review of a plugin whose hooks never run does not promise they run after trust",
  { tags: ["bugbash", "IM-3"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(app);
    const source = await pluginSourcePath(app, "claude-review-kit");
    await app.open();
    await browser.locator('[data-testid="settings-button"]').tap();
    const settings = screen.getByRole("dialog", "Settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("button", "Plugins").tap();
    const review = settings.getByRole("button", "Review hooks for claude-review-kit");
    // One app serves both targets' tests in turn: the plugin can already be installed.
    if ((await review.count()) === 0) {
      await settings.getByRole("button", "Add plugin").tap();
      await settings.getByRole("textbox", "Git URL or owner/repo").fill(source);
      await settings.getByRole("button", "Preview").tap();
      await settings.getByRole("button", "Install").tap({ timeout: 30_000 });
    }
    await review.tap({ timeout: 30_000 });

    await expect(
      settings.getByText(/Never runs: Xum does not run Claude Code plugin hooks/)
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(settings.getByText(/A hook runs only after you trust it/)).toHaveCount(0);
  }
);
