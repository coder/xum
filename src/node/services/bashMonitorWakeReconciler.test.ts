import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { BashMonitorWakeDisplayRecord } from "@/common/types/message";
import {
  BASH_MONITOR_WAKE_HEADINGS,
  classifyMachineTurnPromptKind,
} from "@/common/utils/machineTurnPrompts";
import type {
  BashMonitorRegistryRecord,
  BashMonitorTerminalSummary,
} from "@/node/services/bashMonitorRegistryStore";
import {
  BASH_MONITOR_READ_PAST_NOTE,
  BashMonitorWakeReconciler,
  type BashMonitorProcessSnapshot,
  type BashMonitorWakeDeliveryState,
  type BashMonitorWakeDispatch,
  type BashMonitorWakeDispatchOutcome,
} from "@/node/services/bashMonitorWakeReconciler";

const OWNER = "owner";
const CREATED_AT = "2026-08-31T12:00:00.000Z";

function liveSnapshot(
  overrides: Partial<BashMonitorProcessSnapshot> = {}
): BashMonitorProcessSnapshot {
  return {
    processId: "proc",
    taskId: "bash:proc",
    ownerWorkspaceId: OWNER,
    displayName: "CI watcher",
    filter: "READY",
    filterExclude: false,
    script: "run-ci",
    createdAt: CREATED_AT,
    match: { throughOffset: 12 },
    retired: false,
    ...overrides,
  };
}

function registryRecord(terminal?: BashMonitorTerminalSummary): BashMonitorRegistryRecord {
  return {
    processId: "dead",
    taskId: "bash:dead",
    ownerWorkspaceId: OWNER,
    filter: "DONE",
    filterExclude: false,
    script: "run-job",
    createdAt: CREATED_AT,
    ...(terminal != null ? { terminal } : {}),
  };
}

describe("BashMonitorWakeReconciler", () => {
  let root: string;
  let live: BashMonitorProcessSnapshot[];
  let rows: BashMonitorRegistryRecord[];
  let deliveryState: BashMonitorWakeDeliveryState | undefined;
  let dispatches: BashMonitorWakeDispatch[];
  let dispatchOutcome: "in-flight" | "deferred";
  let acknowledged: Array<{ processId: string; matchedThroughOffset?: number }>;
  let removed: string[];
  let removedOwners: string[];
  let dropped: string[];
  let droppedGenerations: Array<string | undefined>;
  let acknowledgeGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let transcript: BashMonitorWakeDisplayRecord[];
  let reconciler: BashMonitorWakeReconciler;

  beforeEach(async () => {
    root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bash-wake-reconciler-"));
    live = [];
    rows = [];
    deliveryState = { status: "settled", shownThroughOffset: 0, terminalStatusShown: false };
    dispatches = [];
    dispatchOutcome = "in-flight";
    acknowledged = [];
    removed = [];
    removedOwners = [];
    dropped = [];
    droppedGenerations = [];
    acknowledgeGate = undefined;
    transcript = [];
    reconciler = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: (processId, _generation, matchedThroughOffset) => {
          acknowledged.push({
            processId,
            ...(matchedThroughOffset != null ? { matchedThroughOffset } : {}),
          });
          return acknowledgeGate?.promise;
        },
        dropRetiredMonitor: (processId, createdAt) => {
          droppedGenerations.push(createdAt);
          const current = live.find((snapshot) => snapshot.processId === processId);
          if (current?.createdAt === createdAt && current.retired) {
            dropped.push(processId);
            live = live.filter((snapshot) => snapshot !== current);
          }
        },
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: (ownerWorkspaceId, processId, createdAt) => {
          removedOwners.push(ownerWorkspaceId);
          removed.push(processId);
          rows = rows.filter((row) =>
            createdAt == null
              ? row.processId !== processId
              : row.processId !== processId || row.createdAt !== createdAt
          );
        },
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        dispatches.push(dispatch);
        return dispatchOutcome;
      },
    });
  });

  afterEach(async () => {
    // Accepted wakes schedule another pass; stop it before the next test reuses the fixtures.
    await reconciler.dispose(OWNER);
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  test("re-dispatches unchanged signals after a busy delivery defers", async () => {
    live = [liveSnapshot()];
    dispatchOutcome = "deferred";

    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    dispatchOutcome = "in-flight";
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("re-dispatches unchanged signals after a queued delivery is canceled", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const queued = dispatches[0];

    await queued.onDeferred();
    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(2);
  });

  test("a newer match withdraws the in-flight wake and dispatches again", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    live = [liveSnapshot({ match: { throughOffset: 24 } })];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(2);
    expect(dispatches[0].cancelSignal.aborted).toBe(true);
    expect(dispatches[1].cancelSignal.aborted).toBe(false);
  });

  test("consumeCurrent withdraws an in-flight wake without waiting behind acceptance I/O", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const wake = dispatches[0];

    // Acceptance holds the owner lock while acknowledging the process; a Stop must still
    // withdraw the wake immediately so the admission can bail before claiming a turn.
    acknowledgeGate = Promise.withResolvers<void>();
    const accepted = wake.onAccepted();
    while (acknowledged.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const consumed = reconciler.consumeCurrent(OWNER);
    try {
      expect(wake.cancelSignal.aborted).toBe(true);
    } finally {
      acknowledgeGate.resolve();
    }
    await accepted;
    await consumed;
    expect(acknowledged).toHaveLength(1);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
  });

  test("an accepted wake stays withdrawable until its send settles", async () => {
    live = [liveSnapshot()];
    const send = Promise.withResolvers<BashMonitorWakeDispatchOutcome>();
    const inFlight: BashMonitorWakeDispatch[] = [];
    const held = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: (processId, _generation, matchedThroughOffset) => {
          acknowledged.push({
            processId,
            ...(matchedThroughOffset != null ? { matchedThroughOffset } : {}),
          });
        },
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        inFlight.push(dispatch);
        return send.promise;
      },
    });
    const reconciling = held.reconcile(OWNER);
    while (inFlight.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The row is durable, so the wake is accepted while its send is still in preflight.
    await inFlight[0].onAccepted();
    expect(acknowledged).toEqual([{ processId: "proc", matchedThroughOffset: 12 }]);
    // A Stop landing before the stream starts still withdraws it.
    await held.consumeCurrent(OWNER);
    expect(inFlight[0].cancelSignal.aborted).toBe(true);
    send.resolve("in-flight");
    await reconciling;

    live = [liveSnapshot({ match: { throughOffset: 24 } })];
    await held.reconcile(OWNER);
    expect(inFlight).toHaveLength(2);
    expect(inFlight[1].cancelSignal.aborted).toBe(false);
    await held.dispose(OWNER);
  });

  test("a discarded process withdraws an unaccepted wake but leaves an accepted one to stream", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const unaccepted = dispatches[0];
    await reconciler.discardProcess(OWNER, "proc", CREATED_AT);
    expect(unaccepted.cancelSignal.aborted).toBe(true);

    // The accepted wake's send is still in flight (row durable, stream not yet started).
    const send = Promise.withResolvers<BashMonitorWakeDispatchOutcome>();
    const inFlight: BashMonitorWakeDispatch[] = [];
    const held = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        inFlight.push(dispatch);
        return send.promise;
      },
    });
    const reconciling = held.reconcile(OWNER);
    while (inFlight.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await inFlight[0].onAccepted();
    await held.discardProcess(OWNER, "proc", CREATED_AT);
    expect(inFlight[0].cancelSignal.aborted).toBe(false);
    send.resolve("in-flight");
    await reconciling;
    await held.dispose(OWNER);
  });

  test("consumeCurrent withdraws the wake but keeps signals owed when the commit is refused", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const wake = dispatches[0];

    await reconciler.consumeCurrent(OWNER, () => Promise.resolve(false));

    expect(wake.cancelSignal.aborted).toBe(true);
    expect(acknowledged).toEqual([]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].cancelSignal.aborted).toBe(false);
  });

  test("consumeCurrent retires only the attention owed when the stop was requested", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    live = [liveSnapshot({ match: { throughOffset: 30 } })];
    stop.resolve(true);
    await consuming;

    expect(acknowledged).toEqual([{ processId: "proc", matchedThroughOffset: 12 }]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].cancelSignal.aborted).toBe(false);
  });

  test("consumeCurrent leaves a settlement recorded after the stop request owed", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    const terminal: BashMonitorTerminalSummary = {
      status: "exited",
      exitCode: 0,
      settledAt: "2026-08-31T12:00:05.000Z",
      wakeOnExit: true,
      terminalStatusShown: false,
    };
    live = [liveSnapshot({ terminal })];
    rows = [{ ...registryRecord(terminal), processId: "proc", taskId: "bash:proc" }];
    stop.resolve(true);
    await consuming;

    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].muxMetadata.records[0]).toMatchObject({
      processId: "proc",
      wakeUpdatedAt: terminal.settledAt,
      terminal: { status: "exited", exitCode: 0 },
    });
  });

  test("consumeCurrent leaves a monitor failure recorded after the stop request owed", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    live = [liveSnapshot({ retired: true })];
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        lost: { reason: "runtime-failure", failedAt: "2026-08-31T12:00:05.000Z" },
      },
    ];
    stop.resolve(true);
    await consuming;

    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].muxMetadata.records[0]).toMatchObject({
      processId: "proc",
      kind: "monitor-lost",
    });
  });

  test("consumeCurrent keeps the registry row of a monitor armed after the stop request", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const stop = Promise.withResolvers<boolean>();
    const stopRequested = Promise.withResolvers<void>();
    const consuming = reconciler.consumeCurrent(OWNER, () => {
      stopRequested.resolve();
      return stop.promise;
    });
    await stopRequested.promise;
    const later = liveSnapshot({
      processId: "later",
      taskId: "bash:later",
      createdAt: "2026-08-31T12:00:05.000Z",
    });
    live = [liveSnapshot(), later];
    rows = [
      { ...registryRecord(), processId: "later", taskId: "bash:later", createdAt: later.createdAt },
    ];
    stop.resolve(true);
    await consuming;

    expect(removed).toEqual([]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].muxMetadata.records).toEqual([
      expect.objectContaining({ processId: "later", kind: "match" }),
    ]);
  });

  test("keeps dead registry evidence until the queued wake is accepted", async () => {
    rows = [registryRecord()];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(removed).toEqual([]);
    expect(classifyMachineTurnPromptKind(dispatches[0].prompt)).toBe("turn.monitor_wake");
    expect(dispatches[0].muxMetadata.records[0]).toMatchObject({
      processId: "dead",
      kind: "monitor-lost",
    });

    await dispatches[0].onAccepted();
    await dispatches[0].onAccepted();

    expect(removed).toEqual(["dead"]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
  });

  test("cancels a queued wake when the level no longer has an outstanding signal", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const queued = dispatches[0];

    deliveryState = { status: "settled", shownThroughOffset: 12, terminalStatusShown: false };
    await reconciler.reconcile(OWNER);

    expect(queued.cancelSignal.aborted).toBe(true);
    await queued.onAccepted();
    deliveryState = { status: "settled", shownThroughOffset: 0, terminalStatusShown: false };
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    live = [liveSnapshot({ match: { throughOffset: 24 } })];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("advances the watermark only on acceptance and later delivers a newer match", async () => {
    live = [liveSnapshot({ retired: true })];
    await reconciler.reconcile(OWNER);
    expect(dropped).toEqual([]);

    await dispatches[0].onAccepted();
    expect(dropped).toEqual(["proc"]);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    live = [
      liveSnapshot({
        match: { throughOffset: 24 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("failed acceptance I/O is retried ahead of dispatch instead of redelivering the wake", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    const wake = dispatches[0];

    acknowledgeGate = Promise.withResolvers<void>();
    acknowledgeGate.promise.catch(() => undefined);
    acknowledgeGate.reject(new Error("transient acknowledgement failure"));
    // The accepted row is durable, so acceptance resolves and only the consumption stays owed.
    await wake.onAccepted();
    await expect(reconciler.reconcile(OWNER)).rejects.toThrow("transient acknowledgement failure");
    expect(dispatches).toHaveLength(1);

    acknowledgeGate = undefined;
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    live = [liveSnapshot({ match: { throughOffset: 24 } })];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("a process created in this instance never triggers a transcript scan", async () => {
    let transcriptReads = 0;
    const fresh = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => {
        transcriptReads++;
        return Promise.resolve(transcript);
      },
      onWake: (dispatch) => {
        dispatches.push(dispatch);
        return "in-flight";
      },
    });
    // A failed acceptance from this instance stays owed in memory, so only processes older than
    // the instance can have a delivered row the reconciler does not remember.
    live = [liveSnapshot({ createdAt: new Date(Date.now() + 1_000).toISOString() })];
    await fresh.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
    expect(transcriptReads).toBe(0);
    await fresh.dispose(OWNER);
  });

  test.each(["9", "not-a-date"])(
    "a recovered process with the noncanonical age %j is still checked against the transcript",
    async (createdAt) => {
      // The registry accepts any createdAt string, and both sort after an ISO instance stamp: a string
      // comparison would take the process for a live one and redeliver the wake its row already holds.
      live = [liveSnapshot({ createdAt })];
      transcript.push({
        processId: "proc",
        wakeUpdatedAt: createdAt + ":12",
        kind: "match",
        displayName: "CI watcher",
        filter: "READY",
        filterExclude: false,
      });
      await reconciler.reconcile(OWNER);
      expect(dispatches).toEqual([]);
      expect(acknowledged).toEqual([{ processId: "proc", matchedThroughOffset: 12 }]);
    }
  );

  test("a wake the transcript already carries is consumed after restart, not redelivered", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    // The row landed but its consumption I/O never succeeded before the app exited.
    transcript.push(...dispatches[0].muxMetadata.records);
    await reconciler.dispose(OWNER);

    let transcriptReads = 0;
    let transcriptReadFails = true;
    const afterRestart: BashMonitorWakeDispatch[] = [];
    const restarted = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: (processId, _generation, matchedThroughOffset) => {
          acknowledged.push({
            processId,
            ...(matchedThroughOffset != null ? { matchedThroughOffset } : {}),
          });
        },
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => {
        transcriptReads++;
        return transcriptReadFails
          ? Promise.reject(new Error("transient transcript read"))
          : Promise.resolve(transcript);
      },
      onWake: (dispatch) => {
        afterRestart.push(dispatch);
        return "in-flight";
      },
    });

    await expect(restarted.reconcile(OWNER)).rejects.toThrow("transient transcript read");
    expect(afterRestart).toEqual([]);

    transcriptReadFails = false;
    await restarted.reconcile(OWNER);
    expect(afterRestart).toEqual([]);
    expect(acknowledged).toEqual([{ processId: "proc", matchedThroughOffset: 12 }]);

    live = [liveSnapshot({ match: { throughOffset: 24 } })];
    await restarted.reconcile(OWNER);
    await restarted.reconcile(OWNER);
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0].muxMetadata.records[0].wakeUpdatedAt).toBe(`${CREATED_AT}:24`);
    // One lookup per new outstanding key; an unchanged frontier reconciles without another read.
    expect(transcriptReads).toBe(3);
    await restarted.dispose(OWNER);
  });

  test("full history clear consumes signals present both before and during the clear", async () => {
    live = [liveSnapshot()];
    const token = await reconciler.beginFullHistoryClear(OWNER);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    live = [
      liveSnapshot({
        match: { throughOffset: 24 },
      }),
    ];
    await reconciler.finishFullHistoryClear(token);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    live = [
      liveSnapshot({
        match: { throughOffset: 36 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
  });

  test("delivers wake-on-exit settlements and terminal summaries recovered after restart", async () => {
    live = [
      liveSnapshot({
        match: undefined,
        terminal: {
          status: "exited",
          exitCode: 0,
          settledAt: "2026-08-31T12:01:00.000Z",
          wakeOnExit: true,
          terminalStatusShown: false,
        },
        retired: true,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0].terminal).toEqual({
      status: "exited",
      exitCode: 0,
    });
    expect(dispatches[0].prompt).toContain('task_ids: ["bash:proc"]');
    await dispatches[0].onAccepted();
    expect(removed).toEqual(["proc"]);
    expect(dropped).toEqual(["proc"]);

    live = [];
    rows = [
      registryRecord({
        status: "timed_out",
        settledAt: "2026-08-31T12:02:00.000Z",
        wakeOnExit: true,
        terminalStatusShown: false,
      }),
    ];
    const restartedDispatches: BashMonitorWakeDispatch[] = [];
    const restarted = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(undefined),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: (_ownerWorkspaceId, processId) => {
          rows = rows.filter((row) => row.processId !== processId);
        },
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        restartedDispatches.push(dispatch);
        return "in-flight";
      },
    });

    await restarted.reconcile(OWNER);

    expect(restartedDispatches).toHaveLength(1);
    expect(restartedDispatches[0].muxMetadata.records[0].terminal).toEqual({ status: "killed" });
    expect(restartedDispatches[0].prompt).toContain("no longer awaitable");
    // No live process holds its output, so the wake offers no read of it.
    expect(restartedDispatches[0].prompt).not.toContain('task_ids: ["bash:dead"]');
    await restartedDispatches[0].onAccepted();
    await restarted.reconcile(OWNER);
    expect(restartedDispatches).toHaveLength(1);
  });

  test("explicit cancellation retracts a queued wake without consuming a later generation", async () => {
    live = [liveSnapshot()];
    rows = [registryRecord()];
    await reconciler.reconcile(OWNER);
    const queued = dispatches[0];

    live = [];
    rows = [];
    await reconciler.reconcile(OWNER);

    expect(queued.cancelSignal.aborted).toBe(true);
    await queued.onAccepted();
    live = [
      liveSnapshot({
        createdAt: "2026-08-31T12:03:00.000Z",
        match: { throughOffset: 4 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].muxMetadata.records[0].wakeUpdatedAt).toBe("2026-08-31T12:03:00.000Z:4");
  });

  test("max-events retirement keeps matched lines but never invents a settlement or lost wake", async () => {
    live = [liveSnapshot({ retired: true })];
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        filter: "READY",
        script: "run-ci",
      },
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0]).not.toHaveProperty("terminal");
    await dispatches[0].onAccepted();
    live = [];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
    expect(removed).toEqual(["proc"]);
    expect(dropped).toEqual(["proc"]);
  });

  test("watermarks suppress delivered signals across reconstruction and reset for re-arm", async () => {
    live = [liveSnapshot()];
    await reconciler.reconcile(OWNER);
    await dispatches[0].onAccepted();

    const afterRestart: BashMonitorWakeDispatch[] = [];
    const restarted = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        afterRestart.push(dispatch);
        return "in-flight";
      },
    });
    await restarted.reconcile(OWNER);
    expect(afterRestart).toEqual([]);

    live = [
      liveSnapshot({
        createdAt: "2026-08-31T12:04:00.000Z",
        match: { throughOffset: 3 },
      }),
    ];
    await restarted.reconcile(OWNER);
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0].muxMetadata.records[0].wakeUpdatedAt).toBe("2026-08-31T12:04:00.000Z:3");
  });

  test("a blocking output read defers without consuming the wake", async () => {
    let settleRead: (() => void) | undefined;
    const readSettled = new Promise<void>((resolve) => {
      settleRead = resolve;
    });
    live = [liveSnapshot()];
    deliveryState = { status: "blocked", readSettled };

    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    deliveryState = { status: "settled", shownThroughOffset: 0, terminalStatusShown: false };
    settleRead?.();
    await readSettled;
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].prompt).toContain("READY");
  });

  test("wake-on-exit opt-out keeps an undelivered exit flush match-only", async () => {
    live = [
      liveSnapshot({
        match: { throughOffset: 12 },
        terminal: {
          status: "exited",
          exitCode: 0,
          settledAt: "2026-08-31T12:13:00.000Z",
          wakeOnExit: false,
          terminalStatusShown: false,
        },
        retired: true,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].prompt.startsWith(BASH_MONITOR_WAKE_HEADINGS.matched)).toBe(true);
    expect(dispatches[0].prompt).not.toContain("Status: exited");
    expect(dispatches[0].muxMetadata.records[0]).not.toHaveProperty("terminal");
  });

  test("shown matched output does not hold back a new settlement wake", async () => {
    live = [
      liveSnapshot({
        terminal: {
          status: "killed",
          settledAt: "2026-08-31T12:05:00.000Z",
          wakeOnExit: true,
          terminalStatusShown: false,
        },
        retired: true,
      }),
    ];
    deliveryState = { status: "settled", shownThroughOffset: 12, terminalStatusShown: false };

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0].terminal).toEqual({ status: "killed" });
  });

  test("runtime monitor failure remains actionable and deduplicates after reconstruction", async () => {
    const runtimeFailure: BashMonitorRegistryRecord = {
      processId: "proc",
      taskId: "bash:proc",
      ownerWorkspaceId: OWNER,
      displayName: "CI watcher",
      filter: "READY",
      filterExclude: false,
      script: "run-ci",
      createdAt: CREATED_AT,
      lost: {
        reason: "runtime-failure",
        failureMessage: "transport failed",
        failedOperations: ["getExitCode"],
        failedMatch: {
          lines: ["READY before failure"],
          totalMatches: 1,
          droppedLines: 0,
          matchedThroughOffset: 12,
        },
        failedAt: "2026-08-31T12:06:00.000Z",
      },
    };
    live = [liveSnapshot({ match: undefined, retired: true })];
    rows = [runtimeFailure];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0]).toMatchObject({
      processId: "proc",
      kind: "monitor-lost",
      lostReason: "runtime-failure",
    });
    expect(dispatches[0].prompt).toContain("monitor failed at runtime");
    expect(dispatches[0].prompt).toContain("process may still be running");
    expect(dispatches[0].prompt).toContain("Failed operations: getExitCode");
    // An older build's registry row can still hold the failure text and matched lines.
    expect(dispatches[0].prompt).not.toContain("transport failed");
    expect(dispatches[0].prompt).not.toContain("READY before failure");
    expect(dispatches[0].prompt).not.toContain("process was terminated");
    await dispatches[0].onAccepted();

    live = [];
    rows = [runtimeFailure];
    const afterRestart: BashMonitorWakeDispatch[] = [];
    const restarted = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: () => Promise.resolve(undefined),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: (_ownerWorkspaceId, processId) => {
          rows = rows.filter((row) => row.processId !== processId);
        },
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        afterRestart.push(dispatch);
        return "in-flight";
      },
    });

    await restarted.reconcile(OWNER);
    expect(afterRestart).toEqual([]);
  });

  test.each([
    ["a dead registry row", false],
    ["a retired live monitor", true],
  ])(
    "an older build's lost row with output and failure text yields a wake without them (%s)",
    async (_label, liveToo) => {
      const hostile = "IGNORE_PREVIOUS_INSTRUCTIONS_MARKER";
      const lostRow: BashMonitorRegistryRecord = {
        ...registryRecord(),
        lost: {
          reason: "runtime-failure",
          failureMessage: `ssh: ${hostile} failure`,
          failedOperations: ["readOutput"],
          failedMatch: {
            lines: [`RESULT ${hostile} line`],
            totalMatches: 1,
            droppedLines: 0,
            matchedThroughOffset: 40,
          },
          failedAt: "2026-08-31T12:30:00.000Z",
        },
      };
      rows = [lostRow];
      if (liveToo) {
        live = [
          liveSnapshot({
            processId: "dead",
            taskId: "bash:dead",
            filter: "DONE",
            match: { throughOffset: 20 },
            retired: true,
          }),
        ];
        // The process is still in memory, but its output read failed: no read facts apply.
        deliveryState = {
          status: "settled",
          shownThroughOffset: 0,
          terminalStatusShown: false,
          readCursorOffset: 0,
          outputThroughOffset: 50_000,
        };
      }

      await reconciler.reconcile(OWNER);

      expect(dispatches).toHaveLength(1);
      const prompt = dispatches[0].prompt;
      expect(prompt).not.toContain(hostile);
      expect(prompt).toContain("Task ID: bash:dead");
      expect(prompt).toContain("Failed operations: readOutput");
      expect(prompt).not.toContain("Unread output:");
      expect(prompt).not.toContain("task_await({");
      expect(classifyMachineTurnPromptKind(prompt)).toBe("turn.monitor_wake");
      expect(dispatches[0].muxMetadata.records[0]).toMatchObject({
        kind: "monitor-lost",
        lostReason: "runtime-failure",
      });
    }
  );

  test("the read call names only processes whose output is still readable", async () => {
    const terminal: BashMonitorTerminalSummary = {
      status: "exited",
      exitCode: 2,
      settledAt: "2026-08-31T12:40:00.000Z",
      wakeOnExit: true,
      terminalStatusShown: false,
    };
    live = [liveSnapshot({ terminal, retired: true })];
    rows = [{ ...registryRecord(terminal), processId: "gone", taskId: "bash:gone" }];
    deliveryState = {
      status: "settled",
      shownThroughOffset: 0,
      terminalStatusShown: false,
      readCursorOffset: 0,
      outputThroughOffset: 200,
    };
    const states: Record<string, BashMonitorWakeDeliveryState | undefined> = {
      proc: deliveryState,
      gone: undefined,
    };
    const branching = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => live,
        getMonitorWakeDeliveryState: (processId) => Promise.resolve(states[processId]),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        dispatches.push(dispatch);
        return "in-flight";
      },
    });

    await branching.reconcile(OWNER);
    await branching.dispose(OWNER);

    expect(dispatches).toHaveLength(1);
    const prompt = dispatches[0].prompt;
    expect(prompt).toContain('task_ids: ["bash:proc"]');
    expect(prompt).not.toContain('task_ids: ["bash:gone"]');
    expect(prompt).toContain("Unread output: 200 bytes");
    // The settled process that only the registry still knows has no unread size to report.
    expect(prompt.match(/Unread output:/g)).toHaveLength(1);
  });

  test.each([
    [false, 100, null],
    [false, 20_000, 'filter: "READY" })'],
    [true, 20_000, 'filter: "READY", filter_exclude: true })'],
  ] as const)(
    "inverted=%p with %p unread bytes offers the filtered read %p",
    async (filterExclude, outputThroughOffset, filteredCall) => {
      live = [liveSnapshot({ filterExclude })];
      deliveryState = {
        status: "settled",
        shownThroughOffset: 0,
        terminalStatusShown: false,
        readCursorOffset: 0,
        outputThroughOffset,
      };

      await reconciler.reconcile(OWNER);

      const prompt = dispatches[0].prompt;
      expect(prompt).toContain(`Unread output: ${outputThroughOffset} bytes`);
      if (filteredCall == null) expect(prompt).not.toContain("filter:");
      else expect(prompt).toContain(filteredCall);
      expect(prompt).not.toContain(BASH_MONITOR_READ_PAST_NOTE);
    }
  );

  test.each([
    ["the cursor passed the whole match", 0, 12, false, true],
    ["the cursor stopped inside the match", 0, 11, false, false],
    ["an owner read showed the match before it settled", 12, 30, true, false],
  ] as const)(
    "read-past note when %s: %p",
    async (_label, shownThroughOffset, readCursorOffset, settled, expected) => {
      live = [
        liveSnapshot(
          settled
            ? {
                terminal: {
                  status: "exited",
                  exitCode: 0,
                  settledAt: "2026-08-31T13:00:00.000Z",
                  wakeOnExit: true,
                  terminalStatusShown: false,
                },
                retired: true,
              }
            : {}
        ),
      ];
      deliveryState = {
        status: "settled",
        shownThroughOffset,
        terminalStatusShown: false,
        readCursorOffset,
        outputThroughOffset: 40,
      };

      await reconciler.reconcile(OWNER);

      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].prompt.includes(BASH_MONITOR_READ_PAST_NOTE)).toBe(expected);
    }
  );

  test("stale accepted wake does not drop a newer retired monitor generation", async () => {
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        filter: "READY",
      },
    ];
    await reconciler.reconcile(OWNER);
    live = [
      liveSnapshot({
        createdAt: "2026-08-31T12:20:00.000Z",
        match: { throughOffset: 10 },
        retired: true,
      }),
    ];
    rows = [
      {
        ...registryRecord(),
        processId: "proc",
        taskId: "bash:proc",
        filter: "READY",
        createdAt: "2026-08-31T12:20:00.000Z",
      },
    ];

    await dispatches[0].onAccepted();

    expect(droppedGenerations).toEqual([CREATED_AT]);
    expect(live).toHaveLength(1);
    expect(live[0].match?.throughOffset).toBe(10);
  });

  test("dead registry cleanup uses the scanned workspace instead of embedded owner", async () => {
    rows = [{ ...registryRecord(), ownerWorkspaceId: "other-owner" }];

    await reconciler.reconcile(OWNER);
    await dispatches[0].onAccepted();

    expect(removedOwners).toEqual([OWNER]);
  });

  test("accepted stale generation does not remove a re-armed registry row", async () => {
    rows = [registryRecord()];
    await reconciler.reconcile(OWNER);
    rows = [
      {
        ...registryRecord(),
        createdAt: "2026-08-31T12:10:00.000Z",
        filter: "NEW",
      },
    ];

    await dispatches[0].onAccepted();

    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe("2026-08-31T12:10:00.000Z");
  });

  test("retries a failed reconcile pass without another process event", async () => {
    let pulls = 0;
    const retryDispatches: BashMonitorWakeDispatch[] = [];
    const retrying = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: () => {
          pulls++;
          if (pulls === 1) throw new Error("transient read failure");
          return [liveSnapshot()];
        },
        getMonitorWakeDeliveryState: () => Promise.resolve(deliveryState),
        acknowledgeMonitorWake: () => undefined,
        dropRetiredMonitor: () => undefined,
      },
      registry: {
        listAll: () => Promise.resolve([]),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve(transcript),
      onWake: (dispatch) => {
        retryDispatches.push(dispatch);
        return "in-flight";
      },
    });

    retrying.scheduleReconcile(OWNER);
    for (let attempt = 0; attempt < 30 && retryDispatches.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(pulls).toBe(2);
    expect(retryDispatches).toHaveLength(1);
  });

  test("disposed workspaces ignore late pokes without recreating session state", async () => {
    const sessionDir = path.join(root, OWNER);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await reconciler.dispose(OWNER);
    await fsPromises.rm(sessionDir, { recursive: true, force: true });
    live = [liveSnapshot()];

    reconciler.scheduleReconcile(OWNER);
    await reconciler.reconcile(OWNER);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(dispatches).toEqual([]);
    const statError = await fsPromises.stat(sessionDir).catch((error: unknown) => error);
    expect(statError).toMatchObject({ code: "ENOENT" });
  });

  test("revived workspace resumes wake delivery after a failed removal", async () => {
    await reconciler.dispose(OWNER);
    reconciler.revive(OWNER);
    live = [liveSnapshot()];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
  });

  test("restart converts an opted-out undelivered match into a content-free lost wake", async () => {
    rows = [
      registryRecord({
        status: "exited",
        exitCode: 0,
        settledAt: "2026-09-01T00:02:00.000Z",
        wakeOnExit: false,
        terminalStatusShown: false,
        matchedThroughOffset: 12,
      }),
    ];

    await reconciler.reconcile(OWNER);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].muxMetadata.records[0]).toMatchObject({
      processId: "dead",
      kind: "monitor-lost",
      lostReason: "restart",
    });
    expect(dispatches[0].prompt).not.toContain("READY");
    expect(dispatches[0].muxMetadata.records[0]).not.toHaveProperty("terminal");
  });

  test("snapshot supplies pending kinds without dispatching and removes the legacy wake directory", async () => {
    rows = [
      registryRecord({
        status: "exited",
        exitCode: 0,
        settledAt: "2026-08-31T12:01:00.000Z",
        wakeOnExit: true,
        terminalStatusShown: false,
      }),
    ];
    const legacy = path.join(root, OWNER, "bash-monitor-wakes");
    await fsPromises.mkdir(legacy, { recursive: true });
    await fsPromises.writeFile(path.join(legacy, "old.json"), "{}", "utf8");

    const snapshot = await reconciler.snapshot(OWNER);

    expect(reconciler.pendingWakeKind(snapshot, "dead")).toBe("settled");
    expect(dispatches).toEqual([]);
    const statError = await fsPromises.stat(legacy).catch((error: unknown) => error);
    expect(statError).toMatchObject({ code: "ENOENT" });

    await fsPromises.mkdir(legacy, { recursive: true });
    await reconciler.snapshot(OWNER);
    expect((await fsPromises.stat(legacy)).isDirectory()).toBe(true);
  });
});
