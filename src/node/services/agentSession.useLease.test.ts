import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import { Err, Ok } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import type { AgentSessionAIService } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { TurnCompletion } from "./streamManager";
import { createTestConfig } from "./taskService.testHarness";
import {
  WorkspaceBusyError,
  workspaceUseLeasesFor,
  type WorkspaceUseLeases,
} from "./workspaceUseLeases";

// #4476: a turn is cross-process evidence that this backend uses the workspace. Another backend
// sharing the Xum root (desktop beside `xum server`) must see it before renaming or removing the
// checkout, and a turn must not start while such a mutation runs.

const workspaceId = "ws-turn-lease";
const model = "openai:gpt-4o";
const sendOptions = { model, agentId: "exec" };
const idle = { hasRunningBackgroundProcesses: () => Promise.resolve(false) };

const end = (): StreamEndEvent => ({
  type: "stream-end",
  workspaceId,
  messageId: "assistant-1",
  metadata: { model },
  parts: [{ type: "text", text: "done" }],
});

/**
 * Wait until every lease transition this backend queued so far has landed: its transition lock is
 * FIFO, so a fresh hold/release on the same workspace runs after them.
 */
async function settled(leases: WorkspaceUseLeases): Promise<void> {
  await (await leases.hold(workspaceId, "exec")).release();
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceBusyError);
    return error as Error;
  }
  throw new Error("expected the mutation gate to refuse");
}

describe("AgentSession turn use lease across two backends on one root", () => {
  test("a turn in B holds its lease from preparation until it settles, on failure and on success", async () => {
    const streams: Array<
      PromiseWithResolvers<Awaited<ReturnType<AgentSessionAIService["streamMessage"]>>>
    > = [];
    let turnSettled = Promise.withResolvers<void>();
    let streamReached = Promise.withResolvers<void>();
    const b = await createAgentSessionHarness({
      workspaceId,
      onTurnSettled: () => turnSettled.resolve(),
      aiServiceOverrides: {
        streamMessage: mock(() => {
          const stream =
            Promise.withResolvers<Awaited<ReturnType<AgentSessionAIService["streamMessage"]>>>();
          streams.push(stream);
          streamReached.resolve();
          return stream.promise;
        }),
      },
    });
    const leasesB = workspaceUseLeasesFor(b.config);
    const leasesA = workspaceUseLeasesFor(await createTestConfig(b.config.rootDir));
    expect(leasesA).not.toBe(leasesB);
    try {
      // Failure: the provider request fails while A tries to mutate.
      const failing = b.session.sendMessage("first", sendOptions);
      await streamReached.promise;
      expect(leasesB.heldCount(workspaceId, "turn")).toBe(1);
      expect(
        (await refusal(leasesA.withMutationGate([workspaceId], idle, () => Promise.resolve())))
          .message
      ).toContain("turn");
      streams[0].resolve(Err({ type: "unknown", raw: "provider down" }));
      expect((await failing).success).toBe(false);
      await settled(leasesB);
      expect(leasesB.heldCount(workspaceId, "turn")).toBe(0);
      expect(
        await leasesA.withMutationGate([workspaceId], idle, () => Promise.resolve("renamed"))
      ).toBe("renamed");

      // Success: the lease outlives preparation and is released when the stream completes.
      const completion = Promise.withResolvers<TurnCompletion>();
      streamReached = Promise.withResolvers<void>();
      const succeeding = b.session.sendMessage("second", sendOptions);
      await streamReached.promise;
      b.aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: "assistant-1",
        model,
        startTime: Date.now(),
      });
      streams[1].resolve(Ok({ messageId: "assistant-1", completion: completion.promise }));
      expect((await succeeding).success).toBe(true);
      expect(leasesB.heldCount(workspaceId, "turn")).toBe(1);
      await refusal(leasesA.withMutationGate([workspaceId], idle, () => Promise.resolve()));
      turnSettled = Promise.withResolvers<void>();
      b.aiEmitter.emit("stream-end", end());
      completion.resolve({ status: "completed", streamEnd: end() });
      await turnSettled.promise;
      await settled(leasesB);
      expect(leasesB.heldCount(workspaceId, "turn")).toBe(0);
      expect(await leasesA.withMutationGate([workspaceId], idle, () => Promise.resolve(1))).toBe(1);
    } finally {
      await b.session.dispose();
      await b.cleanup();
    }
  });

  test("B's send while A's mutation runs fails as a settled preparation failure", async () => {
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
      Promise.resolve(Err({ type: "unknown", raw: "must not be reached" }))
    );
    const b = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: { streamMessage },
    });
    const leasesA = workspaceUseLeasesFor(await createTestConfig(b.config.rootDir));
    try {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const mutation = leasesA.withMutationGate([workspaceId], idle, async () => {
        entered();
        await finished;
      });
      await inside;

      const result = await b.session.sendMessage("blocked", sendOptions);
      expect(result.success).toBe(false);
      expect(!result.success && result.error.type === "unknown" && result.error.raw).toContain(
        "being renamed, removed or archived"
      );
      expect(streamMessage).not.toHaveBeenCalled();
      expect(b.session.isBusy()).toBe(false);
      expect(workspaceUseLeasesFor(b.config).heldCount(workspaceId)).toBe(0);

      finish();
      await mutation;
      // Once the mutation ends, B's next turn is admitted again.
      await b.session.sendMessage("admitted", sendOptions);
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      await b.session.dispose();
      await b.cleanup();
    }
  });

  test("disposing the session mid-turn releases its lease", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<AgentSessionAIService["streamMessage"]>>>();
    const reached = Promise.withResolvers<void>();
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() => {
      reached.resolve();
      return pending.promise;
    });
    const b = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: { streamMessage },
    });
    const leasesB = workspaceUseLeasesFor(b.config);
    try {
      const sending = b.session.sendMessage("first", sendOptions);
      await reached.promise;
      expect(leasesB.heldCount(workspaceId, "turn")).toBe(1);
      const disposing = b.session.dispose();
      pending.resolve(Err({ type: "unknown", raw: "aborted" }));
      await disposing;
      await sending.catch(() => undefined);
      await settled(leasesB);
      expect(leasesB.heldCount(workspaceId, "turn")).toBe(0);
    } finally {
      await b.cleanup();
    }
  });
});
