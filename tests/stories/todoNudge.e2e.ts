/**
 * Story: the agent finishes open TODO items after Xum's turn-end nudge. The user asks for work;
 * the mock AI (`[mock:todo-nudge]`, mockAiRouter.ts) writes a TODO list, leaves "Verify the fix"
 * pending and ends its turn. Xum then sends its turn-end TODO nudge, shown as the collapsed row
 * "Asked the agent to update its TODO list and finish open items". The nudged turn keeps the
 * turn's tools (#7027), so the mock reads README.md and marks the list complete.
 *
 * The mock runs no tool, so the exact check reads the nudge row's tool policy from the server: a
 * todo_write-only policy there is the regression (open work waited for the user, and the smaller
 * tool block missed the prompt cache).
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, sendMessage, todoNudgeToolPolicies } from "../bugbash/repros/helpers";
import { openPlayground } from "./helpers";

const NUDGE_REPLY = "Verified the fix in README.md. The TODO list is complete.";

test(
  "the agent finishes open TODO items after the turn-end nudge",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, browser, screen }) => {
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    const transcript = browser.locator('[role="log"][aria-label="Conversation transcript"]');

    await disableTutorials(app);
    await app.open();
    // exact step: Haiku 5.5 missed this step in 10 of 14 cold failures (Phase 5)
    await openPlayground(screen);
    const before = (await todoNudgeToolPolicies(app)).length;
    // exact step: an agent step that types here stops replaying when the placeholder tip rotates.
    await sendMessage(screen, "[mock:todo-nudge] fix the login bug");
    await expect(transcript).toContainText(NUDGE_REPLY, { timeout: 60_000 });
    await expect(transcript).toContainText(
      "Asked the agent to update its TODO list and finish open items"
    );
    // The file_read row of the nudged turn, by the mock's tool call ID (mockAiRouter.ts), which
    // MessageRenderer puts on the row. No judge saw a planted bug that hid this tool card.
    await expect(
      browser.locator('[data-testid="chat-message"][data-tool-call-id="tool-file-read-verify"]')
    ).toContainText("README.md");
    // The row's text, quoted: "a row that says Xum asked the agent ..." failed, because the row
    // does not name Xum (PR lane, run 39695607277: ASSERTION_FAILED).
    await agent.assert(
      "after the row 'Asked the agent to update its TODO list and finish open items', the " +
        "agent read a file (README.md) and replied that the TODO list is complete"
    );

    const nudges = await todoNudgeToolPolicies(app);
    expect(nudges.length).toBe(before + 1);
    const nudge = nudges[nudges.length - 1];
    // The user turn had no tool policy, so the nudge must carry none: any policy narrows it.
    expect(nudge.toolPolicy).toBeNull();
    expect(nudge.retryToolPolicy).toBeNull();
  }
);
