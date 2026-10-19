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
import {
  disableTutorials,
  todoNudgeToolPolicies,
  WORKSPACE_TITLE,
} from "../bugbash/repros/helpers";
import { applyToolPolicyToNames } from "../../src/common/utils/tools/toolPolicy";

const NUDGE_REPLY = "Verified the fix in README.md. The TODO list is complete.";
const TOOLS = ["bash", "file_read", "todo_write"];

test(
  "the agent finishes open TODO items after the turn-end nudge",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, browser }) => {
    // e2e has no `log` role query, so CSS: the transcript is ChatPane's role="log" element.
    const transcript = browser.locator('[role="log"][aria-label="Conversation transcript"]');

    await disableTutorials(app);
    await app.open();
    await agent.act(`open the '${WORKSPACE_TITLE}' workspace in the left sidebar`);
    const before = (await todoNudgeToolPolicies(app)).length;
    await agent.act(
      "type exactly '[mock:todo-nudge] fix the login bug' into the message box, send it, and " +
        "wait until the agent stops replying"
    );
    await expect(transcript).toContainText(NUDGE_REPLY, { timeout: 60_000 });
    await expect(transcript).toContainText(
      "Asked the agent to update its TODO list and finish open items"
    );
    await agent.assert(
      "after a row that says Xum asked the agent to update its TODO list and finish open " +
        "items, the agent read a " +
        "file (README.md) and replied that the TODO list is complete"
    );

    const nudges = await todoNudgeToolPolicies(app);
    expect(nudges.length).toBe(before + 1);
    const nudge = nudges[nudges.length - 1];
    expect(applyToolPolicyToNames(TOOLS, nudge.toolPolicy ?? undefined)).toEqual(TOOLS);
    expect(applyToolPolicyToNames(TOOLS, nudge.retryToolPolicy ?? undefined)).toEqual(TOOLS);
  }
);
