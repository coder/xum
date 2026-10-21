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
import { expect, unique } from "e2e";
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

    // A param, not part of the instruction: the path is a new temp folder on each run, and
    // unique() keeps it out of the replay cache key, so the recording replays with today's path.
    await agent.act(
      "open Settings > Plugins, type the path {path} into the install field (the field takes a " +
        "local path), preview it, and install the hook-guard plugin",
      { params: { path: unique(path) } }
    );
    await agent.act(
      "in Settings > Plugins, open the hook review of the hook-guard plugin and trust ONLY its " +
        "PreToolUse hook (MCP tool guard / check_command). Do not trust or turn off any other hook."
    );
    await expectTrusted();

    await xum.restartServer();
    await app.open();
    // exact steps: the replay ran its taps, its end-state check misread the open review, and
    // Haiku 5.5 then toggled the review closed (PR lane, runs 39656243674; #7070: 3 of 10 warm).
    // The button names of SettingsButton.tsx, SettingsPage.tsx and PluginsSettingsSection.tsx.
    await screen.getByTestId("settings-button").tap();
    await settings.getByRole("button", "Plugins").tap();
    await settings.getByRole("button", "Review hooks for hook-guard").tap();
    // The exact checks first, then the judge: the judge sees one screen.
    await expectTrusted();
    // Only what the screen shows now. A claim about a later prompt ("does not ask again") made
    // the judge answer ASSERTION_INCONCLUSIVE in a merge-queue run (#7070 item 6). Only the
    // PreToolUse hook: the user never trusted the others, so they still need review, and a judge
    // read "hook-guard" as all of them (first run).
    await agent.assert(
      "In the hook review of the hook-guard plugin, its PreToolUse hook (MCP tool guard / " +
        "check_command) shows as trusted, with no Trust button for it. Its other hooks can still " +
        "show that they need review."
    );
  }
);
