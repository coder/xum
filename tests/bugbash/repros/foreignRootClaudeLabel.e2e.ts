// Follow-up to #7406: a repository whose root plugin.json has no `$schema` and that has only a
// Claude Code manifest loads with the Claude rules, but the preview's install method badge said
// "Agent Plugin" (detectInstallMethods counted any root plugin.json as the repository's own
// manifest). The seed writes claude-foreign-root (tests/bugbash/pluginInstallFixtures.ts) in that
// shape. Preview only, so the test runs again on the second target.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, pluginSourcePath } from "./helpers";

test(
  "A Claude Code plugin next to another tool's plugin.json previews as a Claude Code plugin",
  { tags: ["bugbash", "foreign-root-claude-label"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(app);
    const source = await pluginSourcePath(app, "claude-foreign-root");
    await app.open();
    await browser.locator('[data-testid="settings-button"]').tap();
    const settings = screen.getByRole("dialog", "Settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("button", "Plugins").tap();
    await settings.getByRole("button", "Add plugin").tap();
    await settings.getByRole("textbox", "Git URL or owner/repo").fill(source);
    await settings.getByRole("button", "Preview").tap();

    await expect(settings.getByText("Skills (1 of 1 selected)")).toBeVisible({ timeout: 30_000 });
    await expect(settings.getByText("Claude Code plugin", { exact: true })).toBeVisible();
    await expect(settings.getByText("Agent Plugin", { exact: true })).toHaveCount(0);
  }
);
