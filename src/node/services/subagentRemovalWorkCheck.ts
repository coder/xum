/**
 * Finds work that removing a sub-agent checkout would destroy and nothing preserves (#4723). Only
 * model-driven task_remove consults it; user-confirmed and automatic removals keep force-removing.
 */
import assert from "node:assert/strict";

import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { matchesProjectArtifactProjectPathForUpdate } from "@/node/services/subagentGitPatchArtifacts";
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
  | { kind: "lossy"; paths: string[]; uncapturedCommitCount: number };

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

/** null when there is no git checkout to lose work from; throws when one cannot be inspected. */
async function openGitRepo(
  runtime: Runtime,
  repo: SubagentRemovalProjectRepo
): Promise<GitRepo | null> {
  try {
    await runtime.stat(`${repo.repoCwd.replace(/\/+$/, "")}/.git`);
  } catch {
    // Gone, or a plain directory (scratch sub-agents run in copies this check cannot judge).
    return null;
  }
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

export async function findUnpreservedSubagentWork(params: {
  runtime: Runtime;
  projectRepos: SubagentRemovalProjectRepo[];
  patchArtifact: SubagentGitPatchArtifact | null;
  taskBaseCommitShaByProjectPath: Readonly<Record<string, string>>;
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
      // Default untracked mode collapses new directories, and ignored files (build output,
      // dependencies) are not treated as work, matching the #3950 snapshot check.
      const status = await git(params.runtime, repo, "--no-optional-locks status --porcelain -z");
      for (const entry of parseGitStatusPorcelainZ(status)) {
        paths.push(prefixPaths ? `${repo.projectName}/${entry.path}` : entry.path);
      }
    }
    if (paths.length > 0) {
      return Ok({ kind: "lossy", paths: [...new Set(paths)].sort(), uncapturedCommitCount: 0 });
    }

    // Committed work survives only in a patch artifact: removal force-deletes the task branch.
    // A ready/skipped artifact covers it only when it captured the current head and the range has
    // no merge commits (format-patch drops merge resolutions). Refuse to guess without a base.
    let uncapturedCommitCount = 0;
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
        (artifact.status === "ready" || artifact.status === "skipped") &&
        artifact.headCommitSha === head;
      if (commits > 0 && !(captured && (await count("--merges ")) === 0)) {
        uncapturedCommitCount += commits;
      }
    }
    return Ok(
      uncapturedCommitCount > 0
        ? { kind: "lossy", paths: [], uncapturedCommitCount }
        : { kind: "none" }
    );
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}
