// #7027, #7029: a turn and its turn-end TODO nudge must send the model one byte-identical tool
// block, or the nudge misses the prompt cache. #7027 sent the nudge with a todo_write-only tool
// policy, and the policy removed every other tool from the block. The nudged turn must also be
// able to use those tools, not just see them.
//
// The only lane that shows the real block: BUGBASH_SCENARIO=scripted-tools (startApp.ts) runs the
// app with agent tools on, against a loopback script (scriptedModel.ts) that logs each request's
// tool block. Tag `tools-on`: only `make test-bugbash-repros-sandbox` selects it, in the
// sandbox, and startApp.ts refuses the scenario everywhere else.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readScriptedModelRequests, SCRIPTED_DONE_TEXT, SCRIPTED_STEPS } from "../appControl";
import { openPlayground, sendMessage } from "./helpers";

const NUDGE_ROW = "Asked the agent to update its TODO list and finish open items";
const README_TEXT = "A small throwaway project for the Xum bug bash.";

test(
  "a turn and its TODO nudge send one tool block, and the nudged turn can use it",
  { tags: ["bugbash", "7027", "7029", "tools-on"] },
  async ({ app, screen, browser }) => {
    if (app.baseUrl === undefined) throw new Error("The bug-bash target declares no app URL");
    const port = Number(new URL(app.baseUrl).port);
    await openPlayground(app, screen, browser);
    const before = readScriptedModelRequests(port).length;

    // The script ignores this text: the turn writes one open TODO item and ends, Xum nudges, and
    // the nudged turn reads README.md and completes the list.
    await sendMessage(screen, `Start the task ${Date.now()}`);
    await expect(screen.getByText(SCRIPTED_DONE_TEXT).last()).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByText(NUDGE_ROW).last()).toBeVisible();

    const requests = readScriptedModelRequests(port).slice(before);
    // Two requests of the user turn, then three of the nudged turn: the nudge fired once.
    expect(requests.map((r) => r.step)).toEqual([...SCRIPTED_STEPS]);
    // Tools are on: the block holds the agent's real tools, not just todo_write.
    expect(requests[0].toolNames).toEqual(
      expect.arrayContaining(["bash", "file_read", "todo_write"])
    );
    // One block for the whole turn, nudge included.
    expect(new Set(requests.map((r) => r.toolsSha256)).size).toBe(1);
    // The nudged turn's file_read ran: its result, in the next request, holds the file.
    const afterRead = requests.find((r) => r.step === "complete-todo");
    expect(afterRead?.toolResult).toContain(README_TEXT);
  }
);
