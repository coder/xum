/**
 * The Electron story lane's smoke test (`make test-stories`, e2e.electron.config.ts): Xum
 * Electron shows the seeded project, exact steps open the playground workspace, and the agent
 * confirms its chat. It proves the lane end to end: the sandbox job with Xvfb, the provider, the
 * seed and the proxy model.
 */
import { test } from "@e2e-dev/web";
import { WORKSPACE_TITLE } from "../../bugbash/repros/helpers";
import { openPlayground } from "../helpers";

test(
  "Xum Electron opens the playground workspace",
  { tags: ["story"] },
  async ({ app, agent, screen }) => {
    await app.open();
    await openPlayground(screen);
    await agent.assert(
      `the chat of the '${WORKSPACE_TITLE}' workspace is shown, with its message box`
    );
  }
);
