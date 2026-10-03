import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { BashToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { localBgWorkspaceDir } from "./backgroundProcessExecutor";
import { BackgroundProcessManager, SPAWN_NAME_LOCK_FILENAME } from "./backgroundProcessManager";
import { BackgroundProcessManagerLive } from "./di/layers/core";
import { BackgroundProcessManagerTag } from "./di/tags";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import { createBashTool } from "./tools/bash";
import { createTestToolConfig, mockToolCallOptions } from "./tools/testHelpers";
import { createWorkspaceServiceHarness } from "./workspaceService.testHarness";

// Deterministic code repros for the TLA+ model in formal/background-processes/ (see its
// check.sh). Each repro wraps its body in expectReproFailure, so it passes only while it fails at
// its "Target assertion" (a fix makes it fail: then turn it into a plain test); each plain test
// is the passing control that shows the setup reaches the code path.

const workspaceDirs: string[] = [];
const cleanups: Array<() => PromiseLike<unknown>> = [];

/** A workspace id no other test (or concurrent run on this host) uses: records live in /tmp. */
function uniqueWorkspace(tag: string): string {
  const id = `formal-bg-${tag}-${randomUUID().slice(0, 8)}`;
  workspaceDirs.push(localBgWorkspaceDir(id));
  return id;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await Promise.resolve(cleanup()).catch(() => undefined);
  }
  mock.restore();
  for (const dir of workspaceDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false
  );

async function tempDir(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `formal-bg-${tag}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------------------------
// B1 (BgTerminate.tla, MC_term_one_caller; BgTerminateGroup.tla): terminate() trusted the
// in-memory status, which only follows a natural exit when something polls it, so the kill
// command signalled the dead process group (its PGID may already belong to another group) and
// overwrote the exit code with 143. Fixed (MC_group_supervisor): only the group's supervisor
// signals the group, from inside it; a stop files a request and watches the group end, so a
// stop after a natural exit sends no signal and keeps the recorded code.

describe("B1: terminating a background process that already exited", () => {
  async function spawnExited(tag: string) {
    // Every bash Xum starts sources BASH_ENV: log each `kill` call to see which signals a stop
    // sends (process.env reaches LocalRuntime children).
    const dir = await tempDir(`${tag}-kills`);
    const killLog = path.join(dir, "kills.log");
    const recorder = path.join(dir, "record-kill.sh");
    await fs.writeFile(
      recorder,
      `kill() { printf '%s\\n' "$*" >> '${killLog}'; builtin kill "$@"; }\n`
    );
    const previousBashEnv = process.env.BASH_ENV;
    process.env.BASH_ENV = recorder;
    cleanups.push(() => {
      if (previousBashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previousBashEnv;
      return Promise.resolve();
    });

    const manager = new BackgroundProcessManager(await tempDir(`${tag}-root`));
    const ws = uniqueWorkspace(tag);
    cleanups.push(() => manager.cleanup(ws));
    const spawned = await manager.spawn(new LocalRuntime(process.cwd()), ws, "exit 3", {
      cwd: process.cwd(),
      displayName: "exits",
    });
    expect(spawned.success).toBe(true);
    if (!spawned.success) throw new Error(spawned.error);
    // The supervisor writes exit_code once the whole group has ended.
    const exitCodeFile = path.join(spawned.outputDir, "exit_code");
    await waitFor(() => exists(exitCodeFile), "the supervisor's exit_code");
    expect((await fs.readFile(exitCodeFile, "utf-8")).trim()).toBe("3");
    /** Arguments of every kill call that sent a real signal (not `kill -0`). */
    const signalsSent = async () =>
      (await fs.readFile(killLog, "utf-8").catch(() => ""))
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith("-0 "));
    return { manager, processId: spawned.processId, exitCodeFile, signalsSent };
  }

  test("control: once the status was refreshed, a stop keeps the real exit code", async () => {
    const { manager, processId, exitCodeFile } = await spawnExited("term-ctl");
    expect((await manager.getProcess(processId))?.status).toBe("exited");
    expect(await manager.terminate(processId, { monitorDisposition: "discard" })).toEqual({
      success: true,
    });
    expect((await fs.readFile(exitCodeFile, "utf-8")).trim()).toBe("3");
  });

  test("a stop after a natural exit does not overwrite the exit code", async () => {
    const { manager, processId, exitCodeFile } = await spawnExited("term");
    expect(await manager.terminate(processId, { monitorDisposition: "discard" })).toEqual({
      success: true,
    });
    expect((await fs.readFile(exitCodeFile, "utf-8")).trim()).toBe("3");
    expect((await manager.getProcess(processId))?.exitCode).toBe(3);
  }, 20_000);

  test("a stop after a natural exit sends no signal to the process group", async () => {
    const { manager, processId, signalsSent } = await spawnExited("term-signal");
    expect(await manager.terminate(processId, { monitorDisposition: "discard" })).toEqual({
      success: true,
    });
    expect(await signalsSent()).toEqual([]);
  }, 20_000);
});

// The residual of the B1 fix: a process that kills its group's supervisor leaves nobody to act on
// a stop request. The stop then reports "unconfirmed" (never a signal from outside), the process
// stays visible as running, and removal and archive abort before touching the checkout.
describe("B1: a stop that cannot be confirmed", () => {
  const projectPath = "/tmp/proj-formal-bg-unconfirmed";
  /** Kills its own supervisor (the group leader), then keeps running. */
  const killsSupervisor = 'g=$(ps -o pgid= -p $$ | tr -d " "); kill -KILL "$g"; sleep 30';

  async function harnessWithOrphanedGroup(tag: string, runtimeConfig: { type: "local" }) {
    const ws = uniqueWorkspace(tag);
    const harness = await createWorkspaceServiceHarness();
    cleanups.push(() => harness[Symbol.asyncDispose]());
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, `${ws}-checkout`, ws, { runtimeConfig }),
    ]);
    const manager = harness.backgroundProcessManager;
    const spawned = await manager.spawn(new LocalRuntime(process.cwd()), ws, killsSupervisor, {
      cwd: process.cwd(),
      displayName: "orphaned",
    });
    if (!spawned.success) throw new Error(spawned.error);
    // Test-only teardown of the group this test started (the product never signals it).
    cleanups.push(() => {
      try {
        process.kill(-spawned.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      return Promise.resolve();
    });
    await waitFor(() => Promise.resolve(!isAlive(spawned.pid)), "the supervisor's death");
    return { ws, harness, manager, spawned };
  }

  test("removal aborts before deleting the checkout", async () => {
    const { ws, harness, manager, spawned } = await harnessWithOrphanedGroup("rm-unconfirmed", {
      type: "local",
    });
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: "x" })
    );
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const removed = await harness.service.remove(ws, true);
    expect(removed.success ? "" : removed.error).toContain("may still be running");
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(isAlive(-spawned.pid)).toBe(true);
    expect((await manager.getProcess(spawned.processId))?.status).toBe("running");
  }, 30_000);

  test("archive fails instead of stopping the runtime under the process", async () => {
    const { ws, harness, spawned } = await harnessWithOrphanedGroup("archive-unconfirmed", {
      type: "local",
    });
    const archived = await harness.service.archive(ws);
    expect(archived.success ? "" : archived.error).toContain("may still be running");
    expect(isAlive(-spawned.pid)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// B2 (BgCleanup.tla, MC_cleanup_spawn_remove): spawn() checked no seal and was no pending entry,
// so a run_in_background spawn in flight when removal's cleanup() listed the processes
// registered afterwards and ran while the checkout was deleted. Fixed: spawns are admitted under
// the same seal as migrations (#4967) and stay pending until registered (MC_cleanup_fixed).

describe("B2: a background spawn in flight during workspace removal", () => {
  const projectPath = "/tmp/proj-formal-bg";

  async function removalHarness(ws: string) {
    const harness = await createWorkspaceServiceHarness();
    cleanups.push(() => harness[Symbol.asyncDispose]());
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, `${ws}-checkout`, ws, {
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src-formal-bg" },
      }),
    ]);
    return harness;
  }

  test("control: a background process started before the removal is stopped before deletion", async () => {
    const ws = uniqueWorkspace("rm-ctl");
    const harness = await removalHarness(ws);
    const manager = harness.backgroundProcessManager;
    cleanups.push(() => manager.cleanup(ws));
    const spawned = await manager.spawn(new LocalRuntime(process.cwd()), ws, "sleep 30", {
      cwd: process.cwd(),
      displayName: "server",
    });
    if (!spawned.success) throw new Error(spawned.error);
    let liveAtDeletion: boolean | undefined;
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: mock(() => {
        liveAtDeletion = isAlive(spawned.pid);
        return Promise.resolve({ success: true as const, deletedPath: "x" });
      }),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    expect((await harness.service.remove(ws, true)).success).toBe(true);
    expect(liveAtDeletion).toBe(false);
  });

  test("a spawn that was waiting for its record name does not run when the checkout is deleted", async () => {
    const ws = uniqueWorkspace("rm");
    const harness = await removalHarness(ws);
    const manager = harness.backgroundProcessManager;
    cleanups.push(() => manager.cleanup(ws));
    // Another backend holds the name lock, so this backend's spawn (from a bash tool call the
    // removal's stopStream did not stop) waits inside spawn().
    const nameLock = await acquireProcessFileLock({
      lockPath: path.join(localBgWorkspaceDir(ws), SPAWN_NAME_LOCK_FILENAME),
      timeoutMs: 5000,
      label: "test: other backend's spawn-name lock",
    });
    const spawning = manager.spawn(new LocalRuntime(process.cwd()), ws, "sleep 30", {
      cwd: process.cwd(),
      displayName: "server",
    });
    let liveAtDeletion: boolean | undefined;
    const cleanup = manager.cleanup.bind(manager);
    spyOn(manager, "cleanup").mockImplementation(async (id: string) => {
      // The other backend frees the name while cleanup runs. Before the fix, cleanup listed
      // (and stopped) what it saw within microtasks, before this file unlock completed.
      const cleaning = cleanup(id);
      await nameLock[Symbol.asyncDispose]();
      await cleaning;
      const spawned = await spawning;
      if (spawned.success)
        cleanups.push(() =>
          manager.terminate(spawned.processId, { monitorDisposition: "discard" })
        );
      liveAtDeletion = spawned.success && isAlive(spawned.pid);
    });
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: mock(() => Promise.resolve({ success: true as const, deletedPath: "x" })),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    expect((await harness.service.remove(ws, true)).success).toBe(true);
    expect(liveAtDeletion).toBeDefined();
    // Target assertion: no background process of the workspace ran into its deletion.
    expect(liveAtDeletion).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// B3 (BgCleanup.tla, MC_cleanup_archive): archiveUnlocked stopped the stream, terminals and MCP
// servers but never this backend's background processes, although ARCHIVE_OWN_ACTIVITY_POLICY's
// comment says it does and the model-facing refusal says archiving "would terminate" them.
// Fixed: archive seals the workspace and runs cleanup() before its hooks and any deletion, and
// again after the stream stop (MC_cleanup_archive_fixed).

describe("B3: archive and this backend's own background process", () => {
  test("archiving a workspace stops its running background process", async () => {
    const ws = uniqueWorkspace("archive");
    const harness = await createWorkspaceServiceHarness();
    cleanups.push(() => harness[Symbol.asyncDispose]());
    await saveWorkspaces(harness.config, "/tmp/proj-formal-bg-archive", [
      projectWorkspace("/tmp/proj-formal-bg-archive", `${ws}-checkout`, ws, {
        runtimeConfig: { type: "local" },
      }),
    ]);
    const manager = harness.backgroundProcessManager;
    cleanups.push(() => manager.cleanup(ws));
    const spawned = await manager.spawn(new LocalRuntime(process.cwd()), ws, "sleep 30", {
      cwd: process.cwd(),
      displayName: "server",
    });
    if (!spawned.success) throw new Error(spawned.error);

    const archived = await harness.service.archive(ws);
    expect(archived.success).toBe(true);
    // Target assertion: the archived workspace has no running background process left.
    expect(isAlive(spawned.pid)).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// B4 (BgGateEvidence.tla, MC_gate_migrated_ostmp): a command sent to the background kept its
// record under path.join(os.tmpdir(), "mux-bashes") (di/layers/core.ts), while another backend's
// structural-mutation gate scanned only localBgWorkspaceDir (/tmp/mux-bashes/<ws>). On macOS
// os.tmpdir() is /var/folders/... (and on Linux it follows TMPDIR), so the other backend saw no
// evidence of the live migrated command. Fixed by one shared root (localBgRecordsRoot) for
// writers, the name lock and scanners, plus a scan of the old os.tmpdir() root for upgrades.
// Downgrades stay safe: an older gate scans /tmp/mux-bashes, where new builds now migrate.

describe("B4: another backend's evidence of a command sent to the background", () => {
  /** The manager exactly as production wires it (BackgroundProcessManagerLive). */
  function productionManager(): BackgroundProcessManager {
    return Effect.runSync(
      Effect.gen(function* () {
        return yield* BackgroundProcessManagerTag;
      }).pipe(Effect.provide(BackgroundProcessManagerLive))
    );
  }

  /** Points os.tmpdir() outside /tmp for this test, as on macOS (/var/folders/...). */
  async function useMacosTmpdir(fakeTmp?: string): Promise<void> {
    fakeTmp ??= await tempDir("ostmp");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = fakeTmp;
    cleanups.push(() => {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      return Promise.resolve();
    });
    expect(os.tmpdir()).toBe(fakeTmp);
  }

  /** Backend A: sends a running foreground command to the background. */
  async function migrateOn(manager: BackgroundProcessManager, ws: string): Promise<void> {
    cleanups.push(() => manager.cleanup(ws));
    const dir = await tempDir("mig");
    const started = path.join(dir, "started");
    const config = createTestToolConfig(process.cwd(), { workspaceId: ws });
    config.runtimeTempDir = dir;
    config.backgroundProcessManager = manager;
    const running = createBashTool(config).execute!(
      {
        script: `touch "${started}"; sleep 30`,
        timeout_secs: 60,
        run_in_background: false,
        display_name: "dev",
      },
      mockToolCallOptions
    ) as Promise<BashToolResult>;
    await waitFor(() => exists(started), "the foreground command");
    expect(manager.sendToBackground(mockToolCallOptions.toolCallId).success).toBe(true);
    const result = await running;
    expect("backgroundProcessId" in result && result.backgroundProcessId).toBeTruthy();
  }

  test("control: with os.tmpdir() under /tmp (Linux), the other backend sees the command", async () => {
    const ws = uniqueWorkspace("mig-ctl");
    await migrateOn(new BackgroundProcessManager(path.dirname(localBgWorkspaceDir(ws))), ws);
    expect(await productionManager().hasOrphanedRunningBackgroundProcesses(ws)).toBe(true);
  }, 20_000);

  test("with os.tmpdir() outside /tmp (macOS), the other backend sees the command", async () => {
    await useMacosTmpdir();
    const ws = uniqueWorkspace("mig");
    await migrateOn(productionManager(), ws);
    // Target assertion: the live migrated command is evidence for the other backend's gate.
    expect(await productionManager().hasOrphanedRunningBackgroundProcesses(ws)).toBe(true);
  }, 20_000);

  test("with os.tmpdir() an alias of /tmp, a backend's own command is not foreign evidence", async () => {
    // Like TMPDIR=/private/tmp on macOS, where /tmp -> /private/tmp.
    const alias = path.join(await tempDir("alias"), "tmp");
    await fs.symlink(path.dirname(path.dirname(localBgWorkspaceDir("x"))), alias);
    await useMacosTmpdir(alias);
    const ws = uniqueWorkspace("mig-alias");
    const manager = productionManager();
    await migrateOn(manager, ws);
    expect(await manager.hasOrphanedRunningBackgroundProcesses(ws)).toBe(false);
    expect(await productionManager().hasOrphanedRunningBackgroundProcesses(ws)).toBe(true);
  }, 20_000);

  test("upgrade: a command an older build migrated under os.tmpdir() stays visible", async () => {
    await useMacosTmpdir();
    const ws = uniqueWorkspace("mig-old");
    // How builds before the shared root wired the manager.
    await migrateOn(new BackgroundProcessManager(path.join(os.tmpdir(), "mux-bashes")), ws);
    // Target assertion: the new backend's gate still sees the older backend's command.
    expect(await productionManager().hasOrphanedRunningBackgroundProcesses(ws)).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// #4889 (BgSpawnName.tla, MC_name_remote_serial): on runtimes whose records are not host-local
// (SSH/Coder, Docker, devcontainer, multi-project) a settled record dir was free to another
// backend, which reinitialised it while its first owner still tracked it (#4882 on the host).
// Fixed: the name is claimed with an atomic mkdir on the runtime (MC_name_remote_fixed).

/** Delegates to a real LocalRuntime but is not a LocalBaseRuntime: the manager's remote path. */
function remoteLike(base: LocalRuntime): Runtime {
  return new Proxy({} as Runtime, {
    get(_target, prop) {
      const value = (base as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(base)
        : value;
    },
  });
}

describe("#4889: same-name spawns from two backends on a non-host runtime", () => {
  async function spawnTwice(runtime: Runtime, tag: string) {
    const root = await tempDir(`${tag}-root`);
    const [a, b] = [new BackgroundProcessManager(root), new BackgroundProcessManager(root)];
    const ws = uniqueWorkspace(tag);
    cleanups.push(
      () => a.cleanup(ws),
      () => b.cleanup(ws)
    );
    const first = await a.spawn(runtime, ws, "echo from-a", {
      cwd: process.cwd(),
      displayName: "job",
    });
    if (!first.success) throw new Error(first.error);
    await waitFor(() => exists(path.join(first.outputDir, "exit_code")), "A's exit");
    // A still tracks its settled record.
    expect((await a.list(ws)).map((p) => p.id)).toEqual([first.processId]);
    const second = await b.spawn(runtime, ws, "echo from-b", {
      cwd: process.cwd(),
      displayName: "job",
    });
    if (!second.success) throw new Error(second.error);
    return { first, second };
  }

  test("control: host-local spawns give B a fresh record directory", async () => {
    const { first, second } = await spawnTwice(new LocalRuntime(process.cwd()), "name-ctl");
    expect(second.outputDir).not.toBe(first.outputDir);
  }, 20_000);

  test("B does not reinitialise the record directory A still tracks", async () => {
    const { first, second } = await spawnTwice(remoteLike(new LocalRuntime(process.cwd())), "name");
    // Target assertion: A's tracked record is not reused for B's command.
    expect(second.outputDir === first.outputDir).toBe(false);
  }, 20_000);
});
