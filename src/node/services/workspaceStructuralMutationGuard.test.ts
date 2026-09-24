import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import { deriveHostLocalCheckoutPath } from "./taskCheckoutPreparation";
import {
  classifyStructuralMutationTarget,
  findProtectedFootprintOverlap,
  isProtectedTaskRow,
} from "./workspaceStructuralMutationGuard";

/**
 * Proof-bearing rows: the producer's `taskCheckoutPreparation` field is not in this
 * checkout's config schema yet, so these rows are built in memory (the service-level
 * suite covers every real-file path). What matters is the branch: a PRESENT proof
 * protects regardless of parent/runtime, and its saved paths join the footprint.
 */
describe("workspaceStructuralMutationGuard proof-bearing rows", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(tmpdir(), "xum-structural-guard-"));
  });
  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function withProof(row: Workspace, proof: unknown): Workspace {
    return Object.assign({}, row, { taskCheckoutPreparation: proof });
  }

  test("a present proof protects a row whose runtime flipped off-host or whose parent link is gone", () => {
    const proof = { v: 1, path: "/srv/x", realpath: "/srv/x" };
    expect(
      isProtectedTaskRow(
        withProof(
          {
            path: "/srv/x",
            id: "t1",
            parentWorkspaceId: "root",
            runtimeConfig: { type: "ssh", host: "box.invalid", srcBaseDir: "/srv" },
          },
          proof
        )
      )
    ).toBe(true);
    expect(isProtectedTaskRow(withProof({ path: "/srv/x", id: "t2" }, proof))).toBe(true);
    // Malformed-but-present proof (retained by the schema as unknown) still protects.
    expect(isProtectedTaskRow(withProof({ path: "/srv/x", id: "t3" }, "garbage"))).toBe(true);
    // Without a proof, an off-host task row and an ordinary root are not protected rows.
    expect(
      isProtectedTaskRow({
        path: "/srv/x",
        id: "t4",
        parentWorkspaceId: "root",
        runtimeConfig: { type: "ssh", host: "box.invalid", srcBaseDir: "/srv" },
      })
    ).toBe(false);
    expect(isProtectedTaskRow({ path: "/srv/x", id: "r1" })).toBe(false);
  });

  test("a proof's saved path and gitdir pointer protect a root that aliases them", async () => {
    const rootCheckout = path.join(tempDir, "src", "repo", "root");
    const gitAdminDir = path.join(tempDir, "repo", ".git", "worktrees", "task");
    await fsPromises.mkdir(rootCheckout, { recursive: true });
    await fsPromises.mkdir(gitAdminDir, { recursive: true });
    const projectPath = path.join(tempDir, "repo");
    const root: Workspace = { path: rootCheckout, id: "root", name: "root" };
    // The task row was re-pointed elsewhere, but its immutable proof still names the
    // root's checkout as the prepared path.
    const task = withProof(
      { path: path.join(tempDir, "elsewhere"), id: "task", parentWorkspaceId: "root" },
      {
        v: 1,
        path: rootCheckout,
        realpath: rootCheckout,
        gitdir: { pointer: gitAdminDir, dev: "1", ino: "2" },
      }
    );
    const snapshot: ProjectsConfig = {
      projects: new Map([[projectPath, { workspaces: [root, task] }]]),
    };

    expect(classifyStructuralMutationTarget(snapshot, "task").kind).toBe("protected-task");
    expect(
      await findProtectedFootprintOverlap(snapshot, { row: root, bucketProjectPath: projectPath })
    ).toMatchObject({ kind: "overlap", taskWorkspaceId: "task", taskPath: rootCheckout });
    // Deleting the repository's .git admin directory (a project-dir root) is an overlap too.
    const repoRoot: Workspace = { path: projectPath, id: "repo-root", name: "repo" };
    expect(
      await findProtectedFootprintOverlap(
        { projects: new Map([[projectPath, { workspaces: [repoRoot, task] }]]) },
        { row: repoRoot, bucketProjectPath: projectPath }
      )
    ).toMatchObject({ kind: "overlap", taskWorkspaceId: "task", taskPath: gitAdminDir });
  });

  test("a v2 proof's secondary checkout paths (a list of identities) protect a root that aliases them", async () => {
    const projectPath = path.join(tempDir, "repo");
    const secondaryProjectPath = path.join(tempDir, "repo2");
    const rootCheckout = path.join(tempDir, "src", "repo2", "root");
    await fsPromises.mkdir(rootCheckout, { recursive: true });
    const elsewhere = path.join(tempDir, "elsewhere");
    const identity = (checkout: string, pointer: string) => ({
      path: checkout,
      realpath: checkout,
      root: { dev: "1", ino: "2" },
      gitdir: { pointer, dev: "1", ino: "3" },
    });
    // Only the SECONDARY identity names the root's checkout and the second repository's admin
    // dir; the row and its primary identity point elsewhere.
    const task = withProof(
      { path: elsewhere, id: "task", parentWorkspaceId: "root" },
      {
        v: 2,
        ...identity(elsewhere, path.join(projectPath, ".git", "worktrees", "task")),
        secondaries: [
          {
            projectPath: secondaryProjectPath,
            ...identity(rootCheckout, path.join(secondaryProjectPath, ".git", "worktrees", "task")),
          },
        ],
      }
    );
    const root: Workspace = { path: rootCheckout, id: "root", name: "root" };
    expect(
      await findProtectedFootprintOverlap(
        { projects: new Map([[projectPath, { workspaces: [root, task] }]]) },
        { row: root, bucketProjectPath: projectPath }
      )
    ).toMatchObject({ kind: "overlap", taskWorkspaceId: "task", taskPath: rootCheckout });
    // A project-dir root of the second repository holds the secondary's admin dir.
    const repoRoot: Workspace = { path: secondaryProjectPath, id: "repo2-root", name: "repo2" };
    expect(
      await findProtectedFootprintOverlap(
        { projects: new Map([[secondaryProjectPath, { workspaces: [repoRoot, task] }]]) },
        { row: repoRoot, bucketProjectPath: secondaryProjectPath }
      )
    ).toMatchObject({
      kind: "overlap",
      taskWorkspaceId: "task",
      taskPath: path.join(secondaryProjectPath, ".git", "worktrees", "task"),
    });
  });

  test("a protected row sharing the target's id (malformed duplicate) makes the target ambiguous, and the scan still excludes only the exact target entry", async () => {
    const projectPath = path.join(tempDir, "repo");
    const rootCheckout = path.join(tempDir, "src", "repo", "root");
    await fsPromises.mkdir(rootCheckout, { recursive: true });
    const root: Workspace = { path: rootCheckout, id: "dup", name: "root" };
    const task: Workspace = {
      path: rootCheckout,
      id: "dup",
      name: "agent_dup",
      parentWorkspaceId: "other",
      taskIsolation: "none",
    };
    // Off-host first row in another bucket: classifying by the first row alone would skip
    // the footprint scan entirely.
    const offHost: Workspace = {
      path: "/srv/dup",
      id: "dup",
      name: "dup",
      runtimeConfig: { type: "ssh", host: "box.invalid", srcBaseDir: "/srv" },
    };
    const snapshot: ProjectsConfig = {
      projects: new Map([[projectPath, { workspaces: [root, task] }]]),
    };

    expect(classifyStructuralMutationTarget(snapshot, "dup")).toEqual({
      kind: "ambiguous",
      count: 2,
    });
    expect(
      classifyStructuralMutationTarget(
        {
          projects: new Map([
            ["/srv/other", { workspaces: [offHost] }],
            [projectPath, { workspaces: [task] }],
          ]),
        },
        "dup"
      )
    ).toEqual({ kind: "ambiguous", count: 2 });
    expect(
      await findProtectedFootprintOverlap(snapshot, { row: root, bucketProjectPath: projectPath })
    ).toMatchObject({ kind: "overlap", taskPath: rootCheckout });
  });

  test("a task checkout whose .git file is not a gitdir pointer is unknown backing, not permission", async () => {
    const projectPath = path.join(tempDir, "repo");
    const rootCheckout = path.join(tempDir, "src", "repo", "root");
    const taskCheckout = path.join(tempDir, "src", "repo", "agent_task");
    await fsPromises.mkdir(rootCheckout, { recursive: true });
    await fsPromises.mkdir(taskCheckout, { recursive: true });
    // Disjoint spellings; only the (unreadable) backing could tie the two together.
    await fsPromises.writeFile(path.join(taskCheckout, ".git"), "not a pointer\n");
    const root: Workspace = { path: rootCheckout, id: "root", name: "root" };
    const task: Workspace = {
      path: taskCheckout,
      id: "task",
      name: "agent_task",
      parentWorkspaceId: "root",
    };
    const snapshot: ProjectsConfig = {
      projects: new Map([[projectPath, { workspaces: [root, task] }]]),
    };

    expect(
      await findProtectedFootprintOverlap(snapshot, { row: root, bucketProjectPath: projectPath })
    ).toMatchObject({ kind: "unknown", taskWorkspaceId: "task" });
    // A checkout that IS a repository (`.git` directory) has its backing inside itself: no alias.
    await fsPromises.rm(path.join(taskCheckout, ".git"));
    await fsPromises.mkdir(path.join(taskCheckout, ".git"));
    expect(
      await findProtectedFootprintOverlap(snapshot, { row: root, bucketProjectPath: projectPath })
    ).toEqual({ kind: "none" });
  });

  test("a local-runtime task row's footprint covers every project directory it executes in", async () => {
    const rootCheckout = path.join(tempDir, "src", "repo", "root");
    const primaryProject = path.join(tempDir, "repo");
    // The row's secondary project lives INSIDE the root's checkout; its stored path does not.
    const secondaryProject = path.join(rootCheckout, "nested-project");
    await fsPromises.mkdir(rootCheckout, { recursive: true });
    await fsPromises.mkdir(primaryProject, { recursive: true });
    await fsPromises.mkdir(secondaryProject, { recursive: true });
    const root: Workspace = { path: rootCheckout, id: "root", name: "root" };
    const localTask: Workspace = {
      path: path.join(tempDir, "unrelated-stored"),
      id: "task",
      name: "local-task",
      parentWorkspaceId: "root",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: primaryProject, projectName: "repo" },
        { projectPath: secondaryProject, projectName: "nested-project" },
      ],
    };
    const snapshot: ProjectsConfig = {
      projects: new Map([[primaryProject, { workspaces: [root, localTask] }]]),
    };

    expect(
      await findProtectedFootprintOverlap(snapshot, {
        row: root,
        bucketProjectPath: primaryProject,
      })
    ).toMatchObject({ kind: "overlap", taskWorkspaceId: "task", taskPath: secondaryProject });
  });

  test("a missing runtimeConfig derives through the default worktree runtime under XUM_ROOT, and a tilde srcBaseDir is expanded", async () => {
    // Config.getAllMetadata substitutes DEFAULT_RUNTIME_CONFIG (worktree, `~/.xum/src`) and
    // WorktreeManager expands the tilde through getXumHome(): the runtime acts on
    // <XUM_ROOT>/src/<project>/<name>, so that is the footprint — never the literal spelling.
    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = tempDir;
    try {
      const projectPath = path.join(tempDir, "repo");
      const derivedRoot = path.join(tempDir, "src", "repo", "root");
      const derivedTask = path.join(tempDir, "src", "repo", "agent_task");
      for (const dir of [projectPath, derivedRoot, derivedTask, path.join(tempDir, "stale")]) {
        await fsPromises.mkdir(dir, { recursive: true });
      }
      const explicitWorktree = { type: "worktree", srcBaseDir: path.join(tempDir, "src") } as const;
      const scan = (root: Workspace, task: Workspace) =>
        findProtectedFootprintOverlap(
          { projects: new Map([[projectPath, { workspaces: [root, task] }]]) },
          { row: root, bucketProjectPath: projectPath }
        );

      // Legacy root without a runtimeConfig and a stale stored path; the task sits at the
      // root's default-derived target.
      const legacyRoot: Workspace = { path: path.join(tempDir, "stale"), id: "root", name: "root" };
      const taskAtTarget: Workspace = {
        path: derivedRoot,
        id: "task",
        name: "agent_task",
        parentWorkspaceId: "root",
        runtimeConfig: explicitWorktree,
      };
      expect(await scan(legacyRoot, taskAtTarget)).toMatchObject({
        kind: "overlap",
        taskWorkspaceId: "task",
        targetPath: derivedRoot,
      });
      // Legacy TASK without a runtimeConfig and a stale stored path; the root's checkout is
      // the task's default-derived location.
      const rootAtTaskTarget: Workspace = {
        path: derivedTask,
        id: "root",
        name: "agent_task",
        runtimeConfig: explicitWorktree,
      };
      const legacyTask: Workspace = {
        path: path.join(tempDir, "stale"),
        id: "task",
        name: "agent_task",
        parentWorkspaceId: "other-root",
      };
      expect(await scan(rootAtTaskTarget, legacyTask)).toMatchObject({
        kind: "overlap",
        taskWorkspaceId: "task",
        taskPath: derivedTask,
      });
      // An explicit `~/.xum/src` srcBaseDir aliases <XUM_ROOT>/src.
      const tildeRoot: Workspace = {
        path: path.join(tempDir, "stale"),
        id: "root",
        name: "root",
        runtimeConfig: { type: "worktree", srcBaseDir: "~/.xum/src" },
      };
      expect(await scan(tildeRoot, taskAtTarget)).toMatchObject({
        kind: "overlap",
        taskWorkspaceId: "task",
        targetPath: derivedRoot,
      });
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });

  test("devcontainer rows are host worktrees under <XUM_ROOT>/src: a task row is protected, a root is scanned, both derive their checkout", async () => {
    // DevcontainerRuntime keeps its checkout on the host through a WorktreeManager rooted at
    // `new Config().srcDir` (runtimeFactory) — <XUM_ROOT>/src — though its runtimeConfig
    // carries no srcBaseDir. Preparation exempts these rows (no plugin consent to protect);
    // the structural guard must not.
    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = tempDir;
    try {
      const devcontainer = { type: "devcontainer", configPath: ".devcontainer/x.json" } as const;
      const projectPath = path.join(tempDir, "repo");
      const derivedRoot = path.join(tempDir, "src", "repo", "root");
      const derivedTask = path.join(tempDir, "src", "repo", "agent_task");
      const stale = path.join(tempDir, "stale");
      for (const dir of [projectPath, derivedRoot, derivedTask, stale]) {
        await fsPromises.mkdir(dir, { recursive: true });
      }
      const worktree = { type: "worktree", srcBaseDir: path.join(tempDir, "src") } as const;
      const snapshotOf = (...workspaces: Workspace[]): ProjectsConfig => ({
        projects: new Map([[projectPath, { workspaces }]]),
      });

      // Rename's destination derivation must land in the host worktree, not the project dir.
      expect(deriveHostLocalCheckoutPath(devcontainer, projectPath, "root")).toBe(derivedRoot);

      const devTask: Workspace = {
        path: stale,
        id: "task",
        name: "agent_task",
        parentWorkspaceId: "other-root",
        runtimeConfig: devcontainer,
      };
      expect(isProtectedTaskRow(devTask)).toBe(true);
      const rootAtTaskTarget: Workspace = {
        path: derivedTask,
        id: "root",
        name: "r",
        runtimeConfig: worktree,
      };
      expect(classifyStructuralMutationTarget(snapshotOf(devTask), "task")).toMatchObject({
        kind: "protected-task",
      });
      expect(
        await findProtectedFootprintOverlap(snapshotOf(rootAtTaskTarget, devTask), {
          row: rootAtTaskTarget,
          bucketProjectPath: projectPath,
        })
      ).toMatchObject({ kind: "overlap", taskWorkspaceId: "task", taskPath: derivedTask });

      const devRoot: Workspace = {
        path: stale,
        id: "root",
        name: "root",
        runtimeConfig: devcontainer,
      };
      const taskAtRootTarget: Workspace = {
        path: derivedRoot,
        id: "task",
        name: "t",
        parentWorkspaceId: "root",
        runtimeConfig: worktree,
      };
      const snapshot = snapshotOf(devRoot, taskAtRootTarget);
      expect(classifyStructuralMutationTarget(snapshot, "root")).toMatchObject({
        kind: "host-local-root",
        bucketProjectPath: projectPath,
      });
      expect(
        await findProtectedFootprintOverlap(snapshot, {
          row: devRoot,
          bucketProjectPath: projectPath,
        })
      ).toMatchObject({ kind: "overlap", taskWorkspaceId: "task", targetPath: derivedRoot });
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });

  test.skipIf(process.platform === "win32")(
    "a symlinked or special .git entry is unknown backing: never followed, never opened",
    async () => {
      const projectPath = path.join(tempDir, "repo");
      const rootCheckout = path.join(tempDir, "src", "repo", "root");
      const taskCheckout = path.join(tempDir, "src", "repo", "agent_task");
      const elsewhere = path.join(tempDir, "elsewhere");
      await fsPromises.mkdir(rootCheckout, { recursive: true });
      await fsPromises.mkdir(taskCheckout, { recursive: true });
      await fsPromises.mkdir(path.join(elsewhere, "repo.git"), { recursive: true });
      // A valid pointer file living OUTSIDE the checkout, reachable only through a symlink.
      await fsPromises.writeFile(
        path.join(elsewhere, "pointer"),
        `gitdir: ${path.join(elsewhere, "repo.git", "worktrees", "task")}\n`
      );
      const root: Workspace = { path: rootCheckout, id: "root", name: "root" };
      const task: Workspace = {
        path: taskCheckout,
        id: "task",
        name: "agent_task",
        parentWorkspaceId: "root",
      };
      const snapshot: ProjectsConfig = {
        projects: new Map([[projectPath, { workspaces: [root, task] }]]),
      };
      const gitEntry = path.join(taskCheckout, ".git");
      const scan = () =>
        findProtectedFootprintOverlap(snapshot, { row: root, bucketProjectPath: projectPath });

      // Symlink to a directory: following it would look like "a repository inside the
      // checkout" (no alias) while the real backing lives elsewhere.
      await fsPromises.symlink(path.join(elsewhere, "repo.git"), gitEntry);
      expect(await scan()).toMatchObject({ kind: "unknown", taskWorkspaceId: "task" });
      // Symlink to a regular pointer file: following it would read a pointer the checkout
      // does not own.
      await fsPromises.rm(gitEntry);
      await fsPromises.symlink(path.join(elsewhere, "pointer"), gitEntry);
      expect(await scan()).toMatchObject({ kind: "unknown", taskWorkspaceId: "task" });
      // A FIFO: an unguarded open/read would block a libuv worker forever; the scan must
      // refuse without opening it.
      await fsPromises.rm(gitEntry);
      execFileSync("mkfifo", [gitEntry]);
      expect(await scan()).toMatchObject({ kind: "unknown", taskWorkspaceId: "task" });
    }
  );
});
