/**
 * Deterministic repros of the violations found by the TLA+ model in formal/message-queue/
 * (run formal/message-queue/check.sh). Each test states the CORRECT contract and is marked
 * `test.failing` because the current code breaks it; when a fix lands, the test starts
 * passing, bun reports it as a failure, and the fix should flip it to a plain `test`.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { MessageQueue } from "./messageQueue";
import type { QueuedDispatchDecision } from "./taskWorkspaceSeam";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
const options: SendMessageOptions = { model: TEST_MODEL, agentId: "exec" };
// Background sends (peer messages, monitor wakes, sub-agent reports) are hidden and sealed.
const hidden = { synthetic: true, agentInitiated: true, sealed: true };

describe("promoteAheadOfHiddenTurnEnd (MQ_promoted.cfg, invariant PromotedNotBlockedByHidden)", () => {
  // messageQueue.ts:461-471 stops the promotion at the first tool-end predecessor, assuming it
  // would cut the stream anyway. A hidden tool-end entry that itself sits behind a hidden
  // turn-end entry cuts nothing, so the promoted report waits for the turn to end.
  test.failing(
    "a promoted tool-end report cuts past a hidden tool-end entry stuck behind a hidden turn-end entry",
    () => {
      const queue = new MessageQueue();
      queue.add("peer message", { ...options, queueDispatchMode: "turn-end" }, hidden);
      queue.add("bash monitor wake", { ...options, queueDispatchMode: "tool-end" }, hidden);
      queue.add(
        "progress report",
        { ...options, queueDispatchMode: "tool-end" },
        { ...hidden, removableDedupeKey: true, promoteAheadOfHiddenTurnEnd: true }
      );

      // actual: "turn-end" (queue order: peer message, bash monitor wake, progress report)
      expect(queue.getNextDispatchableMode()).toBe("tool-end");
    }
  );

  // Same gap through a withdrawn entry: an aborted tool-end entry also stops the promotion,
  // although nextDispatchableEntry (messageQueue.ts:392-394) skips it.
  test.failing("a withdrawn tool-end entry does not stop the promotion", () => {
    const queue = new MessageQueue();
    const withdrawn = new AbortController();
    queue.add("peer message", { ...options, queueDispatchMode: "turn-end" }, hidden);
    queue.add(
      "bash monitor wake",
      { ...options, queueDispatchMode: "tool-end" },
      { ...hidden, cancelSignal: withdrawn.signal }
    );
    withdrawn.abort();
    queue.add(
      "progress report",
      { ...options, queueDispatchMode: "tool-end" },
      { ...hidden, removableDedupeKey: true, promoteAheadOfHiddenTurnEnd: true }
    );

    expect(queue.getNextDispatchableMode()).toBe("tool-end"); // actual: "turn-end"
  });
});

describe("removeByDedupeKeyPrefix (found while modelling; not a TLA+ invariant)", () => {
  // messageQueue.ts:1087-1090 pairs messages[i] with [...dedupeKeys][i], which holds only when
  // every add in the entry carried a key. Latent today: every prefix-removed key is sent with
  // removableQueueDedupeKey, which seals its entry to one message.
  test.failing("removes the keyed message, not an unkeyed one batched before it", () => {
    const queue = new MessageQueue();
    const background = { synthetic: true, agentInitiated: true };
    queue.add("unkeyed", options, background);
    queue.addOnce("keyed", options, "agent-report:child:call-1", background);

    queue.removeByDedupeKeyPrefix("agent-report:child:");

    expect(queue.getMessages()).toEqual(["unkeyed"]); // actual: ["keyed"]
  });
});

describe("user-authored order (MQ_userorder.cfg, invariant UserOrder)", () => {
  // A report-decision hold (agentSession.ts:10566-10567) leaves the session idle with the user's
  // queued input in place. WorkspaceService.sendMessage queues only while isBusy()
  // (workspaceService.ts:14993-14996), so the user's NEXT message goes straight to
  // AgentSession.sendMessage and runs before the earlier queued one.
  test.failing(
    "a later user message never starts a turn before an earlier queued one",
    async () => {
      const h = await createAgentSessionHarness({ workspaceId: "formal-mq-user-order" });
      const stream = spyOn(h.aiService, "streamMessage");
      let decision: QueuedDispatchDecision = "hold";
      try {
        h.session.queueMessage("first", options, {
          acceptanceOrigin: "manual",
          turnAdmission: {
            admissionStale: () => false,
            onEnqueued: () => undefined,
            onAdmitted: () => undefined,
            onDisposed: () => undefined,
            resolveDispatch: () => decision,
          },
        });
        h.session.sendQueuedMessages("terminal"); // the drain of the turn that just ended holds
        await h.session.waitForIdle();
        expect(h.session.isBusy()).toBe(false); // so WorkspaceService would not queue the next send

        expect((await h.session.sendMessage("second", options)).success).toBe(true);
        await h.session.waitForIdle();
        decision = "proceed";
        h.session.drainQueuedMessagesIfIdle(); // TaskService re-runs the drain once it decides
        await h.session.waitForIdle();

        const history = await h.historyService.getHistoryFromLatestBoundary("formal-mq-user-order");
        expect(history.success).toBe(true);
        const userTexts = history.success
          ? history.data
              .filter((row) => row.role === "user")
              .map((row) =>
                row.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
              )
          : [];
        expect(userTexts).toEqual(["first", "second"]); // actual: ["second", "first"]
      } finally {
        stream.mockRestore();
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );
});
