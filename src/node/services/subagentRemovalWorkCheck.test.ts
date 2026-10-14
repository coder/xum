import * as path from "path";
import * as os from "os";
import * as fsPromises from "fs/promises";
import { execSync } from "child_process";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";
import { buildSourceRefSnapshotCommand } from "@/node/runtime/gitBundleSync";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { getSubagentGitPatchMboxPath } from "@/node/services/subagentGitPatchArtifacts";
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
    options: {
      patchArtifact?: SubagentGitPatchArtifact | null;
      base?: string | null;
      dockerCopy?: boolean;
    } = {}
  ) {
    const taskBase: Record<string, string> =
      options.base === null ? {} : { "/proj": options.base ?? base };
    return findUnpreservedSubagentWork({
      runtime: new LocalRuntime(rootDir),
      projectRepos: [{ projectPath: "/proj", projectName: "repo", repoCwd: repo }],
      patchArtifact: options.patchArtifact ?? null,
      patchArtifactSessionDir: path.join(rootDir, "sessions"),
      taskBaseCommitShaByProjectPath: taskBase,
      removalDeletesBundleClone: options.dockerCopy ?? false,
    });
  }

  /**
   * Mimics a Docker copy (#4761 gap 2): a clone whose origin/* refs become local branches, with
   * the task branch checked out at the source's main.
   */
  function makeStandaloneCopy() {
    execSync("git checkout -q -b feature && git commit -q --allow-empty -m feature", { cwd: repo });
    execSync("git checkout -q main", { cwd: repo });
    const copy = path.join(rootDir, "copy");
    execSync(`git clone -q ${repo} ${copy}`);
    // A clone does not inherit the source's local identity config; CI runners have no global one.
    execSync('git config user.email "test@example.com" && git config user.name test', {
      cwd: copy,
    });
    execSync("git config commit.gpgsign false", { cwd: copy });
    execSync("git branch feature origin/feature && git checkout -q -b task", { cwd: copy });
    repo = copy;
  }

  test("a Docker copy loses commits on other local branches and the stash (#4761 gap 2)", async () => {
    makeStandaloneCopy();
    // Branches that came from the source are preserved there.
    expect(await check({ dockerCopy: true })).toEqual({ success: true, data: { kind: "none" } });

    // A branch the child committed on and then left dies with the container.
    execSync("git checkout -q -b side && git commit -q --allow-empty -m side", { cwd: repo });
    execSync("git checkout -q task", { cwd: repo });
    expect(await check({ dockerCopy: true })).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 0, otherRefCommitCount: 1 },
    });

    // A stash also lives only in the copy (clones never fetch refs/stash).
    execSync("git branch -D -q side", { cwd: repo });
    await addStash();
    expect(otherRefCount(await check({ dockerCopy: true }))).toBe(2);
  });

  /** Commits that only other branches or the stash hold; throws unless the check succeeded. */
  function otherRefCount(result: Awaited<ReturnType<typeof check>>): number {
    if (!result.success) throw new Error(result.error);
    return result.data.kind === "lossy" ? (result.data.otherRefCommitCount ?? 0) : 0;
  }

  async function addStash() {
    await fsPromises.writeFile(path.join(repo, "README.md"), `stashed ${Math.random()}\n`);
    execSync("git stash -q", { cwd: repo });
  }

  function commitOnSideBranch() {
    execSync("git checkout -q -b side && git commit -q --allow-empty -m side", { cwd: repo });
    execSync("git checkout -q task", { cwd: repo });
  }

  test("a Docker copy without remote-tracking refs counts every other branch and the stash (#5105)", async () => {
    makeStandaloneCopy();
    // A project without an origin URL loses its origin/* refs at creation. With no snapshot either
    // (a copy made before #5105), nothing proves the source has `feature`, so it counts.
    execSync("git remote remove origin", { cwd: repo });
    expect(otherRefCount(await check({ dockerCopy: true }))).toBe(1);
    // A stash is counted even without remote-tracking refs.
    execSync("git branch -D -q feature", { cwd: repo });
    await addStash();
    expect(otherRefCount(await check({ dockerCopy: true }))).toBe(2);
  });

  test("the creation snapshot records the source's branches, so only the child's commits count (#5105)", async () => {
    makeStandaloneCopy();
    // Docker creation writes the snapshot and then removes a URL-less origin.
    execSync(buildSourceRefSnapshotCommand(), { cwd: repo });
    execSync("git remote remove origin", { cwd: repo });
    expect(await check({ dockerCopy: true })).toEqual({ success: true, data: { kind: "none" } });

    commitOnSideBranch();
    expect(otherRefCount(await check({ dockerCopy: true }))).toBe(1);
    execSync("git branch -D -q side", { cwd: repo });
    await addStash();
    expect(otherRefCount(await check({ dockerCopy: true }))).toBe(2);
  });

  test("a cp -R -P copy (SSH fork fallback) counts inherited refs unless the snapshot records them (#5105)", async () => {
    // The source holds a local-only branch and a stash that a `cp` copy inherits.
    execSync("git checkout -q -b local && git commit -q --allow-empty -m local", { cwd: repo });
    execSync("git checkout -q main", { cwd: repo });
    await addStash();
    const copy = path.join(rootDir, "copy");
    execSync(`cp -R -P ${repo} ${copy}`);
    const source = repo;
    repo = copy;
    execSync("git checkout -q -b task", { cwd: repo });
    // Removal runs `rm -rf` on this standalone repository. Without a snapshot the check cannot
    // attribute the inherited refs to the source, so they count (fail closed).
    expect(otherRefCount(await check())).toBe(3);

    // The fork writes the snapshot before creating the task branch.
    execSync(`rm -rf ${copy} && cp -R -P ${source} ${copy}`);
    execSync(buildSourceRefSnapshotCommand(), { cwd: repo });
    execSync("git checkout -q -b task", { cwd: repo });
    expect(await check()).toEqual({ success: true, data: { kind: "none" } });
    await addStash();
    expect(otherRefCount(await check())).toBe(2);
  });

  test("a linked worktree keeps the base..HEAD scope: its repository survives removal", async () => {
    const worktree = path.join(rootDir, "worktree");
    execSync(`git worktree add -q -b task ${worktree}`, { cwd: repo });
    repo = worktree;
    commitOnSideBranch();
    await addStash();
    expect(await check()).toEqual({ success: true, data: { kind: "none" } });
  });

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

  test("reports uncaptured commits alongside dirty paths, and paths even when commits cannot be counted (#5106)", async () => {
    execSync("git commit -q --allow-empty -m work", { cwd: repo });
    await fsPromises.writeFile(path.join(repo, "notes.txt"), "unsaved\n");
    expect(await check()).toEqual({
      success: true,
      data: { kind: "lossy", paths: ["notes.txt"], uncapturedCommitCount: 1 },
    });
    const unknownBase = await check({ base: null });
    expect(unknownBase.success ? unknownBase.data : null).toMatchObject({
      kind: "lossy",
      paths: ["notes.txt"],
      commitCheckError: "the task base commit of repo is unknown",
    });
  });

  test("commits are preserved only by a ready artifact that captured the current head", async () => {
    execSync("git commit --allow-empty -m work", { cwd: repo, stdio: "ignore" });
    const head = git(repo, "rev-parse HEAD");

    // No artifact: the commit lives only on the branch that removal deletes.
    const mbox = getSubagentGitPatchMboxPath(path.join(rootDir, "sessions"), "child", "repo");
    expect(await check()).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 1 },
    });
    // A ready artifact whose mbox is gone no longer preserves anything.
    expect(await check({ patchArtifact: readyArtifact(head) })).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 1 },
    });
    await fsPromises.mkdir(path.dirname(mbox), { recursive: true });
    await fsPromises.writeFile(mbox, "From 0000\n");
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

  test("an mbox path that is not a regular file preserves nothing (#4761 gap 3)", async () => {
    execSync("git commit --allow-empty -m work", { cwd: repo, stdio: "ignore" });
    const head = git(repo, "rev-parse HEAD");
    // task_apply_git_patch only reads a regular file, so a directory there cannot restore the commits.
    const mbox = getSubagentGitPatchMboxPath(path.join(rootDir, "sessions"), "child", "repo");
    await fsPromises.mkdir(mbox, { recursive: true });
    expect(await check({ patchArtifact: readyArtifact(head) })).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 1 },
    });
  });

  test("a merge commit is never treated as captured, since format-patch drops merge resolutions", async () => {
    execSync("git checkout -q -b side && git commit -q --allow-empty -m side", { cwd: repo });
    execSync("git checkout -q main && git commit -q --allow-empty -m main", { cwd: repo });
    execSync("git merge -q --no-ff --no-edit side", { cwd: repo });
    const head = git(repo, "rev-parse HEAD");
    const mbox = getSubagentGitPatchMboxPath(path.join(rootDir, "sessions"), "child", "repo");
    await fsPromises.mkdir(path.dirname(mbox), { recursive: true });
    await fsPromises.writeFile(mbox, "From 0000\n");
    expect(await check({ patchArtifact: readyArtifact(head) })).toEqual({
      success: true,
      data: { kind: "lossy", paths: [], uncapturedCommitCount: 3 },
    });
  });

  test("repo config cannot hide untracked files or submodule edits", async () => {
    const sub = path.join(rootDir, "sub");
    await fsPromises.mkdir(sub);
    initGitRepo(sub);
    execSync(`git -c protocol.file.allow=always submodule -q add ${sub} modules/sub`, {
      cwd: repo,
    });
    execSync("git config -f .gitmodules submodule.modules/sub.ignore all", { cwd: repo });
    execSync("git add -A && git commit -q -m sub", { cwd: repo });
    git(repo, "config status.showUntrackedFiles no");
    await fsPromises.writeFile(path.join(repo, "modules", "sub", "README.md"), "edited\n");
    await fsPromises.writeFile(path.join(repo, "draft.txt"), "draft\n");
    const result = await check({ base: git(repo, "rev-parse HEAD") });
    expect(result.success ? result.data : null).toMatchObject({
      paths: ["draft.txt", "modules/sub"],
    });
  });

  test("fails closed when an existing checkout cannot be inspected", async () => {
    await fsPromises.rm(path.join(repo, ".git"), { recursive: true, force: true });
    await fsPromises.writeFile(path.join(repo, ".git"), "gitdir: /nonexistent/worktree\n");
    expect((await check()).success).toBe(false);
  });

  test("a .git that only looks absent fails closed (#4761 gap 4)", async () => {
    // A dangling symlink makes `[ -e .git ]` false although the checkout is not gone.
    await fsPromises.rm(path.join(repo, ".git"), { recursive: true, force: true });
    await fsPromises.symlink(path.join(rootDir, "missing-git-dir"), path.join(repo, ".git"));
    await fsPromises.writeFile(path.join(repo, "notes.txt"), "draft\n");
    expect((await check()).success).toBe(false);
  });

  test("a checkout hidden behind an unsearchable directory fails closed (#4761 gap 4)", async () => {
    // Root bypasses directory permissions, so the lookup would not fail there.
    if (process.getuid?.() === 0) return;
    await fsPromises.writeFile(path.join(repo, "notes.txt"), "draft\n");
    // Traversal fails with EACCES, which `[ -e ]` also reports as "does not exist".
    await fsPromises.chmod(rootDir, 0o600);
    try {
      expect((await check()).success).toBe(false);
    } finally {
      await fsPromises.chmod(rootDir, 0o700);
    }
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

    // A plain directory has no git state this check can judge.
    await fsPromises.mkdir(repo);
    await fsPromises.writeFile(path.join(repo, "scratch.txt"), "notes\n");
    expect(await check()).toEqual({ success: true, data: { kind: "none" } });
  });
});
