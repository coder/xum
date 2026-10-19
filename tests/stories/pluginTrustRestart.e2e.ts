/**
 * Story: a hook the user trusts stays trusted after the app server restarts. The user installs
 * the hook-guard plugin from its local path, trusts only its PreToolUse hook, and the server
 * restarts (xum.restartServer, fixtures.ts). Xum must read the trust record back from disk
 * (pluginHookTrust.ts) and not ask again.
 *
 * The exact checks use the review buttons' names (PluginHooksPanel.tsx): `check_command` is the
 * hook-guard PreToolUse handler only (../bugbash/pluginHookFixtures.ts), so the seeded
 * hook-review-demo plugin, whose PreToolUse hook is already trusted, cannot satisfy them.
 */
import { expect } from "e2e";
import { z } from "zod";
import { disableTutorials, WORKSPACE_TITLE } from "../bugbash/repros/helpers";
import { test } from "./fixtures";

const TURN_OFF = /^Turn off PreToolUse hook MCP tool guard \/ check_command/;
const TRUST = /^Trust PreToolUse hook MCP tool guard \/ check_command/;

test(
  "a trusted plugin hook stays trusted after the server restarts",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, screen, xum }) => {
    const settings = screen.getByRole("dialog", "Settings");
    // Trusted: Xum offers only to turn the hook off.
    const expectTrusted = async () => {
      await expect(settings.getByRole("button", TURN_OFF)).toBeVisible({ timeout: 15_000 });
      await expect(settings.getByRole("button", TRUST)).not.toBeVisible();
    };

    await disableTutorials(app);
    await app.open();
    await agent.act(
      `open the '${WORKSPACE_TITLE}' workspace, then open the file 'plugin-sources.md' in its Artifacts tab`
    );
    // The clipboard is blocked in the sandbox, so the agent reads the path and types it later.
    const { path } = await agent.extract(
      "the local path listed for the hook-guard plugin in 'plugin-sources.md'",
      { schema: z.object({ path: z.string() }) }
    );
    expect(path).toMatch(/^\/\S+\/plugin-sources\/hook-guard$/);

    await agent.act(
      `open Settings > Plugins, type the path ${path} into the install field (the field takes a ` +
        "local path), preview it, and install the hook-guard plugin"
    );
    await agent.act(
      "in Settings > Plugins, open the hook review of the hook-guard plugin and trust ONLY its " +
        "PreToolUse hook (MCP tool guard / check_command). Do not trust or turn off any other hook."
    );
    await expectTrusted();

    await xum.restartServer();
    await app.open();
    await agent.act(
      "open Settings > Plugins and open the hook review of the hook-guard plugin. Only look: do " +
        "not click Trust, Turn off or any other button in the review."
    );
    // Only the PreToolUse hook: the user never trusted the others, so they still need review,
    // and a judge read "hook-guard" as all of them (first run).
    await agent.assert(
      "Xum does not ask to allow or review the PreToolUse hook of hook-guard again, and that " +
        "hook is trusted. Its other hooks were never trusted, so they may still need review."
    );
    await expectTrusted();
  }
);
