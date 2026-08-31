import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { classifyMachineTurnPromptKind } from "@/common/utils/machineTurnPrompts";
import type {
  BashMonitorRegistryRecord,
  BashMonitorTerminalSummary,
} from "@/node/services/bashMonitorRegistryStore";
import {
  BashMonitorWakeReconciler,
  type BashMonitorProcessSnapshot,
  type BashMonitorWakeDispatch,
  type BashMonitorWakeFrontier,
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
    match: { throughOffset: 12, lines: ["READY"], totalMatches: 1 },
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
  let frontier: BashMonitorWakeFrontier | undefined;
  let dispatches: BashMonitorWakeDispatch[];
  let removed: string[];
  let dropped: string[];
  let reconciler: BashMonitorWakeReconciler;

  beforeEach(async () => {
    root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bash-wake-reconciler-"));
    live = [];
    rows = [];
    frontier = { shownThroughOffset: 0, terminalStatusShown: false, taskAwaitable: true };
    dispatches = [];
    removed = [];
    dropped = [];
    reconciler = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: {
        pullMonitorWakeSignals: async () => live,
        getMonitorWakeFrontier: async () => frontier,
        dropRetiredMonitor: async (processId) => {
          dropped.push(processId);
        },
      },
      registry: {
        listAll: async () => rows,
        remove: async (_ownerWorkspaceId, processId) => {
          removed.push(processId);
          rows = rows.filter((row) => row.processId !== processId);
        },
        recordTerminal: async () => undefined,
      },
      onWake: async (dispatch) => {
        dispatches.push(dispatch);
      },
    });
  });

  afterEach(async () => {
    await fsPromises.rm(root, { recursive: true, force: true });
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

    frontier = { shownThroughOffset: 12, terminalStatusShown: false, taskAwaitable: true };
    await reconciler.reconcile(OWNER);

    expect(queued.cancelSignal.aborted).toBe(true);
    await queued.onAccepted();
    frontier = { shownThroughOffset: 0, terminalStatusShown: false, taskAwaitable: true };
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);

    live = [
      liveSnapshot({ match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 } }),
    ];
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
        match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(2);
  });

  test("full history clear consumes signals present both before and during the clear", async () => {
    live = [liveSnapshot()];
    const token = await reconciler.beginFullHistoryClear(OWNER);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    live = [
      liveSnapshot({
        match: { throughOffset: 24, lines: ["READY again"], totalMatches: 2 },
      }),
    ];
    await reconciler.finishFullHistoryClear(token);
    await reconciler.reconcile(OWNER);
    expect(dispatches).toEqual([]);

    live = [
      liveSnapshot({
        match: { throughOffset: 36, lines: ["READY third"], totalMatches: 3 },
      }),
    ];
    await reconciler.reconcile(OWNER);
    expect(dispatches).toHaveLength(1);
  });

  test("snapshot supplies pending kinds without dispatching and removes the legacy outbox", async () => {
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
    await expect(fsPromises.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
