// Cursor plugin RFC, PR 2: cursor/plugins ships a Cursor and a Claude Code marketplace file, and
// both list pstack. The Plugins tab must list pstack once with a Preview action per build, and the
// Cursor build must install through its own manifest. The seed writes cursor-market
// (tests/bugbash/pluginInstallFixtures.ts), whose two builds have different skills.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, pluginSourcePath } from "./helpers";

test(
  "A name in both marketplace files is one row, and its Cursor build installs",
  { tags: ["bugbash", "cursor-marketplace-merge"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(app);
    const source = await pluginSourcePath(app, "cursor-market");
    await app.open();
    await browser.locator('[data-testid="settings-button"]').tap();
    const settings = screen.getByRole("dialog", "Settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("button", "Plugins").tap();
    const manage = settings.getByRole("button", "Manage components for pstack");
    await expect(settings.getByRole("button", "Add plugin")).toBeVisible({ timeout: 15_000 });
    // One app serves both targets' tests in turn: the plugin can already be installed.
    const installed = (await manage.count()) > 0;

    await settings.getByRole("button", "Add plugin").tap();
    await settings.getByRole("textbox", "Git URL or owner/repo").fill(source);
    await settings.getByRole("button", "Preview").tap();
    await expect(settings.getByRole("radio", /pstack/)).toBeChecked({ timeout: 30_000 });
    await expect(settings.getByRole("radio")).toHaveCount(1);
    await expect(settings.getByRole("button", "Preview Claude build")).toBeEnabled();
    await settings.getByRole("button", "Preview Cursor build").tap();

    await expect(settings.getByRole("checkbox", "plan-first")).toBeVisible({ timeout: 30_000 });
    await expect(settings.getByText("Skills (1 of 1 selected)")).toBeVisible();
    if (installed) {
      // The name is taken, so close the Add panel: its skill list would match below.
      await settings.getByRole("button", "Back").tap();
      await settings.getByRole("button", "Back").tap();
      await settings.getByRole("button", "Cancel").tap();
    } else {
      await settings.getByRole("button", "Install").tap();
    }

    await manage.tap({ timeout: 30_000 });
    await expect(settings.getByRole("checkbox", "plan-first")).toBeVisible({ timeout: 15_000 });
    await expect(settings.getByRole("checkbox", "claude-notes")).toHaveCount(0);
  }
);
