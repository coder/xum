import { describe, expect, mock, spyOn, test } from "bun:test";

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Err, Ok } from "@/common/types/result";
import { taskRecoveryPromptDedupeKey } from "@/constants/agentMessaging";
import type { AgentSessionAIService } from "./agentSession";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import type { MessageQueue } from "./messageQueue";
import { createTurnCompletionController } from "./streamManager";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
const workspaceId = "queue-cut-receipts";

type Request = Parameters<AgentSessionAIService["streamMessage"]>[0];

function queueOf(h: AgentSessionHarness): MessageQueue {
  return (h.session as unknown as { messageQueue: MessageQueue }).messageQueue;
}

/** Controlled provider in the token-budget test style: stream-start is emitted on delivery. */
async function setup(args?: { failure?: boolean }) {
  const requests: Request[] = [];
  const firstRequest = Promise.withResolvers<Request>();
  const streamMessage = mock<AgentSessionAIService["streamMessage"]>((request) => {
    requests.push(request);
    firstRequest.resolve(request);
    if (args?.failure) {
      return Promise.resolve(Err({ type: "unknown" as const, raw: "provider unavailable" }));
    }
    h.aiEmitter.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: `assistant-${requests.length}`,
      model: request.modelString,
      startTime: Date.now(),
    });
    const completion = createTurnCompletionController();
    const close = () => completion.settle({ status: "aborted", abortReason: "system" });
    const signal = h.session.closingSignal;
    if (signal.aborted) close();
    else signal.addEventListener("abort", close, { once: true });
    return Promise.resolve(
      Ok({
        messageId: `assistant-${requests.length}`,
        completion: completion.promise.finally(() => signal.removeEventListener("abort", close)),
      })
    );
  });
  const h = await createAgentSessionHarness({
    workspaceId,
    captureEvents: true,
    aiServiceOverrides: { streamMessage },
  });
  spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
    Ok({
      id: workspaceId,
      name: "receipts",
      projectName: "project",
      projectPath: h.config.rootDir,
      namedWorkspacePath: h.config.rootDir,
      runtimeConfig: { type: "local" },
    } as FrontendWorkspaceMetadata)
  );
  return { ...h, requests, firstRequest: firstRequest.promise, streamMessage };
}

async function teardown(h: AgentSessionHarness) {
  await h.session.dispose();
  await h.cleanup();
}

function queuedChanges(events: WorkspaceChatMessage[]): number {
  return events.filter((event) => event.type === "queued-message-changed").length;
}

describe("AgentSession queue-cut receipts", () => {
  test("a selected tool-end cut registers one pending receipt keyed by the entry", async () => {
    const h = await setup();
    try {
      expect(h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" })).toBe(
        "tool-end"
      );
      const first = h.session.getQueuedInputStopCause();
      const second = h.session.getQueuedInputStopCause();
      expect(first?.entryId).toBeDefined();
      expect(second?.entryId).toBe(first!.entryId);
      const receipt = h.session.getQueueCutReceipt(first!.entryId);
      expect(receipt).toMatchObject({
        successor: "pending",
        sourceHandled: false,
        disposed: false,
      });
      expect(typeof receipt?.sourceTurnGeneration).toBe("symbol");
      // Idempotent: the second selection did not replace the receipt.
      expect(h.session.getQueueCutReceipt(first!.entryId)).toBe(receipt);
    } finally {
      await teardown(h);
    }
  });

  test("turn-end entries (recovery prompts) never cut and leave no receipt", async () => {
    const h = await setup();
    try {
      h.session.queueMessage(
        "Your stream ended without a final assistant response.",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          dedupeKey: taskRecoveryPromptDedupeKey(workspaceId, "completion"),
          removableDedupeKey: true,
        }
      );
      const candidate = queueOf(h).getNextQueueCutCandidate();
      expect(candidate?.dispatchMode).toBe("turn-end");
      expect(h.session.getQueuedInputStopCause()).toBeUndefined();
      expect(h.session.getQueueCutReceipt(candidate!.entryId)).toBeUndefined();
      // A budget stop with nothing queued has no continuation to hand over to either.
      h.session.clearQueue();
      expect(h.session.selectContextBudgetContinuationEntryId()).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test("a budget stop selects the queue head as its continuation and registers a receipt", async () => {
    const h = await setup();
    try {
      h.session.queueMessage("Continue", { model: TEST_MODEL, agentId: "exec" });
      const head = queueOf(h).getNextQueueCutCandidate();
      const selected = h.session.selectContextBudgetContinuationEntryId();
      expect(selected).toBe(head!.entryId);
      expect(h.session.getQueueCutReceipt(selected!)?.successor).toBe("pending");
    } finally {
      await teardown(h);
    }
  });

  test("clearing a cut entry records canceled and notifies; dispose is consume-once", async () => {
    const h = await setup();
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      const before = queuedChanges(h.events);
      h.session.clearQueue();
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("canceled");
      expect(queuedChanges(h.events)).toBeGreaterThan(before);

      expect(h.session.disposeQueueCut(entryId)).toBe(true);
      expect(h.session.disposeQueueCut(entryId)).toBe(false);
      // Retained until the source handler also arrives, so it cannot recover a second time.
      expect(h.session.getQueueCutReceipt(entryId)?.disposed).toBe(true);
      h.session.markQueueCutSourceHandled(entryId);
      expect(h.session.getQueueCutReceipt(entryId)).toBeUndefined();
      expect(h.session.disposeQueueCut(entryId)).toBe(false);
    } finally {
      await teardown(h);
    }
  });

  test("dispatch records admitted, then streaming; release waits for the source handler", async () => {
    const h = await setup();
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      const observed: string[] = [];
      h.session.onChatEvent(({ message }) => {
        if (message.type !== "queued-message-changed") return;
        const successor = h.session.getQueueCutReceipt(entryId)?.successor;
        observed.push(typeof successor === "object" ? successor.kind : String(successor));
      });
      h.session.sendQueuedMessages();
      await h.firstRequest;
      expect(observed).toEqual(["admitted", "streaming"]);
      // Streaming alone does not release: the source handler may still consult the transfer.
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("streaming");
      h.session.markQueueCutSourceHandled(entryId);
      expect(h.session.getQueueCutReceipt(entryId)).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test("an admitted entry whose turn fails before streaming records prestream-failed before idle", async () => {
    const h = await setup({ failure: true });
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      const observed: Array<{ type: string; successor: unknown }> = [];
      h.session.onChatEvent(({ message }) => {
        observed.push({
          type: message.type === "stream-lifecycle" ? `lifecycle:${message.phase}` : message.type,
          successor: h.session.getQueueCutReceipt(entryId)?.successor,
        });
      });
      h.session.sendQueuedMessages();
      await h.firstRequest;
      await h.session.waitForIdle();
      // The failure is recorded (and published) before the turn's terminal lifecycle lands.
      const recorded = observed.findIndex((event) => event.successor === "prestream-failed");
      const terminal = observed.findIndex((event) => event.type === "lifecycle:failed");
      expect(observed[recorded]?.type).toBe("queued-message-changed");
      expect(terminal).toBeGreaterThan(recorded);
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("prestream-failed");
      // Not released by failure alone: the source handler may still arrive.
      h.session.markQueueCutSourceHandled(entryId);
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("prestream-failed");
      expect(h.session.disposeQueueCut(entryId)).toBe(true);
      expect(h.session.getQueueCutReceipt(entryId)).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test("a dequeued entry whose turn goes idle without any stream records prestream-failed", async () => {
    const h = await setup();
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      // The send resolves without ever admitting a stream (withdrawn-style outcome).
      const sendMessage = spyOn(h.session, "sendMessage").mockResolvedValue(Ok(undefined));
      h.session.sendQueuedMessages();
      await h.session.waitForIdle();
      sendMessage.mockRestore();
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("prestream-failed");
    } finally {
      await teardown(h);
    }
  });
});
