import { describe, expect, mock, spyOn, test } from "bun:test";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Ok } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import { WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE } from "@/constants/agentMessaging";
import type { AgentSessionAIService } from "./agentSession";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import type { MessageQueue } from "./messageQueue";
import { createTurnCompletionController } from "./streamManager";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
const workspaceId = "stop-barrier";
type Request = Parameters<AgentSessionAIService["streamMessage"]>[0];

/**
 * Controlled stop-cascade state (what WorkspaceService derives from TaskService) plus a provider
 * whose start can be paused between admission and the provider request.
 */
async function setup() {
  const stop = { inProgress: false, epoch: 0 };
  const requests: Request[] = [];
  const settledTurns: symbol[] = [];
  let releaseStart: (() => void) | undefined;
  const startGate = Promise.withResolvers<void>();
  const streamMessage = mock<AgentSessionAIService["streamMessage"]>(async (request) => {
    requests.push(request);
    // Pause between admission and the provider request until the test releases it.
    await new Promise<void>((resolve) => {
      releaseStart = resolve;
      startGate.resolve();
    });
    // Mirror the production fence: no provider request once the stop latched or the epoch moved.
    if (request.stopFence?.() === false) {
      return Ok({
        messageId: `aborted-${requests.length}`,
        completion: Promise.resolve({
          status: "aborted" as const,
          abortReason: "startup" as const,
        }),
      });
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
    if (h.session.closingSignal.aborted) close();
    else h.session.closingSignal.addEventListener("abort", close, { once: true });
    return Ok({ messageId: `assistant-${requests.length}`, completion: completion.promise });
  });
  const h: AgentSessionHarness = await createAgentSessionHarness({
    workspaceId,
    captureEvents: true,
    aiServiceOverrides: { streamMessage },
    isStopInProgress: () => stop.inProgress,
    getStopEpoch: () => stop.epoch,
    onTurnSettled: (turn) => settledTurns.push(turn),
  });
  spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
    Ok({
      id: workspaceId,
      name: "barrier",
      projectName: "project",
      projectPath: h.config.rootDir,
      namedWorkspacePath: h.config.rootDir,
      runtimeConfig: { type: "local" },
    } as FrontendWorkspaceMetadata)
  );
  const queue = (h.session as unknown as { messageQueue: MessageQueue }).messageQueue;
  return {
    ...h,
    stop,
    requests,
    settledTurns,
    queue,
    startGate: startGate.promise,
    releaseStart: () => releaseStart?.(),
  };
}

describe("AgentSession stop-cascade barrier and provider-start fence", () => {
  test("a direct send is refused at admission with the stable retryable error while latched", async () => {
    const h = await setup();
    try {
      h.stop.inProgress = true;
      const refused = await h.session.sendMessage("hello", { model: TEST_MODEL, agentId: "exec" });
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toEqual({
          type: "unknown",
          raw: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
        });
      }
      expect(h.requests).toHaveLength(0);
      // After release the same send works.
      h.stop.inProgress = false;
      const accepted = h.session.sendMessage("hello again", { model: TEST_MODEL, agentId: "exec" });
      await h.startGate;
      h.releaseStart();
      expect((await accepted).success).toBe(true);
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("queued dispatch holds entries while latched and dispatches them after release", async () => {
    const h = await setup();
    try {
      h.stop.inProgress = true;
      h.session.queueMessage("held", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.queue.getNextQueueCutCandidate()!.entryId;
      h.session.sendQueuedMessages();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Held: neither consumed nor removed, and no turn admitted.
      expect(h.queue.hasEntry(entryId)).toBe(true);
      expect(h.session.isBusy()).toBe(false);
      expect(h.requests).toHaveLength(0);

      h.stop.inProgress = false;
      h.session.sendQueuedMessages();
      await h.startGate;
      // Dispatched normally once the latch dropped: consumed by an admitted turn, one request.
      expect(h.queue.hasEntry(entryId)).toBe(false);
      expect(h.requests).toHaveLength(1);
      h.releaseStart();
      const deadline = Date.now() + 2_000;
      while (!h.events.some((event) => event.type === "stream-start")) {
        if (Date.now() > deadline) throw new Error("dispatched turn never started");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("a turn admitted before the stop is fenced at provider start and settles as a startup abort", async () => {
    const h = await setup();
    try {
      const active = h.session.getActiveTurnGeneration();
      expect(active).toBeUndefined();
      const send = h.session.sendMessage("work", { model: TEST_MODEL, agentId: "exec" });
      await h.startGate;
      // Admitted and preparing: the cascade captures this generation as the owner to wait for.
      const owner = h.session.getActiveTurnGeneration();
      expect(typeof owner).toBe("symbol");
      // Teardown begins: bump + latch, then the paused preparation resumes.
      h.stop.epoch += 1;
      h.stop.inProgress = true;
      expect(h.requests[0].stopFence?.()).toBe(false);
      h.releaseStart();
      await send;
      await h.session.waitForIdle();
      // No provider stream ever started; the owner settled authoritatively via the seam signal.
      expect(h.events.some((event) => event.type === "stream-start")).toBe(false);
      expect(h.settledTurns).toContain(owner!);
      expect(h.session.getActiveTurnGeneration()).toBeUndefined();
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("a resume is refused while latched", async () => {
    const h = await setup();
    try {
      expect(
        (
          await h.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("user-1", "user", "Earlier request"),
            createMuxMessage("assistant-1", "assistant", "Earlier answer", { model: TEST_MODEL }),
          ])
        ).success
      ).toBe(true);
      h.stop.inProgress = true;
      const resumed = await h.session.resumeStream({ model: TEST_MODEL, agentId: "exec" });
      expect(resumed.success).toBe(false);
      if (!resumed.success) {
        expect(resumed.error).toEqual({
          type: "unknown",
          raw: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
        });
      }
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });
});
