// Install of DietrichGebert/ponytail (user report, 2026-10-24): its root plugin.json is another
// harness's file with no `$schema`, next to complete Codex and Claude Code manifests. Discovery
// took the root file and the preview failed with "Invalid plugin manifest: '$schema' is required
// and must be a string". The seed writes multi-harness (tests/bugbash/pluginInstallFixtures.ts)
// in the same shape. Preview only, so the test runs again on the second target.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, pluginSourcePath } from "./helpers";

test(
  "A root plugin.json without $schema previews through the Codex manifest",
  { tags: ["bugbash", "ponytail-root-manifest"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(app);
    const source = await pluginSourcePath(app, "multi-harness");
    await app.open();
    await browser.locator('[data-testid="settings-button"]').tap();
    const settings = screen.getByRole("dialog", "Settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("button", "Plugins").tap();
    await settings.getByRole("button", "Add plugin").tap();
    await settings.getByRole("textbox", "Git URL or owner/repo").fill(source);
    await settings.getByRole("button", "Preview").tap();

    // The Codex manifest lists skills/, which holds two skills.
    await expect(settings.getByText("Skills (2 of 2 selected)")).toBeVisible({ timeout: 30_000 });
    await expect(settings.getByText(/'\$schema' is required/)).toHaveCount(0);
  }
);
