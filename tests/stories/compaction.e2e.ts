/**
 * Story: `/compact` replaces the old chat with a summary. The user sends two messages, then
 * `/compact -t 500`. The mock AI answers the compaction request with "Mock compaction summary:"
 * (mockAiRouter.ts), and Xum must drop the older messages from the live transcript once the
 * compaction boundary arrives (StreamingMessageAggregator's live prune). The story never reloads
 * the page, so the live prune decides what the user sees. The older messages stay reachable
 * through "Load older messages".
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials } from "../bugbash/repros/helpers";
import { openPlayground } from "./helpers";

// Plain texts get the mock's default reply, "Mock response: <text>". Neither is part of the other.
const FIRST = "plan the garden beds";
const SECOND = "order tomato seeds";

test(
  "/compact replaces the old chat with a summary",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, browser, screen }) => {
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    const transcript = browser.locator('[role="log"][aria-label="Conversation transcript"]');

    await disableTutorials(app);
    await app.open();
    // exact step: Haiku 5.5 missed this step in 10 of 14 cold failures (Phase 5)
    await openPlayground(screen);
    for (const text of [FIRST, SECOND]) {
      await agent.act(`send the chat message '${text}' and wait for the reply`);
      await expect(transcript).toContainText(`Mock response: ${text}`, { timeout: 30_000 });
    }

    await agent.act(
      "type exactly '/compact -t 500' into the message box and send it as a message. Do not " +
        "pick another command from the suggestions."
    );
    await expect(transcript).toContainText("Mock compaction summary:", { timeout: 30_000 });
    // innerText: the label renders upper case (CSS), "COMPACTION BOUNDARY #1".
    await expect(transcript).toContainText("Compaction boundary", { ignoreCase: true });
    // The live prune: without it the older replies stay on screen until a reload.
    await expect(transcript).not.toContainText(`Mock response: ${FIRST}`, { timeout: 15_000 });
    await agent.assert(
      "the chat shows a compaction summary in place of the earlier conversation: the earlier " +
        `replies, such as the one to '${FIRST}', are no longer shown in the chat`
    );
  }
);
