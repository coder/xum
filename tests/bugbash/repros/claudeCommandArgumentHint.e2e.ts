// Found while seeding the install-method bug bash (charters.install-methods.txt, finding IM-1): a
// Claude Code command with `argument-hint: [focus]`, the form the Claude Code docs show, did not
// load. YAML reads `[focus]` as a list, the skill schema wants a string, and the preview showed
// "Invalid SKILL.md frontmatter" instead of the /review command. The seed writes
// claude-review-kit (tests/bugbash/pluginInstallFixtures.ts).
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, pluginSourcePath } from "./helpers";

test(
  "A Claude Code command with a bracketed argument-hint loads as a skill",
  { tags: ["bugbash", "IM-1"] },
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
    await settings.getByRole("button", "Preview").tap();

    // The preview has loaded once its skill list shows a fixture skill.
    await expect(settings.getByText("lint-rules", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      settings.getByText(/commands\/review\.md: Invalid SKILL\.md frontmatter/)
    ).toHaveCount(0);
    await expect(settings.getByText("review", { exact: true })).toBeVisible();
  }
);
