import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { BashToolResult } from "@/common/types/tools";
import { EXIT_CODE_ABORTED } from "@/common/constants/exitCodes";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { nodeClock } from "@/node/utils/hostClock";
import { expectReproFailure } from "@/node/utils/repro.testHarness";
import { localBgRecordsRoot, localBgWorkspaceDir } from "./backgroundProcessExecutor";
import { realRecordPath } from "./backgroundRecordFiles";
import { BackgroundProcessManager, SPAWN_NAME_LOCK_FILENAME } from "./backgroundProcessManager";
import { HostClockTag } from "./di/hostClockLive";
import { BackgroundProcessManagerLive } from "./di/layers/core";
import { BackgroundProcessManagerTag } from "./di/tags";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import { createBashTool } from "./tools/bash";
import { createTestToolConfig, mockToolCallOptions } from "./tools/testHelpers";
import { createWorkspaceServiceHarness } from "./workspaceService.testHarness";

// Deterministic code repros of background-process findings. Each repro wraps its body in
// expectReproFailure, so it passes only while it fails at its "Target assertion" (a fix makes it
// fail: then turn it into a plain test); each plain test is the passing control that shows the
// setup reaches the code path.

const workspaceDirs: string[] = [];
const cleanups: Array<() => PromiseLike<unknown>> = [];

/** A workspace id no other test (or concurrent run on this host) uses: records live in /tmp. */
function uniqueWorkspace(tag: string): string {
  const id = `repro-bg-${tag}-${randomUUID().slice(0, 8)}`;
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

/**
 * A file a shell redirect writes (`echo $? > file`) exists, empty, between the redirect's create
 * and its write: wait for the content, not for the file.
 */
async function readWhenWritten(file: string, what: string): Promise<string> {
  let content = "";
  await waitFor(async () => {
    content = await fs.readFile(file, "utf-8").then(
      (text) => text.trim(),
      () => ""
    );
    return content !== "";
  }, what);
  return content;
}

async function tempDir(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `repro-bg-${tag}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------------------------
// terminate() trusts the in-memory status, which only
// follows a natural exit when something polls it. The kill command then signals the dead
// process group (its PGID may already belong to another group) and overwrites the exit code
// the wrapper's trap wrote with 143. Fixed: the exit code survives (noclobber publish). Still
// open (#5481): the stop still signals the group.

/**
 * The wrapper records its exit with the shell's `echo $? > exit_code`, so the marker exists,
 * empty, from the redirect's create until the write. A slow host can stretch that window.
 * Spawns started inside `run` get an exported `echo` function that holds the exit code 3 until
 * `gate` exists (bash imports it at start, so `run` may drop it once the spawn returned).
 */
async function withHeldMarkerWrite<T>(gate: string | undefined, run: () => Promise<T>): Promise<T> {
  if (gate == null) return run();
  const key = "BASH_FUNC_echo%%";
  // The runner's own environment may already export an `echo` function: put it back afterwards.
  const previous = process.env[key];
  process.env[key] =
    `() {  case "$1" in 3) while [ ! -e '${gate}' ]; do sleep 0.01; done;; esac; builtin echo "$@"\n}`;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

describe("terminating a background process that already exited", () => {
  async function spawnExiting(tag: string, holdMarkerWriteUntil?: string) {
    const manager = new BackgroundProcessManager(await tempDir(`${tag}-root`));
    const ws = uniqueWorkspace(tag);
    cleanups.push(() => manager.cleanup(ws));
    // The wrapper exits 3 while a `sleep` it started keeps the process group alive. The stale
    // stop under test signals that PGID; holding it with our own process means the signal can
    // only reach this test's group, never a host process that reused the number.
    const spawned = await withHeldMarkerWrite(holdMarkerWriteUntil, () =>
      manager.spawn(new LocalRuntime(process.cwd()), ws, "sleep 30 & exit 3", {
        cwd: process.cwd(),
        displayName: "exits",
      })
    );
    expect(spawned.success).toBe(true);
    if (!spawned.success) throw new Error(spawned.error);
    // PID === PGID (set -m); stop the group's sleep if the stop under test did not.
    cleanups.push(() => {
      try {
        process.kill(-spawned.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      return Promise.resolve();
    });
    const exitCodeFile = path.join(spawned.outputDir, "exit_code");
    return { manager, processId: spawned.processId, exitCodeFile, pgid: spawned.pid };
  }

  /** The step every test of this block settles its exit with. */
  async function expectExited(spawned: Awaited<ReturnType<typeof spawnExiting>>) {
    expect(await readWhenWritten(spawned.exitCodeFile, "the wrapper's exit_code")).toBe("3");
    return spawned;
  }

  async function spawnExited(tag: string) {
    return expectExited(await spawnExiting(tag));
  }

  async function holdMarkerWrite(): Promise<string> {
    const gate = path.join(await tempDir("gate"), "release");
    // Registered after the folder's removal, so it runs first and frees a held wrapper.
    cleanups.push(() => fs.writeFile(gate, ""));
    return gate;
  }

  test("a marker the wrapper created but has not written yet reads as still running", async () => {
    const gate = await holdMarkerWrite();
    const { manager, processId, exitCodeFile } = await spawnExiting("term-empty", gate);
    await waitFor(() => exists(exitCodeFile), "the created marker");
    expect(await fs.readFile(exitCodeFile, "utf-8")).toBe("");
    expect((await manager.getProcess(processId))?.status).toBe("running");
    await fs.writeFile(gate, "");
    await waitFor(
      async () => (await manager.getProcess(processId))?.status === "exited",
      "the exit after the write"
    );
    expect((await manager.getProcess(processId))?.exitCode).toBe(3);
  }, 20_000);

  test("the exit code is read once the wrapper wrote it, not once its marker exists", async () => {
    const gate = await holdMarkerWrite();
    const spawned = await spawnExiting("term-held", gate);
    await waitFor(() => exists(spawned.exitCodeFile), "the created marker");
    expect(await fs.readFile(spawned.exitCodeFile, "utf-8")).toBe("");
    const exited = expectExited(spawned);
    const raced = await Promise.race([
      exited.then(() => "settled"),
      Bun.sleep(150).then(() => "held"),
    ]);
    // The exit stays pending while the marker is empty. A reader that took the empty marker for
    // the exit would reject `exited` inside expectExited, so the race throws before this line.
    expect(raced).toBe("held");
    await fs.writeFile(gate, "");
    expect((await exited).processId).toBe(spawned.processId);
  }, 20_000);

  test("control: once the status was refreshed, a stop keeps the real exit code", async () => {
    const { manager, processId, exitCodeFile } = await spawnExited("term-ctl");
    expect((await manager.getProcess(processId))?.status).toBe("exited");
    expect(await manager.terminate(processId, { monitorDisposition: "discard" })).toEqual({
      success: true,
    });
    expect((await fs.readFile(exitCodeFile, "utf-8")).trim()).toBe("3");
  }, 20_000);

  test("a stop after a natural exit does not overwrite the exit code", async () => {
    const { manager, processId, exitCodeFile } = await spawnExited("term");
    expect(await manager.terminate(processId, { monitorDisposition: "discard" })).toEqual({
      success: true,
    });
    // Target assertion: the trap's code survives (143 means the kill command ran).
    expect((await fs.readFile(exitCodeFile, "utf-8")).trim()).toBe("3");
  }, 20_000);

  test("a stop after a natural exit sends no signal to the process group", async () => {
    await expectReproFailure(
      async () => {
        const { manager, processId, pgid } = await spawnExited("term-signal");
        expect(await manager.terminate(processId, { monitorDisposition: "discard" })).toEqual({
          success: true,
        });
        // A signaled member can stay visible as a zombie until its reaper collects it.
        for (let attempt = 0; attempt < 100 && isAlive(-pgid); attempt++) await Bun.sleep(10);
        // Target assertion: the wrapper's `sleep` still holds the group (no signal reached it).
        expect(isAlive(-pgid)).toBe(true);
      },
      { matcher: "toBe", expected: "true", received: "false" }
    );
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// spawn() checked no seal and was no pending entry,
// so a run_in_background spawn in flight when removal's cleanup() listed the processes
// registered afterwards and ran while the checkout was deleted. Fixed: spawns are admitted under
// the same seal as migrations (#4967) and stay pending until registered.

describe("a background spawn in flight during workspace removal", () => {
  const projectPath = "/tmp/proj-repro-bg";

  async function removalHarness(ws: string) {
    const harness = await createWorkspaceServiceHarness();
    cleanups.push(() => harness[Symbol.asyncDispose]());
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, `${ws}-checkout`, ws, {
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src-repro-bg" },
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
// archiveUnlocked stopped the stream, terminals and MCP
// servers but never this backend's background processes, although ARCHIVE_OWN_ACTIVITY_POLICY's
// comment says it does and the model-facing refusal says archiving "would terminate" them.
// Fixed: archive seals the workspace and runs cleanup() before its hooks and any deletion, and
// again after the stream stop.

describe("archive and this backend's own background process", () => {
  test("archiving a workspace stops its running background process", async () => {
    const ws = uniqueWorkspace("archive");
    const harness = await createWorkspaceServiceHarness();
    cleanups.push(() => harness[Symbol.asyncDispose]());
    await saveWorkspaces(harness.config, "/tmp/proj-repro-bg-archive", [
      projectWorkspace("/tmp/proj-repro-bg-archive", `${ws}-checkout`, ws, {
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
// A command sent to the background kept its
// record under path.join(os.tmpdir(), "mux-bashes") (di/layers/core.ts), while another backend's
// structural-mutation gate scanned only localBgWorkspaceDir (/tmp/mux-bashes/<ws>). On macOS
// os.tmpdir() is /var/folders/... (and on Linux it follows TMPDIR), so the other backend saw no
// evidence of the live migrated command. Fixed by one shared root (localBgRecordsRoot) for
// writers, the name lock and scanners, plus a scan of the old os.tmpdir() root for upgrades.
// Downgrades stay safe: an older gate scans /tmp/mux-bashes, where new builds now migrate.

describe("another backend's evidence of a command sent to the background", () => {
  /** The manager exactly as production wires it (BackgroundProcessManagerLive). */
  function productionManager(): BackgroundProcessManager {
    return Effect.runSync(
      Effect.gen(function* () {
        return yield* BackgroundProcessManagerTag;
      }).pipe(
        Effect.provide(
          // nodeClock is what HostClockLive gives production (the default Effect Clock).
          BackgroundProcessManagerLive.pipe(Layer.provide(Layer.succeed(HostClockTag)(nodeClock)))
        )
      )
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
// #4889: on runtimes whose records are not host-local
// (SSH/Coder, Docker, devcontainer, multi-project) a settled record dir was free to another
// backend, which reinitialised it while its first owner still tracked it (#4882 on the host).
// Fixed: the name is claimed with an atomic mkdir on the runtime.

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

// ---------------------------------------------------------------------------------------------
// #5465 case 1: a migration refused by a
// cleanup's seal (or one that fails) unregisters the foreground entry, aborts the command and
// waits at most 5 s for its exit. A command whose exit that join does not see keeps running with
// no manager entry and no record, so the removal waiting on the migration goes on to delete its
// checkout. The runtime below holds the abort until the test releases it: it stands in for a kill
// that takes effect after the join (a command stuck in uninterruptible I/O, or a remote exec whose
// close is late). Fixed in #5522: the migration stays pending until the command's exit settles.

describe("#5465 case 1: a refused migration whose command outlives the kill join", () => {
  /**
   * Backend A: a foreground command sent to the background while cleanup seals the workspace, or
   * (`failMigration`) an admitted migration whose record cannot be created.
   */
  async function refuseMigration(
    tag: string,
    holdKill: boolean,
    failMigration = false,
    rejectExit = false,
    hostClock = nodeClock
  ) {
    const ws = uniqueWorkspace(tag);
    const manager = new BackgroundProcessManager(path.dirname(localBgWorkspaceDir(ws)), hostClock);
    cleanups.push(() => manager.cleanup(ws));
    const dir = await tempDir(tag);
    const pidFile = path.join(dir, "pid");
    const releaseKill = Promise.withResolvers<void>();
    /** Delivers the tool's abort to the command only once the test releases it. */
    class HeldKillRuntime extends LocalRuntime {
      override exec(command: string, options: Parameters<Runtime["exec"]>[1]) {
        const delayed = new AbortController();
        options.abortSignal?.addEventListener(
          "abort",
          () => void releaseKill.promise.then(() => delayed.abort()),
          { once: true }
        );
        return super.exec(command, { ...options, abortSignal: delayed.signal }).then((stream) =>
          rejectExit
            ? {
                ...stream,
                // The transport fails instead of reporting the exit (RemoteRuntime's child error).
                exitCode: stream.exitCode.then(() => Promise.reject(new Error("transport lost"))),
              }
            : stream
        );
      }
    }
    const runtime = holdKill ? new HeldKillRuntime(process.cwd()) : new LocalRuntime(process.cwd());
    let pid = 0;
    cleanups.push(() => {
      releaseKill.resolve();
      try {
        if (pid > 0) process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      return Promise.resolve();
    });
    const config = createTestToolConfig(process.cwd(), { workspaceId: ws, runtime });
    config.runtimeTempDir = dir;
    config.backgroundProcessManager = manager;
    const running = createBashTool(config).execute!(
      {
        script: `echo $$ > "${pidFile}"; sleep 30`,
        timeout_secs: 60,
        run_in_background: false,
        display_name: "dev",
      },
      mockToolCallOptions
    ) as Promise<BashToolResult>;
    pid = Number(await readWhenWritten(pidFile, "the foreground command's pid"));
    expect(pid).toBeGreaterThan(1);
    // The seal a removal or archive holds (workspaceService.ts) while its cleanup() runs.
    using _seal = failMigration ? undefined : manager.sealAdmissions(ws);
    const outputDir = path.join(localBgWorkspaceDir(ws), "dev");
    if (failMigration) {
      // The migration opens the record by its real path (backgroundRecordFiles.ts).
      const outputLog = await realRecordPath(
        path.dirname(localBgRecordsRoot()),
        path.join(outputDir, "output.log")
      );
      const open = fs.open;
      spyOn(fs, "open").mockImplementation((file, flags, mode) =>
        file === outputLog
          ? Promise.reject(new Error("ENOSPC: no space left on device"))
          : open(file, flags, mode)
      );
    }
    expect(manager.sendToBackground(mockToolCallOptions.toolCallId).success).toBe(true);
    const result = await running;
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain("could not be tracked");
    // The path taken: the seal's refusal, or the record that could not be created.
    expect(!result.success && result.error).toContain(
      failMigration ? "ENOSPC" : "being cleaned up"
    );
    return { manager, ws, pid, outputDir, releaseKill: () => releaseKill.resolve() };
  }

  test("control: a refused migration's command is stopped once its kill takes effect", async () => {
    const { manager, ws, pid } = await refuseMigration("join-ctl", false);
    expect(await manager.list(ws)).toEqual([]);
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  for (const failMigration of [false, true]) {
    test(`a ${failMigration ? "failed" : "refused"} migration keeps its command tracked until it exits`, async () => {
      const { manager, ws, pid, releaseKill } = await refuseMigration(
        failMigration ? "join-fail" : "join",
        true,
        failMigration
      );
      // The join gave up: the command the tool reported as terminated still runs.
      expect(isAlive(pid)).toBe(true);
      // A removal's cleanup (workspaceService.ts) deletes the checkout once it returns, so it must
      // keep waiting (or fail closed at its drain deadline) while the command runs.
      const cleanup = manager.cleanup(ws, { failClosedAfterDrainTimeout: true }).then(
        () => "finished",
        () => "failed closed"
      );
      expect(await Promise.race([cleanup, Bun.sleep(500).then(() => "waiting")])).toBe("waiting");
      // Once the kill takes effect, the exit settles the migration and the cleanup finishes.
      releaseKill();
      expect(await cleanup).toBe("finished");
      expect(isAlive(pid)).toBe(false);
    }, 20_000);
  }

  test("a failed migration settles its record only after confirmed exit", async () => {
    const deadline = Promise.withResolvers<() => void>();
    const publicationStarted = Promise.withResolvers<void>();
    const allowPublication = Promise.withResolvers<void>();
    const open = fs.open;
    const { manager, ws, pid, outputDir, releaseKill } = await refuseMigration(
      "failed-record-settlement",
      true,
      true,
      false,
      {
        nowMs: () => nodeClock.nowMs(),
        setTimer: (onTimeout) => {
          deadline.resolve(onTimeout);
          return () => undefined;
        },
      }
    );
    const marker = path.join(outputDir, "exit_code");
    expect(await exists(outputDir)).toBe(true);
    expect(await exists(marker)).toBe(false);
    expect(await manager.hasOrphanedRunningBackgroundProcesses(ws)).toBe(true);
    expect(isAlive(pid)).toBe(true);
    const realMarker = await realRecordPath(path.dirname(localBgRecordsRoot()), marker);
    spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (file === realMarker) {
        publicationStarted.resolve();
        await allowPublication.promise;
      }
      return open(file, flags, mode);
    });
    releaseKill();
    await publicationStarted.promise;
    const removalDrain = manager.cleanup(ws, { failClosedAfterDrainTimeout: true }).then(
      () => true,
      () => false
    );
    try {
      // A blocked marker write must keep removal pending, even after the command stops.
      (await deadline.promise)();
      expect(await removalDrain).toBe(false);
    } finally {
      allowPublication.resolve();
    }
    await manager.cleanup(ws, { failClosedAfterDrainTimeout: true });
    expect(Number((await fs.readFile(marker, "utf8")).trim())).toBe(EXIT_CODE_ABORTED);
    expect(isAlive(pid)).toBe(false);
    expect(await manager.hasOrphanedRunningBackgroundProcesses(ws)).toBe(false);
  }, 20_000);

  test("a failed migration keeps its record unknown when exit rejects", async () => {
    const { manager, ws, pid, outputDir, releaseKill } = await refuseMigration(
      "failed-record-reject",
      true,
      true,
      true
    );
    releaseKill();
    await waitFor(() => Promise.resolve(!isAlive(pid)), "the failed migration's stopped command");
    expect(await exists(path.join(outputDir, "exit_code"))).toBe(false);
    expect(await manager.hasOrphanedRunningBackgroundProcesses(ws)).toBe(true);
  }, 20_000);

  test("a migration whose exit is never confirmed blocks removal but not session disposal", async () => {
    const { manager, ws, releaseKill } = await refuseMigration("join-reject", true, false, true);
    // The kill takes effect, but the runtime reports an error instead of the exit: that does not
    // confirm the stop, so the migration stays pending.
    releaseKill();
    // Session disposal (agentSession.ts) deletes nothing: it finishes and releases its admission
    // seal, so the workspace can send commands to the background again (#5589).
    const disposal = manager.cleanup(ws).then(() => "finished");
    expect(await Promise.race([disposal, Bun.sleep(2_000).then(() => "waiting")])).toBe("finished");
    const later = manager.beginMigration(ws);
    expect(later.admitted).toBe(true);
    later[Symbol.dispose]();
    // A removal's cleanup (workspaceService.ts) deletes the checkout once it returns, so it keeps
    // waiting for the unconfirmed stop (and fails closed at its drain deadline).
    const removal = manager.cleanup(ws, { failClosedAfterDrainTimeout: true }).then(
      () => "finished",
      () => "failed closed"
    );
    expect(await Promise.race([removal, Bun.sleep(500).then(() => "waiting")])).toBe("waiting");
  }, 20_000);
});
