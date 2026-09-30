/**
 * Deterministic regression tests for the violations found by the TLA+ model in
 * formal/message-queue/ (run formal/message-queue/check.sh). Each test states the correct
 * contract; the model's mutant configs keep the pre-fix behaviour as a counterexample.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { Ok } from "@/common/types/result";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { MessageQueue } from "./messageQueue";
import { saveWorkspaces } from "./taskService.testHarness";
import type { QueuedDispatchDecision } from "./taskWorkspaceSeam";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import { waitForCondition } from "./testDispatchHelpers";
import { createWorkspaceServiceHarness } from "./workspaceService.testHarness";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
const options: SendMessageOptions = { model: TEST_MODEL, agentId: "exec" };
// Background sends (peer messages, monitor wakes, sub-agent reports) are hidden and sealed.
const hidden = { synthetic: true, agentInitiated: true, sealed: true };

describe("promoteAheadOfHiddenTurnEnd (MQ_promoted.cfg, invariant PromotedNotBlockedByHidden)", () => {
  // The promotion used to stop at the first tool-end predecessor, assuming it would cut the
  // stream anyway. A hidden tool-end entry that itself sits behind a hidden turn-end entry cuts
  // nothing, so the promoted report waited for the turn to end.
  test("a promoted tool-end report cuts past a hidden tool-end entry stuck behind a hidden turn-end entry", () => {
    const queue = new MessageQueue();
    queue.add("peer message", { ...options, queueDispatchMode: "turn-end" }, hidden);
    queue.add("bash monitor wake", { ...options, queueDispatchMode: "tool-end" }, hidden);
    queue.add(
      "progress report",
      { ...options, queueDispatchMode: "tool-end" },
      { ...hidden, removableDedupeKey: true, promoteAheadOfHiddenTurnEnd: true }
    );

    expect(queue.getNextDispatchableMode()).toBe("tool-end");
    expect(queue.getMessages()).toEqual(["progress report", "peer message", "bash monitor wake"]);
  });

  // Same gap through a withdrawn entry: an aborted tool-end entry used to stop the promotion,
  // although nextDispatchableEntry skips it.
  test("a withdrawn tool-end entry does not stop the promotion", () => {
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

    expect(queue.getNextDispatchableMode()).toBe("tool-end");
  });
});

describe("removeByDedupeKeyPrefix (found while modelling; not a TLA+ invariant)", () => {
  // Removal used to pair messages[i] with [...dedupeKeys][i], which holds only when every add in
  // the entry carried a key. Latent: every prefix-removed key is sent with
  // removableQueueDedupeKey, which seals its entry to one message.
  test("removes the keyed message, not an unkeyed one batched before it", () => {
    const queue = new MessageQueue();
    const background = { synthetic: true, agentInitiated: true };
    queue.add("unkeyed", options, background);
    queue.addOnce("keyed", options, "agent-report:child:call-1", background);

    queue.removeByDedupeKeyPrefix("agent-report:child:");

    expect(queue.getMessages()).toEqual(["unkeyed"]);
  });
});

describe("sends to an idle session holding queued work (MQ_userorder.cfg, invariant UserOrder)", () => {
  /**
   * A real session behind WorkspaceService.sendMessage whose queue head answers the report
   * decision with `decision.current`. It holds at the drain of the turn that just ended, which
   * leaves the session idle with that entry queued. Every turn completes at once, so a queued
   * entry's terminal drain runs after each turn.
   */
  async function createIdleSessionWithHeldEntry(
    workspaceId: string,
    heldEntry: { message: string; internal: { synthetic?: boolean; agentInitiated?: boolean } },
    heldOptions: SendMessageOptions = options
  ) {
    const ws = await createWorkspaceServiceHarness();
    await saveWorkspaces(ws.config, "/tmp/test/project", [
      { id: workspaceId, path: "/tmp/test/workspace", name: "workspace" },
    ]);
    // The workspace's stop latch (TaskService.isWorkspaceStopInProgress), seen by the service
    // and the session alike.
    const stop = { latched: false };
    ws.service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ isWorkspaceStopInProgress: () => stop.latched })
    );
    // Keep sendMessage's fire-and-forget recency write off disk instead of racing cleanup.
    spyOn(ws.extensionMetadata, "updateRecency").mockImplementation((_workspaceId, recency) =>
      Promise.resolve({
        recency: recency ?? Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      })
    );
    const h = await createAgentSessionHarness({
      workspaceId,
      config: ws.config,
      historyService: ws.historyService,
      isStopInProgress: () => stop.latched,
      aiServiceOverrides: {
        streamMessage: () =>
          Promise.resolve(
            Ok({
              messageId: "assistant",
              completion: Promise.resolve({
                status: "completed" as const,
                streamEnd: {
                  type: "stream-end" as const,
                  workspaceId,
                  parts: [],
                  metadata: { model: TEST_MODEL },
                },
              }),
            })
          ),
      },
    });
    ws.service.registerSession(workspaceId, h.session);
    const decision: { current: QueuedDispatchDecision } = { current: "hold" };
    h.session.queueMessage(heldEntry.message, heldOptions, {
      acceptanceOrigin: "manual",
      ...heldEntry.internal,
      turnAdmission: {
        admissionStale: () => false,
        onEnqueued: () => undefined,
        onAdmitted: () => undefined,
        onDisposed: () => undefined,
        resolveDispatch: () => decision.current,
      },
    });
    h.session.sendQueuedMessages("terminal");
    await h.session.waitForIdle();
    expect(h.session.isBusy()).toBe(false);

    const readUserTexts = async (): Promise<string[]> => {
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      return history.success
        ? history.data
            .filter((row) => row.role === "user")
            .map((row) => row.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
        : [];
    };
    const cleanup = async () => {
      await h.session.dispose();
      await h.cleanup();
      await ws.cleanup();
    };
    /** Whether a user message survives a queue clear: in history, or held for the composer. */
    const retained = async (text: string): Promise<boolean> =>
      (await readUserTexts()).includes(text) ||
      h.session.getHeldInputs().some((held) => held.send.message === text);
    return { ws, h, stop, decision, readUserTexts, retained, cleanup };
  }

  // A report-decision hold (TurnAdmissionToken.resolveDispatch) leaves the session idle with the
  // user's queued input in place. WorkspaceService.sendMessage used to queue only while isBusy(),
  // so the user's NEXT message went straight to AgentSession.sendMessage and ran before the
  // earlier queued one.
  test("a later user message never starts a turn before an earlier queued one", async () => {
    const workspaceId = "formal-mq-user-order";
    const { ws, h, decision, readUserTexts, cleanup } = await createIdleSessionWithHeldEntry(
      workspaceId,
      { message: "first", internal: {} }
    );
    try {
      expect((await ws.service.sendMessage(workspaceId, "second", options)).success).toBe(true);
      await h.session.waitForIdle();
      expect(h.session.hasQueuedMessages()).toBe(true); // "second" queued behind the held "first"
      decision.current = "proceed";
      h.session.drainQueuedMessagesIfIdle(); // TaskService re-runs the drain once it decides
      // The turn "first" started ends; its terminal drain dispatches "second".
      await waitForCondition(async () => (await readUserTexts()).length >= 2, {
        timeoutMs: 10_000,
      });
      expect(await readUserTexts()).toEqual(["first", "second"]);
    } finally {
      await cleanup();
    }
  }, 30_000);

  // Queueing on an idle session must not strand the new entry. A promoted wake yields to
  // preflight sends, so its service call has no disposal drain; it overtakes the held hidden
  // turn-end entry and must start now, not when the unrelated decision resolves.
  test("a promoted wake queued ahead of a held hidden entry starts without waiting", async () => {
    const workspaceId = "formal-mq-idle-drain";
    const { ws, h, readUserTexts, cleanup } = await createIdleSessionWithHeldEntry(
      workspaceId,
      { message: "held peer message", internal: hidden },
      { ...options, queueDispatchMode: "turn-end" }
    );
    try {
      const sent = await ws.service.sendMessage(
        workspaceId,
        "progress report",
        { ...options, queueDispatchMode: "tool-end" },
        {
          synthetic: true,
          agentInitiated: true,
          promoteAheadOfHiddenTurnEnd: true,
          yieldToPreflightSends: true,
        }
      );
      expect(sent.success).toBe(true);
      await waitForCondition(async () => (await readUserTexts()).length >= 1, {
        timeoutMs: 10_000,
      });
      expect(await readUserTexts()).toEqual(["progress report"]);
      expect(h.session.hasQueuedMessages()).toBe(true); // the held entry still waits
    } finally {
      await cleanup();
    }
  }, 30_000);

  // A Stop cascade latches the workspace, then clears its queue once (TaskService
  // runWorkspaceStopCleanup, Phase B). A user send that passed sendMessage's entry barrier before
  // the latch and decides queue-or-send after it must not queue behind the held entry only to be
  // cleared: before F2 it went direct and the session refused it visibly.
  test("a user send deciding during a Stop cascade is refused or retained, never dropped", async () => {
    const workspaceId = "formal-mq-stop-during-send";
    const { ws, stop, readUserTexts, retained, cleanup } = await createIdleSessionWithHeldEntry(
      workspaceId,
      { message: "first", internal: {} }
    );
    try {
      // Park the send in its preflight (after the entry barrier, before queue-or-send).
      let parked = false;
      let releasePreflight!: () => void;
      const preflight = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      spyOn(
        ws.service as unknown as {
          maybePersistAISettingsFromOptions: (
            workspaceId: string,
            options: unknown
          ) => Promise<void>;
        },
        "maybePersistAISettingsFromOptions"
      ).mockImplementation(async () => {
        parked = true;
        await preflight;
      });
      const sending = ws.service.sendMessage(workspaceId, "second", options);
      await waitForCondition(() => parked);
      stop.latched = true; // Stop begins: epoch bump + latch
      releasePreflight();
      const result = await sending;
      ws.service.clearQueue(workspaceId, { preserveUserInput: true }); // the cascade's Phase B

      // An accepted send must survive the cascade; a refused one is the caller's to keep.
      expect(!result.success || (await retained("second"))).toBe(true);
      expect(await readUserTexts()).not.toContain("second"); // it never ran after the Stop
      // The enqueue point re-checks the latch, so the caller gets the explicit Stop refusal.
      expect(result.success).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  // Input queued before the Stop must not run after it, but it is still the user's: the cascade
  // hands it back (held input) instead of discarding it. Before F2 this send started its turn
  // directly, so its row was in history when the cascade aborted that turn.
  test("a Stop cascade hands a queued user message back instead of dropping it", async () => {
    const workspaceId = "formal-mq-stop-after-queue";
    const { ws, h, stop, decision, readUserTexts, retained, cleanup } =
      await createIdleSessionWithHeldEntry(workspaceId, { message: "first", internal: {} });
    try {
      expect((await ws.service.sendMessage(workspaceId, "second", options)).success).toBe(true);
      expect(h.session.hasQueuedMessages()).toBe(true);
      stop.latched = true;
      ws.service.clearQueue(workspaceId, { preserveUserInput: true }); // the cascade's Phase B
      expect(await retained("second")).toBe(true);

      stop.latched = false;
      decision.current = "proceed";
      h.session.drainQueuedMessagesIfIdle();
      await h.session.waitForIdle();
      expect(await readUserTexts()).not.toContain("second"); // held input never runs by itself
    } finally {
      await cleanup();
    }
  }, 30_000);
});
