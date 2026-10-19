/**
 * A `xum://chat/new` link that the desktop opens while Xum Electron runs starts a new chat in the
 * running app, with the link's prompt in the composer. On Linux the desktop launches a second
 * Xum with the link in its argv; that process hands the argv to the running app over the
 * single-instance lock (`second-instance`, src/desktop/main.ts) and quits.
 */
import { randomBytes } from "node:crypto";
import { expect } from "e2e";
import { test } from "./fixtures";

test(
  "a deep link of a second launch starts a chat in the running app",
  { tags: ["story"] },
  async ({ app, agent, screen, xum }) => {
    await app.open();
    // The link only after the app shows its sidebar: e2e first loads about:blank, and a link
    // that arrives before the projects load waits in a buffer (WorkspaceContext handleDeepLink).
    await expect(screen.getByRole("button", "Expand project demo-app")).toBeVisible({
      timeout: 30_000,
    });
    // New on each run, so a prompt left from an earlier run (a draft) cannot pass the check.
    const prompt = `deep link ${randomBytes(4).toString("hex")}`;
    await xum.openDeepLink(`xum://chat/new?project=demo-app&prompt=${encodeURIComponent(prompt)}`);
    await expect(screen.getByRole("textbox", "Message")).toHaveValue(prompt, { timeout: 15_000 });
    await agent.assert(
      `a new chat for the project demo-app is open, and its message box holds the text '${prompt}'`
    );
  }
);
