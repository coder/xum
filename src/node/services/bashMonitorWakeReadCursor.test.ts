import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { BASH_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import assert from "@/common/utils/assert";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { BackgroundProcessManager } from "./backgroundProcessManager";
import type { BashMonitorRegistryRecord } from "./bashMonitorRegistryStore";
import {
  BASH_MONITOR_EARLIER_READ_NOTE,
  BashMonitorWakeReconciler,
  type BashMonitorWakeDispatch,
} from "./bashMonitorWakeReconciler";
import { waitForCondition } from "./testDispatchHelpers";

// Every getOutput read shares one cursor per process (proc.outputBytesRead), whatever its filter
// and whichever workspace reads. These tests drive a real manager and a real reconciler, so the
// wake must report what the next owner read can still return. The first asserts in each test
// describe the cursor itself (true before this change too); the wake asserts check the prompt.
describe("bash monitor wake and the shared read cursor", () => {
  const runId = randomUUID().slice(0, 12);
  const owner = `wake-cursor-owner-${runId}`;
  const parent = `wake-cursor-parent-${runId}`;
  let root: string;
  let manager: BackgroundProcessManager;
  let reconciler: BashMonitorWakeReconciler;
  let dispatches: BashMonitorWakeDispatch[];
  let rows: BashMonitorRegistryRecord[];
  const runtime = new LocalRuntime(process.cwd());

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bash-wake-cursor-"));
    manager = new BackgroundProcessManager(root);
    dispatches = [];
    rows = [];
    reconciler = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: manager,
      registry: {
        listAll: () => Promise.resolve(rows),
        remove: () => undefined,
        recordTerminal: () => undefined,
      },
      deliveredWakes: () => Promise.resolve([]),
      onWake: (dispatch) => {
        dispatches.push(dispatch);
        return "in-flight";
      },
    });
  });

  afterEach(async () => {
    await reconciler.dispose(owner);
    await manager.cleanup(owner);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(`/tmp/mux-bashes/${owner}`, { recursive: true, force: true });
  });

  async function spawnMonitored(displayName: string, script: string): Promise<string> {
    const result = await manager.spawn(runtime, owner, script, {
      cwd: process.cwd(),
      displayName,
      monitor: { filter: "^RESULT ", pattern: /^RESULT /, exclude: false, cooldownMs: 0 },
    });
    assert(result.success, `spawn failed: ${result.success ? "" : result.error}`);
    return result.processId;
  }

  function snapshotOf(processId: string) {
    return manager.pullMonitorWakeSignals(owner).find((entry) => entry.processId === processId);
  }

  async function read(processId: string, workspaceId: string, filter?: string): Promise<string> {
    const result = await manager.getOutput(
      processId,
      filter,
      false,
      0,
      undefined,
      workspaceId,
      "task_await"
    );
    assert(result.success, `read failed: ${result.success ? "" : result.error}`);
    return result.output;
  }

  async function wakePrompt(): Promise<string> {
    await reconciler.reconcile(owner);
    expect(dispatches).toHaveLength(1);
    return dispatches[0].prompt;
  }

  function unreadBytes(prompt: string): number {
    const found = /Unread output: (\d+) bytes/.exec(prompt);
    assert(found != null, "wake names its unread bytes");
    return Number(found[1]);
  }

  test("a filtered owner read moves the cursor past the matched line, and the wake offers no read", async () => {
    const marker = `MARKER_FILTERED_${runId}`;
    const processId = await spawnMonitored(
      "cursor-filtered",
      `printf 'noise one\\nRESULT ${marker}\\n'; sleep 30`
    );
    await waitForCondition(() => snapshotOf(processId)?.match != null, { timeoutMs: 5_000 });

    expect(await read(processId, owner, "^noise")).toContain("noise one");
    expect(await read(processId, owner)).not.toContain(marker);

    const prompt = await wakePrompt();
    expect(prompt).not.toContain(marker);
    expect(unreadBytes(prompt)).toBe(0);
    expect(prompt).not.toContain("task_await({");
    expect(prompt).not.toContain(BASH_MONITOR_EARLIER_READ_NOTE);
  });

  test("a read from another workspace moves the owner's cursor, and the wake offers no read", async () => {
    const marker = `MARKER_PARENT_${runId}`;
    const processId = await spawnMonitored(
      "cursor-parent",
      `printf 'RESULT ${marker}\\n'; sleep 30`
    );
    await waitForCondition(() => snapshotOf(processId)?.match != null, { timeoutMs: 5_000 });

    expect(await read(processId, parent)).toContain(marker);
    expect(await read(processId, owner)).not.toContain(marker);

    const prompt = await wakePrompt();
    expect(prompt).not.toContain(marker);
    expect(unreadBytes(prompt)).toBe(0);
    expect(prompt).not.toContain("task_await({");
    expect(prompt).not.toContain(BASH_MONITOR_EARLIER_READ_NOTE);
  });

  test("an owner read after a filtered one returns the match, and the wake offers no read", async () => {
    const marker = `MARKER_GAP_${runId}`;
    const gate = path.join(root, "gate-open");
    const processId = await spawnMonitored(
      "cursor-gap",
      `printf 'noise one\\n'; while [ ! -f '${gate}' ]; do sleep 0.05; done; printf 'RESULT ${marker}\\n'; sleep 30`
    );
    // The filtered read drops `noise one` before the matched line exists, so it skips nothing
    // the monitor matched. It still leaves the owner's shown frontier behind the cursor.
    await waitForCondition(
      async () => {
        await read(processId, owner, "^zzz");
        return ((await manager.getProcess(processId))?.outputBytesRead ?? 0) > 0;
      },
      { timeoutMs: 5_000 }
    );
    await fs.writeFile(gate, "");
    await waitForCondition(() => snapshotOf(processId)?.match != null, { timeoutMs: 5_000 });

    expect(await read(processId, owner)).toContain(marker);

    const prompt = await wakePrompt();
    expect(prompt).not.toContain(marker);
    expect(unreadBytes(prompt)).toBe(0);
    // Nothing is unread, so the wake offers no read that would return nothing.
    expect(prompt).not.toContain("task_await({");
  });

  test("a matched line that a capped read left buffered is still returned by the next read", async () => {
    const marker = `MARKER_BUFFERED_${runId}`;
    const processId = await spawnMonitored(
      "cursor-buffered",
      `head -c 30000 /dev/zero | tr '\\0' 'x' | fold -w 99; echo; echo 'RESULT ${marker}'; sleep 30`
    );
    await waitForCondition(() => snapshotOf(processId)?.match != null, { timeoutMs: 5_000 });

    // A filtered read scans past one page and keeps what it cannot return in memory.
    const firstPage = await read(processId, owner, ".");
    expect(firstPage).not.toContain(marker);

    const prompt = await wakePrompt();
    expect(unreadBytes(prompt)).toBeGreaterThan(0);
    expect(await read(processId, owner, ".")).toContain(marker);
  });

  test("output past one read page before the match: the wake gives the unread size and the filtered read", async () => {
    const marker = `MARKER_PAGED_${runId}`;
    const fillerBytes = 40_000;
    const processId = await spawnMonitored(
      "cursor-paged",
      `head -c ${fillerBytes} /dev/zero | tr '\\0' 'x' | fold -w 99; echo; echo 'RESULT ${marker}'`
    );
    await waitForCondition(() => snapshotOf(processId)?.terminal != null, { timeoutMs: 5_000 });

    const prompt = await wakePrompt();
    expect(prompt).not.toContain(marker);
    expect(unreadBytes(prompt)).toBeGreaterThan(fillerBytes);
    expect(prompt).toContain(`filter: ${JSON.stringify("^RESULT ")}`);
    expect(prompt).toContain(BASH_MONITOR_EARLIER_READ_NOTE);

    const firstPage = await read(processId, owner);
    expect(Buffer.byteLength(firstPage, "utf8")).toBeLessThanOrEqual(BASH_MAX_TOTAL_BYTES);
    expect(firstPage).not.toContain(marker);
  });

  test("after a runtime monitor failure the wake gives no frozen unread count and still offers the read", async () => {
    // A lost wake shows the script, so the shell builds the marker: the script never holds it.
    const marker = `MARKER_LATE_${runId}`;
    const gate = path.join(root, "gate-open");
    const wrote = path.join(root, "late-written");
    const processId = await spawnMonitored(
      "cursor-runtime-failure",
      `printf 'RESULT first\\n'; while [ ! -f '${gate}' ]; do sleep 0.05; done; printf 'MARKER_LATE_%s\\n' '${runId}'; touch '${wrote}'; sleep 30`
    );
    await waitForCondition(() => snapshotOf(processId)?.match != null, { timeoutMs: 5_000 });
    // The cursor now sits at the end of the output the monitor scanned.
    await read(processId, owner, "^zzz");

    const proc = manager.peekProcess(processId);
    assert(proc?.monitor != null, "process has a monitor");
    const arm = proc.monitor.armMetadata;
    // WorkspaceService writes this registry row on a failed monitor; this test has no service.
    manager.on("monitor:stopped", (_workspaceId, payload) => {
      if (payload.processId !== processId || payload.reason !== "failed") return;
      rows = [
        {
          processId,
          taskId: arm.taskId,
          ownerWorkspaceId: owner,
          filter: arm.filter,
          filterExclude: arm.filterExclude,
          script: arm.script,
          createdAt: arm.createdAt,
          lost: {
            reason: "runtime-failure",
            failedAt: new Date().toISOString(),
            ...(payload.failedOperations != null
              ? { failedOperations: payload.failedOperations }
              : {}),
          },
        },
      ];
    });
    spyOn(proc.handle, "getExitCodeForMonitor").mockResolvedValue({
      success: false,
      error: "exit probe down",
    });
    await waitForCondition(() => rows.length === 1, { timeoutMs: 10_000 });
    // The stopped monitor no longer scans, but the process keeps writing.
    await fs.writeFile(gate, "");
    await waitForCondition(
      () =>
        fs.stat(wrote).then(
          () => true,
          () => false
        ),
      { timeoutMs: 5_000 }
    );

    const prompt = await wakePrompt();
    expect(prompt).toContain("inspect current output");
    expect(prompt).not.toContain("Unread output:");
    expect(prompt).not.toContain(marker);
    expect(await read(processId, owner)).toContain(marker);
  }, 30_000);
});
