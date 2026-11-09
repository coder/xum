import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { BASH_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import assert from "@/common/utils/assert";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { BackgroundProcessManager } from "./backgroundProcessManager";
import {
  BASH_MONITOR_READ_PAST_NOTE,
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
  const runtime = new LocalRuntime(process.cwd());

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bash-wake-cursor-"));
    manager = new BackgroundProcessManager(root);
    dispatches = [];
    reconciler = new BashMonitorWakeReconciler({
      sessionsDir: root,
      processManager: manager,
      registry: {
        listAll: () => Promise.resolve([]),
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

  test("a filtered owner read moves the cursor past the matched line, and the wake says so", async () => {
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
    expect(prompt).toContain(BASH_MONITOR_READ_PAST_NOTE);
    expect(unreadBytes(prompt)).toBe(0);
  });

  test("a read from another workspace moves the owner's cursor, and the wake says so", async () => {
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
    expect(prompt).toContain(BASH_MONITOR_READ_PAST_NOTE);
  });

  test("a matched line that a capped read left buffered is not reported as read past", async () => {
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
    expect(prompt).not.toContain(BASH_MONITOR_READ_PAST_NOTE);
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
    expect(prompt).not.toContain(BASH_MONITOR_READ_PAST_NOTE);
    expect(unreadBytes(prompt)).toBeGreaterThan(fillerBytes);
    expect(prompt).toContain(`filter: ${JSON.stringify("^RESULT ")}`);

    const firstPage = await read(processId, owner);
    expect(Buffer.byteLength(firstPage, "utf8")).toBeLessThanOrEqual(BASH_MAX_TOTAL_BYTES);
    expect(firstPage).not.toContain(marker);
  });
});
