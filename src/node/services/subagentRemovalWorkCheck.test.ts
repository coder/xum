import * as path from "path";
import * as os from "os";
import * as fsPromises from "fs/promises";
import { execSync } from "child_process";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { initGitRepo } from "@/node/services/taskService.testHarness";
import { findUnpreservedSubagentWork } from "./subagentRemovalWorkCheck";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf-8" }).trim();
}

function readyArtifact(headCommitSha: string): SubagentGitPatchArtifact {
  const project = { projectPath: "/proj", projectName: "repo", storageKey: "repo" };
  return {
    childTaskId: "child",
    parentWorkspaceId: "parent",
    createdAtMs: 1,
    status: "ready",
    projectArtifacts: [{ ...project, status: "ready", headCommitSha, commitCount: 1 }],
    readyProjectCount: 1,
    failedProjectCount: 0,
    skippedProjectCount: 0,
    totalCommitCount: 1,
  };
}

describe("findUnpreservedSubagentWork", () => {
  let rootDir: string;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "subagent-removal-check-"));
    repo = path.join(rootDir, "child");
    await fsPromises.mkdir(repo);
    initGitRepo(repo);
    base = git(repo, "rev-parse HEAD");
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  function check(
    options: { patchArtifact?: SubagentGitPatchArtifact | null; base?: string | null } = {}
  ) {
    const taskBase: Record<string, string> =
      options.base === null ? {} : { "/proj": options.base ?? base };
    return findUnpreservedSubagentWork({
      runtime: new LocalRuntime(rootDir),
      projectRepos: [{ projectPath: "/proj", projectName: "repo", repoCwd: repo }],
      patchArtifact: options.patchArtifact ?? null,
      taskBaseCommitShaByProjectPath: taskBase,
    });
  }

  test("a clean checkout with no new commits has nothing to preserve", async () => {
    expect(await check()).toEqual({ success: true, data: { kind: "none" } });
  });

  test("lists uncommitted and untracked paths but not ignored files", async () => {
    await fsPromises.writeFile(path.join(repo, "README.md"), "edited\n");
    await fsPromises.mkdir(path.join(repo, "notes"));
    await fsPromises.writeFile(path.join(repo, "notes", "draft.md"), "draft\n");
    await fsPromises.writeFile(path.join(repo, ".gitignore"), "build/\n");
    await fsPromises.mkdir(path.join(repo, "build"));
    await fsPromises.writeFile(path.join(repo, "build", "out.js"), "generated\n");

    const result = await check();
    expect(result.success).toBe(true);
    expect(result.success ? result.data : null).toEqual({
      kind: "lossy",
      paths: [".gitignore", "README.md", "notes/"],
      uncapturedCommitCount: 0,
    });
  });

  test("commits are preserved only by a ready artifact that captured the current head", async () => {
    execSync("git commit --allow-empty -m work", { cwd: repo, stdio: "ignore" });
    const head = git(repo, "rev-parse HEAD");

    // No artifact: the commit lives only on the branch that removal deletes.
    expect(await check()).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 1 },
    });
    expect(await check({ patchArtifact: readyArtifact(head) })).toEqual({
      success: true,
      data: { kind: "none" },
    });

    // A stale artifact (the child committed again after it was captured) does not cover the tip.
    execSync("git commit --allow-empty -m more", { cwd: repo, stdio: "ignore" });
    expect(await check({ patchArtifact: readyArtifact(head) })).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 2 },
    });

    // Without a task base there is no way to tell new commits apart, so refuse to guess.
    expect((await check({ base: null })).success).toBe(false);
  });

  test("a merge commit is never treated as captured, since format-patch drops merge resolutions", async () => {
    execSync("git checkout -q -b side && git commit -q --allow-empty -m side", { cwd: repo });
    execSync("git checkout -q main && git commit -q --allow-empty -m main", { cwd: repo });
    execSync("git merge -q --no-ff --no-edit side", { cwd: repo });
    const head = git(repo, "rev-parse HEAD");
    expect(await check({ patchArtifact: readyArtifact(head) })).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 3 },
    });
  });

  test("fails closed when an existing checkout cannot be inspected", async () => {
    await fsPromises.rm(path.join(repo, ".git"), { recursive: true, force: true });
    await fsPromises.writeFile(path.join(repo, ".git"), "gitdir: /nonexistent/worktree\n");
    expect((await check()).success).toBe(false);
  });

  test("never runs checkout-configured repository automation", async () => {
    const marker = path.join(rootDir, "fsmonitor-ran");
    const hook = path.join(rootDir, "fsmonitor.sh");
    await fsPromises.writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(repo, `config core.fsmonitor ${hook}`);
    await fsPromises.writeFile(path.join(repo, "notes.txt"), "draft\n");
    expect((await check()).success).toBe(true);
    expect(await fsPromises.stat(marker).catch(() => null)).toBeNull();
  });

  test("skips checkouts that are gone or are not git work trees", async () => {
    await fsPromises.rm(repo, { recursive: true, force: true });
    expect(await check()).toEqual({ success: true, data: { kind: "none" } });

    // Scratch sub-agents run in plain copied directories, which this check cannot judge.
    await fsPromises.mkdir(repo);
    await fsPromises.writeFile(path.join(repo, "scratch.txt"), "notes\n");
    expect(await check()).toEqual({ success: true, data: { kind: "none" } });
  });
});
