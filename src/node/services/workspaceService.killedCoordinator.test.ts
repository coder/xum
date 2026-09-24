import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { RuntimeConfig } from "@/common/types/runtime";
import { Config, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import {
  TASK_CHECKOUT_PREPARATION_NONCE_FILE,
  validateTaskCheckoutPreparation,
} from "@/node/services/taskCheckoutPreparation";
import {
  prepareDedicatedTaskCheckout,
  prepareExistingTaskCheckout,
} from "@/node/services/taskCheckoutPreparation.testHarness";
import { createTestProject, saveWorkspaces } from "@/node/services/taskService.testHarness";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";

/**
 * Killed-coordinator writer evidence. A coordinator process running the real create rollback
 * (abortUnsanitizedCreation → WorktreeRuntime.deleteWorkspace → git) under the registration lock
 * is SIGKILLed while its git child is held mid-flight by a PATH-shimmed `git` wrapper (a FIFO
 * barrier before the real git runs). The orphaned git child then completes after a successor has
 * taken the registration lock (its holder is provably dead) — and must not damage the successor's
 * protected task checkout (files, Git admin entry, preparation nonce), which must still validate
 * ready, nor the successor's own operation.
 *
 * Every wait below is on an explicit signal (barrier files, the FIFO, process exit, the shim's
 * completion marker); none uses elapsed time as evidence.
 */
const FIXTURE = path.join(import.meta.dir, "workspaceService.killedCoordinator.fixture.ts");
const REGISTRATION_LOCK = "workspace-registration.lock";
const ROOT_ID = "kc-root";
const PROTECTED_ID = "kcprotect01";

/**
 * `git` shim: once armed (the registration lock exists, i.e. inside the coordinator's
 * registration/rollback hold) the FIRST invocation whose arguments contain KC_MATCH records its
 * pid, detaches its output from the (soon dead) coordinator's pipes, blocks on the release FIFO,
 * then runs the real git and writes a completion marker. Every other invocation passes through.
 */
const SHIM = `#!/bin/bash
if [ -e "$KC_ARM_FILE" ] && [ ! -e "$KC_DIR/claimed" ]; then
  case " $* " in
    *" $KC_MATCH "*)
      : > "$KC_DIR/claimed"
      exec >>"$KC_DIR/orphan.log" 2>&1 </dev/null
      echo $$ > "$KC_DIR/held.tmp" && mv "$KC_DIR/held.tmp" "$KC_DIR/held"
      read -r _ < "$KC_DIR/release"
      "$KC_REAL_GIT" "$@"
      rc=$?
      echo $rc > "$KC_DIR/done.tmp" && mv "$KC_DIR/done.tmp" "$KC_DIR/done"
      exit $rc
      ;;
  esac
fi
exec "$KC_REAL_GIT" "$@"
`;

/** Smudge filter for the successor's `git worktree add`: signals, blocks on a FIFO, then copies. */
const SMUDGE = `#!/bin/bash
: > "$KC_DIR/smudge.reached"
read -r _ < "$KC_DIR/smudge.release"
cat
`;

async function exists(target: string): Promise<boolean> {
  return fsPromises
    .access(target)
    .then(() => true)
    .catch(() => false);
}

/** Wait for an explicit signal; the deadline only turns a hang into a readable failure. */
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  label: string,
  diagnostics: () => string = () => ""
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${diagnostics()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Relative path → content hash (files), link target (symlinks), or "dir". */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await fsPromises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out[rel] = "dir";
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        out[rel] = `link:${await fsPromises.readlink(full)}`;
      } else {
        const stat = await fsPromises.stat(full);
        out[rel] =
          `${(stat.mode & 0o777).toString(8)}:` +
          createHash("sha256")
            .update(await fsPromises.readFile(full))
            .digest("hex");
      }
    }
  }
  await walk(root);
  return out;
}

/** A process that is gone or a zombie (an orphan's reaper may be slow or absent in containers). */
function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = execFileSync("cat", [`/proc/${pid}/stat`], { encoding: "utf-8" });
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("killed coordinator: an orphaned rollback git writer vs a successor", () => {
  let rootDir: string;
  let projectPath: string;
  let config: Config;
  let worktree: RuntimeConfig;
  let barrierDir: string;
  let shimDir: string;
  let protectedCheckout: string;
  let protectedAdminDir: string;
  let coordinator: ChildProcess | undefined;
  const coordinatorOutput: string[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  const lockPath = () => path.join(rootDir, REGISTRATION_LOCK);
  const lockHolderPid = async (): Promise<number | undefined> => {
    try {
      return (JSON.parse(await fsPromises.readFile(lockPath(), "utf-8")) as { pid: number }).pid;
    } catch {
      return undefined;
    }
  };
  const protectedSnapshot = async () => ({
    checkout: await snapshotTree(protectedCheckout),
    admin: await snapshotTree(protectedAdminDir),
    nonce: await fsPromises.readFile(
      path.join(protectedAdminDir, TASK_CHECKOUT_PREPARATION_NONCE_FILE),
      "utf-8"
    ),
  });
  const taskRow = (
    id: string,
    checkout: string,
    extra: Partial<WorkspaceConfigEntry> = {}
  ): WorkspaceConfigEntry => ({
    id,
    name: `agent_explore_${id}`,
    path: checkout,
    runtimeConfig: worktree,
    parentWorkspaceId: ROOT_ID,
    agentType: "explore",
    taskStatus: "reported",
    ...extra,
  });
  const diagnostics = () =>
    `coordinator output:\n${coordinatorOutput.join("")}\nbarrier dir: ${barrierDir}`;

  beforeEach(async () => {
    rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(tmpdir(), "xum-killed-coordinator-"))
    );
    coordinatorOutput.length = 0;
    projectPath = await createTestProject(rootDir, "repo");
    // A tracked file carrying a filter attribute: inert unless a command configures the filter
    // (only the successor's add in the prune scenario does, to hold itself mid-initialization).
    await fsPromises.writeFile(
      path.join(projectPath, ".gitattributes"),
      "hold.txt filter=kchold\n"
    );
    await fsPromises.writeFile(path.join(projectPath, "hold.txt"), "held content\n");
    git(projectPath, "add", ".gitattributes", "hold.txt");
    git(projectPath, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-qm", "hold");
    config = new Config(rootDir);
    worktree = { type: "worktree", srcBaseDir: config.srcDir };
    await fsPromises.mkdir(config.srcDir, { recursive: true });

    // The successor's protected checkout: a real worktree, claimed and bound (nonce present),
    // published on a task row that validates ready.
    protectedCheckout = path.join(config.srcDir, "repo", `agent_explore_${PROTECTED_ID}`);
    const proof = await prepareDedicatedTaskCheckout({
      projectPath,
      checkout: protectedCheckout,
      branch: PROTECTED_ID,
      runtimeConfig: worktree,
    });
    await saveWorkspaces(config, projectPath, [
      { id: ROOT_ID, name: "root", path: projectPath, runtimeConfig: { type: "local" } },
      taskRow(PROTECTED_ID, protectedCheckout, { taskCheckoutPreparation: proof }),
    ]);
    protectedAdminDir = path.resolve(
      protectedCheckout,
      git(protectedCheckout, "rev-parse", "--git-dir")
    );
    expect(await exists(path.join(protectedAdminDir, TASK_CHECKOUT_PREPARATION_NONCE_FILE))).toBe(
      true
    );
    expect(await validateTaskCheckoutPreparation(config, PROTECTED_ID)).toMatchObject({
      kind: "ready",
    });

    barrierDir = path.join(rootDir, "barrier");
    shimDir = path.join(rootDir, "shim");
    await fsPromises.mkdir(barrierDir);
    await fsPromises.mkdir(shimDir);
    await fsPromises.writeFile(path.join(shimDir, "git"), SHIM, { mode: 0o755 });
    await fsPromises.writeFile(path.join(barrierDir, "smudge.sh"), SMUDGE, { mode: 0o755 });
    execFileSync("mkfifo", [
      path.join(barrierDir, "release"),
      path.join(barrierDir, "smudge.release"),
    ]);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    if (coordinator?.exitCode === null && coordinator.signalCode === null) {
      coordinator.kill("SIGKILL");
    }
    coordinator = undefined;
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  /**
   * Start the coordinator, wait for its git child at the barrier, confirm it holds the
   * registration lock, SIGKILL it (reaped here, so its pid is dead), and return the orphan's pid.
   */
  async function killCoordinatorAtBarrier(mode: "remove" | "prune"): Promise<number> {
    const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    const child = spawn(process.execPath, [FIXTURE, rootDir, projectPath, mode], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        XUM_ROOT: rootDir,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        KC_REAL_GIT: realGit,
        KC_DIR: barrierDir,
        KC_ARM_FILE: lockPath(),
        KC_MATCH: mode === "remove" ? "worktree remove" : "worktree prune",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    coordinator = child;
    child.stdout?.on("data", (chunk: Buffer) => coordinatorOutput.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => coordinatorOutput.push(chunk.toString()));
    const exited = once(child, "exit");
    await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`coordinator exited before the barrier\n${diagnostics()}`);
        }
        return exists(path.join(barrierDir, "held"));
      },
      "the coordinator's git child at the barrier",
      diagnostics
    );
    const orphanPid = Number(
      (await fsPromises.readFile(path.join(barrierDir, "held"), "utf-8")).trim()
    );
    expect(Number.isInteger(orphanPid) && orphanPid > 0).toBe(true);
    // The rollback runs inside the coordinator's registration-lock hold.
    expect(await lockHolderPid()).toBe(child.pid);

    child.kill("SIGKILL");
    await exited;
    expect(child.signalCode).toBe("SIGKILL");
    // The git child survived its coordinator.
    expect(processExited(orphanPid)).toBe(false);
    cleanups.push(async () => {
      // Never leave a held orphan behind a failed assertion: release it and let it finish.
      if (!(await exists(path.join(barrierDir, "done"))) && !processExited(orphanPid)) {
        await fsPromises.writeFile(path.join(barrierDir, "release"), "go\n");
        await waitFor(() => processExited(orphanPid), "the orphan to exit during cleanup");
      }
    });
    return orphanPid;
  }

  /** The successor takes the registration lock with production parameters (dead holder). */
  async function successorAcquire(): Promise<() => Promise<void>> {
    const release = await acquireCrossProcessLock({
      lockPath: lockPath(),
      acquireTimeoutMs: 10_000,
      staleMs: 5 * 60_000,
      timeoutMessage: "registration lock still held",
    });
    expect(await lockHolderPid()).toBe(process.pid);
    return release;
  }

  async function releaseOrphan(orphanPid: number): Promise<number> {
    await fsPromises.writeFile(path.join(barrierDir, "release"), "go\n");
    await waitFor(() => exists(path.join(barrierDir, "done")), "the orphan's completion marker");
    await waitFor(() => processExited(orphanPid), "the orphan to exit");
    return Number((await fsPromises.readFile(path.join(barrierDir, "done"), "utf-8")).trim());
  }

  async function expectSuccessorPreparesTask(taskId: string, checkout: string, add: boolean) {
    const proof = add
      ? await prepareDedicatedTaskCheckout({
          projectPath,
          checkout,
          branch: taskId,
          runtimeConfig: worktree,
        })
      : await prepareExistingTaskCheckout({ workspacePath: checkout, runtimeConfig: worktree });
    await config.editConfig((cfg) => {
      cfg.projects
        .get(projectPath)!
        .workspaces.push(taskRow(taskId, checkout, { taskCheckoutPreparation: proof }));
      return cfg;
    });
    expect(await validateTaskCheckoutPreparation(config, taskId)).toMatchObject({ kind: "ready" });
  }

  test("an orphaned `git worktree remove` from a killed rollback finishes under the successor's lock without touching its protected checkout", async () => {
    const before = await protectedSnapshot();
    const orphanPid = await killCoordinatorAtBarrier("remove");
    const ordinaryCheckout = path.join(config.srcDir, "repo", "ordinary");
    // The coordinator died after the config rollback, mid checkout removal.
    expect(await exists(ordinaryCheckout)).toBe(true);
    expect(
      [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .map((row) => row.id)
        .sort()
    ).toEqual([ROOT_ID, PROTECTED_ID].sort());

    const releaseLock = await successorAcquire();
    try {
      expect(await releaseOrphan(orphanPid)).toBe(0);
      // The orphan did its (bounded) work: only the ordinary checkout and its admin entry.
      expect(await exists(ordinaryCheckout)).toBe(false);
      expect(await exists(path.join(projectPath, ".git", "worktrees", "ordinary"))).toBe(false);

      expect(await protectedSnapshot()).toEqual(before);
      expect(await validateTaskCheckoutPreparation(config, PROTECTED_ID)).toMatchObject({
        kind: "ready",
      });
      // The successor's own operation succeeds.
      await expectSuccessorPreparesTask(
        "kcsucc01",
        path.join(config.srcDir, "repo", "agent_explore_kcsucc01"),
        true
      );
    } finally {
      await releaseLock();
    }
    expect(await protectedSnapshot()).toEqual(before);
  }, 120_000);

  test("an orphaned `git worktree prune` from a killed rollback runs while the successor's `git worktree add` initializes: the locked entry survives", async () => {
    const before = await protectedSnapshot();
    const orphanPid = await killCoordinatorAtBarrier("prune");
    const staleAdmin = path.join(projectPath, ".git", "worktrees", "ordinary");
    // The fault injection deleted the ordinary checkout; its admin entry is stale.
    expect(await exists(path.join(config.srcDir, "repo", "ordinary"))).toBe(false);
    expect(await exists(staleAdmin)).toBe(true);

    const releaseLock = await successorAcquire();
    try {
      // The successor starts a new task checkout; the smudge filter holds it mid-initialization.
      const successorCheckout = path.join(config.srcDir, "repo", "agent_explore_kcsucc02");
      const add = spawn(
        "git",
        [
          "-c",
          `filter.kchold.smudge=${path.join(barrierDir, "smudge.sh")}`,
          "-c",
          "filter.kchold.required=true",
          "worktree",
          "add",
          "-q",
          "-b",
          "kcsucc02",
          successorCheckout,
          "main",
        ],
        { cwd: projectPath, env: { ...process.env, KC_DIR: barrierDir }, stdio: "ignore" }
      );
      const addExited = once(add, "exit");
      await waitFor(
        () => exists(path.join(barrierDir, "smudge.reached")),
        "the successor's add at its smudge barrier"
      );
      const successorAdmin = path.join(projectPath, ".git", "worktrees", "agent_explore_kcsucc02");
      expect((await fsPromises.readFile(path.join(successorAdmin, "locked"), "utf-8")).trim()).toBe(
        "initializing"
      );

      expect(await releaseOrphan(orphanPid)).toBe(0);
      // The orphaned prune removed the stale entry and nothing else.
      expect(await exists(staleAdmin)).toBe(false);
      expect(await exists(path.join(successorAdmin, "gitdir"))).toBe(true);
      expect(await exists(path.join(successorAdmin, "locked"))).toBe(true);
      expect(await protectedSnapshot()).toEqual(before);

      await fsPromises.writeFile(path.join(barrierDir, "smudge.release"), "go\n");
      await addExited;
      expect(add.exitCode).toBe(0);
      expect(await exists(path.join(successorAdmin, "locked"))).toBe(false);
      expect(await fsPromises.readFile(path.join(successorCheckout, "hold.txt"), "utf-8")).toBe(
        "held content\n"
      );
      await expectSuccessorPreparesTask("kcsucc02", successorCheckout, false);
      expect(await validateTaskCheckoutPreparation(config, PROTECTED_ID)).toMatchObject({
        kind: "ready",
      });
    } finally {
      await releaseLock();
    }
    expect(await protectedSnapshot()).toEqual(before);
  }, 120_000);

  // The barrier above holds the successor's add at checkout, after git has already written the
  // admin entry's `gitdir` (pointing at the existing new directory), so that entry would survive
  // the prune even unlocked. The earlier add window — admin directory and `locked` written, no
  // `gitdir` yet — lies inside a single git process and has no external barrier; this checks how
  // the INSTALLED git's prune treats that exact on-disk state (and that it does prune the same
  // state unlocked, i.e. prune's reach is every dangling entry, not only the caller's own).
  test("the installed git's prune keeps an initializing (locked, gitdir-less) admin entry and removes the unlocked one", async () => {
    const worktrees = path.join(projectPath, ".git", "worktrees");
    await fsPromises.mkdir(path.join(worktrees, "initializing"), { recursive: true });
    await fsPromises.writeFile(path.join(worktrees, "initializing", "locked"), "initializing\n");
    await fsPromises.mkdir(path.join(worktrees, "dangling"), { recursive: true });
    const before = await protectedSnapshot();

    git(projectPath, "worktree", "prune");

    expect(await exists(path.join(worktrees, "initializing", "locked"))).toBe(true);
    expect(await exists(path.join(worktrees, "dangling"))).toBe(false);
    expect(await protectedSnapshot()).toEqual(before);
    expect(await validateTaskCheckoutPreparation(config, PROTECTED_ID)).toMatchObject({
      kind: "ready",
    });
  });
});
