// #7027: Xum's turn-end TODO nudge sent the nudged turn with a todo_write-only tool policy. The
// agent could only edit its list, so open work waited for the next user message, and the smaller
// tool block missed the prompt cache on about half of the nudges. Proves the nudge now keeps the
// turn's tools: the nudge row carries no policy that narrows them.
//
// The mock AI answers `[mock:todo-nudge]` with a todo_write that leaves one item pending
// (mockAiRouter.ts), so Xum sends its real nudge, and answers the nudge with a file_read. The
// mock runs no tool, so only the stored tool policy shows what the nudged turn may call.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, sendMessage, todoNudgeToolPolicies } from "./helpers";
import { applyToolPolicyToNames } from "../../../src/common/utils/tools/toolPolicy";

const NUDGE_ROW = "Asked the agent to update its TODO list and finish open items";
const NUDGE_REPLY = "Verified the fix in README.md. The TODO list is complete.";
const TOOLS = ["bash", "file_read", "todo_write"];

test(
  "the turn-end TODO nudge keeps the turn's tools",
  { tags: ["bugbash", "7027", "mock-only"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    const before = (await todoNudgeToolPolicies(app)).length;

    await sendMessage(screen, `[mock:todo-nudge] ${Date.now()}`);
    await expect(screen.getByText(NUDGE_REPLY).last()).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText(NUDGE_ROW).last()).toBeVisible();

    const nudges = await todoNudgeToolPolicies(app);
    // Exactly one nudge for this user turn, and it lets the turn use every tool.
    expect(nudges.length).toBe(before + 1);
    const nudge = nudges[nudges.length - 1];
    expect(applyToolPolicyToNames(TOOLS, nudge.toolPolicy ?? undefined)).toEqual(TOOLS);
    expect(applyToolPolicyToNames(TOOLS, nudge.retryToolPolicy ?? undefined)).toEqual(TOOLS);
  }
);
