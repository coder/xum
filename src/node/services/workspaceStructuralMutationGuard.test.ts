import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
});
