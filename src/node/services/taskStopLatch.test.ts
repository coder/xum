import { describe, expect, mock, test } from "bun:test";

import type { ProjectsConfig } from "@/node/config";
import type {
  AdmittedSend,
  OwnedTaskAttempt,
  SettlementReceiptDecision,
  StreamEndDecision,
} from "@/node/services/taskService";
import { TaskStopLatch, type TaskStopLatchDeps } from "@/node/services/taskStopLatch";

const TASK = "task-a";
const PARENT = "parent-a";
const ATTEMPT = "att_00000000000000a1";

function ownedAttempt(receiptEligible = true): OwnedTaskAttempt {
  return { generation: 1, source: "test", attemptId: ATTEMPT, receiptEligible };
}

function send(state: AdmittedSend["state"], attemptId = ATTEMPT): AdmittedSend {
  return { taskId: TASK, attemptId, state, capturedBy: new Set() } as unknown as AdmittedSend;
}

function streamEnd(outcome: StreamEndDecision["outcome"]): StreamEndDecision {
  return { attempt: undefined, attemptId: ATTEMPT, messageId: "msg-1", outcome, turn: undefined };
}

/** A config whose only workspace is TASK, with this execution mirror. */
function configWithMirror(taskExecutionId: string, taskExecutionStatus: string): ProjectsConfig {
  const workspace = { id: TASK, taskExecutionId, taskExecutionStatus };
  return {
    projects: new Map([["/project", { workspaces: [workspace] }]]),
  } as unknown as ProjectsConfig;
}

interface HarnessState {
  activeTurn: symbol | undefined;
  liveHandleId: string | undefined;
  activeStreamMessageId: string | undefined;
  owned: OwnedTaskAttempt | undefined;
  currentAttemptId: string | undefined;
  sends: Set<AdmittedSend>;
  eligible: boolean;
  streamEnd: StreamEndDecision | undefined;
  decision: SettlementReceiptDecision;
  write: Promise<boolean>;
  config: ProjectsConfig;
}

/** Fake TaskService side: records every dep call in `events`, in call order. */
function createHarness() {
  const events: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const state: HarnessState = {
    activeTurn: undefined,
    liveHandleId: undefined,
    activeStreamMessageId: "msg-1",
    owned: undefined,
    currentAttemptId: ATTEMPT,
    sends: new Set(),
    eligible: false,
    streamEnd: undefined,
    decision: { kind: "memory-only" },
    write: Promise.resolve(true),
    config: { projects: new Map() },
  };
  const clearQueue = mock((id: string, _options?: { preserveUserInput?: boolean }) => {
    events.push(`clearQueue:${id}`);
    return { success: true as const, data: undefined };
  });
  const interruptWorkspaceTurn = mock((owner: string, handleId: string, _options?: unknown) => {
    events.push(`interrupt:${owner}:${handleId}`);
    return Promise.resolve({ success: true, data: undefined });
  });
  const deps: TaskStopLatchDeps = {
    config: () => ({ loadConfigOrDefault: () => state.config }),
    aiService: () => ({
      stopStream: mock((id: string, options?: { expectedMessageId?: string }) => {
        events.push(`stopStream:${id}:${options?.expectedMessageId ?? ""}`);
        return Promise.resolve({ success: true as const, data: undefined });
      }),
    }),
    workspaceService: () => ({
      getActiveTurnGeneration: () => state.activeTurn,
      clearQueue,
    }),
    turnManager: () =>
      ({
        getLiveWorkspaceTurnRegistration: () =>
          state.liveHandleId != null ? { handleId: state.liveHandleId } : undefined,
        captureQueueCutAttributionSnapshot: () => ({
          activeStream:
            state.activeStreamMessageId != null
              ? { messageId: state.activeStreamMessageId }
              : undefined,
        }),
        interruptWorkspaceTurn,
      }) as unknown as ReturnType<TaskStopLatchDeps["turnManager"]>,
    terminalAttention: () => ({
      suppressTerminalAttention: (params) => {
        events.push(`suppress:${params.sourceId}`);
        return Promise.resolve();
      },
    }),
    scheduleMaybeStartQueuedTasks: () => events.push("scheduleQueue"),
    scheduleParkedPeerSendFlush: (id) => events.push(`peerFlush:${id}`),
    notifyAttemptSettlementListeners: (id) => {
      events.push(`notify:${id}:record=${latch.hasStopRecord(id)}`);
      for (const listener of [...(listeners.get(id) ?? [])]) listener();
    },
    addAttemptSettlementListener: (id, listener) => {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
    },
    removeAttemptSettlementListener: (id, listener) => {
      listeners.get(id)?.delete(listener);
      if (listeners.get(id)?.size === 0) listeners.delete(id);
    },
    ownedAttempt: () => state.owned,
    currentTaskAttemptId: () => state.currentAttemptId,
    admittedSends: () => state.sends,
    ownsReceiptEligibleAttempt: () => state.eligible,
    findStreamEndDecision: () => state.streamEnd,
    decideSettlementReceipt: (id) => {
      events.push(`decide:${id}`);
      return state.decision;
    },
    writeSettlementReceipt: (id) => {
      events.push(`write:${id}`);
      return state.write;
    },
    closeAttemptAdmission: (id, attemptId) => events.push(`close:${id}:${attemptId ?? ""}`),
    settleOwnedTaskAttempt: (id, attempt) =>
      events.push(`settle:${id}:${attempt?.attemptId ?? "none"}`),
    recheckResumeFailureSettlement: (id) => events.push(`resumeRecheck:${id}`),
  };
  const latch = new TaskStopLatch(deps);
  return { latch, events, listeners, state, clearQueue, interruptWorkspaceTurn };
}

/** Phase A + the cascade's durable marker + Phase B's cleanup paid back (no Phase B run). */
function stopUntilOnlyTurnsHold(h: ReturnType<typeof createHarness>) {
  const record = h.latch.beginWorkspaceStop(TASK);
  h.latch.markWorkspaceStopPersisted(TASK);
  record.cleanupInFlight -= 1;
  return record;
}

describe("TaskStopLatch latches", () => {
  test("overlapping latches release only when the last holder releases", () => {
    const h = createHarness();
    const first = h.latch.latchWorkspaceStopsInProgress([TASK]);
    const second = h.latch.latchWorkspaceStopsInProgress([TASK]);
    first();
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(true);
    expect(h.events).toEqual([]);
    second();
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(false);
    // No launch was deferred, so the queue is not rechecked.
    expect(h.events).toEqual([`notify:${TASK}:record=false`, `peerFlush:${TASK}`]);
  });

  test("a deferred launch makes the clearing latch recheck the queue once, before notifying", () => {
    const h = createHarness();
    expect(h.latch.deferLaunchWhileStopInProgress(TASK, PARENT)).toBe(false);
    const release = h.latch.latchWorkspaceStopsInProgress([PARENT]);
    expect(h.latch.deferLaunchWhileStopInProgress(TASK, PARENT)).toBe(true);
    expect(h.latch.deferLaunchWhileStopInProgress(TASK, undefined)).toBe(false);
    release();
    expect(h.events).toEqual([
      "scheduleQueue",
      `notify:${PARENT}:record=false`,
      `peerFlush:${PARENT}`,
    ]);
    h.events.length = 0;
    h.latch.latchWorkspaceStopsInProgress([PARENT])();
    expect(h.events).not.toContain("scheduleQueue");
  });

  test("epochs count bumps and a forgotten epoch restarts at zero", () => {
    const h = createHarness();
    h.latch.bumpWorkspaceStopEpoch(TASK);
    h.latch.bumpWorkspaceStopEpoch(TASK);
    expect(h.latch.getWorkspaceStopEpoch(TASK)).toBe(2);
    expect(h.latch.getWorkspaceStopEpoch(PARENT)).toBe(0);
    h.latch.forgetStopEpoch(TASK);
    expect(h.latch.getWorkspaceStopEpoch(TASK)).toBe(0);
  });
});

describe("TaskStopLatch.beginWorkspaceStop", () => {
  test("captures the owner and only this attempt's unadmitted sends, by reference", () => {
    const h = createHarness();
    const turn = Symbol("turn");
    h.state.activeTurn = turn;
    h.state.liveHandleId = "wst_live";
    h.state.owned = ownedAttempt();
    const pending = send("pending");
    const enqueued = send("enqueued");
    const admitted = send("admitted");
    const otherAttempt = send("pending", "att_00000000000000b2");
    h.state.sends = new Set([pending, enqueued, admitted, otherAttempt]);

    const record = h.latch.beginWorkspaceStop(TASK);

    expect(h.latch.getWorkspaceStopEpoch(TASK)).toBe(1);
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(true);
    expect(h.latch.isCurrentStopRecord(TASK, record)).toBe(true);
    expect(h.latch.stopRecordAttemptId(TASK)).toBe(ATTEMPT);
    expect(record.ownedAttempt).toBe(h.state.owned);
    expect([...record.capturedTurns]).toEqual([turn]);
    expect(record.capturedExecutionId).toBe("wst_live");
    // The live mirror is not terminal in the (empty) config.
    expect(record.executionSettled).toBe(false);
    expect(record.capturedStreamMessageId).toBe("msg-1");
    expect([...record.pendingAdmissions]).toEqual([pending, enqueued]);
    expect(pending.capturedBy.has(record)).toBe(true);
    expect(admitted.capturedBy.size).toBe(0);
    expect(otherAttempt.capturedBy.size).toBe(0);
  });

  test("falls back to the persisted attempt id without an owned attempt", () => {
    const h = createHarness();
    h.state.currentAttemptId = "att_00000000000000c3";
    h.state.activeStreamMessageId = undefined;
    const record = h.latch.beginWorkspaceStop(TASK);
    expect(record.capturedStreamMessageId).toBeUndefined();
    expect(record.ownedAttempt).toBeUndefined();
    expect(record.attemptId).toBe("att_00000000000000c3");
    expect(record.executionSettled).toBe(true);
  });

  test("a captured execution whose mirror is already terminal counts as settled", () => {
    const h = createHarness();
    h.state.liveHandleId = "wst_live";
    h.state.config = configWithMirror("wst_live", "interrupted");
    expect(h.latch.beginWorkspaceStop(TASK).executionSettled).toBe(true);
    const other = createHarness();
    other.state.liveHandleId = "wst_live";
    other.state.config = configWithMirror("wst_live", "running");
    expect(other.latch.beginWorkspaceStop(TASK).executionSettled).toBe(false);
  });

  test("an overlapping cascade joins the same record and plans one more cleanup", () => {
    const h = createHarness();
    const first = h.latch.beginWorkspaceStop(TASK);
    const second = h.latch.beginWorkspaceStop(TASK);
    expect(second).toBe(first);
    expect(first.releases).toHaveLength(2);
    expect(first.cleanupInFlight).toBe(2);
    expect(h.latch.getWorkspaceStopEpoch(TASK)).toBe(2);
  });
});

describe("TaskStopLatch release", () => {
  test("a settled turn releases: record dropped before the latch, unowned attempt closed", () => {
    const h = createHarness();
    const turn = Symbol("turn");
    h.state.activeTurn = turn;
    stopUntilOnlyTurnsHold(h);
    h.latch.releaseCapturedTurn(TASK, Symbol("other"));
    expect(h.latch.hasStopRecord(TASK)).toBe(true);
    h.events.length = 0;

    h.latch.releaseCapturedTurn(TASK, turn);

    expect(h.latch.hasStopRecord(TASK)).toBe(false);
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(false);
    expect(h.events).toEqual([
      `decide:${TASK}`,
      `notify:${TASK}:record=false`,
      `peerFlush:${TASK}`,
      `close:${TASK}:${ATTEMPT}`,
      `settle:${TASK}:none`,
      `resumeRecheck:${TASK}`,
    ]);
  });

  test("an owed cleanup keeps the record until it is paid back", () => {
    const h = createHarness();
    const record = h.latch.beginWorkspaceStop(TASK);
    h.latch.markWorkspaceStopPersisted(TASK);
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(true);
    record.cleanupInFlight -= 1;
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(false);
  });

  test("the record waits for the durable stop marker; marking it only notifies", () => {
    const h = createHarness();
    const record = h.latch.beginWorkspaceStop(TASK);
    record.cleanupInFlight -= 1;
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(true);
    h.events.length = 0;
    h.latch.markWorkspaceStopPersisted(TASK);
    expect(h.events).toEqual([`notify:${TASK}:record=true`]);
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(false);
  });

  test("turn and record accessors are no-ops without a stop record", () => {
    const h = createHarness();
    const turn = Symbol("turn");
    expect(h.latch.stopRecordAttemptId(TASK)).toBeUndefined();
    h.latch.releaseCapturedTurn(TASK, turn);
    h.latch.rebindCapturedTurn(TASK, turn, Symbol("next"));
    h.latch.markWorkspaceStopPersisted(TASK);
    h.latch.releaseRetainedStopLatches(TASK);
    expect(h.events).toEqual([]);
  });

  test("a superseded turn rebinds the wait to its successor", () => {
    const h = createHarness();
    const previous = Symbol("previous");
    const next = Symbol("next");
    h.state.activeTurn = previous;
    stopUntilOnlyTurnsHold(h);
    h.latch.rebindCapturedTurn(TASK, previous, next);
    h.latch.releaseCapturedTurn(TASK, previous);
    expect(h.latch.hasStopRecord(TASK)).toBe(true);
    h.latch.releaseCapturedTurn(TASK, next);
    expect(h.latch.hasStopRecord(TASK)).toBe(false);
  });

  test("an eligible attempt without a stream-end decision does not wait for one", () => {
    const h = createHarness();
    h.state.owned = ownedAttempt();
    h.state.eligible = true;
    stopUntilOnlyTurnsHold(h);
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(false);
  });

  test("a pending stream-end decision holds the release while a receipt is at stake", () => {
    const h = createHarness();
    h.state.owned = ownedAttempt();
    h.state.eligible = true;
    h.state.streamEnd = streamEnd("pending");
    stopUntilOnlyTurnsHold(h);
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(true);
    expect(h.events).not.toContain(`decide:${TASK}`);

    h.state.streamEnd = streamEnd("nonreport");
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(false);
  });

  test("the receipt is written before the latch releases; a written receipt settles", async () => {
    const h = createHarness();
    h.state.owned = ownedAttempt();
    h.state.decision = { kind: "write", attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [] };
    const write = Promise.withResolvers<boolean>();
    h.state.write = write.promise;
    const record = stopUntilOnlyTurnsHold(h);
    h.events.length = 0;

    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(record.receipt).toBe("writing");
    // A recheck while the write is in flight starts no second write.
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.events).toEqual([`decide:${TASK}`, `write:${TASK}`]);
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(true);

    write.resolve(true);
    await write.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(record.receipt).toBe("written");
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(false);
    expect(h.events).toContain(`settle:${TASK}:${ATTEMPT}`);
    // An owned attempt is settled, not closed by the stop.
    expect(h.events.some((e) => e.startsWith("close:"))).toBe(false);
  });

  test.each([
    ["a failed write", "write" as const],
    ["an unreadable config", "unreadable" as const],
  ])("%s still releases, without settling the attempt", async (_label, kind) => {
    const h = createHarness();
    h.state.owned = ownedAttempt();
    h.state.decision =
      kind === "write"
        ? { kind, attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [] }
        : { kind };
    h.state.write = Promise.resolve(false);
    const record = stopUntilOnlyTurnsHold(h);
    h.latch.recheckWorkspaceStopRelease(TASK);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(record.receipt).toBe("failed");
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(false);
    expect(h.events.some((e) => e.startsWith("settle:"))).toBe(false);
    expect(h.events).toContain(`resumeRecheck:${TASK}`);
  });

  test("the release waits for the durable stop marker and the captured execution", () => {
    const h = createHarness();
    h.state.liveHandleId = "wst_live";
    const record = h.latch.beginWorkspaceStop(TASK);
    record.cleanupInFlight -= 1;
    h.latch.recheckWorkspaceStopRelease(TASK);
    expect(h.latch.hasStopRecord(TASK)).toBe(true);
    h.latch.markWorkspaceStopPersisted(TASK);
    // The same handle is still live and its mirror is not terminal: not settled.
    h.latch.releaseRetainedStopLatches(TASK);
    expect(record.executionSettled).toBe(false);
    expect(h.latch.hasStopRecord(TASK)).toBe(true);
    h.state.liveHandleId = undefined;
    h.latch.releaseRetainedStopLatches(TASK);
    expect(record.executionSettled).toBe(true);
    expect(h.latch.hasStopRecord(TASK)).toBe(false);
  });

  test("Phase B clears the queue, stops the captured stream and pays its cleanup back", async () => {
    const h = createHarness();
    h.latch.beginWorkspaceStop(TASK);
    h.latch.markWorkspaceStopPersisted(TASK);
    h.events.length = 0;

    const onTimeout = mock((_id: string) => undefined);
    await h.latch.runWorkspaceStopCleanup([TASK], {
      label: "test",
      abandonPartial: true,
      clearQueue: true,
      onTimeout,
    });
    await Promise.resolve();

    expect(h.events.slice(0, 2)).toEqual([`clearQueue:${TASK}`, `stopStream:${TASK}:msg-1`]);
    // The user's queued input is handed back, never dropped.
    expect(h.clearQueue).toHaveBeenCalledWith(TASK, { preserveUserInput: true });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(h.latch.hasStopRecord(TASK)).toBe(false);
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(false);
  });

  test("Phase B interrupts a captured execution before the stream stop", async () => {
    const h = createHarness();
    h.latch.beginWorkspaceStop(TASK);
    h.events.length = 0;
    await h.latch.runWorkspaceStopCleanup([TASK], {
      label: "test",
      abandonPartial: false,
      clearQueue: false,
      capturedExecutionsById: new Map([[TASK, { ownerWorkspaceId: PARENT, handleId: "wst_live" }]]),
    });
    expect(h.events.slice(0, 3)).toEqual([
      `interrupt:${PARENT}:wst_live`,
      "suppress:wst_live",
      `stopStream:${TASK}:msg-1`,
    ]);
    // The stop drains no queue: the cascade owns what runs next.
    expect(h.interruptWorkspaceTurn).toHaveBeenCalledWith(PARENT, "wst_live", {
      scheduleQueueDrain: false,
    });
  });

  test("Phase B for a workspace without a record stops any stream", async () => {
    const h = createHarness();
    await h.latch.runWorkspaceStopCleanup([TASK], {
      label: "test",
      abandonPartial: false,
      clearQueue: false,
    });
    expect(h.events[0]).toBe(`stopStream:${TASK}:`);
  });
});

describe("TaskStopLatch.waitForWorkspaceStopsToRelease", () => {
  test("resolves once the latch drops and removes its listener", async () => {
    const h = createHarness();
    const release = h.latch.latchWorkspaceStopsInProgress([TASK]);
    let resolved = false;
    const wait = h.latch
      .waitForWorkspaceStopsToRelease([PARENT, TASK], Date.now() + 60_000)
      .then(() => {
        resolved = true;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(h.listeners.get(TASK)?.size).toBe(1);
    release();
    await wait;
    expect(resolved).toBe(true);
    expect(h.listeners.has(TASK)).toBe(false);
  });

  test("returns at the deadline while the latch is still held", async () => {
    const h = createHarness();
    h.latch.latchWorkspaceStopsInProgress([TASK]);
    await h.latch.waitForWorkspaceStopsToRelease([TASK], Date.now() - 1);
    expect(h.latch.isWorkspaceStopInProgress(TASK)).toBe(true);
    expect(h.listeners.has(TASK)).toBe(false);
  });
});
