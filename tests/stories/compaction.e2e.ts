/**
 * Story: `/compact` replaces the old chat with a summary. The user sends two messages, then
 * `/compact -t 500`. The mock AI answers the compaction request with "Mock compaction summary:"
 * (mockAiRouter.ts), and Xum must drop the older messages from the live transcript once the
 * compaction boundary arrives (StreamingMessageAggregator's live prune). The story never reloads
 * the page, so the live prune decides what the user sees. The older messages stay reachable
 * through "Load older messages". It replaces the Playwright test "slash command /compact produces
 * compacted summary" (tests/e2e/scenarios/slashCommands.spec.ts).
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, WORKSPACE_TITLE } from "../bugbash/repros/helpers";

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
    await agent.act(`open the '${WORKSPACE_TITLE}' workspace in the left sidebar`);
    for (const text of [FIRST, SECOND]) {
      await agent.act(`send the chat message '${text}' and wait for the reply`);
      await expect(transcript).toContainText(`Mock response: ${text}`, { timeout: 30_000 });
    }

    // Exact steps, not agent.act: the "Compaction started" toast (chatCommands.ts) dismisses
    // itself after 3 s in a browser (ChatInputToast.tsx), sooner than an agent concludes its step.
    const message = screen.getByRole("textbox", "Message");
    await message.fill("/compact -t 500");
    // Escape closes the command suggestions, so Enter sends instead of picking one.
    await message.press("Escape");
    await message.press("Enter");
    await expect(
      screen.getByRole("status").filter({ hasText: /^Compaction started/ })
    ).toBeVisible();
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
