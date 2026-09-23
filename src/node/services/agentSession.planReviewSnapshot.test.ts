import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { isMuxMessage } from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import { Ok, type Result } from "@/common/types/result";
import type { StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import { getAuthenticPlanReviewRecord } from "@/common/utils/planReview/planReviewEnvelope";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import { ensurePlanSnapshot, getPlanReviewState } from "./planReviewService";
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

/** HistoryService's private locked write step; the admitted snapshot row is written here. */
interface LockedAppendInternals {
  appendToHistoryUnderWriteLock: (
    workspaceId: string,
    message: MuxMessage
  ) => Promise<Result<void>>;
}

/** Proposal a snapshot row belongs to (undefined for on-demand); null for any other row. */
function snapshotProposalOf(message: MuxMessage): string | undefined | null {
  const record = getAuthenticPlanReviewRecord(message);
  return record?.kind === "snapshot" ? record.proposalToolCallId : null;
}

/** True when `promise` settles within `ms`. Only bounds a negative probe (see callers). */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

const PLAN_V1 = "# Plan\n\nStep one.\n";
const PLAN_V2 = "# Plan\n\nStep one, revised.\n";

describe("AgentSession plan-review snapshot: an admitted append outlives Stop/failure", () => {
  afterEach(async () => {
    await fs.rm(planDir, { recursive: true, force: true });
  });

  // Codex review (PR #4317, F3): Stop/failure detaches a capture whose append was already
  // admitted, so its row lands and is emitted AFTER the turn settled. The claim under test: the
  // history lock the admitted append holds orders it before anything a successor can publish —
  // a successor turn cannot even start (send/resume take the same lock, and streamWithHistory
  // reads history under it before any provider request), and an on-demand snapshot racing it
  // waits on that lock.
  // Holding the REAL write (before or after its disk append) keeps that lock held.
  const cases = (["stop", "failed"] as const).flatMap((outcome) =>
    (["before-write", "after-write"] as const).flatMap((hold) =>
      (["send", "resume", "on-demand"] as const).map(
        (successor) => [outcome, hold, successor] as const
      )
    )
  );

  test.each(cases)(
    "%s turn, admitted append held %s, successor %s: older snapshot is sequenced and emitted first",
    async (outcome, hold, successor) => {
      const workspaceId = `plan-admitted-${outcome}-${hold}-${successor}`;
      await writePlan(workspaceId, PLAN_V1);
      const emitter = new EventEmitter();
      const order: string[] = [];
      const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
      const streamStarted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const firstSettled = Promise.withResolvers<void>();
      let turns = 0;
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        onTurnSettled: () => {
          order.push("settled");
          firstSettled.resolve();
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
            streamStarted[turns - 1]?.resolve();
            return Promise.resolve(Ok({ messageId, completion: completion.promise }));
          }),
          getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadataFor(workspaceId)))),
        },
      });
      const emitted: Array<{ id: string; proposal: string | undefined; sequence: unknown }> = [];
      h.session.onChatEvent(({ message }) => {
        if (!isMuxMessage(message)) return;
        const proposal = snapshotProposalOf(message);
        if (proposal === null) return;
        emitted.push({ id: message.id, proposal, sequence: message.metadata?.historySequence });
        order.push(`emit:${proposal ?? "on-demand"}`);
      });

      // Park the stopped turn's snapshot append AFTER admission: the derive callback already
      // returned this row, and the lock stays held until the latch opens.
      const internals = h.historyService as unknown as LockedAppendInternals;
      const realAppend = internals.appendToHistoryUnderWriteLock.bind(h.historyService);
      const admitted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const appendSpy = spyOn(internals, "appendToHistoryUnderWriteLock").mockImplementation(
        async (id, message) => {
          if (snapshotProposalOf(message) !== "call-old") return realAppend(id, message);
          order.push("old-admitted");
          if (hold === "after-write") {
            const written = await realAppend(id, message);
            order.push("old-written");
            admitted.resolve();
            await release.promise;
            return written;
          }
          admitted.resolve();
          await release.promise;
          const written = await realAppend(id, message);
          order.push("old-written");
          return written;
        }
      );
      const completed: TurnCompletion = {
        status: "completed",
        streamEnd: {
          type: "stream-end",
          workspaceId,
          metadata: { model },
          parts: [{ type: "text", text: "Proposed." }],
        },
      };
      const proposePlan = (messageId: string, toolCallId: string) =>
        emitter.emit("tool-call-end", {
          type: "tool-call-end",
          workspaceId,
          messageId,
          toolCallId,
          toolName: "propose_plan",
          result: { success: true },
          timestamp: Date.now(),
        });
      try {
        expect((await h.session.sendMessage("propose", sendOptions)).success).toBe(true);
        proposePlan("assistant-1", "call-old");
        await admitted.promise;

        // Stop / fail the owning turn while its admitted append is in flight.
        completions[0].resolve(
          outcome === "stop"
            ? {
                status: "aborted",
                abortReason: "user",
                streamAbort: { type: "stream-abort", workspaceId },
              }
            : {
                status: "failed",
                streamError: {
                  messageId: "assistant-1",
                  error: "boom",
                  errorType: "authentication",
                },
              }
        );
        // Settlement detaches the capture instead of waiting on it (the finding's premise).
        expect(await settlesWithin(firstSettled.promise, 300)).toBe(true);
        order.push("stopped-turn-settled-while-held");

        let successorProgress: Promise<unknown>;
        let successorCall: Promise<{ success: boolean }>;
        if (successor === "on-demand") {
          // The user edits the plan while the old append is held and asks for a snapshot
          // (WorkspaceService.planReviewEnsureSnapshot's exact deps).
          await writePlan(workspaceId, PLAN_V2);
          successorCall = ensurePlanSnapshot(
            {
              historyService: h.historyService,
              emitChatEvent: (_id, message) =>
                h.session.emitChatEvent({ ...message, type: "message" }),
            },
            { workspaceId, metadata: metadataFor(workspaceId) }
          );
          successorProgress = successorCall;
        } else {
          successorCall =
            successor === "send"
              ? h.session.sendMessage("revise", sendOptions)
              : h.session.resumeStream(sendOptions);
          successorProgress = streamStarted[1].promise;
        }
        // Negative probe: the successor stays parked on the history lock the held append owns.
        expect(await settlesWithin(successorProgress, 300)).toBe(false);
        order.push("release");
        release.resolve();

        expect((await successorCall).success).toBe(true);
        if (successor !== "on-demand") {
          await streamStarted[1].promise;
          // The successor turn revises the plan (as its file_edit would) and proposes it.
          await writePlan(workspaceId, PLAN_V2);
          proposePlan("assistant-2", "call-new");
          completions[1].resolve(completed);
          await h.session.waitForIdle();
        }

        const newProposal = successor === "on-demand" ? undefined : "call-new";
        const durable: Array<{ id: string; proposal: string | undefined; sequence: unknown }> = [];
        const scanned = await h.historyService.iterateFullHistory(
          workspaceId,
          "forward",
          (chunk) => {
            for (const row of chunk) {
              const proposal = snapshotProposalOf(row);
              if (proposal !== null) {
                durable.push({ id: row.id, proposal, sequence: row.metadata?.historySequence });
              }
            }
          }
        );
        expect(scanned.success).toBe(true);
        // Durable order: the stopped turn's snapshot first, the successor's second.
        expect(durable.map((row) => row.proposal)).toEqual(["call-old", newProposal]);
        expect(Number(durable[0].sequence)).toBeLessThan(Number(durable[1].sequence));
        // Live order matches commit order, row for row and sequence for sequence.
        expect(emitted).toEqual(durable);
        // The successor only started once the admitted append had fully settled and emitted.
        const successorMark = successor === "on-demand" ? "emit:on-demand" : "stream-2";
        expect(order.indexOf("emit:call-old")).toBeLessThan(order.indexOf(successorMark));
        expect(order.indexOf("release")).toBeLessThan(order.indexOf("emit:call-old"));

        // What a client presents: getState's newest revision is the successor's, and the older
        // row still carries the plan text the stopped turn actually proposed.
        const state = await getPlanReviewState(h.historyService, workspaceId);
        expect(state.success).toBe(true);
        if (!state.success) return;
        expect(
          state.data.snapshots.map((snapshot) => [snapshot.proposalToolCallId, snapshot.content])
        ).toEqual([
          ["call-old", PLAN_V1],
          [newProposal, PLAN_V2],
        ]);
      } finally {
        release.resolve();
        appendSpy.mockRestore();
        completions.forEach((completion) =>
          completion.resolve({ status: "aborted", abortReason: "user" })
        );
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );
});
