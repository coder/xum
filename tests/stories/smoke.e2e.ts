/**
 * The story lane's smoke test (`make test-stories`): the agent opens the seeded workspace, and
 * an exact check confirms it. It proves the lane end to end: the sandbox job, the proxy model
 * and the seeded app. The exact checks of the transcript and the message box replace the
 * Playwright test "workspace content loads correctly" (tests/e2e/scenarios/windowLifecycle.spec.ts).
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, WORKSPACE_TITLE } from "../bugbash/repros/helpers";

test(
  "the agent opens the playground workspace",
  { tags: ["story"] },
  async ({ app, agent, browser, screen }) => {
    await disableTutorials(app);
    await app.open();
    await agent.act(`open the '${WORKSPACE_TITLE}' workspace in the left sidebar`);
    // The workspace header's bell shows only once a workspace is open (repros/helpers.ts).
    await expect(screen.getByRole("button", "Notifications")).toBeVisible({ timeout: 15_000 });
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    await expect(
      browser.locator('[role="log"][aria-label="Conversation transcript"]')
    ).toBeVisible();
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    // The judge last: a replayed act ends in about a second, before the workspace has loaded,
    // and a judge that sees "Opening page..." cannot decide (ASSERTION_INCONCLUSIVE, first run).
    await agent.assert(
      `the chat of the '${WORKSPACE_TITLE}' workspace is shown, with its message box`
    );
  }
);
