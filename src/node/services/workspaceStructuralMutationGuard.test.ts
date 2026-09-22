import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
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
