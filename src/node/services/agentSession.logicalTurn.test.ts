import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import { Ok } from "@/common/types/result";
import type { StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { TurnCompletion } from "./streamManager";
import type { TurnCoordinator } from "./turnCoordinator";

// Logical-turn hooks drive Artifacts M4 turn-end snapshots: one start/complete pair per logical
// turn, never a completion for a stopped turn, and a queued-input chain counts once.

const workspaceId = "session-logical-turn";
const model = "openai:gpt-4o";
const sendOptions = { model, agentId: "exec" };

const end = (messageId: string): StreamEndEvent => ({
  type: "stream-end",
  workspaceId,
  messageId,
  metadata: { model },
  parts: [{ type: "text", text: "done" }],
});
const abort = (messageId: string): StreamAbortEvent => ({
  type: "stream-abort",
  workspaceId,
  messageId,
  abortReason: "user",
});

function coordinator(session: AgentSession): TurnCoordinator {
  return (session as unknown as { coordinator: TurnCoordinator }).coordinator;
}

/** Harness whose Nth stream completes when the test resolves completions[N-1]. */
async function createHarness(options: {
  turns: number;
  onLogicalTurnCompleted?: (abortSignal: AbortSignal) => Promise<void>;
  logicalTurnCompletedTimeoutMs?: number;
}) {
  const emitter = new EventEmitter();
  const completions = Array.from({ length: options.turns }, () =>
    Promise.withResolvers<TurnCompletion>()
  );
  const started = Array.from({ length: options.turns }, () => Promise.withResolvers<void>());
  const events: string[] = [];
  let calls = 0;
  const h = await createAgentSessionHarness({
    workspaceId,
    aiEmitter: emitter,
    onLogicalTurnStarted: () => events.push("started"),
    onLogicalTurnCompleted: async (abortSignal) => {
      events.push("completed");
      await options.onLogicalTurnCompleted?.(abortSignal);
    },
    logicalTurnCompletedTimeoutMs: options.logicalTurnCompletedTimeoutMs,
    aiServiceOverrides: {
      streamMessage: mock(() => {
        const index = calls++;
        const messageId = `assistant-${index + 1}`;
        emitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId,
          model,
          startTime: Date.now(),
        });
        started[index].resolve();
        return Promise.resolve(Ok({ messageId, completion: completions[index].promise }));
      }),
    },
  });
  const consumer = spyOn(coordinator(h.session), "consumeCompletion");
  const lastPolicy = (): Promise<void> => {
    const result = consumer.mock.results.at(-1);
    if (result?.type !== "return") throw new Error("No completion consumer registered");
    return result.value;
  };
  return { h, completions, started, events, lastPolicy, consumer };
}

describe("AgentSession logical turn hooks", () => {
  test("a completed turn reports start and completion before going idle", async () => {
    let busyDuringCompletion: boolean | undefined;
    const t = await createHarness({
      turns: 1,
      onLogicalTurnCompleted: () => {
        busyDuringCompletion = t.h.session.isBusy();
        return Promise.resolve();
      },
    });
    try {
      expect((await t.h.session.sendMessage("hi", sendOptions)).success).toBe(true);
      t.completions[0].resolve({ status: "completed", streamEnd: end("assistant-1") });
      await t.lastPolicy();
      expect(t.events).toEqual(["started", "completed"]);
      // Awaited before finishTurn: a snapshot runs while the turn still holds the session.
      expect(busyDuringCompletion).toBe(true);
      expect(t.h.session.isBusy()).toBe(false);
    } finally {
      t.consumer.mockRestore();
      await t.h.session.dispose();
      await t.h.cleanup();
    }
  });

  test("an aborted turn never reports completion", async () => {
    const t = await createHarness({ turns: 1 });
    try {
      await t.h.session.sendMessage("hi", sendOptions);
      t.completions[0].resolve({
        status: "aborted",
        abortReason: "user",
        streamAbort: abort("assistant-1"),
      });
      await t.lastPolicy();
      expect(t.events).toEqual(["started"]);
      expect(t.h.session.isBusy()).toBe(false);
    } finally {
      t.consumer.mockRestore();
      await t.h.session.dispose();
      await t.h.cleanup();
    }
  });

  test("queued input dispatched at completion continues the same logical turn", async () => {
    const t = await createHarness({ turns: 2 });
    try {
      await t.h.session.sendMessage("first", sendOptions);
      t.h.session.queueMessage("queued follow-up", sendOptions);
      t.completions[0].resolve({ status: "completed", streamEnd: end("assistant-1") });
      await t.lastPolicy();
      await t.started[1].promise;
      // The successor replaced the live generation without an idle transition.
      expect(t.events).toEqual(["started"]);
      t.completions[1].resolve({ status: "completed", streamEnd: end("assistant-2") });
      await t.h.session.waitForIdle();
      expect(t.events).toEqual(["started", "completed"]);
    } finally {
      t.consumer.mockRestore();
      await t.h.session.dispose();
      await t.h.cleanup();
    }
  });

  test("turns separated by idle are separate logical turns", async () => {
    const t = await createHarness({ turns: 2 });
    try {
      await t.h.session.sendMessage("first", sendOptions);
      t.completions[0].resolve({ status: "completed", streamEnd: end("assistant-1") });
      await t.lastPolicy();
      await t.h.session.sendMessage("second", sendOptions);
      t.completions[1].resolve({ status: "completed", streamEnd: end("assistant-2") });
      await t.lastPolicy();
      expect(t.events).toEqual(["started", "completed", "started", "completed"]);
    } finally {
      t.consumer.mockRestore();
      await t.h.session.dispose();
      await t.h.cleanup();
    }
  });

  test("a stalled completion hook cannot hold the session busy past its timeout", async () => {
    const stalled = Promise.withResolvers<void>();
    let hookSignal: AbortSignal | undefined;
    const t = await createHarness({
      turns: 1,
      onLogicalTurnCompleted: (abortSignal) => {
        hookSignal = abortSignal;
        return stalled.promise;
      },
      logicalTurnCompletedTimeoutMs: 20,
    });
    try {
      await t.h.session.sendMessage("hi", sendOptions);
      t.completions[0].resolve({ status: "completed", streamEnd: end("assistant-1") });
      await t.lastPolicy();
      expect(t.h.session.isBusy()).toBe(false);
      // The hook is told to stop, so its reads and writes do not run on after the timeout.
      expect(hookSignal?.aborted).toBe(true);
    } finally {
      stalled.resolve();
      t.consumer.mockRestore();
      await t.h.session.dispose();
      await t.h.cleanup();
    }
  });
});
