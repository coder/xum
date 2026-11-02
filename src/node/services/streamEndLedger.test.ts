import { describe, expect, test } from "bun:test";

import type { StreamEndEvent } from "@/common/types/stream";
import type { ProjectsConfig } from "@/node/config";
import { StreamEndLedger, type StreamEndLedgerDeps } from "@/node/services/streamEndLedger";
import type {
  AdmittedSend,
  OwnedTaskAttempt,
  StreamEndTaskOrigin,
} from "@/node/services/taskService";
import type {
  QueueCutAttributionSnapshot,
  QueueCutReceipt,
} from "@/node/services/taskWorkspaceSeam";
import type { StreamAccountingReceiptOutcome } from "@/node/services/workspaceGoalService";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

const TASK = "task-a";
const ATTEMPT = "att_00000000000000a1";
const OTHER = "att_00000000000000b2";

function attempt(attemptId: string = ATTEMPT): OwnedTaskAttempt {
  return { attemptId, receiptEligible: true } as unknown as OwnedTaskAttempt;
}

function send(attemptId: string, state: string): AdmittedSend {
  return { taskId: TASK, attemptId, state } as unknown as AdmittedSend;
}

function configWithRow(row: Record<string, unknown> | undefined): ProjectsConfig {
  const workspaces = row == null ? [] : [{ id: TASK, ...row }];
  return { projects: new Map([["/project", { workspaces }]]) } as unknown as ProjectsConfig;
}

const streamEnd = { workspaceId: TASK, messageId: "msg-1" } as unknown as StreamEndEvent;
const snapshot = {} as unknown as QueueCutAttributionSnapshot;

function deferral(overrides: Record<string, unknown> = {}) {
  return {
    sourceMessageId: "msg-1",
    sourceTurnGeneration: Symbol("source"),
    continuationEntryId: "entry-1",
    executionId: "exec-1",
    stopEpoch: 0,
    attemptId: ATTEMPT,
    ...overrides,
  };
}

/** A ledger over fake deps; `calls` records the order of the deps that act. */
function harness() {
  const state = {
    config: configWithRow({ taskStatus: "running", taskAttemptId: ATTEMPT }),
    activeTurn: undefined as symbol | undefined,
    sends: new Set<AdmittedSend>(),
    stopEpoch: 0,
    executionId: "exec-1" as string | null,
    admissionOpen: true,
    receipt: undefined as QueueCutReceipt | undefined,
    disposeResult: true,
    accounting: Promise.withResolvers<StreamAccountingReceiptOutcome>(),
    handlerResults: [] as Array<"deferred" | undefined | Error>,
  };
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const locks = new MutexMap<string>();
  const deps: StreamEndLedgerDeps = {
    config: () => ({ loadConfigOrDefault: () => state.config }),
    workspaceService: () => ({
      getActiveTurnGeneration: () => state.activeTurn,
      drainQueuedMessagesIfIdle: () => calls.push("drain"),
      disposeQueueCut: () => {
        calls.push("dispose");
        return state.disposeResult;
      },
      getQueueCutReceipt: () => state.receipt,
    }),
    workspaceGoalService: () => ({
      streamAccountingReceiptOutcome: () => {
        calls.push("accounting");
        return state.accounting.promise;
      },
    }),
    workspaceEventLocks: () => locks,
    handleStreamEnd: () => {
      calls.push("handle");
      const result = state.handlerResults.shift();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    recoverTaskFromIncompleteStreamEnd: (_workspaceId, status, streamAttemptId) => {
      calls.push(`recover:${String(status)}:${String(streamAttemptId)}`);
      return Promise.resolve();
    },
    getWorkspaceStopEpoch: () => state.stopEpoch,
    getAgentTaskExecutionId: () => state.executionId,
    recheckWorkspaceStopRelease: () => {
      // The decision is pruned before the stop latch rechecks it.
      calls.push(`recheck:${String(ledger.streamEndDecisionsByTaskId.has(TASK))}`);
    },
    attemptAdmissionOpen: () => state.admissionOpen,
    addAttemptSettlementListener: (_taskId, listener) => {
      calls.push("add-listener");
      listeners.add(listener);
    },
    removeAttemptSettlementListener: (_taskId, listener) => {
      calls.push("remove-listener");
      listeners.delete(listener);
    },
    sendsOf: () => state.sends,
  };
  const ledger = new StreamEndLedger(deps);
  return { ledger, state, calls, listeners, locks };
}

function origin(owned: OwnedTaskAttempt | undefined): StreamEndTaskOrigin {
  return { executionId: "exec-1", stopEpoch: 0, ownedAttempt: owned };
}

/** Waits until the event lock of TASK is free (the handler run finished). */
async function settle(locks: MutexMap<string>): Promise<void> {
  for (let i = 0; i < 5; i++) await locks.withLock(TASK, () => Promise.resolve());
}

describe("StreamEndLedger decisions", () => {
  test("register binds the owned attempt object and the turn live in the event tick", () => {
    const t = harness();
    const turn = Symbol("turn");
    t.state.activeTurn = turn;
    const owned = attempt();
    const decision = t.ledger.registerStreamEndDecision(TASK, "msg-1", owned, undefined);
    t.state.activeTurn = undefined;
    expect(decision?.attempt).toBe(owned);
    expect(decision?.turn).toBe(turn);
    expect(t.ledger.findPendingStreamEndDecision(TASK, owned)).toBe(decision);
    expect(t.ledger.registerStreamEndDecision(TASK, "msg-2", undefined, undefined)).toBeUndefined();
  });

  test("an unowned decision is keyed by the persisted attempt id and never matches an owner", () => {
    const t = harness();
    const decision = t.ledger.registerStreamEndDecision(TASK, "msg-1", undefined, ATTEMPT);
    expect(t.ledger.findPendingStreamEndDecision(TASK, undefined, ATTEMPT)).toBe(decision);
    expect(t.ledger.findPendingStreamEndDecision(TASK, attempt())).toBeUndefined();
    expect(t.ledger.findPendingStreamEndDecision(TASK, undefined)).toBeUndefined();
    expect(t.ledger.findPendingStreamEndDecision(TASK, attempt(OTHER))).toBeUndefined();
  });

  test("find prefers the pending decision of the attempt, else its latest", () => {
    const t = harness();
    t.state.sends.add(send(ATTEMPT, "pending"));
    const first = t.ledger.registerStreamEndDecision(TASK, "msg-1", undefined, ATTEMPT);
    const pending = t.ledger.registerStreamEndDecision(TASK, "msg-2", undefined, ATTEMPT);
    const third = t.ledger.registerStreamEndDecision(TASK, "msg-3", undefined, ATTEMPT);
    t.ledger.resolveStreamEndDecision(TASK, first, "nonreport");
    t.ledger.resolveStreamEndDecision(TASK, third, "nonreport");
    expect(t.ledger.findStreamEndDecision(TASK, ATTEMPT)).toBe(pending);
    t.ledger.resolveStreamEndDecision(TASK, pending, "nonreport");
    expect(t.ledger.findStreamEndDecision(TASK, ATTEMPT)).toBe(third);
    expect(t.ledger.findStreamEndDecision(TASK, OTHER)).toBeUndefined();
  });

  test("resolve runs once, downgrades the receipt, then prunes, rechecks the stop and drains", () => {
    const t = harness();
    const owned = attempt();
    const decision = t.ledger.registerStreamEndDecision(TASK, "msg-1", owned, undefined);
    expect(t.ledger.resolveStreamEndDecision(TASK, decision, "published")).toBe(true);
    expect(owned.receiptEligible).toBe(false);
    expect(t.calls).toEqual(["recheck:false", "drain"]);
    expect(t.ledger.resolveStreamEndDecision(TASK, decision, "nonreport")).toBe(false);
    expect(decision?.outcome).toBe("published");
    expect(t.calls).toEqual(["recheck:false", "drain"]);
    expect(t.ledger.resolveStreamEndDecision(TASK, undefined, "nonreport")).toBe(false);
  });

  test("a nonreport decision keeps the attempt receipt-eligible", () => {
    const t = harness();
    const owned = attempt();
    const decision = t.ledger.registerStreamEndDecision(TASK, "msg-1", owned, undefined);
    t.ledger.resolveStreamEndDecision(TASK, decision, "nonreport");
    expect(owned.receiptEligible).toBe(true);
  });

  test("prune keeps pending, read and live-turn terminal decisions only", () => {
    const t = harness();
    const turn = Symbol("turn");
    t.state.sends.add(send(OTHER, "enqueued"));
    t.state.sends.add(send("att_unread", "admitted"));
    const pending = t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    const read = t.ledger.registerStreamEndDecision(TASK, "m2", undefined, OTHER);
    t.state.activeTurn = turn;
    const terminal = t.ledger.registerStreamEndDecision(TASK, "m3", undefined, "att_terminal");
    const liveNonreport = t.ledger.registerStreamEndDecision(TASK, "m4", undefined, "att_unread");
    t.ledger.resolveStreamEndDecision(TASK, read, "nonreport");
    t.ledger.resolveStreamEndDecision(TASK, terminal, "indeterminate");
    t.ledger.resolveStreamEndDecision(TASK, liveNonreport, "nonreport");
    expect(t.ledger.streamEndDecisionsByTaskId.get(TASK)).toEqual([pending!, read!, terminal!]);

    // The reporting turn settles: only actual readers keep the terminal decision now.
    t.ledger.settleTurn(TASK, Symbol("unrelated"));
    expect(terminal?.turn).toBe(turn);
    t.ledger.settleTurn(TASK, turn);
    expect(t.ledger.streamEndDecisionsByTaskId.get(TASK)).toEqual([pending!, read!]);

    t.state.sends.clear();
    t.ledger.resolveStreamEndDecision(TASK, pending, "nonreport");
    expect(t.ledger.streamEndDecisionsByTaskId.has(TASK)).toBe(false);
  });

  test("prune keeps the same array when nothing is dropped", () => {
    const t = harness();
    t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    const before = t.ledger.streamEndDecisionsByTaskId.get(TASK);
    expect(before).toHaveLength(1);
    t.ledger.pruneStreamEndDecisions(TASK);
    expect(t.ledger.streamEndDecisionsByTaskId.get(TASK)).toBe(before);
  });

  test("rebindTurn moves decisions of the superseded turn to its successor", () => {
    const t = harness();
    const previous = Symbol("previous");
    const next = Symbol("next");
    t.state.activeTurn = previous;
    const decision = t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    t.ledger.rebindTurn(TASK, Symbol("unrelated"), next);
    expect(decision?.turn).toBe(previous);
    t.ledger.rebindTurn(TASK, previous, next);
    expect(decision?.turn).toBe(next);
  });

  test("settling a turn no decision was decided for prunes nothing", () => {
    const t = harness();
    t.state.sends.add(send(ATTEMPT, "pending"));
    const decision = t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    t.ledger.resolveStreamEndDecision(TASK, decision, "nonreport");
    // The reader went away without a prune: only a settled decision turn prunes now.
    t.state.sends.clear();
    t.ledger.settleTurn(TASK, Symbol("unrelated"));
    expect(t.ledger.findStreamEndDecision(TASK, ATTEMPT)).toBe(decision);
  });

  test("discard drops every decision of the task", () => {
    const t = harness();
    t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    t.ledger.discardStreamEndDecisions(TASK);
    expect(t.ledger.findStreamEndDecision(TASK, ATTEMPT)).toBeUndefined();
  });

  test("a reported row resolves the attempt's decision indeterminate", () => {
    const t = harness();
    const decision = t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    expect(t.ledger.resolveDecisionOfReportedAttempt(TASK, ATTEMPT)).toBe(false);
    expect(t.ledger.resolveDecisionOfReportedAttempt(TASK, undefined)).toBe(false);
    t.state.config = configWithRow(undefined);
    expect(t.ledger.resolveDecisionOfReportedAttempt(TASK, ATTEMPT)).toBe(false);
    t.state.config = configWithRow({ taskStatus: "reported", taskAttemptId: ATTEMPT });
    expect(t.ledger.resolveDecisionOfReportedAttempt(TASK, OTHER)).toBe(false);
    expect(decision?.outcome).toBe("pending");
    expect(t.ledger.resolveDecisionOfReportedAttempt(TASK, ATTEMPT)).toBe(true);
    expect(decision?.outcome).toBe("indeterminate");
  });
});

describe("StreamEndLedger stream-end handler runs", () => {
  test("a handler return resolves nonreport, a throw indeterminate", async () => {
    const t = harness();
    const ok = t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    t.state.handlerResults.push(undefined);
    t.ledger.runStreamEndHandler(streamEnd, snapshot, origin(undefined), ok);
    await settle(t.locks);
    expect(ok?.outcome).toBe("nonreport");

    const thrown = t.ledger.registerStreamEndDecision(TASK, "m2", undefined, OTHER);
    t.state.handlerResults.push(new Error("handler failed"));
    t.ledger.runStreamEndHandler(streamEnd, snapshot, origin(undefined), thrown);
    await settle(t.locks);
    expect(thrown?.outcome).toBe("indeterminate");
  });

  test("a deferred stream waits for its accounting, then re-runs with the same decision", async () => {
    const t = harness();
    const owned = attempt();
    const decision = t.ledger.registerStreamEndDecision(TASK, "m1", owned, undefined);
    t.state.handlerResults.push("deferred", undefined);
    t.ledger.runStreamEndHandler(streamEnd, snapshot, origin(owned), decision);
    await settle(t.locks);
    expect(decision?.outcome).toBe("pending");
    expect(t.calls).toEqual(["handle", "add-listener", "accounting"]);
    expect(t.listeners.size).toBe(1);

    t.state.accounting.resolve("settled");
    await settle(t.locks);
    expect(t.calls.slice(0, 5)).toEqual([
      "handle",
      "add-listener",
      "accounting",
      "remove-listener",
      "handle",
    ]);
    expect(t.listeners.size).toBe(0);
    expect(decision?.outcome).toBe("nonreport");
  });

  test("the deferral listener runs synchronously once and cancels a closed attempt", async () => {
    const t = harness();
    t.state.admissionOpen = false;
    const decision = t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    t.state.handlerResults.push("deferred", undefined);
    t.ledger.runStreamEndHandler(
      streamEnd,
      snapshot,
      { ...origin(undefined), unownedAttemptId: ATTEMPT },
      decision
    );
    await settle(t.locks);
    // Cancelled without the accounting settling: the stream end re-ran.
    expect(t.calls.filter((call) => call === "handle")).toHaveLength(2);
    expect(t.listeners.size).toBe(0);
    expect(decision?.outcome).toBe("nonreport");
  });

  test("a deferral whose attempt reported meanwhile resolves indeterminate before the re-run", async () => {
    const t = harness();
    const owned = attempt();
    const decision = t.ledger.registerStreamEndDecision(TASK, "m1", owned, undefined);
    t.state.handlerResults.push("deferred", undefined);
    t.ledger.runStreamEndHandler(streamEnd, snapshot, origin(owned), decision);
    await settle(t.locks);
    t.state.config = configWithRow({ taskStatus: "reported", taskAttemptId: ATTEMPT });
    // The listener sees the row no longer reads running and cancels the wait.
    for (const listener of t.listeners) listener();
    await settle(t.locks);
    expect(decision?.outcome).toBe("indeterminate");
    expect(owned.receiptEligible).toBe(false);
  });

  test("a deferral whose row is gone cancels at once", async () => {
    const t = harness();
    t.state.config = configWithRow(undefined);
    const decision = t.ledger.registerStreamEndDecision(TASK, "m1", undefined, ATTEMPT);
    t.state.handlerResults.push("deferred", undefined);
    t.ledger.runStreamEndHandler(
      streamEnd,
      snapshot,
      { ...origin(undefined), unownedAttemptId: ATTEMPT },
      decision
    );
    await settle(t.locks);
    expect(t.calls.filter((call) => call === "handle")).toHaveLength(2);
    expect(decision?.outcome).toBe("nonreport");
  });

  test("a stop epoch or execution that moved on cancels the deferral", async () => {
    for (const move of ["stop", "execution"] as const) {
      const t = harness();
      const owned = attempt();
      const decision = t.ledger.registerStreamEndDecision(TASK, "m1", owned, undefined);
      t.state.handlerResults.push("deferred", undefined);
      t.ledger.runStreamEndHandler(streamEnd, snapshot, origin(owned), decision);
      await settle(t.locks);
      expect(t.listeners.size).toBe(1);
      if (move === "stop") t.state.stopEpoch = 1;
      else t.state.executionId = "exec-2";
      for (const listener of t.listeners) listener();
      await settle(t.locks);
      expect(t.listeners.size).toBe(0);
      expect(decision?.outcome).toBe("nonreport");
    }
  });
});

describe("StreamEndLedger deferred cut stream ends", () => {
  test("no deferral reconciles to false", async () => {
    const t = harness();
    expect(await t.ledger.reconcileDeferredTaskStreamEnd(TASK)).toBe(false);
    expect(t.calls).toEqual([]);
  });

  test("an obsolete deferral is dropped and its cut disposed without recovery", async () => {
    // Each case breaks exactly one condition of a live deferral.
    const live = {
      parentWorkspaceId: "p",
      taskStatus: "running",
      taskAttemptId: ATTEMPT,
      taskExecutionId: "exec-1",
    };
    const cases: Array<{ row?: Record<string, unknown>; stopEpoch?: number }> = [
      { row: undefined },
      { row: { ...live, parentWorkspaceId: undefined } },
      { row: { ...live, taskStatus: "awaiting_report" } },
      { row: { ...live, taskAttemptId: OTHER } },
      { row: { ...live, taskExecutionId: "x" } },
      { row: live, stopEpoch: 1 },
    ];
    for (const c of cases) {
      const t = harness();
      t.state.config = configWithRow(c.row);
      t.state.stopEpoch = c.stopEpoch ?? 0;
      t.ledger.recordDeferral(TASK, deferral());
      expect(await t.ledger.reconcileDeferredTaskStreamEnd(TASK)).toBe(false);
      expect(t.ledger.hasDeferral(TASK)).toBe(false);
      expect(t.calls).toEqual(["dispose"]);
    }
  });

  test("the successor outcome settles or keeps the deferral", async () => {
    const live = {
      parentWorkspaceId: "p",
      taskStatus: "running",
      taskAttemptId: ATTEMPT,
      taskExecutionId: "exec-1",
    };
    const receipt = (successor: string) =>
      ({
        successor,
        sourceTurnGeneration: Symbol("s"),
        sourceHandled: true,
        disposed: false,
      }) as unknown as QueueCutReceipt;
    const run = async (r: QueueCutReceipt | undefined, disposeResult = true) => {
      const t = harness();
      t.state.config = configWithRow(live);
      t.state.receipt = r;
      t.state.disposeResult = disposeResult;
      const d = deferral();
      t.ledger.recordDeferral(TASK, d);
      expect(t.ledger.deferralOf(TASK)).toBe(d);
      const result = await t.ledger.reconcileDeferredTaskStreamEnd(TASK);
      return { result, kept: t.ledger.hasDeferral(TASK), calls: t.calls };
    };
    expect(await run(undefined)).toEqual({ result: false, kept: false, calls: [] });
    expect(await run(receipt("streaming"))).toEqual({ result: false, kept: false, calls: [] });
    expect(await run(receipt("pending"))).toEqual({ result: false, kept: true, calls: [] });
    expect(await run(receipt("admitted"))).toEqual({ result: false, kept: true, calls: [] });
    expect(await run(receipt("canceled"))).toEqual({
      result: true,
      kept: false,
      calls: ["dispose", `recover:running:${ATTEMPT}`],
    });
    expect(await run(receipt("prestream-failed"), false)).toEqual({
      result: true,
      kept: false,
      calls: ["dispose"],
    });
  });

  test("forgetDeferral drops the deferral", () => {
    const t = harness();
    t.ledger.recordDeferral(TASK, deferral());
    t.ledger.forgetDeferral(TASK);
    expect(t.ledger.deferralOf(TASK)).toBeUndefined();
  });
});
