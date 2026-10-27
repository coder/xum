/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE } from "@/constants/agentMessaging";
import { Ok } from "@/common/types/result";
import type { TaskAttemptOutcome } from "@/common/types/tasks";
import type { ProjectsConfig, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AgentTaskIndex } from "@/node/services/agentTaskIndex";
import { AttemptLedger, type AttemptLedgerDeps } from "@/node/services/attemptLedger";
import { readSubagentAttemptSettlementReceiptStrict } from "@/node/services/subagentAttemptSettlements";
import type {
  AdmittedSend,
  AgentTaskReport,
  OwnedTaskAttempt,
  SettlementReceiptDecision,
  StreamEndDecision,
  WorkspaceStopRecord,
} from "@/node/services/taskService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isTaskAttemptId } from "@/node/utils/taskAttemptId";

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
  return configWithRows(row == null ? [] : [{ id: TASK, ...row }]);
}

function configWithRows(workspaces: Array<Record<string, unknown>>): ProjectsConfig {
  return { projects: new Map([["/project", { workspaces }]]) } as unknown as ProjectsConfig;
}

interface HarnessState {
  config: ProjectsConfig | Error;
  sessionsDir: string;
  stopRecordAttemptId: string | undefined;
  hasStopRecord: boolean;
  activeTurn: symbol | undefined;
  liveRegistration: unknown;
  streaming: boolean;
  streamEnd: StreamEndDecision | undefined;
  owners: string[];
  outcomes: Array<TaskAttemptOutcome<AgentTaskReport>>;
  stopInProgress: boolean;
  currentStopRecord: WorkspaceStopRecord | undefined;
  /** Config reads (lenient and strict) per call; the next one wins when set. */
  nextConfigs: Array<ProjectsConfig | Error>;
  /** Config edits throw this. */
  editError: Error | undefined;
  /** Config edits run on a copy that is never saved (a write that failed silently). */
  dropEdits: boolean;
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
    activeTurn: undefined,
    liveRegistration: undefined,
    streaming: false,
    streamEnd: undefined,
    owners: [PARENT, ROOT],
    outcomes: [],
    stopInProgress: false,
    currentStopRecord: undefined,
    nextConfigs: [],
    editError: undefined,
    dropEdits: false,
  };
  /** Like Config.editConfig: the edit applies to the stored config, unless it fails. */
  const editConfig = (fn: (config: ProjectsConfig) => ProjectsConfig): Promise<void> => {
    if (state.editError != null) return Promise.reject(state.editError);
    if (state.config instanceof Error) return Promise.reject(state.config);
    const edited = fn(state.dropEdits ? structuredClone(state.config) : state.config);
    if (!state.dropEdits) state.config = edited;
    return Promise.resolve();
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
        const next = state.nextConfigs.shift();
        if (next != null) state.config = next;
        if (!(state.config instanceof Error)) return state.config;
        if (options?.throwOnError === true) throw state.config;
        return configWithRow(undefined);
      },
      sessionsDir: state.sessionsDir,
      editConfig,
    }),
    aiService: () => ({
      isStreaming: () => state.streaming,
      stopStream: (taskId, options) => {
        events.push(`stopStream:${taskId}:abandonPartial=${String(options?.abandonPartial)}`);
        return Promise.resolve(Ok(undefined));
      },
    }),
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
    isWorkspaceStopInProgress: () => state.stopInProgress,
    isCurrentStopRecord: (_workspaceId, record) => state.currentStopRecord === record,
    recheckWorkspaceStopRelease: (workspaceId) => events.push(`recheckStop:${workspaceId}`),
    // Like TaskService.currentTaskAttemptId: the entry, else a lenient read of the row.
    currentTaskAttemptId: (taskId, entry) => {
      const id =
        entry?.taskAttemptId ??
        findWorkspaceEntry(deps.config().loadConfigOrDefault(), taskId)?.workspace.taskAttemptId;
      return isTaskAttemptId(id) ? id : undefined;
    },
    // Like TaskService.editWorkspaceEntry: the updater runs on the row inside one config edit.
    editWorkspaceEntry: async (workspaceId, updater) => {
      let found = false;
      await editConfig((config) => {
        const row = findWorkspaceEntry(config, workspaceId)?.workspace;
        if (row != null) {
          updater(row, config);
          found = true;
        }
        return config;
      });
      return found;
    },
    settleChildGoalPause: (workspaceId) => {
      events.push(`settleGoalPause:${workspaceId}`);
      return Promise.resolve();
    },
    findStreamEndDecision: () => state.streamEnd,
    pruneStreamEndDecisions: (taskId) => events.push(`prune:${taskId}`),
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
      const { ledger, owned } = closedOwner();
      const sends = new Set([send(OTHER)]);
      ledger.admittedSendsByTaskId.set(TASK, sends);
      expect(ledger.attemptCannotStillReport(TASK, owned)).toBe(true);
      sends.add(send(ATTEMPT));
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
      ledger.admittedSendsByTaskId.set(TASK, new Set([send(ATTEMPT)]));
      ledger.recheckResumeFailureSettlement(TASK);
      expect(ledger.resumeFailureSettlementByTaskId.has(TASK)).toBe(true);
      expect(events).toEqual([]);

      ledger.admittedSendsByTaskId.delete(TASK);
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

  describe("send admission", () => {
    function admit(ledger: AttemptLedger, expectedAttemptId?: string) {
      const admission = ledger.admitTaskWorkspaceTurn(TASK, {
        acceptanceOrigin: "automatic",
        ...(expectedAttemptId != null ? { expectedAttemptId } : {}),
      });
      if (admission.kind !== "admitted") throw new Error(`not admitted: ${admission.kind}`);
      return admission.token;
    }

    function onlySend(ledger: AttemptLedger): AdmittedSend {
      const sends = [...ledger.sendsOf(TASK)];
      expect(sends).toHaveLength(1);
      return sends[0];
    }

    /** A stop record that captured `captured` while it was pending (by reference). */
    function capture(captured: AdmittedSend): WorkspaceStopRecord {
      const record = {
        pendingAdmissions: new Set([captured]),
        capturedTurns: new Set<symbol>(),
        cleanupInFlight: 0,
      } as unknown as WorkspaceStopRecord;
      captured.capturedBy.add(record);
      return record;
    }

    test("an admitted send is the object the task's set holds; it is owned only under the owner's id", () => {
      const { ledger } = createHarness();
      begin(ledger, OTHER);
      const unownedToken = admit(ledger);
      const unowned = onlySend(ledger);
      expect(unowned.token).toBe(unownedToken);
      expect(unowned.attemptId).toBe(ATTEMPT);
      expect(unowned.attempt).toBeUndefined();
      expect(ledger.sendsOf(TASK)).toBe(ledger.admittedSendsByTaskId.get(TASK)!);

      const owner = begin(ledger, ATTEMPT);
      admit(ledger, ATTEMPT);
      const [, owned] = [...ledger.sendsOf(TASK)];
      expect(owned.attempt).toBe(owner);
    });

    test("an empty workspace id is refused; any other id is classified", () => {
      const { ledger } = createHarness();
      expect(() => ledger.admitTaskWorkspaceTurn("", { acceptanceOrigin: "manual" })).toThrow();
      expect(ledger.admitTaskWorkspaceTurn("t", { acceptanceOrigin: "manual" })).toEqual({
        kind: "not-a-task",
      });
    });

    test("refusals and non-task sends register no obligation", () => {
      const cases: Array<{
        name: string;
        arrange: (h: ReturnType<typeof createHarness>) => void;
        expectedAttemptId?: string;
        kind: "refused" | "not-a-task";
      }> = [
        {
          name: "unreadable",
          arrange: (h) => (h.state.config = new Error("EIO")),
          kind: "refused",
        },
        {
          name: "row gone for a decided send",
          arrange: (h) => (h.state.config = configWithRow(undefined)),
          expectedAttemptId: ATTEMPT,
          kind: "refused",
        },
        {
          name: "no row for an ordinary send",
          arrange: (h) => (h.state.config = configWithRow(undefined)),
          kind: "not-a-task",
        },
        {
          name: "no parent",
          arrange: (h) => (h.state.config = configWithRow({ taskAttemptId: ATTEMPT })),
          kind: "not-a-task",
        },
        {
          name: "retired",
          arrange: (h) =>
            (h.state.config = configWithRow({
              parentWorkspaceId: PARENT,
              taskAttemptId: ATTEMPT,
              taskAttemptRetiredBy: { runId: "run", stepId: "step" },
            })),
          kind: "refused",
        },
        {
          name: "pre-identity",
          arrange: (h) => (h.state.config = configWithRow({ parentWorkspaceId: PARENT })),
          kind: "not-a-task",
        },
        { name: "superseded", arrange: () => undefined, expectedAttemptId: OTHER, kind: "refused" },
        { name: "stopping", arrange: (h) => (h.state.stopInProgress = true), kind: "refused" },
        {
          name: "closed",
          arrange: (h) => h.ledger.closeAttemptAdmission(TASK, ATTEMPT, undefined, "closed"),
          kind: "refused",
        },
      ];
      for (const c of cases) {
        const harness = createHarness();
        c.arrange(harness);
        const admission = harness.ledger.admitTaskWorkspaceTurn(TASK, {
          acceptanceOrigin: "manual",
          ...(c.expectedAttemptId != null ? { expectedAttemptId: c.expectedAttemptId } : {}),
        });
        expect({ name: c.name, kind: admission.kind }).toEqual({ name: c.name, kind: c.kind });
        expect(harness.ledger.sendsOf(TASK).size).toBe(0);
      }
    });

    test("disposal before admission discharges the send, then prunes, then rechecks only the current stop", () => {
      const { ledger, state, events } = createHarness();
      const token = admit(ledger);
      const pending = onlySend(ledger);
      const current = capture(pending);
      const replaced = capture(pending);
      state.currentStopRecord = current;

      token.onDisposed("refused");
      expect(pending.state).toBe("discharged");
      expect(ledger.admittedSendsByTaskId.has(TASK)).toBe(false);
      expect(current.pendingAdmissions.size).toBe(0);
      expect(replaced.pendingAdmissions.size).toBe(0);
      expect(pending.capturedBy.size).toBe(0);
      expect(events).toEqual([`prune:${TASK}`, `recheckStop:${TASK}`]);

      token.onDisposed("refused");
      ledger.dischargeAdmittedSend(pending);
      expect(events).toEqual([`prune:${TASK}`, `recheckStop:${TASK}`]);
    });

    test("the first admission binds the turn and owes each capturing stop one more stopStream", async () => {
      const { ledger, events } = createHarness();
      const token = admit(ledger);
      const pending = onlySend(ledger);
      const record = capture(pending);
      const turn = Symbol("turn");

      token.onAdmitted(turn);
      expect(pending.state).toBe("admitted");
      expect(pending.turnId).toBe(turn);
      expect(record.pendingAdmissions.has(pending)).toBe(false);
      expect(record.capturedTurns.has(turn)).toBe(true);
      expect(record.cleanupInFlight).toBe(1);
      expect(pending.capturedBy.size).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(record.cleanupInFlight).toBe(0);
      expect(events).toEqual([`stopStream:${TASK}:abandonPartial=false`, `recheckStop:${TASK}`]);

      // First admission wins; an admitted send belongs to its turn, not to a disposal.
      token.onAdmitted(Symbol("other"));
      token.onDisposed("no-work");
      expect(pending.turnId).toBe(turn);
      expect(pending.state).toBe("admitted");
      expect(token.admissionStale()).toBe(false);
    });

    test("a discharged send is never re-admitted", () => {
      const { ledger } = createHarness();
      const token = admit(ledger);
      const pending = onlySend(ledger);
      token.onDisposed("canceled-before-admission");
      token.onAdmitted(Symbol("late"));
      expect(pending.state).toBe("discharged");
      expect(pending.turnId).toBeUndefined();
      expect(token.admissionStale()).toBe(true);
    });

    test("staleness and the dequeue gate follow the attempt, its owner and its stream end", () => {
      const { ledger, state } = createHarness();
      begin(ledger, ATTEMPT);
      const token = admit(ledger);
      const decision = (outcome: StreamEndDecision["outcome"]): StreamEndDecision => ({
        attempt: undefined,
        attemptId: ATTEMPT,
        messageId: "msg-1",
        outcome,
        turn: undefined,
      });
      expect(token.admissionStale()).toBe(false);
      expect(token.resolveDispatch?.()).toBe("proceed");

      state.streamEnd = decision("pending");
      expect(token.admissionStale()).toBe(true);
      token.onEnqueued();
      // Enqueued: the queue's gate holds or refuses instead of the staleness probe.
      expect(token.admissionStale()).toBe(false);
      expect(token.resolveDispatch?.()).toBe("hold");
      state.streamEnd = decision("published");
      expect(token.resolveDispatch?.()).toEqual({
        refuse: TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE,
      });
      state.streamEnd = decision("nonreport");
      expect(token.resolveDispatch?.()).toBe("proceed");

      begin(ledger, ATTEMPT);
      expect(token.admissionStale()).toBe(true);
    });

    test("a pending send reads stale once its row rotates, a closure, a claim or a removal lands", () => {
      const row = { parentWorkspaceId: PARENT, taskAttemptId: ATTEMPT };
      const cases: Array<{ name: string; arrange: (h: ReturnType<typeof createHarness>) => void }> =
        [
          {
            name: "rotated",
            arrange: (h) => (h.state.config = configWithRow({ ...row, taskAttemptId: OTHER })),
          },
          {
            name: "closed",
            arrange: (h) => h.ledger.closeAttemptAdmission(TASK, ATTEMPT, undefined, "closed"),
          },
          {
            name: "retired",
            arrange: (h) =>
              (h.state.config = configWithRow({ ...row, taskAttemptRetiredBy: { runId: "run" } })),
          },
          {
            name: "removing",
            arrange: (h) =>
              (h.state.config = configWithRow({ ...row, pendingRemoval: { pid: 1 } })),
          },
        ];
      for (const c of cases) {
        const harness = createHarness();
        const token = admit(harness.ledger);
        expect({ name: c.name, stale: token.admissionStale() }).toEqual({
          name: c.name,
          stale: false,
        });
        c.arrange(harness);
        expect({ name: c.name, stale: token.admissionStale() }).toEqual({
          name: c.name,
          stale: true,
        });
      }
    });

    test("an admitted send is neither a pending admission nor a live reawakening once its turn ends", () => {
      const { ledger } = createHarness();
      admit(ledger).onAdmitted(Symbol("turn"));
      expect(ledger.hasPendingAdmissions(TASK)).toBe(false);
      expect(ledger.hasLiveReawakening(TASK)).toBe(false);
    });

    test("pending admissions and live reawakenings", () => {
      const { ledger, state } = createHarness();
      expect(ledger.hasLiveReawakening(TASK)).toBe(false);
      ledger.beginReawakening(TASK, ATTEMPT);
      expect(ledger.hasLiveReawakening(TASK)).toBe(true);
      ledger.endReawakening(TASK, OTHER);
      expect(ledger.hasLiveReawakening(TASK)).toBe(true);
      ledger.endReawakening(TASK, ATTEMPT);
      expect(ledger.hasLiveReawakening(TASK)).toBe(false);

      admit(ledger);
      expect(ledger.hasPendingAdmissions(TASK)).toBe(true);
      expect(ledger.hasLiveReawakening(TASK)).toBe(true);
      // A send that reads stale is no continuation to protect.
      state.stopInProgress = true;
      expect(ledger.hasLiveReawakening(TASK)).toBe(false);
      state.activeTurn = Symbol("turn");
      expect(ledger.hasLiveReawakening(TASK)).toBe(true);
      state.config = configWithRow({ parentWorkspaceId: PARENT, taskAttemptId: OTHER });
      expect(ledger.hasPendingAdmissions(TASK)).toBe(false);
    });

    test("a stream event belongs to the turn's direct admission before an inherited or owned one", () => {
      const { ledger, state } = createHarness();
      const owner = begin(ledger, OTHER);
      expect(ledger.resolveStreamAttemptAtEvent(TASK)).toEqual({
        ownedAttempt: owner,
        unownedAttemptId: undefined,
      });
      const turn = Symbol("turn");
      state.activeTurn = turn;
      const token = admit(ledger);
      token.onAdmitted(turn);
      expect(ledger.resolveStreamAttemptAtEvent(TASK)).toEqual({
        ownedAttempt: undefined,
        unownedAttemptId: ATTEMPT,
      });
    });

    test("an inherited obligation counts only when the turn has no direct admission", () => {
      const { ledger, state } = createHarness();
      const turn = Symbol("turn");
      state.activeTurn = turn;
      // Rebound from a superseded predecessor (recordWorkspaceTurnSuperseded) under OTHER.
      admit(ledger).onAdmitted(turn);
      const inherited = onlySend(ledger) as AdmittedSend & { attemptId: string };
      Object.assign(inherited, { attemptId: OTHER, inherited: true });
      expect(ledger.resolveStreamAttemptAtEvent(TASK).unownedAttemptId).toBe(OTHER);

      admit(ledger).onAdmitted(turn);
      expect(ledger.resolveStreamAttemptAtEvent(TASK).unownedAttemptId).toBe(ATTEMPT);
      // Another turn's admission says nothing about this one.
      state.activeTurn = Symbol("next");
      state.config = configWithRow({ parentWorkspaceId: PARENT, taskAttemptId: OTHER });
      expect(ledger.resolveStreamAttemptAtEvent(TASK).unownedAttemptId).toBe(OTHER);
    });
  });

  describe("lineage and unowned settlement proofs", () => {
    let sessionsDir: string;
    beforeEach(async () => {
      sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "attempt-ledger-proof-"));
    });
    afterEach(async () => {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    });

    const interruptedRow = (attemptId: string) =>
      configWithRow({
        parentWorkspaceId: PARENT,
        taskAttemptId: attemptId,
        taskStatus: "interrupted",
      });

    test("the owner's closing settlement is re-read after the closure wait", async () => {
      const { ledger } = createHarness();
      const owner = begin(ledger, ATTEMPT);
      ledger.closeAttemptAdmission(TASK, ATTEMPT, owner, "stopping");
      const entry: WorkspaceConfigEntry = {
        path: "/project/task",
        parentWorkspaceId: PARENT,
        taskAttemptId: ATTEMPT,
      };
      const lineage = ledger.evaluateAttemptLineage(TASK, entry);
      ledger.settleOwnedTaskAttempt(TASK, owner, "stopped");
      expect(await lineage).toEqual({
        proven: true,
        reason: "predecessor settled by this process",
      });
    });

    test("a receipt in the parent's dir proves the predecessor; one naming another parent does not", async () => {
      const { ledger, state } = createHarness();
      state.sessionsDir = sessionsDir;
      const entry: WorkspaceConfigEntry = {
        path: "/project/task",
        parentWorkspaceId: PARENT,
        taskAttemptId: ATTEMPT,
      };
      expect((await ledger.evaluateAttemptLineage(TASK, entry)).proven).toBe(false);
      const target = { attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [PARENT] };
      expect(await ledger.writeSettlementReceipt(TASK, target, "idle-settled")).toBe(true);
      expect((await ledger.evaluateAttemptLineage(TASK, entry)).proven).toBe(true);
      expect(
        (await ledger.evaluateAttemptLineage(TASK, { ...entry, parentWorkspaceId: ROOT })).proven
      ).toBe(false);
    });

    test("a receipt copy that names another parent proves nothing", async () => {
      const { ledger, state } = createHarness();
      state.sessionsDir = sessionsDir;
      // The parent's receipt fans out to ROOT's dir too, naming PARENT.
      const target = { attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [PARENT, ROOT] };
      expect(await ledger.writeSettlementReceipt(TASK, target, "idle-settled")).toBe(true);
      const entry: WorkspaceConfigEntry = {
        path: "/project/task",
        parentWorkspaceId: ROOT,
        taskAttemptId: ATTEMPT,
      };
      expect(await ledger.evaluateAttemptLineage(TASK, entry)).toEqual({
        proven: false,
        reason: `settlement receipt names parent ${PARENT}, expected ${ROOT}`,
      });
      state.config = configWithRow({
        parentWorkspaceId: ROOT,
        taskAttemptId: ATTEMPT,
        taskStatus: "interrupted",
      });
      expect(await ledger.readUnownedSettlementProof(TASK)).toEqual({
        kind: "unproven",
        reason: `settlement receipt names parent ${PARENT}`,
      });
    });

    test("no id, marked lineage, an ineligible owner or no parent is unproven even with a receipt", async () => {
      const { ledger, state } = createHarness();
      state.sessionsDir = sessionsDir;
      const target = { attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [PARENT] };
      expect(await ledger.writeSettlementReceipt(TASK, target, "idle-settled")).toBe(true);
      const entry: WorkspaceConfigEntry = {
        path: "/project/task",
        parentWorkspaceId: PARENT,
        taskAttemptId: ATTEMPT,
      };
      const unprovenEntries: WorkspaceConfigEntry[] = [
        { ...entry, taskAttemptId: undefined },
        { ...entry, taskAttemptUnproven: true },
        { ...entry, parentWorkspaceId: undefined },
      ];
      for (const unproven of unprovenEntries) {
        expect(await ledger.evaluateAttemptLineage(TASK, unproven)).toMatchObject({
          proven: false,
        });
      }
      begin(ledger, ATTEMPT, false);
      expect(await ledger.evaluateAttemptLineage(TASK, entry)).toEqual({
        proven: false,
        reason: "predecessor owned but not receipt-eligible",
      });
    });

    test("an unowned proof needs the receipt and the same row before and after reading it", async () => {
      const { ledger, state } = createHarness();
      state.sessionsDir = sessionsDir;
      state.config = interruptedRow(ATTEMPT);
      expect(await ledger.readUnownedSettlementProof(TASK)).toMatchObject({ kind: "unproven" });
      const target = { attemptId: ATTEMPT, parentWorkspaceId: PARENT, owners: [PARENT] };
      expect(await ledger.writeSettlementReceipt(TASK, target, "idle-settled")).toBe(true);
      expect(await ledger.readUnownedSettlementProof(TASK)).toEqual({
        kind: "proven",
        attemptId: ATTEMPT,
      });

      // Another writer admitted, re-ran or marked the attempt while the receipt was read.
      const changed = { parentWorkspaceId: PARENT, taskAttemptId: ATTEMPT };
      for (const latest of [
        interruptedRow(OTHER),
        configWithRow({ ...changed, taskStatus: "running" }),
        configWithRow({ ...changed, taskStatus: "interrupted", taskAttemptUnproven: true }),
      ]) {
        state.nextConfigs = [interruptedRow(ATTEMPT), latest];
        expect(await ledger.readUnownedSettlementProof(TASK)).toEqual({
          kind: "unproven",
          reason: "the attempt changed while its receipt was read",
        });
      }
      // A strict re-read that fails is no evidence (never the lenient empty view).
      state.nextConfigs = [interruptedRow(ATTEMPT), new Error("EIO")];
      expect(await ledger.readUnownedSettlementProof(TASK)).toEqual({
        kind: "unproven",
        reason: "config unreadable: EIO",
      });
    });
  });

  describe("workflow claims", () => {
    const CLAIMANT = { runId: "run", stepId: "step", inputHash: "hash" };
    const claimableRow = () => ({
      parentWorkspaceId: PARENT,
      taskAttemptId: ATTEMPT,
      taskStatus: "interrupted",
      workflowTask: { runId: CLAIMANT.runId, stepId: CLAIMANT.stepId },
    });
    const rowOf = (state: HarnessState, id = TASK) =>
      findWorkspaceEntry(state.config as ProjectsConfig, id)?.workspace;

    test("a granted claim retires the attempt, is confirmed, and then settles the goal pause", async () => {
      const { ledger, state, events } = createHarness();
      state.config = configWithRow(claimableRow());
      const claim = await ledger.claimRetiredAttempt(TASK, ATTEMPT, CLAIMANT);
      if (!claim.success) throw new Error(claim.error);
      expect(rowOf(state)?.taskAttemptRetiredBy).toMatchObject({
        runId: CLAIMANT.runId,
        attemptId: ATTEMPT,
        nonce: claim.data.nonce,
      });
      expect(events).toEqual([`settleGoalPause:${TASK}`]);

      // The same step re-stamps with a fresh nonce.
      const again = await ledger.claimRetiredAttempt(TASK, ATTEMPT, CLAIMANT);
      if (!again.success) throw new Error(again.error);
      expect(again.data.nonce).not.toBe(claim.data.nonce);
    });

    test("a live attempt, a refused row, a failed or lost write and an unconfirmed claim refuse", async () => {
      const cases: Array<{ name: string; arrange: (h: ReturnType<typeof createHarness>) => void }> =
        [
          { name: "attempt is live", arrange: (h) => (h.state.activeTurn = Symbol("turn")) },
          { name: "attempt is live", arrange: (h) => (h.state.streaming = true) },
          { name: "attempt is live", arrange: (h) => (h.state.liveRegistration = {}) },
          { name: "attempt is live", arrange: (h) => (h.state.stopInProgress = true) },
          {
            name: "attempt is running",
            arrange: (h) =>
              (h.state.config = configWithRow({ ...claimableRow(), taskStatus: "running" })),
          },
          {
            name: "the task does not belong to this workflow step",
            arrange: (h) =>
              (h.state.config = configWithRow({
                ...claimableRow(),
                workflowTask: { runId: CLAIMANT.runId, stepId: "other-step" },
              })),
          },
          {
            name: "the retired attempt already has replacement",
            arrange: (h) =>
              (h.state.config = configWithRow({
                ...claimableRow(),
                taskAttemptRetiredBy: { ...CLAIMANT, attemptId: ATTEMPT, replacementTaskId: "r" },
              })),
          },
          {
            name: "the attempt was retired by another workflow step",
            arrange: (h) =>
              (h.state.config = configWithRow({
                ...claimableRow(),
                taskAttemptRetiredBy: { ...CLAIMANT, attemptId: ATTEMPT, stepId: "other-step" },
              })),
          },
          {
            name: "claim lost: the task now names attempt",
            arrange: (h) =>
              (h.state.config = configWithRow({ ...claimableRow(), taskAttemptId: OTHER })),
          },
          {
            name: "task record not found",
            arrange: (h) => (h.state.config = configWithRow(undefined)),
          },
          { name: "claim write failed", arrange: (h) => (h.state.editError = new Error("EIO")) },
          { name: "claim lost", arrange: (h) => (h.state.dropEdits = true) },
          {
            // The edit lands, then the strict re-read fails.
            name: "claim unconfirmed: config unreadable",
            arrange: (h) => h.state.nextConfigs.push(new Error("EIO")),
          },
        ];
      for (const c of cases) {
        const harness = createHarness();
        harness.state.config = configWithRow(claimableRow());
        c.arrange(harness);
        const claim = await harness.ledger.claimRetiredAttempt(TASK, ATTEMPT, CLAIMANT);
        expect({ name: c.name, success: claim.success }).toEqual({ name: c.name, success: false });
        if (!claim.success) expect(claim.error.startsWith(c.name)).toBe(true);
        expect(harness.events).not.toContain(`settleGoalPause:${TASK}`);
      }
    });

    test("empty ids are refused; one-character ids are not", async () => {
      const { ledger } = createHarness();
      const rejected = (promise: Promise<unknown>) =>
        promise.then(
          () => false,
          () => true
        );
      const claimant = { runId: "r", stepId: "s", inputHash: "" };
      expect(await rejected(ledger.claimRetiredAttempt("", ATTEMPT, claimant))).toBe(true);
      expect(
        await rejected(ledger.claimRetiredAttempt("t", ATTEMPT, { ...claimant, runId: "" }))
      ).toBe(true);
      expect(
        await rejected(ledger.claimRetiredAttempt("t", ATTEMPT, { ...claimant, stepId: "" }))
      ).toBe(true);
      expect(await ledger.claimRetiredAttempt("t", ATTEMPT, claimant)).toEqual({
        success: false,
        error: "task record not found",
      });
      expect(await rejected(ledger.tombstoneUnpublishedReservation("", "t"))).toBe(true);
      expect(await rejected(ledger.tombstoneUnpublishedReservation("p", ""))).toBe(true);
      expect(await ledger.tombstoneUnpublishedReservation("p", "t")).toEqual({
        success: false,
        error: "parent record not found",
      });
    });

    test("a tombstone is written on the parent once and confirmed by a strict re-read", async () => {
      const { ledger, state } = createHarness();
      state.config = configWithRows([{ id: PARENT }]);
      expect(await ledger.tombstoneUnpublishedReservation(PARENT, TASK)).toEqual(Ok(undefined));
      expect(await ledger.tombstoneUnpublishedReservation(PARENT, TASK)).toEqual(Ok(undefined));
      expect(rowOf(state, PARENT)?.taskReservationTombstones).toEqual([TASK]);
    });

    test("an owned attempt, a published task, a missing parent and a failed or lost write refuse", async () => {
      const cases: Array<{ name: string; arrange: (h: ReturnType<typeof createHarness>) => void }> =
        [
          { name: "this process owns an attempt for the task", arrange: (h) => begin(h.ledger) },
          {
            name: "the task was published",
            arrange: (h) => (h.state.config = configWithRows([{ id: PARENT }, { id: TASK }])),
          },
          {
            name: "parent record not found",
            arrange: (h) => (h.state.config = configWithRows([])),
          },
          {
            name: "tombstone write failed",
            arrange: (h) => (h.state.editError = new Error("EIO")),
          },
          { name: "tombstone lost", arrange: (h) => (h.state.dropEdits = true) },
          {
            name: "tombstone unconfirmed: config unreadable",
            arrange: (h) => h.state.nextConfigs.push(new Error("EIO")),
          },
        ];
      for (const c of cases) {
        const harness = createHarness();
        harness.state.config = configWithRows([{ id: PARENT }]);
        c.arrange(harness);
        const result = await harness.ledger.tombstoneUnpublishedReservation(PARENT, TASK);
        expect({ name: c.name, success: result.success }).toEqual({ name: c.name, success: false });
        if (!result.success) expect(result.error.startsWith(c.name)).toBe(true);
      }
    });
  });
});
