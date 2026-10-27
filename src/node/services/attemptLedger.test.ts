/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TaskAttemptOutcome } from "@/common/types/tasks";
import type { ProjectsConfig } from "@/node/config";
import type { AgentTaskIndex } from "@/node/services/agentTaskIndex";
import { AttemptLedger, type AttemptLedgerDeps } from "@/node/services/attemptLedger";
import { readSubagentAttemptSettlementReceiptStrict } from "@/node/services/subagentAttemptSettlements";
import type {
  AdmittedSend,
  AgentTaskReport,
  OwnedTaskAttempt,
  SettlementReceiptDecision,
  StreamEndDecision,
} from "@/node/services/taskService";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

const TASK = "task-a";
const PARENT = "parent-a";
const ROOT = "root-a";
const ATTEMPT = "att_00000000000000a1";
const OTHER = "att_00000000000000b2";

function send(attemptId: string): AdmittedSend {
  return { taskId: TASK, attemptId, state: "admitted" } as unknown as AdmittedSend;
}

/** A config whose only workspace is TASK, with this row. */
function configWithRow(row: Record<string, unknown> | undefined): ProjectsConfig {
  const workspaces = row == null ? [] : [{ id: TASK, ...row }];
  return { projects: new Map([["/project", { workspaces }]]) } as unknown as ProjectsConfig;
}

interface HarnessState {
  config: ProjectsConfig | Error;
  sessionsDir: string;
  stopRecordAttemptId: string | undefined;
  hasStopRecord: boolean;
  sends: Set<AdmittedSend>;
  activeTurn: symbol | undefined;
  liveRegistration: unknown;
  streaming: boolean;
  streamEnd: StreamEndDecision | undefined;
  owners: string[];
  outcomes: Array<TaskAttemptOutcome<AgentTaskReport>>;
}

/**
 * Fake TaskService side: records the facade calls the ledger routes back through TaskService in
 * `events`, in call order, and forwards them to the ledger as the real facades do.
 */
function createHarness() {
  const events: string[] = [];
  const state: HarnessState = {
    config: configWithRow({ parentWorkspaceId: PARENT, taskAttemptId: ATTEMPT }),
    sessionsDir: "/unused",
    stopRecordAttemptId: undefined,
    hasStopRecord: false,
    sends: new Set(),
    activeTurn: undefined,
    liveRegistration: undefined,
    streaming: false,
    streamEnd: undefined,
    owners: [PARENT, ROOT],
    outcomes: [],
  };
  const eventLocks = new MutexMap<string>();
  const inspect = mock(
    (
      _taskId: string,
      _options?: { requestingWorkspaceId?: string }
    ): Promise<TaskAttemptOutcome<AgentTaskReport>> =>
      Promise.resolve(state.outcomes.shift() ?? { kind: "live", executionId: TASK })
  );
  const deps: AttemptLedgerDeps = {
    config: () => ({
      // Like the real Config: an unreadable file throws only for a strict read.
      loadConfigOrDefault: (options?: { throwOnError?: boolean }) => {
        if (!(state.config instanceof Error)) return state.config;
        if (options?.throwOnError === true) throw state.config;
        return configWithRow(undefined);
      },
      sessionsDir: state.sessionsDir,
    }),
    aiService: () => ({ isStreaming: () => state.streaming }),
    workspaceService: () => ({ getActiveTurnGeneration: () => state.activeTurn }),
    turnManager: () =>
      ({
        getLiveWorkspaceTurnRegistration: () => state.liveRegistration,
      }) as unknown as ReturnType<AttemptLedgerDeps["turnManager"]>,
    workspaceEventLocks: () => eventLocks,
    buildAgentTaskIndex: () => ({ parentById: new Map() }) as unknown as AgentTaskIndex,
    listAncestorWorkspaceIdsUsingParentById: () => state.owners,
    stopRecordAttemptId: () => state.stopRecordAttemptId,
    hasStopRecord: () => state.hasStopRecord,
    admittedSends: () => state.sends,
    findStreamEndDecision: () => state.streamEnd,
    discardStreamEndDecisions: (taskId) => events.push(`discardStreamEnds:${taskId}`),
    inspectAttemptOutcome: (taskId, options) => {
      events.push("inspect");
      return inspect(taskId, options);
    },
    notifyAttemptSettlementListeners: (taskId) => {
      events.push("notify");
      ledger.notifyAttemptSettlementListeners(taskId);
    },
    closeAttemptAdmission: (taskId, attemptId, ownedAttempt, source) => {
      events.push(`close:${attemptId ?? "none"}`);
      ledger.closeAttemptAdmission(taskId, attemptId, ownedAttempt, source);
    },
    settleOwnedTaskAttempt: (taskId, attempt, source) => {
      events.push("settle");
      ledger.settleOwnedTaskAttempt(taskId, attempt, source);
    },
    decideSettlementReceipt: (taskId, attempt, source) => {
      events.push("decide");
      return ledger.decideSettlementReceipt(taskId, attempt, source);
    },
    writeSettlementReceipt: (taskId, target, source) => {
      events.push("write");
      return ledger.writeSettlementReceipt(taskId, target, source);
    },
  };
  const ledger = new AttemptLedger(deps);
  return { ledger, state, events, eventLocks, inspect };
}

function begin(
  ledger: AttemptLedger,
  attemptId: string | undefined = ATTEMPT,
  receiptEligible = true
): OwnedTaskAttempt {
  return ledger.beginOwnedTaskAttempt(TASK, "test", { attemptId, receiptEligible });
}

describe("AttemptLedger", () => {
  describe("attempt identity", () => {
    test("a new attempt replaces the owner, bumps its generation and drops the stream-end decisions", () => {
      const { ledger, events } = createHarness();
      const first = begin(ledger, ATTEMPT);
      const second = begin(ledger, OTHER);

      expect(first.generation).toBe(1);
      expect(second.generation).toBe(2);
      expect(ledger.ownedAttempt(TASK)).toBe(second);
      expect(ledger.currentAttemptIdByTaskId.get(TASK)).toBe(OTHER);
      expect(events).toEqual([`discardStreamEnds:${TASK}`, `discardStreamEnds:${TASK}`]);
    });

    test("a closure for the new id survives the begin; another attempt's closure is dropped", () => {
      const { ledger } = createHarness();
      ledger.closeAttemptAdmission(TASK, OTHER, undefined, "early-close");
      begin(ledger, OTHER);
      expect(ledger.isAttemptClosed(TASK, OTHER)).toBe(true);

      begin(ledger, ATTEMPT);
      expect(ledger.attemptSettlement(TASK)).toBeUndefined();
    });

    test("publishing a rotation keeps only a closure that names the new id", () => {
      const { ledger } = createHarness();
      ledger.closeAttemptAdmission(TASK, OTHER, undefined, "early-close");
      ledger.publishAttemptRotation(TASK, OTHER);
      expect(ledger.isAttemptClosed(TASK, OTHER)).toBe(true);

      ledger.publishAttemptRotation(TASK, ATTEMPT);
      expect(ledger.attemptSettlement(TASK)).toBeUndefined();
      expect(ledger.currentAttemptIdByTaskId.get(TASK)).toBe(ATTEMPT);
    });

    test("releasing a reported attempt drops only that attempt's entries", () => {
      const { ledger } = createHarness();
      const stale = begin(ledger, ATTEMPT);
      const current = begin(ledger, OTHER);
      ledger.settleOwnedTaskAttempt(TASK, current, "settled");

      ledger.releaseReportedTaskAttempt(TASK, stale);
      expect(ledger.ownedAttempt(TASK)).toBe(current);

      ledger.releaseReportedTaskAttempt(TASK, current);
      expect(ledger.hasOwnedAttempt(TASK)).toBe(false);
      expect(ledger.attemptSettlement(TASK)).toBeUndefined();
    });
  });

  describe("attempt identity guards", () => {
    test("an empty task id or a malformed attempt id is refused; a pre-identity owner is not", () => {
      const { ledger } = createHarness();
      const begin1 = (taskId: string, attemptId: string | undefined) =>
        ledger.beginOwnedTaskAttempt(taskId, "test", { attemptId, receiptEligible: false });
      expect(() => begin1("", ATTEMPT)).toThrow();
      expect(() => begin1(TASK, "not-an-attempt-id")).toThrow();
      expect(begin1("t", undefined).attemptId).toBeUndefined();
      expect(ledger.currentAttemptIdByTaskId.has("t")).toBe(false);
    });

    test("the reservation's abort signal rides only with the attempt it was given to", () => {
      const { ledger } = createHarness();
      const signal = new AbortController().signal;
      const reserved = ledger.beginOwnedTaskAttempt(TASK, "test", {
        attemptId: ATTEMPT,
        receiptEligible: true,
        abortSignal: signal,
      });
      expect(reserved.abortSignal).toBe(signal);
      expect("abortSignal" in begin(ledger, OTHER)).toBe(false);
    });

    test("entries that are absent are no-ops for release, rotation and the closure wait", async () => {
      const { ledger } = createHarness();
      const owned = begin(ledger, ATTEMPT);
      ledger.publishAttemptRotation(TASK, ATTEMPT);
      ledger.releaseReportedTaskAttempt(TASK, owned);
      expect(ledger.hasOwnedAttempt(TASK)).toBe(false);
      await ledger.waitForAttemptClosureToSettle(TASK, 10_000);
      expect(ledger.attemptSettlementListenersByTaskId.has(TASK)).toBe(false);
    });
  });

  describe("closure and settlement", () => {
    test("closing records the owner only when it holds that id, and notifies once per new closure", () => {
      const { ledger, events } = createHarness();
      const owned = begin(ledger, ATTEMPT);
      events.length = 0;

      ledger.closeAttemptAdmission(TASK, OTHER, owned, "other");
      expect(ledger.attemptSettlement(TASK)).toEqual({
        attemptId: OTHER,
        phase: "closing",
        source: "other",
      });
      ledger.closeAttemptAdmission(TASK, ATTEMPT, owned, "mine");
      expect(ledger.attemptSettlement(TASK)?.attempt).toBe(owned);
      // Already closed for this id: no replacement, no second notification.
      ledger.closeAttemptAdmission(TASK, ATTEMPT, undefined, "again");
      expect(ledger.attemptSettlement(TASK)?.source).toBe("mine");
      expect(events).toEqual(["notify", "notify"]);
    });

    test("closing unless another attempt is closed keeps that other closure", () => {
      const { ledger } = createHarness();
      ledger.closeAttemptAdmission(TASK, OTHER, undefined, "other");
      ledger.closeAttemptAdmissionUnlessOtherClosed(TASK, ATTEMPT, undefined, "mine");
      expect(ledger.attemptSettlement(TASK)?.attemptId).toBe(OTHER);
    });

    test("only the current owner settles; every settlement notifies", () => {
      const { ledger, events } = createHarness();
      const stale = begin(ledger, ATTEMPT);
      const current = begin(ledger, OTHER);
      events.length = 0;

      ledger.settleOwnedTaskAttempt(TASK, stale, "stale");
      expect(ledger.attemptSettlement(TASK)).toBeUndefined();
      ledger.settleOwnedTaskAttempt(TASK, current, "current");
      expect(ledger.attemptSettlement(TASK)).toEqual({
        attemptId: OTHER,
        attempt: current,
        phase: "settled",
        source: "current",
      });
      expect(events).toEqual(["notify", "notify"]);
      // An unowned settlement is only announced.
      ledger.settleOwnedTaskAttempt(TASK, undefined, "unowned");
      expect(events).toEqual(["notify", "notify", "notify"]);
    });

    test("notification iterates a copy, so a listener removing another still lets it run", () => {
      const { ledger } = createHarness();
      const calls: string[] = [];
      const second = () => calls.push("second");
      const first = () => {
        calls.push("first");
        ledger.removeAttemptSettlementListener(TASK, second);
      };
      ledger.addAttemptSettlementListener(TASK, first);
      ledger.addAttemptSettlementListener(TASK, second);

      ledger.notifyAttemptSettlementListeners(TASK);
      expect(calls).toEqual(["first", "second"]);
      ledger.removeAttemptSettlementListener(TASK, first);
      expect(ledger.attemptSettlementListenersByTaskId.has(TASK)).toBe(false);
    });
  });

  describe("no-report boundary", () => {
    function closedOwner() {
      const harness = createHarness();
      const owned = begin(harness.ledger, ATTEMPT) as OwnedTaskAttempt & { attemptId: string };
      harness.ledger.closeAttemptAdmission(TASK, ATTEMPT, owned, "closed");
      return { ...harness, owned };
    }

    test("an open attempt can still report unless a stop record latched it", () => {
      const { ledger, state } = createHarness();
      const owned = begin(ledger, ATTEMPT) as OwnedTaskAttempt & { attemptId: string };
      expect(ledger.attemptCannotStillReport(TASK, owned)).toBe(false);
      state.stopRecordAttemptId = ATTEMPT;
      expect(ledger.attemptCannotStillReport(TASK, owned)).toBe(true);
    });

    test("an obligation of this attempt blocks; a successor's does not", () => {
      const { ledger, state, owned } = closedOwner();
      state.sends.add(send(OTHER));
      expect(ledger.attemptCannotStillReport(TASK, owned)).toBe(true);
      state.sends.add(send(ATTEMPT));
      expect(ledger.attemptCannotStillReport(TASK, owned)).toBe(false);
    });

    test.each(["turn", "registration", "stream"] as const)("a live %s blocks", (live) => {
      const { ledger, state, owned } = closedOwner();
      if (live === "turn") state.activeTurn = Symbol("turn");
      if (live === "registration") state.liveRegistration = {};
      if (live === "stream") state.streaming = true;
      expect(ledger.attemptCannotStillReport(TASK, owned)).toBe(false);
    });

    test.each([
      ["nonreport", true],
      ["pending", false],
      ["published", false],
      ["indeterminate", false],
    ] as const)("a %s stream-end decision gives %p", (outcome, expected) => {
      const { ledger, state, owned } = closedOwner();
      const decision: StreamEndDecision = {
        attempt: undefined,
        attemptId: ATTEMPT,
        messageId: "msg-1",
        outcome,
        turn: undefined,
      };
      state.streamEnd = decision;
      expect(ledger.attemptCannotStillReport(TASK, owned)).toBe(expected);
    });
  });

  describe("settlement receipts", () => {
    let sessionsDir: string;
    beforeEach(async () => {
      sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "attempt-ledger-"));
    });
    afterEach(async () => {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    });

    function eligibleOwner() {
      const harness = createHarness();
      harness.state.sessionsDir = sessionsDir;
      const owned = begin(harness.ledger, ATTEMPT);
      harness.state.stopRecordAttemptId = ATTEMPT;
      harness.events.length = 0;
      return { ...harness, owned };
    }

    async function hasReceipt(ownerId: string): Promise<boolean> {
      const read = await readSubagentAttemptSettlementReceiptStrict(
        path.join(sessionsDir, ownerId),
        TASK,
        ATTEMPT
      );
      return read.kind === "found";
    }

    test("no receipt authority settles in memory only and closes nothing", () => {
      const { ledger, events } = createHarness();
      const owned = begin(ledger, ATTEMPT, false);
      events.length = 0;
      expect(ledger.decideSettlementReceipt(TASK, owned, "src")).toEqual({ kind: "memory-only" });
      expect(ledger.decideSettlementReceipt(TASK, undefined, "src")).toEqual({
        kind: "memory-only",
      });
      expect(events).toEqual([]);
    });

    test("a row naming the attempt closes it in the deciding call, before any await", () => {
      const { ledger, events, owned } = eligibleOwner();
      const decision: SettlementReceiptDecision = ledger.decideSettlementReceipt(
        TASK,
        owned,
        "src"
      );
      expect(decision).toEqual({
        kind: "write",
        attemptId: ATTEMPT,
        parentWorkspaceId: PARENT,
        owners: [PARENT, ROOT],
      });
      // Synchronous: the closure is in place as the decision returns.
      expect(events).toEqual([`close:${ATTEMPT}`, "notify"]);
      expect(ledger.attemptSettlement(TASK)?.attempt).toBe(owned);
    });

    test("a row naming another attempt gives memory-only and closes nothing", () => {
      const { ledger, events, state, owned } = eligibleOwner();
      state.config = configWithRow({ parentWorkspaceId: PARENT, taskAttemptId: OTHER });
      expect(ledger.decideSettlementReceipt(TASK, owned, "src")).toEqual({ kind: "memory-only" });
      expect(events).toEqual([]);
    });

    test("an unreadable config closes the attempt but keeps another attempt's closure", () => {
      const { ledger, events, state, owned } = eligibleOwner();
      state.config = new Error("EIO");
      expect(ledger.decideSettlementReceipt(TASK, owned, "src")).toEqual({ kind: "unreadable" });
      expect(events).toEqual([`close:${ATTEMPT}`, "notify"]);

      ledger.closeAttemptAdmission(TASK, OTHER, undefined, "other");
      events.length = 0;
      expect(ledger.decideSettlementReceipt(TASK, owned, "src")).toEqual({ kind: "unreadable" });
      expect(events).toEqual([]);
      expect(ledger.attemptSettlement(TASK)?.attemptId).toBe(OTHER);
    });

    test.each(["missing", "parentless"] as const)(
      "a %s row gives memory-only and closes nothing",
      (variant) => {
        const { ledger, events, state, owned } = eligibleOwner();
        state.config = configWithRow(
          variant === "missing" ? undefined : { taskAttemptId: ATTEMPT }
        );
        expect(ledger.decideSettlementReceipt(TASK, owned, "src")).toEqual({ kind: "memory-only" });
        expect(events).toEqual([]);
      }
    );

    test("inconsistent ancestry reads as unreadable", () => {
      const { ledger, state, owned } = eligibleOwner();
      state.owners = [ROOT];
      expect(ledger.decideSettlementReceipt(TASK, owned, "src")).toEqual({ kind: "unreadable" });
    });

    test("the receipt reaches every owner, the parent last; a failure stops before the parent", async () => {
      const { ledger } = eligibleOwner();
      const target = { attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [PARENT, "mid"] };
      // The outer owner's session dir is a file: its write, the first, fails.
      await fs.writeFile(path.join(sessionsDir, "mid"), "not a dir");
      expect(await ledger.writeSettlementReceipt(TASK, target, "idle-settled")).toBe(false);
      expect(await hasReceipt(PARENT)).toBe(false);

      const ok = { attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [PARENT, ROOT] };
      expect(await ledger.writeSettlementReceipt(TASK, ok, "idle-settled")).toBe(true);
      expect(await hasReceipt(ROOT)).toBe(true);
      expect(await hasReceipt(PARENT)).toBe(true);
    });

    test("persisting writes the receipt before settling", async () => {
      const { ledger, events, owned } = eligibleOwner();
      await ledger.persistOwnedAttemptSettlement(TASK, owned, "idle-settled", "stop");
      expect(events).toEqual(["decide", `close:${ATTEMPT}`, "notify", "write", "settle", "notify"]);
      expect(ledger.attemptSettlement(TASK)?.phase).toBe("settled");
    });

    test.each(["unreadable", "write failed"] as const)(
      "persisting leaves the attempt closing when %s",
      async (variant) => {
        const { ledger, events, state, owned } = eligibleOwner();
        if (variant === "unreadable") state.config = new Error("EIO");
        if (variant === "write failed") {
          await fs.writeFile(path.join(sessionsDir, ROOT), "not a dir");
        }
        await ledger.persistOwnedAttemptSettlement(TASK, owned, "idle-settled", "stop");
        expect(events).not.toContain("settle");
        expect(ledger.attemptSettlement(TASK)?.phase).toBe("closing");
      }
    );

    test("persisting without receipt authority settles in memory", async () => {
      const { ledger, events } = createHarness();
      const owned = begin(ledger, ATTEMPT, false);
      events.length = 0;
      await ledger.persistOwnedAttemptSettlement(TASK, owned, "idle-settled", "stop");
      expect(events).toEqual(["decide", "settle", "notify"]);
    });
  });

  describe("resume-failure settlement", () => {
    function failedResume() {
      const harness = createHarness();
      const owned = begin(harness.ledger, ATTEMPT, false) as OwnedTaskAttempt & {
        attemptId: string;
      };
      harness.ledger.closeAttemptAdmission(TASK, ATTEMPT, owned, "resume-failed");
      harness.ledger.recordResumeFailureSettlement(TASK, owned);
      harness.events.length = 0;
      return { ...harness, owned };
    }

    test("a superseded attempt is dropped without settling", () => {
      const { ledger, events } = failedResume();
      begin(ledger, OTHER);
      events.length = 0;
      ledger.recheckResumeFailureSettlement(TASK);
      expect(ledger.resumeFailureSettlementByTaskId.has(TASK)).toBe(false);
      expect(events).toEqual([]);
    });

    test("a closure that no longer holds this owner's closing entry drops it without settling", () => {
      const variants = [
        // A new owner under the same id: the closure still names the old owner.
        (ledger: AttemptLedger) => begin(ledger, ATTEMPT),
        // The closure was dropped by a rotation.
        (ledger: AttemptLedger) => ledger.publishAttemptRotation(TASK, OTHER),
        // Another attempt was closed after the rotation.
        (ledger: AttemptLedger) => {
          ledger.publishAttemptRotation(TASK, OTHER);
          ledger.closeAttemptAdmission(TASK, OTHER, undefined, "other");
        },
      ];
      for (const change of variants) {
        const { ledger, events } = failedResume();
        change(ledger);
        events.length = 0;
        ledger.recheckResumeFailureSettlement(TASK);
        expect(ledger.resumeFailureSettlementByTaskId.has(TASK)).toBe(false);
        expect(events).not.toContain("settle");
      }
    });

    test("an in-progress stop or a live obligation defers; the boundary settles", async () => {
      const { ledger, events, state } = failedResume();
      state.hasStopRecord = true;
      ledger.recheckResumeFailureSettlement(TASK);
      state.hasStopRecord = false;
      state.sends.add(send(ATTEMPT));
      ledger.recheckResumeFailureSettlement(TASK);
      expect(ledger.resumeFailureSettlementByTaskId.has(TASK)).toBe(true);
      expect(events).toEqual([]);

      state.sends.clear();
      ledger.recheckResumeFailureSettlement(TASK);
      expect(ledger.resumeFailureSettlementByTaskId.has(TASK)).toBe(false);
      await Promise.resolve();
      expect(events).toEqual(["decide", "settle", "notify"]);
      expect(ledger.attemptSettlement(TASK)?.phase).toBe("settled");
    });
  });

  describe("waits", () => {
    test("the closure wait resolves on the notification that settles it and unsubscribes", async () => {
      const { ledger } = createHarness();
      const owned = begin(ledger, ATTEMPT);
      ledger.closeAttemptAdmission(TASK, ATTEMPT, owned, "closing");
      const waiting = ledger.waitForAttemptClosureToSettle(TASK, 10_000);
      expect(ledger.attemptSettlementListenersByTaskId.get(TASK)?.size).toBe(1);

      ledger.settleOwnedTaskAttempt(TASK, owned, "settled");
      await waiting;
      expect(ledger.attemptSettlementListenersByTaskId.has(TASK)).toBe(false);
    });

    test("the settlement wait subscribes before its first read and re-reads on notification", async () => {
      const { ledger, state, inspect } = createHarness();
      state.outcomes.push({ kind: "live", executionId: TASK });
      state.outcomes.push({ kind: "terminal-no-report" });
      let subscribedAtFirstRead: number | undefined;
      inspect.mockImplementationOnce(() => {
        subscribedAtFirstRead = ledger.attemptSettlementListenersByTaskId.get(TASK)?.size;
        return Promise.resolve(state.outcomes.shift()!);
      });

      const waiting = ledger.waitForAttemptSettlement(TASK, { timeoutMs: 10_000 });
      while (inspect.mock.calls.length < 1) await Promise.resolve();
      await Promise.resolve();
      ledger.notifyAttemptSettlementListeners(TASK);

      expect(await waiting).toEqual({ kind: "terminal-no-report" });
      expect(subscribedAtFirstRead).toBe(1);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(ledger.attemptSettlementListenersByTaskId.has(TASK)).toBe(false);
    });

    test("a held event lock bounds the settlement wait; the abandoned read never runs", async () => {
      const { ledger, eventLocks, inspect } = createHarness();
      const gate = Promise.withResolvers<void>();
      const holding = eventLocks.withLock(TASK, () => gate.promise);

      expect(await ledger.waitForAttemptSettlement(TASK, { timeoutMs: 20 })).toEqual({
        kind: "timeout",
      });
      const abort = new AbortController();
      const aborted = ledger.waitForAttemptSettlement(TASK, {
        timeoutMs: 10_000,
        abortSignal: abort.signal,
      });
      abort.abort();
      await expect(aborted).rejects.toThrow("Interrupted");

      gate.resolve();
      await holding;
      await eventLocks.withLock(TASK, () => Promise.resolve());
      expect(inspect).not.toHaveBeenCalled();
      expect(ledger.attemptSettlementListenersByTaskId.has(TASK)).toBe(false);
    });

    test("the closure wait gives up at its bound", async () => {
      const { ledger } = createHarness();
      ledger.closeAttemptAdmission(TASK, ATTEMPT, undefined, "closing");
      await ledger.waitForAttemptClosureToSettle(TASK, 20);
      expect(ledger.attemptSettlement(TASK)?.phase).toBe("closing");
      expect(ledger.attemptSettlementListenersByTaskId.has(TASK)).toBe(false);
    });

    test("an empty task id or an invalid bound is refused", async () => {
      const { ledger } = createHarness();
      await expect(ledger.waitForAttemptSettlement("", { timeoutMs: 10 })).rejects.toThrow();
      await expect(ledger.waitForAttemptSettlement(TASK, { timeoutMs: 0 })).rejects.toThrow();
      await expect(ledger.waitForAttemptSettlement(TASK, { timeoutMs: NaN })).rejects.toThrow();
      // The smallest valid inputs: a one-character id and a 1 ms bound.
      expect(await ledger.waitForAttemptSettlement("t", { timeoutMs: 1 })).toEqual({
        kind: "timeout",
      });
    });

    test("a read that entered the lock completes past the bound, and its error propagates", async () => {
      const { ledger, inspect } = createHarness();
      inspect.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { kind: "indeterminate", reason: "slow" };
      });
      expect(await ledger.waitForAttemptSettlement(TASK, { timeoutMs: 10 })).toEqual({
        kind: "indeterminate",
        reason: "slow",
      });

      inspect.mockImplementationOnce(() => Promise.reject(new Error("read failed")));
      await expect(ledger.waitForAttemptSettlement(TASK, { timeoutMs: 10_000 })).rejects.toThrow(
        "read failed"
      );
      expect(ledger.attemptSettlementListenersByTaskId.has(TASK)).toBe(false);
    });

    test("an already-aborted wait rejects without reading", async () => {
      const { ledger, inspect } = createHarness();
      const abort = new AbortController();
      abort.abort();
      await expect(
        ledger.waitForAttemptSettlement(TASK, { timeoutMs: 10_000, abortSignal: abort.signal })
      ).rejects.toThrow("Interrupted");
      expect(inspect).not.toHaveBeenCalled();
    });

    test("an indeterminate outcome returns at once", async () => {
      const { ledger, state, inspect } = createHarness();
      state.outcomes.push({ kind: "indeterminate", reason: "unknown owner" });
      expect(await ledger.waitForAttemptSettlement(TASK, { timeoutMs: 10_000 })).toEqual({
        kind: "indeterminate",
        reason: "unknown owner",
      });
      expect(inspect).toHaveBeenCalledTimes(1);
    });
  });
});
