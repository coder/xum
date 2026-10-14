// Bug bash of the Codex-format plugin hooks stack (#6149, charter hooks-warnings-big): the hook
// review listed two identical "'PreToolUse': a 'mcp_tool' handler has missing or invalid fields"
// warnings and regex warnings without their matcher, so a user could not tell which hook Xum
// refused. The seed installs hook-odd-matchers (tests/bugbash/pluginHookFixtures.ts).
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials } from "./helpers";

test(
  "Hook review warnings name the refused matcher and the handler they drop",
  { tags: ["bugbash", "6149"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(app);
    await app.open();
    await browser.locator('[data-testid="settings-button"]').tap();
    const settings = screen.getByRole("dialog", "Settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("button", "Plugins").tap();
    await settings.getByRole("button", "Review hooks for hook-odd-matchers").tap();

    await expect(
      settings.getByText(/ignoring its group "\\\\A\(\?:Bash\|Edit\)\\\\z"/)
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(settings.getByText(/\('timeout' of tool "bad_timeout"\)/)).toBeVisible();
    await expect(settings.getByText(/\('server' of tool "blank_server"\)/)).toBeVisible();
  }
);
