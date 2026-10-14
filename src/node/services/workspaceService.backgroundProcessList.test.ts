import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { localBgWorkspaceDir } from "./backgroundProcessExecutor";
import { BashMonitorRegistryStore } from "./bashMonitorRegistryStore";
import type { BashMonitorWakeReconciler } from "./bashMonitorWakeReconciler";
import { saveWorkspaces } from "./taskService.testHarness";
import { waitForCondition } from "./testDispatchHelpers";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const CREATED_AT = "2026-01-02T03:04:05.000Z";

describe("WorkspaceService.listBackgroundProcesses", () => {
  let harness: WorkspaceServiceHarness;
  let workspaceId: string;

  // The live reconciler: tests spy on it only to inject a failed pending-wake read.
  const reconcilerOf = (h: WorkspaceServiceHarness) =>
    (h.service as unknown as { bashMonitorWakeReconciler: BashMonitorWakeReconciler })
      .bashMonitorWakeReconciler;

  async function spawn(displayName: string, monitored: boolean) {
    const spawned = await harness.backgroundProcessManager.spawn(
      new LocalRuntime(process.cwd()),
      workspaceId,
      "echo READY; sleep 30",
      {
        cwd: process.cwd(),
        displayName,
        ...(monitored
          ? { monitor: { filter: "NEVER", pattern: /NEVER/, exclude: false, cooldownMs: 0 } }
          : {}),
      }
    );
    if (!spawned.success) throw new Error(spawned.error);
    return spawned;
  }

  // An armed monitor whose process is gone (a restart killed it): only the registry row remains.
  async function armLostMonitor(processId: string, displayName?: string, createdAt = CREATED_AT) {
    await new BashMonitorRegistryStore(harness.config).upsert({
      workspaceId,
      processId,
      taskId: `bash:${processId}`,
      ...(displayName != null ? { displayName } : {}),
      filter: "READY",
      filterExclude: true,
      script: "./watch.sh",
      createdAt,
    });
  }

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    workspaceId = `bg-list-${randomUUID().slice(0, 8)}`;
    await saveWorkspaces(harness.config, "/tmp/bg-list/project", [
      // Archived: the reconciler holds owed wakes instead of dispatching a turn the fake AI
      // cannot run, so pending wake kinds stay stable while the tests list them.
      {
        id: workspaceId,
        path: "/tmp/bg-list/ws",
        name: "ws",
        archivedAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
    await fs.rm(localBgWorkspaceDir(workspaceId), { recursive: true, force: true });
  });

  test("lists live processes and lost monitors that owe a wake as synthesized exited rows", async () => {
    const watcher = await spawn("watcher", true);
    const plain = await spawn("plain", false);
    await armLostMonitor("gone");
    await armLostMonitor("done", "Done watcher", "not-a-date");
    await new BashMonitorRegistryStore(harness.config).recordTerminal(
      workspaceId,
      "done",
      "not-a-date",
      {
        status: "exited",
        exitCode: 7,
        settledAt: CREATED_AT,
        wakeOnExit: true,
        terminalStatusShown: false,
      }
    );
    const before = Date.now();

    const rows = await harness.service.listBackgroundProcesses(workspaceId);

    // Registry rows follow live rows, ordered by arm time.
    expect(rows.map((row) => row.id)).toEqual([watcher.processId, plain.processId, "gone", "done"]);
    expect(rows[0]).toMatchObject({
      pid: watcher.pid,
      script: "echo READY; sleep 30",
      displayName: "watcher",
      status: "running",
      monitor: { filter: "NEVER", filter_exclude: false, stopped: false },
    });
    expect(rows[1]).toMatchObject({ pid: plain.pid, displayName: "plain", status: "running" });
    expect(rows[1].monitor).toBeUndefined();
    expect(rows[2]).toEqual({
      id: "gone",
      pid: 0,
      script: "./watch.sh",
      displayName: "gone",
      synthesized: true,
      startTime: Date.parse(CREATED_AT),
      status: "exited",
      monitor: {
        filter: "READY",
        filter_exclude: true,
        cooldown_ms: 0,
        totalMatches: 0,
        droppedLines: 0,
        lastLines: [],
        stopped: true,
        pendingWakeKind: "monitor-lost",
      },
      exitCode: undefined,
    });
    expect(rows[3]).toMatchObject({
      displayName: "Done watcher",
      exitCode: 7,
      monitor: { pendingWakeKind: "settled" },
    });
    // An unparseable arm time falls back to the listing time.
    expect(rows[3].startTime).toBeGreaterThanOrEqual(before);
  });

  test("a pending wake decorates the live row and registry rows without one stay hidden", async () => {
    const watcher = await spawn("watcher", true);
    await armLostMonitor(watcher.processId);
    await armLostMonitor("quiet");
    spyOn(reconcilerOf(harness), "snapshot").mockResolvedValue({
      ownerWorkspaceId: workspaceId,
      pendingWakeKinds: new Map([[watcher.processId, "match" as const]]),
    });

    const rows = await harness.service.listBackgroundProcesses(workspaceId);

    expect(rows.map((row) => [row.id, row.synthesized, row.monitor?.pendingWakeKind])).toEqual([
      [watcher.processId, undefined, "match"],
    ]);
  });

  test("a failed pending-wake read reuses the last good read and schedules a re-read", async () => {
    await armLostMonitor("gone");
    const first = await harness.service.listBackgroundProcesses(workspaceId);
    expect(first.map((row) => row.id)).toEqual(["gone"]);
    spyOn(reconcilerOf(harness), "snapshot").mockRejectedValue(new Error("EIO"));
    const notify = spyOn(harness.backgroundProcessManager, "notifyMonitorWakeStateChanged");

    expect(await harness.service.listBackgroundProcesses(workspaceId)).toEqual(first);
    // The listing resolved, so only this nudge makes a subscriber read again.
    await waitForCondition(() => notify.mock.calls.length > 0, { timeoutMs: 3_000 });
    expect(notify).toHaveBeenCalledWith(workspaceId);
  });

  test("a failed pending-wake read with no earlier good read lists only live processes", async () => {
    const watcher = await spawn("watcher", true);
    await armLostMonitor("gone");
    spyOn(reconcilerOf(harness), "snapshot").mockRejectedValue(new Error("EIO"));

    const rows = await harness.service.listBackgroundProcesses(workspaceId);

    expect(rows.map((row) => [row.id, row.monitor?.pendingWakeKind])).toEqual([
      [watcher.processId, undefined],
    ]);
  });
});
