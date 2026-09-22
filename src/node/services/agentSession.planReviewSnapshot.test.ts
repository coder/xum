import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { Ok } from "@/common/types/result";
import type { StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import { ensurePlanSnapshot } from "./planReviewService";
import type { TurnCompletion } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";

const model = "openai:gpt-4o";
const sendOptions = { model, agentId: "exec" };
// Plan files live under the runtime's xum home (~/.xum/plans/<project>/<workspace>.md), exactly
// like the IPC suite; unique names keep parallel runs apart and afterEach removes them.
const projectName = `plan-review-capture-${process.pid}-${Date.now()}`;
const planDir = expandTilde(path.dirname(getPlanFilePath("x", projectName)));

function metadataFor(workspaceId: string) {
  return {
    id: workspaceId,
    name: workspaceId,
    projectName,
    projectPath: "/tmp/project",
    runtimeConfig: { type: "local" as const },
  };
}

async function writePlan(workspaceId: string, content: string): Promise<string> {
  const planPath = expandTilde(getPlanFilePath(workspaceId, projectName));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, content);
  return planPath;
}

async function planReviewRows(h: AgentSessionHarness, workspaceId: string) {
  const rows: string[] = [];
  const scanned = await h.historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
    for (const row of chunk) {
      if (row.metadata?.muxMetadata?.type === "plan-review") rows.push(row.id);
    }
  });
  if (!scanned.success) throw new Error(scanned.error);
  return rows;
}

/**
 * Drives one turn whose propose_plan capture is parked on a metadata gate armed only after the
 * tool-call-end (send preflight reads metadata too). Returns the gate and the ordering log.
 */
async function startGatedProposal(
  workspaceId: string,
  options: { captureTimeoutMs?: number } = {}
) {
  const emitter = new EventEmitter();
  const order: string[] = [];
  const settled = Promise.withResolvers<void>();
  const metadataGate = Promise.withResolvers<void>();
  const metadataRequested = Promise.withResolvers<void>();
  let gateArmed = false;
  let turns = 0;
  const secondStarted = Promise.withResolvers<void>();
  const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
  const h = await createAgentSessionHarness({
    workspaceId,
    aiEmitter: emitter,
    captureEvents: true,
    planSnapshotCaptureTimeoutMs: options.captureTimeoutMs,
    onTurnSettled: () => {
      order.push("settled");
      settled.resolve();
    },
    aiServiceOverrides: {
      streamMessage: mock(() => {
        turns += 1;
        const messageId = `assistant-${turns}`;
        order.push(`stream-${turns}`);
        emitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId,
          model,
          startTime: Date.now(),
        });
        const completion = Promise.withResolvers<TurnCompletion>();
        completions.push(completion);
        if (turns === 2) secondStarted.resolve();
        return Promise.resolve(Ok({ messageId, completion: completion.promise }));
      }),
      getWorkspaceMetadata: mock(async () => {
        if (gateArmed) {
          metadataRequested.resolve();
          await metadataGate.promise;
          order.push("metadata-released");
        }
        return Ok(metadataFor(workspaceId));
      }),
    },
  });
  expect((await h.session.sendMessage("propose", sendOptions)).success).toBe(true);
  gateArmed = true;
  emitter.emit("tool-call-end", {
    type: "tool-call-end",
    workspaceId,
    messageId: "assistant-1",
    toolCallId: "call-plan",
    toolName: "propose_plan",
    result: { success: true },
    timestamp: Date.now(),
  });
  await metadataRequested.promise;
  const end: StreamEndEvent = {
    type: "stream-end",
    workspaceId,
    messageId: "assistant-1",
    metadata: { model },
    parts: [{ type: "text", text: "Proposed." }],
  };
  const abort: StreamAbortEvent = {
    type: "stream-abort",
    workspaceId,
    messageId: "assistant-1",
    abortReason: "user",
  };
  const cleanup = async () => {
    metadataGate.resolve();
    // Unfinished mock turns (e.g. the queued follow-up) would otherwise hold dispose open.
    completions.forEach((completion) =>
      completion.resolve({ status: "aborted", abortReason: "user", streamAbort: abort })
    );
    await h.session.dispose();
    await h.cleanup();
  };
  return { h, order, settled, secondStarted, metadataGate, completions, end, abort, cleanup };
}

describe("AgentSession plan-review snapshot capture", () => {
  afterEach(async () => {
    await fs.rm(planDir, { recursive: true, force: true });
  });

  test("a completed turn waits for the capture, then settles and dispatches the queued turn", async () => {
    const workspaceId = "session-plan-capture-complete";
    await writePlan(workspaceId, "# Plan\n\nStep one.\n");
    const t = await startGatedProposal(workspaceId);
    try {
      // A queued follow-up must not start until the proposal's snapshot is durable. (With a
      // queued turn the session never passes through idle, so its start is the completion signal.)
      expect(t.h.session.queueMessage("follow-up", sendOptions)).not.toBeNull();
      t.completions[0].resolve({ status: "completed", streamEnd: t.end });

      const startedEarly = await Promise.race([
        t.secondStarted.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      expect(startedEarly).toBe(false);
      expect(t.h.session.isBusy()).toBe(true);

      t.metadataGate.resolve();
      await t.secondStarted.promise;
      expect(t.order.indexOf("metadata-released")).toBeLessThan(t.order.indexOf("stream-2"));
      // The snapshot row is already durable when the queued turn starts.
      expect(await planReviewRows(t.h, workspaceId)).toHaveLength(1);
      t.completions[1].resolve({ status: "completed", streamEnd: t.end });
      await t.settled.promise;
    } finally {
      await t.cleanup();
    }
  });

  test("Stop settles promptly and a late read never appends a stale snapshot", async () => {
    const workspaceId = "session-plan-capture-stop";
    await writePlan(workspaceId, "# Plan\n\nStep one.\n");
    const t = await startGatedProposal(workspaceId);
    try {
      t.completions[0].resolve({ status: "aborted", abortReason: "user", streamAbort: t.abort });
      // Settles without the gate ever opening: Stop is not held hostage by a stalled plan read.
      await t.settled.promise;
      expect(t.order).toEqual(["stream-1", "settled"]);

      // The stalled read finishes later: the abandoned capture must not publish a row.
      t.metadataGate.resolve();
      await t.h.session.waitForIdle();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(t.order).toEqual(["stream-1", "settled", "metadata-released"]);
      expect(await planReviewRows(t.h, workspaceId)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("a stalled capture is abandoned at the deadline and cannot append afterwards", async () => {
    const workspaceId = "session-plan-capture-timeout";
    await writePlan(workspaceId, "# Plan\n\nStep one.\n");
    const t = await startGatedProposal(workspaceId, { captureTimeoutMs: 200 });
    try {
      t.completions[0].resolve({ status: "completed", streamEnd: t.end });
      await t.settled.promise;
      expect(t.order).toEqual(["stream-1", "settled"]);

      t.metadataGate.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(t.order).toEqual(["stream-1", "settled", "metadata-released"]);
      expect(await planReviewRows(t.h, workspaceId)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  test("an abandoned capture stops delaying later turns and later captures still land", async () => {
    // A read that ignores the abort (a hung remote command) stays pending long after the deadline.
    // Once abandoned it must leave settlement tracking: the next completed turn settles at once
    // and a later, healthy capture is neither delayed nor aborted with the stale one.
    const workspaceId = "session-plan-capture-abandoned";
    await writePlan(workspaceId, "# Plan\n\nStep one.\n");
    const emitter = new EventEmitter();
    let turns = 0;
    let metadataCalls = 0;
    const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
    const streamEnd = (): TurnCompletion => ({
      status: "completed",
      streamEnd: {
        type: "stream-end",
        workspaceId,
        metadata: { model },
        parts: [{ type: "text", text: "ok" }],
      },
    });
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      planSnapshotCaptureTimeoutMs: 200,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          turns += 1;
          const messageId = `assistant-${turns}`;
          emitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model,
            startTime: Date.now(),
          });
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
        getWorkspaceMetadata: mock(async () => {
          metadataCalls += 1;
          // Call 1 is the first send's preflight; call 2 is the first capture's read: hang it.
          if (metadataCalls === 2) await Promise.withResolvers<never>().promise;
          return Ok(metadataFor(workspaceId));
        }),
      },
    });
    const proposeAndComplete = async (toolCallId: string) => {
      expect((await h.session.sendMessage("propose", sendOptions)).success).toBe(true);
      emitter.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: `assistant-${turns}`,
        toolCallId,
        toolName: "propose_plan",
        result: { success: true },
        timestamp: Date.now(),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      completions[turns - 1].resolve(streamEnd());
      await h.session.waitForIdle();
    };
    try {
      await proposeAndComplete("call-stalled");
      expect(await planReviewRows(h, workspaceId)).toHaveLength(0);

      // A plain completed turn: nothing to capture, so settlement must not wait the deadline.
      expect((await h.session.sendMessage("hello", sendOptions)).success).toBe(true);
      const started = Date.now();
      completions[turns - 1].resolve(streamEnd());
      await h.session.waitForIdle();
      expect(Date.now() - started).toBeLessThan(150);

      // A later healthy capture (fast read) still becomes durable.
      await proposeAndComplete("call-healthy");
      expect(await planReviewRows(h, workspaceId)).toHaveLength(1);
    } finally {
      completions.forEach((completion) =>
        completion.resolve({ status: "aborted", abortReason: "user" })
      );
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("ensurePlanSnapshot refuses an aborted capture at append admission, after the read", async () => {
    const workspaceId = "session-plan-capture-admission";
    await writePlan(workspaceId, "# Plan\n\nStep one.\n");
    const store = await createTestHistoryService();
    try {
      const controller = new AbortController();
      const original = store.historyService.appendDerivedFromFullHistory.bind(store.historyService);
      // Abort exactly between the successful plan read and the locked append.
      const append = spyOn(store.historyService, "appendDerivedFromFullHistory").mockImplementation(
        ((...args: Parameters<typeof original>) => {
          controller.abort();
          return original(...args);
        }) as typeof original
      );
      const emitted: string[] = [];
      const result = await ensurePlanSnapshot(
        {
          historyService: store.historyService,
          emitChatEvent: (_workspaceId, message) => emitted.push(message.id),
        },
        {
          workspaceId,
          metadata: metadataFor(workspaceId),
          proposalToolCallId: "call-plan",
          signal: controller.signal,
        }
      );
      append.mockRestore();
      expect(result.success).toBe(false);
      expect(emitted).toHaveLength(0);
      const rows: string[] = [];
      await store.historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
        rows.push(...chunk.map((row) => row.id));
      });
      expect(rows).toHaveLength(0);
    } finally {
      await store.cleanup();
    }
  });
});
