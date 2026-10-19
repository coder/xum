/**
 * The Electron story lane's smoke test (`make test-stories`, e2e.electron.config.ts): Xum
 * Electron shows the seeded project, an exact step opens the playground workspace, and the agent
 * confirms the desktop window. It proves the lane end to end: the sandbox job with Xvfb, the
 * provider, the seed and the proxy model.
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { WORKSPACE_TITLE } from "../../bugbash/repros/helpers";

test(
  "Xum Electron opens the playground workspace",
  { tags: ["story"] },
  async ({ app, agent, screen }) => {
    await app.open();
    // In Electron the seeded project starts collapsed.
    const expand = screen.getByRole("button", "Expand project demo-app");
    await expect(expand).toBeVisible({ timeout: 30_000 });
    await expand.tap();
    await screen.getByText(WORKSPACE_TITLE).first().tap();
    // The workspace header's bell shows only once a workspace is open (repros/helpers.ts).
    await expect(screen.getByRole("button", "Notifications")).toBeVisible({ timeout: 15_000 });
    await agent.assert(
      `the chat of the '${WORKSPACE_TITLE}' workspace is shown, with its message box`
    );
  }
);
