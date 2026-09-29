/**
 * Finds work that removing a sub-agent checkout would destroy and nothing preserves (#4723). Only
 * model-driven task_remove consults it; user-confirmed and automatic removals keep force-removing.
 */
import assert from "node:assert/strict";

import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type {
  SubagentGitPatchArtifact,
  SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import * as fsPromises from "fs/promises";
import { SOURCE_REF_SNAPSHOT_NAMESPACE } from "@/node/runtime/gitBundleSync";
import { expandTildeForSSH } from "@/node/runtime/tildeExpansion";
import {
  getSubagentGitPatchMboxPath,
  matchesProjectArtifactProjectPathForUpdate,
} from "@/node/services/subagentGitPatchArtifacts";
import { parseGitStatusPorcelainZ } from "@/node/services/taskGitPatchEngine";
import { coerceNonEmptyString } from "@/node/services/taskUtils";
import type { WorkspaceProjectRepo } from "@/node/services/workspaceProjectRepos";
import {
  gitEnvPrefix,
  gitNoRepoAutomationEnv,
  gitNoRepoAutomationEnvForRuntimeRepo,
} from "@/node/utils/gitNoHooksEnv";
import { execBuffered } from "@/node/utils/runtime/helpers";

type SubagentRemovalProjectRepo = Pick<
  WorkspaceProjectRepo,
  "projectPath" | "projectName" | "repoCwd"
>;

export type UnpreservedSubagentWork =
  | { kind: "none" }
  | {
      kind: "lossy";
      paths: string[];
      uncapturedCommitCount: number;
      /** Commits only other local branches or the stash hold (checkouts that own their repository). */
      otherRefCommitCount?: number;
      /** Why commits could not be counted; set only when uncommitted paths were found. */
      commitCheckError?: string;
    };

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

// Repository automation (hooks, core.fsmonitor, filters) stays off: a checkout-controlled git
// config must not run code in the backend just because the model asked to remove a sub-agent.
interface GitRepo extends SubagentRemovalProjectRepo {
  prefix: string;
}

/** Runs git in the repo; a failure throws, which fails the whole check closed. */
async function git(runtime: Runtime, repo: GitRepo, args: string) {
  const result = await execBuffered(runtime, `${repo.prefix}git ${args}`, {
    cwd: repo.repoCwd,
    timeout: 30,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args} failed in ${repo.projectName}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** An unapplied ready artifact preserves its commits only while its mbox still exists. */
async function hasMbox(
  sessionDir: string,
  childTaskId: string,
  artifact: SubagentGitProjectPatchArtifact
): Promise<boolean> {
  const mboxPath = getSubagentGitPatchMboxPath(sessionDir, childTaskId, artifact.storageKey);
  // Same test as task_apply_git_patch's resolvePatchPath: only a regular file can be applied, so a
  // directory (corrupted session state) at the mbox path preserves nothing (#4761 gap 3).
  return fsPromises.stat(mboxPath).then(
    (stat) => stat.isFile(),
    () => false
  );
}

/** null when there is no git checkout to lose work from; throws when one cannot be inspected. */
async function openGitRepo(
  runtime: Runtime,
  repo: SubagentRemovalProjectRepo
): Promise<GitRepo | null> {
  // Only a confirmed absence counts: an unreachable runtime makes this probe throw or misreport.
  const gitPath = expandTildeForSSH(`${repo.repoCwd.replace(/\/+$/, "")}/.git`);
  // `[ -e ]` is also false for a dangling `.git` symlink and when an unsearchable directory makes
  // the lookup fail with EACCES (#4761 gap 4). So "no" needs proof: the nearest existing ancestor
  // must be a searchable directory, which makes the lookup's "not found" authoritative.
  const exists = await execBuffered(
    runtime,
    `p=${gitPath}; if [ -e "$p" ] || [ -L "$p" ]; then echo yes; else ` +
      `d=$(dirname "$p"); while [ ! -e "$d" ] && [ ! -L "$d" ]; do d=$(dirname "$d"); done; ` +
      `if [ -d "$d" ] && [ -x "$d" ]; then echo no; else echo unknown; fi; fi`,
    { cwd: "/", timeout: 10 }
  );
  const answer = exists.stdout.trim();
  if (exists.exitCode !== 0 || (answer !== "yes" && answer !== "no")) {
    const reason = answer === "unknown" ? "the checkout is not readable" : exists.stderr.trim();
    throw new Error(`cannot inspect ${repo.projectName}: ${reason}`);
  }
  // Gone, or a plain directory this check cannot judge. Scratch sub-agents never get here: they
  // share their scratch ancestor's directory on a project-dir local runtime, which TaskService
  // skips, and removal keeps that directory while another scratch workspace references it.
  if (answer === "no") return null;
  const probe = await execBuffered(
    runtime,
    `${gitEnvPrefix(gitNoRepoAutomationEnv())}git rev-parse --is-inside-work-tree`,
    { cwd: repo.repoCwd, timeout: 10 }
  );
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    throw new Error(`cannot inspect ${repo.projectName}: ${probe.stderr.trim()}`);
  }
  const env = await gitNoRepoAutomationEnvForRuntimeRepo(runtime, repo.repoCwd);
  return { ...repo, prefix: gitEnvPrefix(env) };
}

/**
 * Whether the checkout owns its repository (a `.git` directory), so removal deletes every branch
 * and the stash with it. Linked worktrees keep those in the shared repository. This also matches
 * SSH `cp -R -P` fork copies and legacy SSH clones, which removal deletes with `rm -rf` (#5105).
 */
async function ownsRepository(runtime: Runtime, repo: GitRepo): Promise<boolean> {
  const result = await execBuffered(
    runtime,
    "if [ -d .git ] && [ ! -L .git ]; then echo yes; else echo no; fi",
    {
      cwd: repo.repoCwd,
      timeout: 10,
    }
  );
  const answer = result.stdout.trim();
  if (result.exitCode !== 0 || (answer !== "yes" && answer !== "no")) {
    throw new Error(`cannot inspect ${repo.projectName}: ${result.stderr.trim()}`);
  }
  return answer === "yes";
}

/**
 * Commits that only other local branches or the stash hold, in a checkout whose removal deletes
 * the whole repository (#4761 gap 2). A patch artifact never covers these: it spans base..HEAD only.
 */
async function countOtherRefCommits(
  runtime: Runtime,
  repo: GitRepo,
  base: string,
  head: string
): Promise<number> {
  const stash =
    (await git(runtime, repo, "for-each-ref '--format=%(refname)' refs/stash")).trim() ===
    "refs/stash"
      ? "refs/stash "
      : "";
  // A copy starts with the source's branches (and, for `cp` copies, its stash). Commits the source
  // had are preserved there, and two records prove which those are: the snapshot creation writes
  // (#5105) and the origin/* refs of copies with an origin URL. A copy with neither (made before
  // the snapshot existed, or whose snapshot failed) cannot prove it, so every other branch and the
  // stash count: the model must not guess, and a user-confirmed removal still works.
  const value = Number(
    await git(
      runtime,
      repo,
      `rev-list --count --branches ${stash}--not ${head} ${base} --remotes '--glob=${SOURCE_REF_SNAPSHOT_NAMESPACE}*'`
    )
  );
  assert(Number.isInteger(value) && value >= 0, "git rev-list --count prints a count");
  return value;
}

export async function findUnpreservedSubagentWork(params: {
  runtime: Runtime;
  projectRepos: SubagentRemovalProjectRepo[];
  patchArtifact: SubagentGitPatchArtifact | null;
  /** Session dir holding the artifact's mbox files (the parent's). */
  patchArtifactSessionDir: string;
  taskBaseCommitShaByProjectPath: Readonly<Record<string, string>>;
  /**
   * The checkout is a Docker copy: removal deletes the container and the whole repository in it,
   * not just a worktree and the task branch. Other checkouts that own their repository (SSH
   * `cp -R -P` forks, legacy SSH clones) are detected in the repository itself (#5105).
   */
  removalDeletesBundleClone: boolean;
}): Promise<Result<UnpreservedSubagentWork, string>> {
  assert(params.projectRepos.length > 0, "findUnpreservedSubagentWork requires project repos");
  const prefixPaths = params.projectRepos.length > 1;
  const paths: string[] = [];
  const gitRepos: GitRepo[] = [];
  try {
    for (const candidate of params.projectRepos) {
      // Non-git directories keep the pre-#4723 behavior rather than refusing every removal.
      const repo = await openGitRepo(params.runtime, candidate);
      if (repo == null) continue;
      gitRepos.push(repo);
      // "normal" collapses new directories; ignored files (build output, dependencies) are not
      // work, matching the #3950 snapshot check. Explicit flags override repo config that could
      // hide untracked files or submodule edits (status.showUntrackedFiles, submodule ignore).
      const status = await git(
        params.runtime,
        repo,
        "--no-optional-locks status --porcelain -z --untracked-files=normal --ignore-submodules=none"
      );
      for (const entry of parseGitStatusPorcelainZ(status)) {
        paths.push(prefixPaths ? `${repo.projectName}/${entry.path}` : entry.path);
      }
    }
  } catch (error) {
    return Err(getErrorMessage(error));
  }
  const dirtyPaths = [...new Set(paths)].sort();
  const commits = await countUnpreservedCommits(params, gitRepos);
  if (!commits.success) {
    // The files are known even when commits cannot be counted: report both, so a user
    // confirmation never lists less than removal deletes (#5106).
    if (dirtyPaths.length === 0) return commits;
    return Ok({
      kind: "lossy",
      paths: dirtyPaths,
      uncapturedCommitCount: 0,
      commitCheckError: commits.error,
    });
  }
  const { uncapturedCommitCount, otherRefCommitCount } = commits.data;
  if (dirtyPaths.length === 0 && uncapturedCommitCount === 0 && otherRefCommitCount === 0) {
    return Ok({ kind: "none" });
  }
  return Ok({
    kind: "lossy",
    paths: dirtyPaths,
    uncapturedCommitCount,
    ...(otherRefCommitCount > 0 ? { otherRefCommitCount } : {}),
  });
}

async function countUnpreservedCommits(
  params: Parameters<typeof findUnpreservedSubagentWork>[0],
  gitRepos: GitRepo[]
): Promise<Result<{ uncapturedCommitCount: number; otherRefCommitCount: number }, string>> {
  try {
    // Committed work survives only in a patch artifact: removal force-deletes the task branch.
    // A ready/skipped artifact covers it only when it captured the current head and the range has
    // no merge commits (format-patch drops merge resolutions). Refuse to guess without a base.
    let uncapturedCommitCount = 0;
    let otherRefCommitCount = 0;
    for (const repo of gitRepos) {
      const head = (await git(params.runtime, repo, "rev-parse HEAD")).trim();
      const artifact = params.patchArtifact?.projectArtifacts.find((candidate) =>
        matchesProjectArtifactProjectPathForUpdate(candidate, repo.projectPath)
      );
      const base =
        coerceNonEmptyString(artifact?.baseCommitSha) ??
        coerceNonEmptyString(params.taskBaseCommitShaByProjectPath[repo.projectPath]);
      // Persisted values reach a shell command, so accept only commit ids.
      if (base == null || !COMMIT_SHA_PATTERN.test(base) || !COMMIT_SHA_PATTERN.test(head)) {
        return Err(`the task base commit of ${repo.projectName} is unknown`);
      }
      const count = async (flags: string) => {
        const value = Number(
          await git(params.runtime, repo, `rev-list --count ${flags}${base}..${head}`)
        );
        assert(Number.isInteger(value) && value >= 0, "git rev-list --count prints a count");
        return value;
      };
      const commits = await count("");
      const captured =
        artifact != null &&
        params.patchArtifact != null &&
        (artifact.status === "ready" || artifact.status === "skipped") &&
        artifact.headCommitSha === head &&
        (artifact.appliedAtMs != null ||
          (await hasMbox(
            params.patchArtifactSessionDir,
            params.patchArtifact.childTaskId,
            artifact
          )));
      if (commits > 0 && !(captured && (await count("--merges ")) === 0)) {
        uncapturedCommitCount += commits;
      }
      if (params.removalDeletesBundleClone || (await ownsRepository(params.runtime, repo))) {
        otherRefCommitCount += await countOtherRefCommits(params.runtime, repo, base, head);
      }
    }
    return Ok({ uncapturedCommitCount, otherRefCommitCount });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}
