/**
 * Story: a chat survives a restart of the server. The user sends a message and gets the reply,
 * then the app server restarts (xum.restartServer, fixtures.ts). Xum must read the chat back
 * from disk (chat.jsonl), not from the old server's memory. It replaces the Playwright test "chat
 * history persists across page reload" (tests/e2e/scenarios/persistence.spec.ts, deleted), which
 * only reloaded the page, so the server kept its in-memory state there.
 */
import { expect } from "e2e";
import { disableTutorials, sendMessage } from "../bugbash/repros/helpers";
import { test } from "./fixtures";
import { openPlayground } from "./helpers";

const MESSAGE = "remember this";
// The mock AI's default reply (mockAiRouter.ts).
const REPLY = `Mock response: ${MESSAGE}`;

test(
  "a chat survives a restart of the server",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, browser, screen, xum }) => {
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    const transcript = browser.locator('[role="log"][aria-label="Conversation transcript"]');

    await disableTutorials(app);
    await app.open();
    // Two steps, not one: the combined step's recorded end state (the sidebar) never matched on
    // replay, so the agent had to conclude it with a model call on every warm run.
    // exact step: Haiku 5.5 missed this step in 10 of 14 cold failures (Phase 5)
    await openPlayground(screen);
    // exact step: an agent step that types here stops replaying when the placeholder tip rotates.
    await sendMessage(screen, MESSAGE);
    await expect(transcript).toContainText(REPLY, { timeout: 30_000 });
    // The reply text shows before stream-end persists it: a restart in that gap can lose it.
    await expect(screen.getByRole("button", "Stop streaming")).not.toBeVisible({
      timeout: 30_000,
    });

    await xum.restartServer();
    await app.open();
    await openPlayground(screen);
    await expect(transcript).toContainText(REPLY, { timeout: 15_000 });
    // The whole text, so the reply (which contains it) does not match.
    await expect(transcript.getByText(MESSAGE)).toBeVisible();
    // Only what is on screen now: a judge cannot see the chat from before the restart (first run).
    await agent.assert(`the chat shows the user's message '${MESSAGE}' and the reply '${REPLY}'`);
  }
);
