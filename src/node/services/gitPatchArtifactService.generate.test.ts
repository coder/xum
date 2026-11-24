import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execSync } from "node:child_process";

import { Config } from "@/node/config";
import { GitPatchArtifactService } from "@/node/services/gitPatchArtifactService";
import { readSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";

function initGitRepo(repoPath: string): void {
  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: repoPath, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: repoPath, stdio: "ignore" });
}

async function commitFile(
  repoPath: string,
  fileName: string,
  content: string,
  message: string
): Promise<string> {
  await fsPromises.writeFile(path.join(repoPath, fileName), content, "utf-8");
  execSync(`git add -- ${fileName}`, { cwd: repoPath, stdio: "ignore" });
  // Inline identity: repos not created via initGitRepo (e.g. submodule
  // clones) have no local identity, and CI runners have no global one.
  execSync(
    `git -c user.email="test@example.com" -c user.name="test" -c commit.gpgsign=false commit -m ${JSON.stringify(message)}`,
    { cwd: repoPath, stdio: "ignore" }
  );
  return execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
}

describe("GitPatchArtifactService worktree capture", () => {
  let rootDir: string;
  let config: Config;
  let projectPath: string;
  let childRepo: string;
  let baseSha: string;

  const parentId = "parent-1111";
  const childId = "child-2222";

  async function saveChildWorkspace(): Promise<void> {
    await config.editConfig(() => ({
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { path: projectPath, id: parentId, name: "parent" },
              {
                path: childRepo,
                id: childId,
                name: "child",
                parentWorkspaceId: parentId,
                runtimeConfig: { type: "local" as const },
                taskBaseCommitSha: baseSha,
              },
            ],
          },
        ],
      ]),
    }));
  }

  async function runGenerate(service: GitPatchArtifactService): Promise<void> {
    await (
      service as unknown as {
        generate(
          parentWorkspaceId: string,
          childWorkspaceId: string,
          onComplete: (childWorkspaceId: string) => Promise<void>
        ): Promise<void>;
      }
    ).generate(parentId, childId, () => Promise.resolve());
  }

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-git-patch-generate-test-"));
    config = new Config(rootDir);
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    projectPath = path.join(rootDir, "repo");
    childRepo = path.join(projectPath, "child");
    await fsPromises.mkdir(childRepo, { recursive: true });
    initGitRepo(childRepo);
    baseSha = await commitFile(childRepo, "base.txt", "base\n", "base commit");
    await saveChildWorkspace();
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it("keeps a clean zero-commit tree skipped with no worktree fields", async () => {
    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("skipped");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.status).toBe("skipped");
    // The clean branch must not record dirty-capture results.
    expect(projectArtifact?.hadUncommittedChanges).toBeUndefined();
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchBytes).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toBeUndefined();
  });

  it("removes a stale canonical worktree patch when a rerun finds a clean tree", async () => {
    // A capture writes the canonical patch, then the work is committed and
    // generation re-runs (e.g. startup recovery after a crash that lost the
    // metadata write): the regenerated artifact has no worktree fields, so
    // the stale file must not survive for apply-side canonical probing to
    // re-apply outdated changes after git am.
    await fsPromises.writeFile(path.join(childRepo, "dirty.txt"), "dirty\n", "utf-8");
    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));
    const firstArtifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const canonicalPatchPath = firstArtifact?.projectArtifacts[0]?.worktreePatchPath;
    expect(canonicalPatchPath).toBeDefined();

    execSync("git add -A && git commit -m 'commit the dirty work'", {
      cwd: childRepo,
      stdio: "ignore",
    });
    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("ready");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    const staleFileExists = await fsPromises
      .access(canonicalPatchPath!)
      .then(() => true)
      .catch(() => false);
    expect(staleFileExists).toBe(false);
  });

  it("captures dirty tracked changes for a zero-commit tree as a ready worktree patch", async () => {
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("ready");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.commitCount).toBe(0);
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.mboxPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    expect(projectArtifact?.worktreePatchBytes).toBeGreaterThan(0);

    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("modified");
  });

  it("captures standard a/ b/ prefixes even under diff.noprefix=true", async () => {
    execSync("git config diff.noprefix true", { cwd: childRepo, stdio: "ignore" });
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    // Default `git apply` rejects prefix-less headers, so the capture must
    // not inherit the repo's noprefix setting.
    expect(patch).toContain("diff --git a/base.txt b/base.txt");
    // The captured patch stays applyable with a default-config git.
    execSync("git stash --include-untracked", { cwd: childRepo, stdio: "ignore" });
    execSync(`git apply --3way --binary ${JSON.stringify(projectArtifact!.worktreePatchPath!)}`, {
      cwd: childRepo,
      stdio: "ignore",
    });
    expect(await fsPromises.readFile(path.join(childRepo, "base.txt"), "utf-8")).toBe("modified\n");
  });

  it("reports untracked embedded git repositories as uncaptured and excludes their gitlinks", async () => {
    // Untracked nested repo with a commit that exists only in the child.
    const nestedRepo = path.join(childRepo, "nested-repo");
    await fsPromises.mkdir(nestedRepo, { recursive: true });
    initGitRepo(nestedRepo);
    await commitFile(nestedRepo, "inner.txt", "inner\n", "inner commit");
    // A regular dirty file so a root patch still gets captured alongside.
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("nested-repo");
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("NOT captured");
    // The root patch exists but must not carry the embedded repo's gitlink,
    // whose commit no target can resolve.
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("base.txt");
    expect(patch).not.toContain("Subproject commit");
  });

  it("detects an embedded repo whose name forces porcelain quoting", async () => {
    // A space makes line-oriented `git status --porcelain` quote the path
    // (`?? "nested repo/"`), which a line/regex probe would miss.
    const nestedRepo = path.join(childRepo, "nested repo");
    await fsPromises.mkdir(nestedRepo, { recursive: true });
    initGitRepo(nestedRepo);
    await commitFile(nestedRepo, "inner.txt", "inner\n", "inner commit");
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("nested repo");
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("NOT captured");
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("base.txt");
    expect(patch).not.toContain("Subproject commit");
  });

  it("keeps dirty sibling paths that an embedded repo's glob-like name would match", async () => {
    // The exclude pathspec must be literal: `nested*repo` as a glob would
    // also exclude the dirty sibling `nestedXrepo`, silently dropping it
    // from the patch before child cleanup discards it.
    const nestedRepo = path.join(childRepo, "nested*repo");
    await fsPromises.mkdir(nestedRepo, { recursive: true });
    initGitRepo(nestedRepo);
    await commitFile(nestedRepo, "inner.txt", "inner\n", "inner commit");
    await fsPromises.writeFile(path.join(childRepo, "nestedXrepo"), "sibling\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("nested*repo");
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("nestedXrepo");
    expect(patch).not.toContain("Subproject commit");
  });

  it("reports an embedded-repo-only dirty tree as uncaptured instead of empty", async () => {
    const nestedRepo = path.join(childRepo, "nested-only");
    await fsPromises.mkdir(nestedRepo, { recursive: true });
    initGitRepo(nestedRepo);
    await commitFile(nestedRepo, "inner.txt", "inner\n", "inner commit");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("nested-only");
  });

  it("converts a rejected capture into conservative uncaptured metadata", async () => {
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");
    // A FILE at the patch directory's ancestor makes the capture's local
    // file write reject (ENOTDIR), simulating a runtime/filesystem failure.
    const sessionDir = path.join(config.sessionsDir, parentId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(path.join(sessionDir, "subagent-patches"), "not a dir", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    // The artifacts file itself lives outside subagent-patches/, so the
    // conservative metadata is still recorded.
    const artifact = await readSubagentGitPatchArtifact(sessionDir, childId);
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchSkippedReason).toContain(
      "Could not capture uncommitted changes"
    );
  });

  it("removes a leftover patch file when capture fails after writing it", async () => {
    await fsPromises.writeFile(path.join(childRepo, "dirty.txt"), "dirty\n", "utf-8");

    // Transient I/O failure after the diff stream already wrote the patch
    // file: the capture exception path must not leave the file behind at
    // the canonical location, where apply-side probing would pick it up
    // despite the skip metadata.
    const realStat = fsPromises.stat;
    let failedStat = false;
    const statSpy = spyOn(fsPromises, "stat").mockImplementation(((
      statPath: Parameters<typeof fsPromises.stat>[0],
      options?: Parameters<typeof fsPromises.stat>[1]
    ) => {
      if (typeof statPath === "string" && statPath.endsWith("worktree.patch")) {
        failedStat = true;
        return Promise.reject(new Error("EIO: simulated stat failure"));
      }
      return realStat(statPath, options);
    }) as typeof fsPromises.stat);
    try {
      await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));
    } finally {
      statSpy.mockRestore();
    }
    expect(failedStat).toBe(true);

    const sessionDir = path.join(config.sessionsDir, parentId);
    const artifact = await readSubagentGitPatchArtifact(sessionDir, childId);
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain(
      "Could not capture uncommitted changes"
    );

    const patchDir = path.join(sessionDir, "subagent-patches");
    const leftoverPatches = (
      await fsPromises.readdir(patchDir, { recursive: true }).catch(() => [] as string[])
    ).filter((entry) => String(entry).endsWith("worktree.patch"));
    expect(leftoverPatches).toEqual([]);
  });

  it("captures untracked non-ignored files", async () => {
    await fsPromises.writeFile(path.join(childRepo, "untracked.txt"), "new file\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(artifact?.status).toBe("ready");
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);

    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("untracked.txt");
    expect(patch).toContain("new file");
  });

  it("keeps capture blobs out of the repo's permanent object store", async () => {
    await fsPromises.writeFile(path.join(childRepo, "untracked.txt"), "new file\n", "utf-8");
    const looseObjectCount = async (): Promise<number> => {
      const entries = await fsPromises.readdir(path.join(childRepo, ".git", "objects"), {
        recursive: true,
        withFileTypes: true,
      });
      return entries.filter((entry) => entry.isFile()).length;
    };
    const before = await looseObjectCount();

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    // Staged blobs went to the throwaway object dir, not .git/objects.
    expect(await looseObjectCount()).toBe(before);
  });

  it("warns about unknown dirty state when the worktree cannot be inspected", async () => {
    // Corrupt the repo so git status (and everything after) fails.
    await fsPromises.rm(path.join(childRepo, ".git"), { recursive: true, force: true });
    await fsPromises.writeFile(path.join(childRepo, ".git"), "gitdir: /nonexistent\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.status).toBe("failed");
    // Unknown dirty state must not read as clean.
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("NOT captured");
  });

  it("records dirty work even when commit metadata resolution fails", async () => {
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");
    // Drop taskBaseCommitSha: the merge-base fallback resolves trunk to the
    // parent workspace name ("parent"), which is not a ref, so metadata
    // resolution fails after capture.
    await config.editConfig((cfg) => {
      const workspaces = cfg.projects.get(projectPath)?.workspaces ?? [];
      const child = workspaces.find((workspace) => workspace.id === childId);
      if (child) {
        delete child.taskBaseCommitSha;
      }
      return cfg;
    });

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.status).toBe("failed");
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeDefined();

    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("modified");
  });

  async function addDirtySubmodule(name = "sub"): Promise<void> {
    const subRepo = path.join(rootDir, "subrepo");
    await fsPromises.mkdir(subRepo, { recursive: true });
    initGitRepo(subRepo);
    await commitFile(subRepo, "inner.txt", "inner\n", "sub base");

    execSync(
      `git -c protocol.file.allow=always submodule add ${JSON.stringify(subRepo)} ${JSON.stringify(name)}`,
      {
        cwd: childRepo,
        stdio: "ignore",
      }
    );
    execSync('git commit -m "add submodule"', { cwd: childRepo, stdio: "ignore" });
    baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await saveChildWorkspace();

    // Edit inside the submodule without committing: the superproject diff is
    // empty (the gitlink is unchanged), so capture cannot represent this work.
    await fsPromises.writeFile(path.join(childRepo, name, "inner.txt"), "edited\n", "utf-8");
  }

  it("reports dirty submodule contents as uncaptured instead of an empty diff", async () => {
    await addDirtySubmodule();

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("skipped");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("submodule(s) sub");
  });

  it("detects a dirty submodule whose name core.quotePath would quote", async () => {
    // Non-ASCII names are C-quoted on git's line-oriented output; probing
    // the quoted literal would miss the submodule entirely.
    await addDirtySubmodule("s\u00fcb-m\u00f6dule");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("skipped");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("s\u00fcb-m\u00f6dule");
  });

  it("flags uncaptured submodule work alongside a captured superproject patch", async () => {
    await addDirtySubmodule();
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("ready");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("submodule(s) sub");
  });

  it("keeps a moved submodule gitlink out of the captured worktree patch", async () => {
    await addDirtySubmodule();
    // Commit inside the submodule: the superproject gitlink now points at a
    // commit that exists only in the child's clone, so capturing it would
    // produce a patch referencing an unfetchable object after cleanup.
    await commitFile(path.join(childRepo, "sub"), "inner.txt", "committed inner\n", "sub move");
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("ready");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("submodule(s) sub");
    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("base.txt");
    expect(patch).not.toContain("Subproject commit");
  });

  it("skips worktree capture when the submodule probe fails", async () => {
    await addDirtySubmodule();
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    // A failed probe leaves gitlink discovery unknown, so no exclusion list
    // exists: capturing anyway could stage a moved gitlink and emit a patch
    // referencing a commit that vanishes with child cleanup. Capture must be
    // skipped and reported, not attempted.
    const realExecBuffered = runtimeHelpers.execBuffered;
    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (runtime, command, options) => {
        if (command.endsWith("git ls-files -s -z")) {
          return Promise.resolve({
            stdout: "",
            stderr: "simulated probe failure",
            exitCode: 128,
            duration: 0,
          });
        }
        return realExecBuffered(runtime, command, options);
      }
    );
    try {
      await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));
    } finally {
      execSpy.mockRestore();
    }

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("skipped");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain(
      "Could not determine whether submodules contain uncommitted changes"
    );
    expect(projectArtifact?.worktreePatchSkippedReason).toContain(
      "The uncommitted changes were not captured."
    );
  });

  it("skips worktree capture when the staging-size probe fails", async () => {
    await fsPromises.writeFile(path.join(childRepo, "base.txt"), "modified\n", "utf-8");

    // A failed du probe must not read as "small": partial or empty stdout
    // would let an arbitrarily large dirty file through to `git add`, which
    // materializes unbounded blobs before the diff byte cap can trigger.
    const realExecBuffered = runtimeHelpers.execBuffered;
    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (runtime, command, options) => {
        if (command.includes("du -sk")) {
          return Promise.resolve({
            stdout: "",
            stderr: "du: command not found",
            exitCode: 127,
            duration: 0,
          });
        }
        return realExecBuffered(runtime, command, options);
      }
    );
    try {
      await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));
    } finally {
      execSpy.mockRestore();
    }

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("skipped");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("staging-size preflight failed");
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("NOT captured");
  });

  it("produces both mbox and worktree patch when commits and dirty changes coexist", async () => {
    await commitFile(childRepo, "committed.txt", "committed\n", "child commit");
    await fsPromises.writeFile(path.join(childRepo, "dirty.txt"), "dirty\n", "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("ready");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.commitCount).toBe(1);
    expect(projectArtifact?.mboxPath).toBeDefined();
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeDefined();

    const mbox = await fsPromises.readFile(projectArtifact!.mboxPath!, "utf-8");
    expect(mbox).toContain("child commit");
    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("dirty.txt");
  });

  it("preserves dirty-worktree metadata when mbox generation fails", async () => {
    await commitFile(childRepo, "committed.txt", "committed\n", "child commit");
    await fsPromises.writeFile(path.join(childRepo, "dirty.txt"), "dirty\n", "utf-8");
    // Force git format-patch to fail after worktree capture succeeds.
    execSync("git config format.signatureFile /nonexistent-signature", {
      cwd: childRepo,
      stdio: "ignore",
    });

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.status).toBe("failed");
    expect(projectArtifact?.error).toContain("git format-patch failed");
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
  });

  it("records a skip reason instead of capturing when the diff exceeds the size cap", async () => {
    await fsPromises.writeFile(path.join(childRepo, "big.txt"), "x".repeat(4096), "utf-8");

    await runGenerate(new GitPatchArtifactService(config, nodeSessionLocks, 100));

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("skipped");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("capture cap");
  });

  it("skips capture before staging when dirty files exceed the staged-bytes bound", async () => {
    // A dirty file whose on-disk size exceeds the staging bound but whose
    // path-quoting needs the porcelain -z parse (space in the name).
    await fsPromises.writeFile(path.join(childRepo, "big file.txt"), "x".repeat(64 * 1024));

    await runGenerate(
      new GitPatchArtifactService(config, nodeSessionLocks, 10 * 1024 * 1024, 4096)
    );

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("skipped");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.hadUncommittedChanges).toBe(true);
    expect(projectArtifact?.worktreePatchPath).toBeUndefined();
    expect(projectArtifact?.worktreePatchSkippedReason).toContain("staging bound");
  });

  it("captures normally when dirty files stay under the staged-bytes bound", async () => {
    await fsPromises.writeFile(path.join(childRepo, "small.txt"), "small change\n", "utf-8");

    await runGenerate(
      new GitPatchArtifactService(config, nodeSessionLocks, 10 * 1024 * 1024, 1024 * 1024)
    );

    const artifact = await readSubagentGitPatchArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(artifact?.status).toBe("ready");
    const projectArtifact = artifact?.projectArtifacts[0];
    expect(projectArtifact?.worktreePatchPath).toBeDefined();
    const patch = await fsPromises.readFile(projectArtifact!.worktreePatchPath!, "utf-8");
    expect(patch).toContain("small.txt");
  });

  it("aborts before capture when the pending marker cannot be persisted", async () => {
    // If the pending write silently failed, generation would capture files
    // no index entry references, every later metadata write would also
    // fail, and cleanup would read "no artifact" and delete the child with
    // its dirty work. maybeStartGeneration must propagate the failure and
    // never reach capture or onComplete.
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        for (const workspace of project.workspaces) {
          if (workspace.id === childId) {
            (workspace as { agentType?: string }).agentType = "exec";
          }
        }
      }
      return cfg;
    });
    await fsPromises.writeFile(path.join(childRepo, "dirty.txt"), "dirty\n", "utf-8");
    const parentSessionDir = path.join(config.sessionsDir, parentId);
    // Directory at the artifacts-file path: reads self-heal to empty but
    // the atomic write's rename fails.
    await fsPromises.mkdir(path.join(parentSessionDir, "subagent-patches.json"), {
      recursive: true,
    });

    const service = new GitPatchArtifactService(config, nodeSessionLocks);
    let onCompleteCalls = 0;
    let startError: unknown;
    try {
      await service.maybeStartGeneration(parentId, childId, () => {
        onCompleteCalls += 1;
        return Promise.resolve();
      });
      // Old behavior started a background job; wait for it so the capture
      // assertion below cannot race.
      await (
        service as unknown as { pendingJobsByTaskId: Map<string, Promise<void>> }
      ).pendingJobsByTaskId.get(childId);
    } catch (error) {
      startError = error;
    }
    expect(startError).toBeDefined();
    expect(onCompleteCalls).toBe(0);
    // No capture output at all: the whole task patch dir stays absent
    // regardless of storage key.
    const taskPatchDir = path.join(parentSessionDir, "subagent-patches", childId);
    expect(
      await fsPromises
        .readdir(taskPatchDir, { recursive: true })
        .then((entries) => entries.join(","))
        .catch(() => "ENOENT")
    ).toBe("ENOENT");
  });

  it("shouldGeneratePatchForTask distinguishes exec-like from read-only tasks", async () => {
    const service = new GitPatchArtifactService(config, nodeSessionLocks);
    // The harness child has no persisted agent identity.
    expect(await service.shouldGeneratePatchForTask(parentId, childId)).toBe(false);

    const setAgentType = async (agentType: string): Promise<void> => {
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          for (const workspace of project.workspaces) {
            if (workspace.id === childId) {
              (workspace as { agentType?: string }).agentType = agentType;
            }
          }
        }
        return cfg;
      });
    };
    await setAgentType("exec");
    expect(await service.shouldGeneratePatchForTask(parentId, childId)).toBe(true);
    await setAgentType("explore");
    expect(await service.shouldGeneratePatchForTask(parentId, childId)).toBe(false);
  });
});
