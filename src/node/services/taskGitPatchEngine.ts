import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";
import * as path from "node:path";

import type { z } from "zod";

import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  TaskApplyGitPatchToolArgsSchema,
  type TaskApplyGitPatchToolResultSchema,
  type SubagentGitPatchArtifact,
  type SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { shellQuote } from "@/common/utils/shell";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  gitEnvPrefix,
  gitHooksAllowed,
  gitNoRepoAutomationEnvForRuntimeRepo,
} from "@/node/utils/gitNoHooksEnv";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import {
  getSubagentGitPatchMboxPath,
  getSubagentGitPatchWorktreePatchPath,
  isSafeSubagentGitPatchPathComponent,
  markSubagentGitPatchArtifactApplied,
  matchesProjectArtifactProjectPath,
  readLocalPatchApplyCompletion,
  type LocalPatchApplyCompletionRecord,
  readLocalPatchPartialApply,
  readSubagentGitPatchArtifact,
  setLocalPatchPartialApply,
  type SubagentGitPatchPartialStage,
} from "@/node/services/subagentGitPatchArtifacts";
import { log } from "@/node/services/log";
import { Config } from "@/node/config";
import { coerceNonEmptyString, findWorkspaceEntry } from "@/node/services/taskUtils";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";
import type { Runtime } from "@/node/runtime/Runtime";

import { streamToString } from "@/node/runtime/streamUtils";
import { nodeRuntimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";

export type TaskApplyGitPatchArgs = z.infer<typeof TaskApplyGitPatchToolArgsSchema>;
export type TaskApplyGitPatchResult = z.infer<typeof TaskApplyGitPatchToolResultSchema>;

export type TaskGitPatchApplyConfig = Pick<
  ToolConfiguration,
  | "workspaceId"
  | "cwd"
  | "runtime"
  | "runtimeTempDir"
  | "workspaceSessionDir"
  | "trusted"
  | "sessionLocks"
>;

export interface GitPatchArtifactLookup {
  artifact: SubagentGitPatchArtifact;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  relation: "direct" | "descendant" | "ancestor";
  note?: string;
}

export interface TaskGitPatchApplyOptions {
  abortSignal?: AbortSignal;
  allowAlreadyApplied?: boolean;
  allowedPathPrefixes?: string[];
  pendingGenerationWaitMs?: number;
  pendingGenerationPollIntervalMs?: number;
  pendingGenerationOnPoll?: () => void;
}

export interface GeneratePatchParams {
  runtime: ToolConfiguration["runtime"];
  repoCwd: string;
  baseCommitSha: string;
  headCommitSha: string;
  patchPath: string;
}

export type GeneratePatchResult = { success: true } | { success: false; error: string };

export interface TaskGitPatchEngine {
  applyPatch(
    config: TaskGitPatchApplyConfig,
    args: TaskApplyGitPatchArgs,
    options?: TaskGitPatchApplyOptions
  ): Promise<TaskApplyGitPatchResult>;
  findPatch(params: {
    workspaceId: string;
    workspaceSessionDir: string;
    childTaskId: string;
  }): Promise<GitPatchArtifactLookup | null>;
  generatePatch(params: GeneratePatchParams): Promise<GeneratePatchResult>;
  /** Snapshot uncommitted changes (tracked and untracked) as a binary diff; never rejects. */
  captureWorktreePatch(params: CaptureWorktreePatchParams): Promise<WorktreeCaptureFields>;
}

interface AppliedCommit {
  subject: string;
  sha?: string;
}

interface TaskApplyGitPatchProjectResult {
  projectPath: string;
  projectName: string;
  status: "applied" | "failed" | "skipped";
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  error?: string;
  failedPatchSubject?: string;
  conflictPaths?: string[];
  note?: string;
}

async function copyLocalFileToRuntime(params: {
  runtime: ToolConfiguration["runtime"];
  localPath: string;
  remotePath: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const writable = params.runtime.writeFile(params.remotePath, params.abortSignal);
  const writer = writable.getWriter();

  const fileHandle = await fsPromises.open(params.localPath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      await writer.write(buffer.subarray(0, bytesRead));
    }

    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
      // The stream may already be errored; cleanup still proceeds in the caller's finally block.
    }
    writer.releaseLock();
    throw error;
  } finally {
    await fileHandle.close();
  }
}

function mergeNotes(...notes: Array<string | undefined>): string | undefined {
  const parts = notes
    .map((note) => (typeof note === "string" ? note.trim() : ""))
    .filter((note) => note.length > 0);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

async function gitNoRepoAutomationPrefixForRuntime(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  trusted: boolean;
}): Promise<string> {
  if (gitHooksAllowed(params.trusted)) return "";

  return gitEnvPrefix(await gitNoRepoAutomationEnvForRuntimeRepo(params.runtime, params.cwd));
}

async function tryRevParseHead(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  gitPrefix: string;
}): Promise<string | undefined> {
  try {
    const headResult = await execBuffered(params.runtime, `${params.gitPrefix}git rev-parse HEAD`, {
      cwd: params.cwd,
      timeout: 10,
    });
    if (headResult.exitCode !== 0) {
      return undefined;
    }
    const sha = headResult.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function getAppliedCommits(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  beforeHeadSha: string | undefined;
  commitCountHint: number | undefined;
  includeSha: boolean;
  gitPrefix: string;
}): Promise<AppliedCommit[]> {
  const format = "%H%x00%s";

  async function tryGitLog(args: {
    cmd: string;
    includeSha: boolean;
  }): Promise<AppliedCommit[] | undefined> {
    try {
      const result = await execBuffered(params.runtime, params.gitPrefix + args.cmd, {
        cwd: params.cwd,
        timeout: 30,
      });
      if (result.exitCode !== 0) {
        log.debug("task_apply_git_patch: git log failed", {
          cwd: params.cwd,
          exitCode: result.exitCode,
          stderr: result.stderr.trim(),
          stdout: result.stdout.trim(),
        });
        return undefined;
      }

      const lines = result.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.length > 0);

      const commits: AppliedCommit[] = [];
      for (const line of lines) {
        const nulIndex = line.indexOf("\u0000");
        if (nulIndex === -1) {
          commits.push({ subject: line });
          continue;
        }

        const sha = line.slice(0, nulIndex);
        const subject = line.slice(nulIndex + 1);
        if (subject.length === 0) continue;

        if (args.includeSha && sha.length > 0) {
          commits.push({ sha, subject });
        } else {
          commits.push({ subject });
        }
      }

      return commits;
    } catch (error) {
      log.debug("task_apply_git_patch: git log threw", { cwd: params.cwd, error });
      return undefined;
    }
  }

  if (params.beforeHeadSha) {
    const rangeCmd = `git log --reverse --format=${format} ${params.beforeHeadSha}..HEAD`;
    const commits = await tryGitLog({ cmd: rangeCmd, includeSha: params.includeSha });
    if (commits) return commits;
  }

  if (typeof params.commitCountHint === "number" && params.commitCountHint > 0) {
    const countCmd = `git log -n ${params.commitCountHint} --reverse --format=${format} HEAD`;
    const commits = await tryGitLog({ cmd: countCmd, includeSha: params.includeSha });
    if (commits) return commits;
  }

  return [];
}

const MAX_PARENT_WORKSPACE_DEPTH = 32;

function inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir: string): string | undefined {
  assert(
    workspaceSessionDir.length > 0,
    "inferMuxRootFromWorkspaceSessionDir: workspaceSessionDir must be non-empty"
  );

  const sessionsDir = path.dirname(workspaceSessionDir);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }

  return path.dirname(sessionsDir);
}

function parseFailedPatchSubjectFromGitAmOutput(output: string): string | undefined {
  const normalized = output.replace(/\r/g, "");

  const patchFailedMatch = /^Patch failed at \d+ (.+)$/m.exec(normalized);
  if (patchFailedMatch) {
    const subject = patchFailedMatch[1].trim();
    return subject.length > 0 ? subject : undefined;
  }

  const applyingMatches = Array.from(normalized.matchAll(/^Applying: (.+)$/gm));
  const subject = applyingMatches.at(-1)?.[1]?.trim();
  return subject && subject.length > 0 ? subject : undefined;
}

async function tryGetConflictPaths(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  gitPrefix: string;
}): Promise<string[]> {
  assert(params.cwd.length > 0, "tryGetConflictPaths: cwd must be non-empty");

  try {
    const diffResult = await execBuffered(
      params.runtime,
      `${params.gitPrefix}git diff --name-only --diff-filter=U`,
      {
        cwd: params.cwd,
        timeout: 30,
      }
    );

    if (diffResult.exitCode !== 0) {
      log.debug("task_apply_git_patch: git diff --name-only --diff-filter=U failed", {
        cwd: params.cwd,
        exitCode: diffResult.exitCode,
        stderr: diffResult.stderr.trim(),
        stdout: diffResult.stdout.trim(),
      });
      return [];
    }

    const paths = diffResult.stdout
      .split("\n")
      .map((line) => line.replace(/\r$/, "").trim())
      .filter((line) => line.length > 0);

    return Array.from(new Set(paths));
  } catch (error) {
    log.debug("task_apply_git_patch: git diff --name-only --diff-filter=U threw", {
      cwd: params.cwd,
      error,
    });
    return [];
  }
}

async function isGitAmInProgress(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  gitPrefix: string;
}): Promise<boolean> {
  assert(params.cwd.length > 0, "isGitAmInProgress: cwd must be non-empty");

  try {
    const checkResult = await execBuffered(
      params.runtime,
      `test -d "$(${params.gitPrefix}git rev-parse --git-path rebase-apply)"`,
      {
        cwd: params.cwd,
        timeout: 30,
      }
    );

    return checkResult.exitCode === 0;
  } catch (error) {
    log.debug("task_apply_git_patch: failed to detect git am progress state", {
      cwd: params.cwd,
      error,
    });
    return false;
  }
}

async function findPatch(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
}): Promise<GitPatchArtifactLookup | null> {
  assert(params.workspaceId.length > 0, "findPatch: workspaceId must be non-empty");
  assert(params.workspaceSessionDir.length > 0, "findPatch: workspaceSessionDir must be non-empty");
  assert(params.childTaskId.length > 0, "findPatch: childTaskId must be non-empty");

  const direct = await readSubagentGitPatchArtifact(params.workspaceSessionDir, params.childTaskId);
  if (direct) {
    return {
      artifact: direct,
      artifactWorkspaceId: params.workspaceId,
      relation: "direct",
      artifactSessionDir: params.workspaceSessionDir,
    };
  }

  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    log.debug(
      "task_apply_git_patch: workspaceSessionDir not under sessions/; skipping ancestor lookup",
      {
        workspaceId: params.workspaceId,
        workspaceSessionDir: params.workspaceSessionDir,
        childTaskId: params.childTaskId,
      }
    );
    return null;
  }

  const configService = new Config(muxRootDir);

  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch (error) {
    log.debug("task_apply_git_patch: failed to load mux config for ancestor lookup", {
      workspaceId: params.workspaceId,
      muxRootDir,
      error,
    });
    return null;
  }

  const parentById = new Map<string, string | undefined>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      // First row wins for duplicate ids, as in findWorkspaceEntry (#4550).
      if (!workspace.id || parentById.has(workspace.id)) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  const childParentWorkspaceId = parentById.get(params.childTaskId);
  if (childParentWorkspaceId && childParentWorkspaceId !== params.workspaceId) {
    const descendantVisited = new Set<string>([params.childTaskId]);
    let currentDescendant = params.childTaskId;
    for (let i = 0; i < MAX_PARENT_WORKSPACE_DEPTH; i++) {
      const parent = parentById.get(currentDescendant);
      if (!parent) break;
      if (parent === params.workspaceId) {
        const artifactSessionDir = path.join(configService.sessionsDir, childParentWorkspaceId);
        const artifact = await readSubagentGitPatchArtifact(artifactSessionDir, params.childTaskId);
        if (artifact) {
          return {
            artifact,
            artifactWorkspaceId: childParentWorkspaceId,
            relation: "descendant",
            artifactSessionDir,
            note: `Patch artifact loaded from descendant parent workspace ${childParentWorkspaceId}.`,
          };
        }
        break;
      }
      if (descendantVisited.has(parent)) {
        log.warn(
          "task_apply_git_patch: possible parentWorkspaceId cycle during descendant lookup",
          {
            workspaceId: params.workspaceId,
            childTaskId: params.childTaskId,
            current: currentDescendant,
            parent,
          }
        );
        break;
      }
      descendantVisited.add(parent);
      currentDescendant = parent;
    }
  }

  const visited = new Set<string>();
  visited.add(params.workspaceId);

  let current = params.workspaceId;
  for (let i = 0; i < MAX_PARENT_WORKSPACE_DEPTH; i++) {
    const parent = parentById.get(current);
    if (!parent) {
      return null;
    }

    if (visited.has(parent)) {
      log.warn("task_apply_git_patch: possible parentWorkspaceId cycle during ancestor lookup", {
        workspaceId: params.workspaceId,
        childTaskId: params.childTaskId,
        current,
        parent,
      });
      return null;
    }

    visited.add(parent);

    const parentSessionDir = path.join(configService.sessionsDir, parent);
    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, params.childTaskId);
    if (artifact) {
      return {
        artifact,
        artifactWorkspaceId: parent,
        relation: "ancestor",
        artifactSessionDir: parentSessionDir,
        note: `Patch artifact loaded from ancestor workspace ${parent}.`,
      };
    }

    current = parent;
  }

  log.warn("task_apply_git_patch: exceeded parentWorkspaceId depth during ancestor lookup", {
    workspaceId: params.workspaceId,
    childTaskId: params.childTaskId,
  });

  return null;
}

// A child task's report is delivered before its background `git format-patch`
// generation finishes, so a freshly completed task can briefly expose a
// "pending" patch artifact. Failing immediately misleads callers (e.g. workflow
// applyPatch steps treat the failure as an apply problem and may spawn
// conflict-resolution agents), so we wait for generation to settle instead.
const PENDING_PATCH_GENERATION_WAIT_MS = 120_000;
const PENDING_PATCH_GENERATION_POLL_INTERVAL_MS = 500;

function listRelevantProjectArtifacts(
  artifact: SubagentGitPatchArtifact,
  requestedProjectPath: string | null | undefined
): SubagentGitPatchArtifact["projectArtifacts"] {
  return requestedProjectPath != null
    ? artifact.projectArtifacts.filter((projectArtifact) =>
        matchesProjectArtifactProjectPath(projectArtifact, requestedProjectPath)
      )
    : artifact.projectArtifacts;
}

// Unlike the shared sleepWithAbort in @/node/utils/abort (which REJECTS on
// abort), this helper RESOLVES on abort so the wait loop can fall through to a
// structured tool result instead of throwing out of applyPatch.
async function sleepResolvingOnAbort(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  assert(delayMs > 0, "sleepResolvingOnAbort: delayMs must be positive");
  if (abortSignal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Re-read the artifact until no relevant project artifact is still "pending"
 * (generation finished as ready/failed/skipped), the deadline passes, or the
 * caller aborts. Returns the freshest artifact observed.
 */
async function waitForPendingPatchGeneration(params: {
  artifact: SubagentGitPatchArtifact;
  artifactSessionDir: string;
  childTaskId: string;
  requestedProjectPath: string | null | undefined;
  waitMs: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
  onPoll?: () => void;
}): Promise<SubagentGitPatchArtifact> {
  assert(params.waitMs >= 0, "waitForPendingPatchGeneration: waitMs must be non-negative");
  assert(
    params.pollIntervalMs > 0,
    "waitForPendingPatchGeneration: pollIntervalMs must be positive"
  );

  let artifact = params.artifact;
  const deadlineMs = Date.now() + params.waitMs;
  const startedAtMs = Date.now();
  let waited = false;

  while (
    listRelevantProjectArtifacts(artifact, params.requestedProjectPath).some(
      (projectArtifact) => projectArtifact.status === "pending"
    ) &&
    Date.now() < deadlineMs &&
    params.abortSignal?.aborted !== true
  ) {
    waited = true;
    params.onPoll?.();
    await sleepResolvingOnAbort(params.pollIntervalMs, params.abortSignal);
    const refreshed = await readSubagentGitPatchArtifact(
      params.artifactSessionDir,
      params.childTaskId
    );
    if (refreshed != null) {
      artifact = refreshed;
    }
  }

  if (waited) {
    log.debug("task_apply_git_patch: waited for pending patch generation", {
      childTaskId: params.childTaskId,
      waitedMs: Date.now() - startedAtMs,
      // Log the statuses the loop actually waited on; the artifact-level
      // summary stays "pending" while filtered-out sibling projects generate.
      settledStatuses: listRelevantProjectArtifacts(artifact, params.requestedProjectPath).map(
        (projectArtifact) => projectArtifact.status
      ),
      requestedProjectPath: params.requestedProjectPath ?? null,
    });
  }

  return artifact;
}

function toLegacyFields(projectResults: TaskApplyGitPatchProjectResult[]): {
  appliedCommits?: AppliedCommit[];
  headCommitSha?: string;
  conflictPaths?: string[];
  failedPatchSubject?: string;
} {
  if (projectResults.length !== 1) {
    return {};
  }

  const [onlyProjectResult] = projectResults;
  return {
    ...(onlyProjectResult.appliedCommits
      ? { appliedCommits: onlyProjectResult.appliedCommits }
      : {}),
    ...(onlyProjectResult.headCommitSha ? { headCommitSha: onlyProjectResult.headCommitSha } : {}),
    ...(onlyProjectResult.conflictPaths ? { conflictPaths: onlyProjectResult.conflictPaths } : {}),
    ...(onlyProjectResult.failedPatchSubject
      ? { failedPatchSubject: onlyProjectResult.failedPatchSubject }
      : {}),
  };
}

function worktreeCaptureSkippedNote(
  projectArtifact: SubagentGitProjectPatchArtifact
): string | undefined {
  return projectArtifact.hadUncommittedChanges === true &&
    projectArtifact.worktreePatchSkippedReason != null
    ? `The child ended with uncommitted changes that were NOT captured: ${projectArtifact.worktreePatchSkippedReason}`
    : undefined;
}

function summarizeNonReadyProjectArtifact(params: {
  projectArtifact: SubagentGitProjectPatchArtifact;
}): TaskApplyGitPatchProjectResult {
  const noteByStatus: Record<string, string | undefined> = {
    pending: "Patch generation is still in progress for this project.",
    skipped: "Patch generation was skipped because this project produced no commits.",
    failed: undefined,
    ready: undefined,
  };

  return {
    projectPath: params.projectArtifact.projectPath,
    projectName: params.projectArtifact.projectName,
    status: params.projectArtifact.status === "failed" ? "failed" : "skipped",
    error:
      params.projectArtifact.error ??
      noteByStatus[params.projectArtifact.status] ??
      `Project patch status is ${params.projectArtifact.status}.`,
    note: worktreeCaptureSkippedNote(params.projectArtifact),
  };
}

function resolveCurrentWorkspaceRepoTargets(params: {
  workspaceId: string;
  workspaceSessionDir: string;
}): Map<string, { projectName: string; repoCwd: string }> {
  const muxRootDir = inferMuxRootFromWorkspaceSessionDir(params.workspaceSessionDir);
  if (!muxRootDir) {
    return new Map();
  }

  const configService = new Config(muxRootDir);
  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = configService.loadConfigOrDefault();
  } catch {
    return new Map();
  }

  const entry = findWorkspaceEntry(cfg, params.workspaceId);
  const workspace = entry?.workspace;
  const workspacePath = coerceNonEmptyString(workspace?.path);
  const workspaceName = coerceNonEmptyString(workspace?.name);
  if (!entry || !workspace?.runtimeConfig || !workspacePath || !workspaceName) {
    return new Map();
  }

  const projectRepos = getWorkspaceProjectRepos({
    // Outside the agent loop: the host's runtimes.
    runtimeFactory: nodeRuntimeFactory,
    workspaceId: params.workspaceId,
    workspaceName,
    workspacePath,
    runtimeConfig: workspace.runtimeConfig,
    projectPath: entry.projectPath,
    projectName:
      workspace.projects?.find((project) => project.projectPath === entry.projectPath)
        ?.projectName ??
      entry.projectPath.split("/").filter(Boolean).at(-1) ??
      entry.projectPath,
    projects: workspace.projects,
  });

  return new Map(
    projectRepos.map((projectRepo) => [
      projectRepo.projectPath,
      {
        projectName: projectRepo.projectName,
        repoCwd: projectRepo.repoCwd,
      },
    ])
  );
}

async function findExistingFile(candidates: Iterable<string>): Promise<string | null> {
  for (const candidate of candidates) {
    const stat = await fsPromises.stat(candidate).catch(() => null);
    if (stat?.isFile()) {
      return candidate;
    }
  }
  return null;
}

async function resolvePatchPath(params: {
  taskId: string;
  artifactSessionDir: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactLookupNote?: string;
}): Promise<{ patchPath: string; note?: string } | { error: string; note?: string }> {
  const expectedPatchPath = getSubagentGitPatchMboxPath(
    params.artifactSessionDir,
    params.taskId,
    params.projectArtifact.storageKey
  );

  if (!isPathInsideDir(params.artifactSessionDir, expectedPatchPath)) {
    return {
      error: "Invalid task_id.",
      note: "task_id must not contain path traversal segments.",
    };
  }

  const safeMboxPath =
    typeof params.projectArtifact.mboxPath === "string" &&
    params.projectArtifact.mboxPath.length > 0
      ? isPathInsideDir(params.artifactSessionDir, params.projectArtifact.mboxPath)
        ? params.projectArtifact.mboxPath
        : undefined
      : undefined;

  let patchPathNote = mergeNotes(
    params.artifactLookupNote,
    params.projectArtifact.mboxPath && !safeMboxPath
      ? "Ignoring unsafe mboxPath in patch artifact metadata; using canonical patch location."
      : undefined
  );

  const patchCandidates = [safeMboxPath, expectedPatchPath].filter(
    (candidate): candidate is string => typeof candidate === "string"
  );

  const patchPath = await findExistingFile(patchCandidates);

  if (!patchPath) {
    const checkedPaths = Array.from(new Set(patchCandidates))
      .map((candidate) =>
        isPathInsideDir(params.artifactSessionDir, candidate)
          ? path.relative(params.artifactSessionDir, candidate) || path.basename(candidate)
          : candidate
      )
      .join(", ");

    return {
      error: "Patch file is missing on disk.",
      note: mergeNotes(
        patchPathNote,
        checkedPaths.length > 0 ? `Checked patch locations: ${checkedPaths}` : undefined
      ),
    };
  }

  if (safeMboxPath && patchPath === expectedPatchPath && safeMboxPath !== expectedPatchPath) {
    patchPathNote = mergeNotes(
      patchPathNote,
      "Patch file not found at metadata mboxPath; using canonical patch location."
    );
  }

  return { patchPath, note: patchPathNote };
}

async function resolveWorktreePatchLocalPath(params: {
  taskId: string;
  artifactSessionDir: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
}): Promise<{ patchPath: string } | { error: string } | null> {
  const metadataPath = params.projectArtifact.worktreePatchPath;
  const hasMetadataPath = typeof metadataPath === "string" && metadataPath.length > 0;

  const canonicalPath = getSubagentGitPatchWorktreePatchPath(
    params.artifactSessionDir,
    params.taskId,
    params.projectArtifact.storageKey
  );
  const safeMetadataPath =
    typeof metadataPath === "string" &&
    metadataPath.length > 0 &&
    isPathInsideDir(params.artifactSessionDir, metadataPath)
      ? metadataPath
      : undefined;

  // The canonical location is probed even without metadata, like the mbox
  // resolver: sanitized-away or corrupt worktreePatchPath must not make a
  // captured patch silently unapplied while the file sits on disk.
  const patchPath = await findExistingFile(
    new Set(
      [safeMetadataPath, canonicalPath].filter(
        (value): value is string =>
          typeof value === "string" && isPathInsideDir(params.artifactSessionDir, value)
      )
    )
  );
  if (patchPath != null) {
    return { patchPath };
  }
  // No file and no metadata means no worktree patch was ever captured.
  return hasMetadataPath ? { error: "Uncommitted-changes patch file is missing on disk." } : null;
}

async function snapshotStagedPaths(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  gitPrefix: string;
}): Promise<Set<string> | { error: string }> {
  const result = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git diff-index --cached --name-only -z HEAD --`,
    { cwd: params.cwd, timeout: 30 }
  );
  if (result.exitCode !== 0) {
    return { error: result.stderr.trim() || "git diff-index failed" };
  }
  return new Set(result.stdout.split("\0").filter((filePath) => filePath.length > 0));
}

async function unstagePaths(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  paths: string[];
  gitPrefix: string;
}): Promise<{ error: string } | undefined> {
  // Chunked so a patch touching many files cannot overflow the command
  // line; :(literal) keeps glob characters in file names from matching
  // other paths.
  const chunkSize = 200;
  for (let i = 0; i < params.paths.length; i += chunkSize) {
    const pathspecs = params.paths
      .slice(i, i + chunkSize)
      .map((filePath) => shellQuote(`:(literal)${filePath}`))
      .join(" ");
    const restoreResult = await execBuffered(
      params.runtime,
      `${params.gitPrefix}git restore --staged -- ${pathspecs}`,
      {
        cwd: params.cwd,
        timeout: 60,
      }
    );
    if (restoreResult.exitCode !== 0) {
      return { error: restoreResult.stderr.trim() || "git restore failed" };
    }
  }
  return undefined;
}

/**
 * A failed earlier attempt can leave the patch's paths staged: `git apply
 * --3way` implies --index, so an attempt whose post-apply unstage (or index
 * snapshot) failed, or that stopped at conflicts, leaves index entries
 * behind while the content already sits in the worktree. The reverse check
 * only proves worktree content, so completion must repair the index before
 * the recovery marker is cleared; otherwise the "applied" report leaves the
 * child's changes staged and the next commit-bearing apply fails its
 * clean-index preflight. Staged entries outside the patch are untouched.
 */
async function repairStagedWorktreePatchPaths(params: {
  runtime: ToolConfiguration["runtime"];
  repoCwd: string;
  localPatchPath: string;
  gitPrefix: string;
}): Promise<{ error: string } | undefined> {
  let patchText: string;
  try {
    patchText = await fsPromises.readFile(params.localPatchPath, "utf-8");
  } catch (error: unknown) {
    return { error: `Could not read uncommitted-changes patch: ${getErrorMessage(error)}` };
  }
  const patchPaths = new Set([
    ...parseDiffGitHeaderPaths(patchText),
    ...parsePatchMetadataPaths(patchText).changedPaths,
  ]);
  const staged = await snapshotStagedPaths({
    runtime: params.runtime,
    cwd: params.repoCwd,
    gitPrefix: params.gitPrefix,
  });
  if (!(staged instanceof Set)) {
    return { error: `Could not snapshot the index: ${staged.error}` };
  }
  const toUnstage = [...staged].filter((stagedPath) => patchPaths.has(stagedPath));
  if (toUnstage.length === 0) {
    return undefined;
  }
  return await unstagePaths({
    runtime: params.runtime,
    cwd: params.repoCwd,
    paths: toUnstage,
    gitPrefix: params.gitPrefix,
  });
}

/**
 * Builds the reverse-check script. A plain `git apply --reverse --check`
 * (no --index/--cached) segfaults on git >= 2.40 when GIT_ATTR_SOURCE is set,
 * which the no-repo-automation env always does, and the local runtime reports
 * a signal death as exit 0, so the check would always read as "present".
 * Checking against a throwaway index built from HEAD plus the patch paths'
 * current worktree content avoids that code path. The temp files sit next to
 * the patch copy so the patch's sandbox roots cover them, and the staged blobs
 * go to a throwaway object dir so the check never grows the repo's store.
 */
async function buildIndexReverseCheckCommand(params: {
  localPatchPath: string;
  remotePatchPath: string;
  gitPrefix: string;
}): Promise<{ command: string } | { error: string }> {
  let patchText: string;
  try {
    patchText = await fsPromises.readFile(params.localPatchPath, "utf-8");
  } catch (error: unknown) {
    return { error: `Could not read uncommitted-changes patch: ${getErrorMessage(error)}` };
  }
  const patchPaths = [
    ...new Set([
      ...parseDiffGitHeaderPaths(patchText),
      ...parsePatchMetadataPaths(patchText).changedPaths,
    ]),
  ];
  if (patchPaths.length === 0) {
    return { error: "The uncommitted-changes patch names no paths to check." };
  }
  const tempDir = shellQuote(path.posix.dirname(params.remotePatchPath));
  const chunkSize = 200;
  const addCommands: string[] = [];
  for (let i = 0; i < patchPaths.length; i += chunkSize) {
    const quotedPaths = patchPaths
      .slice(i, i + chunkSize)
      .map((filePath) => shellQuote(filePath))
      .join(" ");
    // update-index takes plain paths (no pathspec magic), ignores .gitignore,
    // and skips a path that exists neither in HEAD nor on disk, so the
    // reverse apply alone decides whether an absent path (a deletion the
    // user has since committed) matches the patch.
    addCommands.push(
      `GIT_INDEX_FILE="$TMP_INDEX" ${params.gitPrefix}git update-index --add --remove -- ${quotedPaths}`
    );
  }
  const command = [
    "set -e",
    `TMP_INDEX="$(mktemp ${tempDir}/mux-reverse-check-index.XXXXXX)"`,
    `TMP_OBJECTS="$(mktemp -d ${tempDir}/mux-reverse-check-objects.XXXXXX)"`,
    'trap \'rm -f "$TMP_INDEX"; rm -rf "$TMP_OBJECTS"\' EXIT',
    `REAL_OBJECTS="$(cd "$(${params.gitPrefix}git rev-parse --git-path objects)" && pwd)"`,
    'export GIT_OBJECT_DIRECTORY="$TMP_OBJECTS"',
    'export GIT_ALTERNATE_OBJECT_DIRECTORIES="$REAL_OBJECTS"',
    `GIT_INDEX_FILE="$TMP_INDEX" ${params.gitPrefix}git read-tree HEAD`,
    ...addCommands,
    `GIT_INDEX_FILE="$TMP_INDEX" ${params.gitPrefix}git apply --cached --reverse --check --binary ${shellQuote(params.remotePatchPath)}`,
  ].join("\n");
  return { command };
}

/** Uses three-way apply so failed conflicts can be surfaced through conflictPaths. */
async function applyWorktreeDiffPatch(params: {
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  repoCwd: string;
  taskId: string;
  storageKey: string;
  workspaceId: string;
  gitPrefix: string;
  localPatchPath: string;
  abortSignal?: AbortSignal;
  /**
   * "reverse-check" only tests whether the patch content is already fully
   * present in the worktree (a reverse application would succeed); nothing
   * is modified.
   */
  mode?: "apply" | "reverse-check";
}): Promise<{ applied: true } | { applied: false; error: string; conflictPaths?: string[] }> {
  const remoteWorktreePatchPath = buildRuntimeTempPath({
    runtimeTempDir: params.runtimeTempDir,
    filename: `mux-task-${params.taskId}-${params.storageKey}-worktree.patch`,
    purpose: "worktree patch copy",
  });

  await cleanupRuntimePatchFile({
    runtime: params.runtime,
    repoCwd: params.repoCwd,
    remotePatchPath: remoteWorktreePatchPath,
    taskId: params.taskId,
    workspaceId: params.workspaceId,
  });

  try {
    await copyLocalFileToRuntime({
      runtime: params.runtime,
      localPath: params.localPatchPath,
      remotePath: remoteWorktreePatchPath,
      abortSignal: params.abortSignal,
    });

    const isRealApply = params.mode !== "reverse-check";
    // `git apply --3way` implies --index (git-apply(1)), so a successful
    // apply stages every file it touched. The child's changes must land as
    // plain worktree changes: staged entries change the dirty-state
    // semantics and make the next commit-bearing apply fail its
    // clean-index preflight. The exact set to unstage is diffed from
    // before/after index snapshots because unrelated staged entries are
    // allowed here (only the commit-bearing path requires a clean index)
    // and must survive untouched.
    let stagedBefore: Set<string> | null = null;
    if (isRealApply) {
      const snapshot = await snapshotStagedPaths({
        runtime: params.runtime,
        cwd: params.repoCwd,
        gitPrefix: params.gitPrefix,
      });
      if (!(snapshot instanceof Set)) {
        // Nothing was applied yet, so this failure is cleanly retryable.
        return {
          applied: false,
          error: `Could not snapshot the index before applying the uncommitted-changes patch: ${snapshot.error}`,
        };
      }
      stagedBefore = snapshot;
    }
    let applyCommand: string;
    if (isRealApply) {
      applyCommand =
        `${params.gitPrefix}git apply --3way --binary ${shellQuote(remoteWorktreePatchPath)}`.trim();
    } else {
      const reverseCheckCommand = await buildIndexReverseCheckCommand({
        localPatchPath: params.localPatchPath,
        remotePatchPath: remoteWorktreePatchPath,
        gitPrefix: params.gitPrefix,
      });
      if ("error" in reverseCheckCommand) {
        return { applied: false, error: reverseCheckCommand.error };
      }
      applyCommand = reverseCheckCommand.command;
    }
    const applyResult = await execBuffered(params.runtime, applyCommand, {
      cwd: params.repoCwd,
      timeout: 300,
      sandboxRoots: runtimeTempSandboxRoots(remoteWorktreePatchPath),
    });

    if (applyResult.exitCode !== 0) {
      const errorOutput = [applyResult.stderr.trim(), applyResult.stdout.trim()]
        .filter((s) => s.length > 0)
        .join("\n")
        .trim();
      // A failed reverse-check never touches the index, so there are no
      // conflict paths to collect.
      const conflictPaths =
        params.mode === "reverse-check"
          ? []
          : await tryGetConflictPaths({
              runtime: params.runtime,
              cwd: params.repoCwd,
              gitPrefix: params.gitPrefix,
            });
      return {
        applied: false,
        error:
          errorOutput.length > 0
            ? errorOutput
            : `git apply failed (exitCode=${applyResult.exitCode})`,
        ...(conflictPaths.length > 0 ? { conflictPaths } : {}),
      };
    }

    if (isRealApply && stagedBefore != null) {
      const alreadyStagedNote =
        "The patch content was applied to the worktree, but the entries `git apply --3way` staged could not be unstaged. Unstage them manually (`git restore --staged -- <paths>`); the applied content itself is correct.";
      const stagedAfter = await snapshotStagedPaths({
        runtime: params.runtime,
        cwd: params.repoCwd,
        gitPrefix: params.gitPrefix,
      });
      if (!(stagedAfter instanceof Set)) {
        return { applied: false, error: `${alreadyStagedNote} (${stagedAfter.error})` };
      }
      const newlyStaged = [...stagedAfter].filter((filePath) => !stagedBefore.has(filePath));
      const unstageError = await unstagePaths({
        runtime: params.runtime,
        cwd: params.repoCwd,
        paths: newlyStaged,
        gitPrefix: params.gitPrefix,
      });
      if (unstageError != null) {
        return { applied: false, error: `${alreadyStagedNote} (${unstageError.error})` };
      }
    }

    return { applied: true };
  } finally {
    await cleanupRuntimePatchFile({
      runtime: params.runtime,
      repoCwd: params.repoCwd,
      remotePatchPath: remoteWorktreePatchPath,
      taskId: params.taskId,
      workspaceId: params.workspaceId,
    });
  }
}

async function isCommitAncestorOfHead(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  commitSha: string;
  gitPrefix: string;
}): Promise<boolean> {
  const result = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git merge-base --is-ancestor ${shellQuote(params.commitSha)} HEAD`,
    { cwd: params.cwd, timeout: 30 }
  );
  // Exit 1 = not an ancestor; other non-zero (e.g. unknown SHA after a
  // reset + gc) also means the recorded HEAD is gone. Fail closed.
  return result.exitCode === 0;
}

/**
 * A completion record proves an apply finished when it was written, not that
 * the work is still present: a crash after the record but before a workflow
 * checkpoint leaves the record while a reset/rebase (or discarded worktree
 * changes) removes the work. Replay-safe retries (allowAlreadyApplied) verify
 * both components before skipping. The recorded post-apply HEAD must still be
 * an ancestor of HEAD (commit series). The uncommitted-changes patch content
 * must still be reverse-applicable OR its paths must deviate from the
 * recorded post-apply state (dirty in the worktree, or changed between the
 * recorded HEAD and the current HEAD): later legitimate edits or commits of
 * the applied work are indistinguishable from each other by content, so only
 * fully pristine patch paths, which is exactly what a discard restores, read
 * as missing. Records without a recorded HEAD (written before the field
 * existed) cannot be validated and keep the legacy skip. Returns a reason
 * string when the applied work is missing, else null.
 */
async function checkAppliedWorkStillPresent(params: {
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  repoCwd: string;
  taskId: string;
  workspaceId: string;
  gitPrefix: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactSessionDir: string;
  recordedHeadSha: string | undefined;
  /**
   * The completion was asserted via acknowledge_partial_recovery: the manual
   * recovery may not be reverse-applicable, so the content check must not
   * re-run against it (the user's assertion would fail forever).
   */
  recordedAcknowledged: boolean;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  if (params.recordedHeadSha == null) {
    return null;
  }
  const artifactHasCommitSeries =
    params.projectArtifact.commitCount !== 0 ||
    (typeof params.projectArtifact.mboxPath === "string" &&
      params.projectArtifact.mboxPath.length > 0);
  if (artifactHasCommitSeries) {
    const stillAncestor = await isCommitAncestorOfHead({
      runtime: params.runtime,
      cwd: params.repoCwd,
      commitSha: params.recordedHeadSha,
      gitPrefix: params.gitPrefix,
    });
    if (!stillAncestor) {
      return `the target branch no longer contains the recorded post-apply HEAD (${params.recordedHeadSha}), so the applied commit series is missing (the target was likely reset or rebased)`;
    }
  }
  if (params.recordedAcknowledged) {
    return null;
  }
  const worktreePatch = await resolveWorktreePatchLocalPath({
    taskId: params.taskId,
    artifactSessionDir: params.artifactSessionDir,
    projectArtifact: params.projectArtifact,
  });
  if (worktreePatch == null) {
    return null;
  }
  if ("error" in worktreePatch) {
    return `whether the child's applied uncommitted changes are still present cannot be verified (${worktreePatch.error})`;
  }
  const reverseCheck = await applyWorktreeDiffPatch({
    runtime: params.runtime,
    runtimeTempDir: params.runtimeTempDir,
    repoCwd: params.repoCwd,
    taskId: params.taskId,
    storageKey: params.projectArtifact.storageKey,
    workspaceId: params.workspaceId,
    gitPrefix: params.gitPrefix,
    localPatchPath: worktreePatch.patchPath,
    abortSignal: params.abortSignal,
    mode: "reverse-check",
  });
  if (reverseCheck.applied) {
    return null;
  }
  let patchText: string;
  try {
    patchText = await fsPromises.readFile(worktreePatch.patchPath, "utf-8");
  } catch (error: unknown) {
    return `whether the child's applied uncommitted changes are still present cannot be verified (could not read the uncommitted-changes patch: ${getErrorMessage(error)})`;
  }
  const patchPaths = [
    ...new Set([
      ...parseDiffGitHeaderPaths(patchText),
      ...parsePatchMetadataPaths(patchText).changedPaths,
    ]),
  ];
  // The failed reverse check proves the whole patch is not present as-is, so
  // every patch path needs its own evidence (still dirty, or changed since the
  // recorded post-apply HEAD): one surviving file must not vouch for a
  // discarded sibling.
  const unaccountedPaths = new Set(patchPaths);
  const chunkSize = 200;
  for (let i = 0; i < patchPaths.length; i += chunkSize) {
    const pathspecs = patchPaths
      .slice(i, i + chunkSize)
      .map((filePath) => shellQuote(`:(literal)${filePath}`))
      .join(" ");
    const statusResult = await execBuffered(
      params.runtime,
      `${params.gitPrefix}git status --porcelain -z --untracked-files=all -- ${pathspecs}`,
      { cwd: params.repoCwd, timeout: 30 }
    );
    if (statusResult.exitCode !== 0) {
      return `whether the child's applied uncommitted changes are still present cannot be verified (${statusResult.stderr.trim() || "git status failed"})`;
    }
    for (const entry of parseGitStatusPorcelainZ(statusResult.stdout)) {
      unaccountedPaths.delete(entry.path);
    }
    // --no-renames: a detected rename would list only its destination and
    // leave the source path unaccounted for.
    const diffResult = await execBuffered(
      params.runtime,
      `${params.gitPrefix}git diff --name-only --no-renames -z ${shellQuote(params.recordedHeadSha)} HEAD -- ${pathspecs}`,
      { cwd: params.repoCwd, timeout: 30 }
    );
    if (diffResult.exitCode !== 0) {
      return `whether the child's applied uncommitted changes are still present cannot be verified (${diffResult.stderr.trim() || "git diff failed"})`;
    }
    for (const changedPath of diffResult.stdout.split("\0")) {
      unaccountedPaths.delete(changedPath);
    }
  }
  if (unaccountedPaths.size === 0) {
    return null;
  }
  return `the child's applied uncommitted changes are no longer present in the worktree (they were likely discarded): ${[...unaccountedPaths].join(", ")}`;
}

/**
 * Replay targets prove completion with their target-local record (pass it as
 * localCompletion); direct targets with the shared artifact's applied fields.
 * A project that cannot be resolved in this workspace (no repoCwd) can be
 * neither validated nor re-applied, so it keeps the legacy skip.
 */
async function findStaleRecordedCompletion(params: {
  config: TaskGitPatchApplyConfig;
  repoCwd: string | undefined;
  taskId: string;
  workspaceId: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactSessionDir: string;
  localCompletion: LocalPatchApplyCompletionRecord | null | undefined;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  if (params.repoCwd == null) return null;
  const isReplay = params.localCompletion !== undefined;
  return await checkAppliedWorkStillPresent({
    runtime: params.config.runtime,
    runtimeTempDir: params.config.runtimeTempDir,
    repoCwd: params.repoCwd,
    taskId: params.taskId,
    workspaceId: params.workspaceId,
    gitPrefix: await gitNoRepoAutomationPrefixForRuntime({
      runtime: params.config.runtime,
      cwd: params.repoCwd,
      trusted: params.config.trusted === true,
    }),
    projectArtifact: params.projectArtifact,
    artifactSessionDir: params.artifactSessionDir,
    recordedHeadSha: isReplay
      ? params.localCompletion?.headCommitSha
      : params.projectArtifact.appliedHeadSha,
    recordedAcknowledged: isReplay
      ? params.localCompletion?.acknowledged === true
      : params.projectArtifact.appliedAcknowledged === true,
    abortSignal: params.abortSignal,
  });
}

function validatePatchRuntimePathComponent(value: string, label: string): string | undefined {
  if (isSafeSubagentGitPatchPathComponent(value)) {
    return undefined;
  }
  return `${label} must be a safe path component.`;
}

/**
 * ExecOptions.sandboxRoots for a command that reads or writes `runtimeTempPath`: the patch file
 * and the dry-run worktree live in runtimeTempDir (~/.xum-tmp), outside the agent sandbox policy.
 * These git commands stay sandboxed, as `git am` and `git worktree add` can run the repo's hooks.
 */
function runtimeTempSandboxRoots(runtimeTempPath: string): string[] {
  return [path.posix.dirname(runtimeTempPath)];
}

function buildRuntimeTempPath(params: {
  runtimeTempDir: string;
  filename: string;
  purpose: string;
}): string {
  const runtimePath = path.posix.join(params.runtimeTempDir, params.filename);
  assert(
    isPathInsideDir(params.runtimeTempDir, runtimePath),
    `task_apply_git_patch ${params.purpose} path must stay inside runtimeTempDir`
  );
  return runtimePath;
}

interface GitStatusPorcelainEntry {
  path: string;
  status: string;
}

export function parseGitStatusPorcelainZ(stdout: string): GitStatusPorcelainEntry[] {
  const entriesByPath: GitStatusPorcelainEntry[] = [];
  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;

    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath.length > 0) {
      entriesByPath.push({ path: filePath, status });
    }

    if (status.includes("R") || status.includes("C")) {
      i += 1;
      const sourcePath = entries[i];
      if (sourcePath != null && sourcePath.length > 0) {
        entriesByPath.push({ path: sourcePath, status });
      }
    }
  }
  return entriesByPath;
}

function parseGitApplyNumstatZ(stdout: string): string[] {
  return stdout
    .split("\0")
    .map((entry) => {
      const firstTabIndex = entry.indexOf("\t");
      const secondTabIndex = entry.indexOf("\t", firstTabIndex + 1);
      return secondTabIndex === -1 ? "" : entry.slice(secondTabIndex + 1);
    })
    .filter((filePath) => filePath.length > 0);
}

interface PatchMetadataPaths {
  /** Paths the patch mutates: rename sources/destinations and copy destinations. */
  changedPaths: string[];
  /** Copy sources are only read, so they conflict with dirty state selectively. */
  copySourcePaths: string[];
}

function parsePatchMetadataPaths(stdout: string): PatchMetadataPaths {
  const changedPaths: string[] = [];
  const copySourcePaths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const changedPrefix = ["rename from ", "rename to ", "copy to "].find((prefix) =>
      line.startsWith(prefix)
    );
    if (changedPrefix != null) {
      const filePath = parsePatchMetadataPath(line.slice(changedPrefix.length));
      if (filePath.length > 0) {
        changedPaths.push(filePath);
      }
      continue;
    }

    if (line.startsWith("copy from ")) {
      const filePath = parsePatchMetadataPath(line.slice("copy from ".length));
      if (filePath.length > 0) {
        copySourcePaths.push(filePath);
      }
    }
  }
  return { changedPaths, copySourcePaths };
}

function parseDiffGitHeaderPaths(stdout: string): string[] {
  const paths = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) continue;
    for (const filePath of parseDiffGitHeaderLine(line.slice("diff --git ".length))) {
      paths.add(filePath);
    }
  }
  return [...paths].filter((filePath) => filePath.length > 0);
}

// Git C-quotes each side of the header independently, so a rename between an
// ASCII and a non-ASCII name yields a mixed quoted/unquoted path pair. An
// unquoted side never contains a literal quote (git would have quoted it), so
// a mid-line quote can only open a quoted b side.
function parseDiffGitHeaderLine(line: string): string[] {
  if (line.startsWith('"')) {
    const first = parseGitQuotedPath(line, 0);
    if (first == null) return [];
    let secondStartOffset = first.nextOffset;
    while (line[secondStartOffset] === " ") {
      secondStartOffset += 1;
    }
    const rest = line.slice(secondStartOffset);
    const second = rest.startsWith('"') ? parseGitQuotedPath(line, secondStartOffset)?.path : rest;
    return [stripDiffPathPrefix(first.path), stripDiffPathPrefix(second)].filter(
      (filePath): filePath is string => filePath != null && filePath.length > 0
    );
  }

  if (!line.startsWith("a/")) {
    return [];
  }

  const quoteIndex = line.indexOf('"');
  if (quoteIndex !== -1) {
    const second = parseGitQuotedPath(line, quoteIndex);
    if (second == null) return [];
    return [
      stripDiffPathPrefix(line.slice(0, quoteIndex).trimEnd()),
      stripDiffPathPrefix(second.path),
    ].filter((filePath): filePath is string => filePath != null && filePath.length > 0);
  }

  const paths = new Set<string>();
  let separatorIndex = line.indexOf(" b/", "a/".length);
  while (separatorIndex !== -1) {
    paths.add(line.slice("a/".length, separatorIndex));
    paths.add(line.slice(separatorIndex + " b/".length));
    separatorIndex = line.indexOf(" b/", separatorIndex + 1);
  }
  return [...paths];
}

function stripDiffPathPrefix(filePath: string | undefined): string | undefined {
  if (filePath == null) return undefined;
  return filePath.startsWith("a/") || filePath.startsWith("b/") ? filePath.slice(2) : filePath;
}

function parsePatchMetadataPath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  return parseGitQuotedPath(value, 0)?.path ?? "";
}

function parseGitQuotedPath(
  value: string,
  startOffset: number
): { path: string; nextOffset: number } | undefined {
  if (value[startOffset] !== '"') {
    return undefined;
  }

  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let offset = startOffset + 1;
  while (offset < value.length) {
    const char = value[offset];
    if (char === '"') {
      return { path: new TextDecoder().decode(Uint8Array.from(bytes)), nextOffset: offset + 1 };
    }

    if (char !== "\\") {
      const codePoint = value.codePointAt(offset);
      if (codePoint == null) {
        return undefined;
      }
      const codePointString = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(codePointString));
      offset += codePointString.length;
      continue;
    }

    offset += 1;
    if (offset >= value.length) {
      return undefined;
    }

    const escaped = value[offset];
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      offset += 1;
      while (offset < value.length && octal.length < 3 && /[0-7]/.test(value[offset])) {
        octal += value[offset];
        offset += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    const escapedByte = decodeGitQuotedEscapedByte(escaped);
    if (escapedByte == null) {
      bytes.push(...encoder.encode(escaped));
    } else {
      bytes.push(escapedByte);
    }
    offset += 1;
  }

  return undefined;
}

function decodeGitQuotedEscapedByte(char: string): number | undefined {
  switch (char) {
    case "a":
      return 0x07;
    case "b":
      return 0x08;
    case "t":
      return 0x09;
    case "n":
      return 0x0a;
    case "v":
      return 0x0b;
    case "f":
      return 0x0c;
    case "r":
      return 0x0d;
    case '"':
      return 0x22;
    case "\\":
      return 0x5c;
    default:
      return undefined;
  }
}

function extractGitPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const parsed = parseDiffGitHeaderLine(line.slice("diff --git ".length));
      if (parsed.length === 0) paths.add("<unparseable diff header>");
      parsed.forEach((filePath) => paths.add(filePath));
      continue;
    }
    const prefixes = ["--- ", "+++ ", "rename from ", "rename to ", "copy from ", "copy to "];
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (prefix != null) {
      const filePath = normalizePatchPath(parsePatchMetadataPath(line.slice(prefix.length)));
      if (filePath != null) paths.add(filePath);
    }
  }
  return [...paths];
}

function normalizePatchPath(rawPath: string): string | undefined {
  let value = rawPath.trim();
  if (value.length === 0 || value === "/dev/null") return undefined;
  value = stripDiffPathPrefix(value) ?? value;
  const segments = value.split("/");
  if (path.posix.isAbsolute(value) || segments.includes("..")) return value;
  return segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
}

function isPatchPathAllowed(patchPath: string, allowedPrefixes: string[]): boolean {
  return allowedPrefixes.some((prefix) => {
    const normalizedPrefix = normalizePatchPath(prefix);
    return (
      normalizedPrefix != null &&
      (patchPath === normalizedPrefix || patchPath.startsWith(normalizedPrefix + "/"))
    );
  });
}

async function getAllowedPatchPathViolation(params: {
  taskId: string;
  artifactSessionDir: string;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
  allowedPathPrefixes: string[];
}): Promise<string | undefined> {
  const violations = new Set<string>();
  for (const projectArtifact of params.projectArtifacts) {
    if (projectArtifact.status === "skipped") continue;
    if (projectArtifact.status !== "ready") {
      return (
        "Patch artifact for " +
        projectArtifact.projectName +
        " is " +
        projectArtifact.status +
        "; cannot validate allowedPathPrefixes."
      );
    }
    // Validate every patch file the apply would use: the commit-series mbox and the
    // uncommitted-changes worktree diff. Both are attacker-controlled.
    const patchFilePaths: string[] = [];
    const hasCommitPatch =
      projectArtifact.commitCount !== 0 ||
      (typeof projectArtifact.mboxPath === "string" && projectArtifact.mboxPath.length > 0);
    if (hasCommitPatch) {
      const resolution = await resolvePatchPath({
        taskId: params.taskId,
        artifactSessionDir: params.artifactSessionDir,
        projectArtifact,
      });
      if ("error" in resolution) return "Patch file is missing for task " + params.taskId;
      patchFilePaths.push(resolution.patchPath);
    }
    // Resolved even without metadata: the apply path probes the canonical worktree patch when
    // worktreePatchPath was sanitized away, so skipping it here would bypass the allowlist.
    const worktreeResolution = await resolveWorktreePatchLocalPath({
      taskId: params.taskId,
      artifactSessionDir: params.artifactSessionDir,
      projectArtifact,
    });
    if (worktreeResolution != null && "error" in worktreeResolution) {
      return "Uncommitted-changes patch file is missing for task " + params.taskId;
    }
    if (worktreeResolution != null) patchFilePaths.push(worktreeResolution.patchPath);
    if (patchFilePaths.length === 0) {
      return (
        "Patch artifact for " +
        projectArtifact.projectName +
        " has no patch files to validate allowedPathPrefixes."
      );
    }
    for (const patchFilePath of patchFilePaths) {
      const patchText = await fsPromises.readFile(patchFilePath, "utf-8");
      for (const patchPath of extractGitPatchPaths(patchText)) {
        if (!isPatchPathAllowed(patchPath, params.allowedPathPrefixes)) violations.add(patchPath);
      }
    }
  }
  return violations.size === 0
    ? undefined
    : "Patch touches paths outside allowed prefixes (" +
        params.allowedPathPrefixes.join(", ") +
        "): " +
        [...violations].join(", ");
}

function patchPathOverlapsDirtyPath(patchPath: string, dirtyPath: string): boolean {
  const normalizedPatchPath = patchPath.replace(/\/+$/, "");
  const normalizedDirtyPath = dirtyPath.replace(/\/+$/, "");
  return (
    normalizedPatchPath === normalizedDirtyPath ||
    normalizedPatchPath.startsWith(`${normalizedDirtyPath}/`) ||
    normalizedDirtyPath.startsWith(`${normalizedPatchPath}/`)
  );
}

async function checkDirtyPatchPathOverlap(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  remotePatchPath: string;
  threeWay: boolean;
  gitPrefix: string;
}): Promise<{ error: string; conflictPaths?: string[] } | undefined> {
  const statusResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git status --porcelain -z --untracked-files=all`,
    {
      cwd: params.cwd,
      timeout: 10,
    }
  );
  if (statusResult.exitCode !== 0) {
    return { error: statusResult.stderr.trim() || "git status failed" };
  }

  const dirtyEntries = parseGitStatusPorcelainZ(statusResult.stdout);
  if (dirtyEntries.length === 0) {
    return undefined;
  }

  const cachedResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git diff-index --cached --name-only -z HEAD --`,
    {
      cwd: params.cwd,
      timeout: 10,
    }
  );
  if (cachedResult.exitCode !== 0) {
    return { error: cachedResult.stderr.trim() || "git diff-index failed" };
  }
  const stagedPaths = cachedResult.stdout
    .split("\0")
    .filter((filePath) => filePath.length > 0)
    .sort();
  if (stagedPaths.length > 0) {
    return {
      error: "Index has staged changes; git am requires a clean index.",
      conflictPaths: stagedPaths,
    };
  }

  const dirtyPaths = new Set(dirtyEntries.map((entry) => entry.path));

  const patchBodyCommand = `awk '/^From / { in_patch=0 } /^---$/ { in_patch=1; next } in_patch { print }' ${shellQuote(
    params.remotePatchPath
  )}`;
  const numstatResult = await execBuffered(
    params.runtime,
    `${patchBodyCommand} | ${params.gitPrefix}git apply --numstat -z`,
    {
      cwd: params.cwd,
      timeout: 30,
      sandboxRoots: runtimeTempSandboxRoots(params.remotePatchPath),
    }
  );
  const numstatPaths = parseGitApplyNumstatZ(numstatResult.stdout);

  const diffHeaderResult = await execBuffered(
    params.runtime,
    `awk '/^From / { in_patch=0 } /^---$/ { in_patch=1; next } in_patch && /^diff --git / { print }' ${shellQuote(
      params.remotePatchPath
    )}`,
    {
      cwd: params.cwd,
      timeout: 30,
      sandboxRoots: runtimeTempSandboxRoots(params.remotePatchPath),
    }
  );

  if (numstatResult.exitCode !== 0 && !numstatResult.stderr.includes("No valid patches")) {
    return {
      error:
        numstatResult.stderr.trim() ||
        numstatResult.stdout.trim() ||
        "Could not determine patch paths before applying in dirty worktree.",
    };
  }

  const metadataResult = await execBuffered(
    params.runtime,
    `awk '/^From / { in_patch=0; in_diff=0 } /^---$/ { in_patch=1; next } in_patch && /^diff --git / { in_diff=1; next } in_patch && in_diff && (/^rename from / || /^rename to / || /^copy from / || /^copy to /) { print }' ${shellQuote(
      params.remotePatchPath
    )}`,
    {
      cwd: params.cwd,
      timeout: 30,
      sandboxRoots: runtimeTempSandboxRoots(params.remotePatchPath),
    }
  );
  const metadataPaths = parsePatchMetadataPaths(metadataResult.stdout);
  const patchPaths = new Set([
    ...(numstatResult.exitCode === 0
      ? numstatPaths
      : parseDiffGitHeaderPaths(diffHeaderResult.stdout)),
    ...metadataPaths.changedPaths,
  ]);
  const conflictPaths = [
    ...new Set([
      ...[...dirtyPaths].filter((dirtyPath) =>
        [...patchPaths].some((patchPath) => patchPathOverlapsDirtyPath(patchPath, dirtyPath))
      ),
      ...dirtyEntries
        .filter(
          (entry) => !params.threeWay || entry.status.includes("D") || entry.status.includes("T")
        )
        .filter((entry) =>
          metadataPaths.copySourcePaths.some((copySourcePath) =>
            patchPathOverlapsDirtyPath(copySourcePath, entry.path)
          )
        )
        .map((entry) => entry.path),
    ]),
  ].sort();
  if (conflictPaths.length === 0) {
    return undefined;
  }

  return {
    error: "Working tree has local changes that overlap patch paths.",
    conflictPaths,
  };
}

/**
 * Preflights the uncommitted-changes patch against the ACTUAL target repo's
 * dirty state. Dry runs apply in a clean temp worktree, so without this check
 * a dry run can succeed while the real `git apply --3way` fails on local
 * modifications; real applies use it for a deterministic early failure.
 */
async function checkDirtyWorktreePatchPathOverlap(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  localPatchPath: string;
  gitPrefix: string;
}): Promise<{ error: string; conflictPaths?: string[] } | undefined> {
  const statusResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git status --porcelain -z --untracked-files=all`,
    { cwd: params.cwd, timeout: 10 }
  );
  if (statusResult.exitCode !== 0) {
    return { error: statusResult.stderr.trim() || "git status failed" };
  }
  const dirtyEntries = parseGitStatusPorcelainZ(statusResult.stdout);
  if (dirtyEntries.length === 0) {
    return undefined;
  }

  let patchText: string;
  try {
    patchText = await fsPromises.readFile(params.localPatchPath, "utf-8");
  } catch (error: unknown) {
    return { error: `Could not read uncommitted-changes patch: ${getErrorMessage(error)}` };
  }
  const patchPaths = new Set([
    ...parseDiffGitHeaderPaths(patchText),
    ...parsePatchMetadataPaths(patchText).changedPaths,
  ]);
  const conflictPaths = dirtyEntries
    .map((entry) => entry.path)
    .filter((dirtyPath) =>
      [...patchPaths].some((patchPath) => patchPathOverlapsDirtyPath(patchPath, dirtyPath))
    )
    .sort();
  if (conflictPaths.length === 0) {
    return undefined;
  }
  return {
    error: "Working tree has local changes that overlap the child's uncommitted-changes patch.",
    conflictPaths: [...new Set(conflictPaths)],
  };
}

async function checkExpectedHead(params: {
  runtime: ToolConfiguration["runtime"];
  cwd: string;
  expectedHeadSha?: string;
  gitPrefix: string;
}): Promise<string | undefined> {
  if (params.expectedHeadSha == null) {
    return undefined;
  }
  const currentHeadSha = await tryRevParseHead({
    runtime: params.runtime,
    cwd: params.cwd,
    gitPrefix: params.gitPrefix,
  });
  if (currentHeadSha == null) {
    return "Could not determine current HEAD before applying patch.";
  }
  if (currentHeadSha !== params.expectedHeadSha) {
    return `Current HEAD ${currentHeadSha} does not match expected HEAD ${params.expectedHeadSha}.`;
  }
  return undefined;
}

async function createDryRunWorktree(params: {
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  repoCwd: string;
  taskId: string;
  storageKey: string;
  gitPrefix: string;
  filenamePrefix: string;
}): Promise<{ path: string } | { error: string }> {
  const dryRunId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
  const dryRunWorktreePath = buildRuntimeTempPath({
    runtimeTempDir: params.runtimeTempDir,
    filename: `${params.filenamePrefix}-${params.taskId}-${params.storageKey}-${dryRunId}`,
    purpose: "dry-run worktree",
  });
  const addResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git worktree add --detach ${shellQuote(dryRunWorktreePath)} HEAD`,
    {
      cwd: params.repoCwd,
      timeout: 60,
      sandboxRoots: runtimeTempSandboxRoots(dryRunWorktreePath),
    }
  );
  return addResult.exitCode === 0
    ? { path: dryRunWorktreePath }
    : { error: addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed" };
}

async function applyProjectPatch(params: {
  taskId: string;
  workspaceId: string;
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  trusted: boolean;
  repoCwd: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  /** The applying workspace's own session dir (target-local replay state). */
  workspaceSessionDir: string;
  artifactLookupNote?: string;
  dryRun: boolean;
  threeWay: boolean;
  force: boolean;
  expectedHeadSha?: string;
  isReplay: boolean;
  abortSignal?: AbortSignal;
  /** The artifact workspace's FIFO for the applied watermark write. */
  locks: SessionLocks;
  /**
   * The commit series already landed in an earlier partial application, so
   * only the pending uncommitted-changes patch is applied (never `git am`).
   */
  completePartialWorktreeOnly?: boolean;
  /** Target HEAD recorded with the partial marker (ancestry fence). */
  partialCompletionFenceSha?: string;
}): Promise<{ success: boolean; projectResult: TaskApplyGitPatchProjectResult }> {
  const taskIdError = validatePatchRuntimePathComponent(params.taskId, "task_id");
  const storageKeyError = validatePatchRuntimePathComponent(
    params.projectArtifact.storageKey,
    "storageKey"
  );
  if (taskIdError != null || storageKeyError != null) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: taskIdError ?? storageKeyError,
      },
    };
  }

  const worktreeResolution = await resolveWorktreePatchLocalPath({
    taskId: params.taskId,
    artifactSessionDir: params.artifactSessionDir,
    projectArtifact: params.projectArtifact,
  });
  if (worktreeResolution != null && "error" in worktreeResolution) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: worktreeResolution.error,
        note: params.artifactLookupNote,
      },
    };
  }

  if (params.completePartialWorktreeOnly === true) {
    if (worktreeResolution == null) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error:
            "Patch was PARTIALLY applied: the commit series landed but the child's uncommitted-changes patch failed, and that patch is no longer available to complete the application.",
          note: mergeNotes(
            params.artifactLookupNote,
            "Recover manually: apply the child's uncommitted changes by hand. Only use force=true after resetting the branch to its pre-apply state, since it replays the already-applied commit series."
          ),
        },
      };
    }
    return applyWorktreeOnlyProjectPatch({
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      runtime: params.runtime,
      runtimeTempDir: params.runtimeTempDir,
      trusted: params.trusted,
      repoCwd: params.repoCwd,
      projectArtifact: params.projectArtifact,
      artifactWorkspaceId: params.artifactWorkspaceId,
      artifactSessionDir: params.artifactSessionDir,
      workspaceSessionDir: params.workspaceSessionDir,
      artifactLookupNote: params.artifactLookupNote,
      dryRun: params.dryRun,
      expectedHeadSha: params.expectedHeadSha,
      isReplay: params.isReplay,
      abortSignal: params.abortSignal,
      locks: params.locks,
      worktreePatchLocalPath: worktreeResolution.patchPath,
      partialCompletion: true,
      partialCompletionFenceSha: params.partialCompletionFenceSha,
    });
  }

  const hasCommitPatch =
    params.projectArtifact.commitCount !== 0 ||
    (typeof params.projectArtifact.mboxPath === "string" &&
      params.projectArtifact.mboxPath.length > 0);
  if (!hasCommitPatch) {
    if (worktreeResolution == null) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: "Artifact has no commit patch and no uncommitted-changes patch to apply.",
          note: params.artifactLookupNote,
        },
      };
    }
    return applyWorktreeOnlyProjectPatch({
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      runtime: params.runtime,
      runtimeTempDir: params.runtimeTempDir,
      trusted: params.trusted,
      repoCwd: params.repoCwd,
      projectArtifact: params.projectArtifact,
      artifactWorkspaceId: params.artifactWorkspaceId,
      artifactSessionDir: params.artifactSessionDir,
      workspaceSessionDir: params.workspaceSessionDir,
      artifactLookupNote: params.artifactLookupNote,
      dryRun: params.dryRun,
      expectedHeadSha: params.expectedHeadSha,
      isReplay: params.isReplay,
      abortSignal: params.abortSignal,
      locks: params.locks,
      worktreePatchLocalPath: worktreeResolution.patchPath,
    });
  }

  const remotePatchPath = buildRuntimeTempPath({
    runtimeTempDir: params.runtimeTempDir,
    filename: `mux-task-${params.taskId}-${params.projectArtifact.storageKey}-series.mbox`,
    purpose: "patch copy",
  });

  await cleanupRuntimePatchFile({
    runtime: params.runtime,
    repoCwd: params.repoCwd,
    remotePatchPath,
    taskId: params.taskId,
    workspaceId: params.workspaceId,
  });

  const patchResolution = await resolvePatchPath({
    taskId: params.taskId,
    artifactSessionDir: params.artifactSessionDir,
    projectArtifact: params.projectArtifact,
    artifactLookupNote: params.artifactLookupNote,
  });
  if ("error" in patchResolution) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: patchResolution.error,
        note: patchResolution.note,
      },
    };
  }

  const gitPrefix = await gitNoRepoAutomationPrefixForRuntime({
    runtime: params.runtime,
    cwd: params.repoCwd,
    trusted: params.trusted,
  });
  const expectedHeadError = await checkExpectedHead({
    runtime: params.runtime,
    cwd: params.repoCwd,
    expectedHeadSha: params.expectedHeadSha,
    gitPrefix,
  });
  if (expectedHeadError != null) {
    return {
      success: false,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "failed",
        error: expectedHeadError,
        note: patchResolution.note,
      },
    };
  }

  try {
    await copyLocalFileToRuntime({
      runtime: params.runtime,
      localPath: patchResolution.patchPath,
      remotePath: remotePatchPath,
      abortSignal: params.abortSignal,
    });

    const flags: string[] = [];
    if (params.threeWay) flags.push("--3way");
    if (!gitHooksAllowed(params.trusted)) flags.push("--no-gpg-sign");

    if (params.dryRun) {
      const dryRunDirtyOverlap = await checkDirtyPatchPathOverlap({
        runtime: params.runtime,
        cwd: params.repoCwd,
        remotePatchPath,
        threeWay: params.threeWay,
        gitPrefix,
      });
      if (dryRunDirtyOverlap != null) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            error: dryRunDirtyOverlap.error,
            conflictPaths: dryRunDirtyOverlap.conflictPaths,
            note: mergeNotes(
              patchResolution.note,
              "Commit or stash local changes on overlapping patch paths before applying. Unrelated dirty files can remain in place."
            ),
          },
        };
      }

      if (worktreeResolution != null) {
        const worktreeDirtyOverlap = await checkDirtyWorktreePatchPathOverlap({
          gitPrefix,
          runtime: params.runtime,
          cwd: params.repoCwd,
          localPatchPath: worktreeResolution.patchPath,
        });
        if (worktreeDirtyOverlap != null) {
          return {
            success: false,
            projectResult: {
              projectPath: params.projectArtifact.projectPath,
              projectName: params.projectArtifact.projectName,
              status: "failed",
              error: worktreeDirtyOverlap.error,
              conflictPaths: worktreeDirtyOverlap.conflictPaths,
              note: mergeNotes(
                patchResolution.note,
                "Commit or stash local changes on overlapping patch paths before applying. Unrelated dirty files can remain in place."
              ),
            },
          };
        }
      }

      const dryRunHeadError = await checkExpectedHead({
        runtime: params.runtime,
        cwd: params.repoCwd,
        expectedHeadSha: params.expectedHeadSha,
        gitPrefix,
      });
      if (dryRunHeadError != null) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            error: dryRunHeadError,
            note: patchResolution.note,
          },
        };
      }
      const dryRunWorktree = await createDryRunWorktree({
        runtime: params.runtime,
        runtimeTempDir: params.runtimeTempDir,
        repoCwd: params.repoCwd,
        taskId: params.taskId,
        storageKey: params.projectArtifact.storageKey,
        gitPrefix,
        filenamePrefix: "mux-git-am-dry-run",
      });
      if ("error" in dryRunWorktree) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            error: dryRunWorktree.error,
          },
        };
      }
      const dryRunWorktreePath = dryRunWorktree.path;

      try {
        const beforeHeadSha = await tryRevParseHead({
          runtime: params.runtime,
          cwd: dryRunWorktreePath,
          gitPrefix,
        });

        const amCmd = `${gitPrefix}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
        const amResult = await execBuffered(params.runtime, amCmd, {
          cwd: dryRunWorktreePath,
          timeout: 300,
          sandboxRoots: runtimeTempSandboxRoots(remotePatchPath),
        });

        if (amResult.exitCode !== 0) {
          const stderr = amResult.stderr.trim();
          const stdout = amResult.stdout.trim();
          const errorOutput = [stderr, stdout]
            .filter((s) => s.length > 0)
            .join("\n")
            .trim();

          const conflictPaths = await tryGetConflictPaths({
            runtime: params.runtime,
            cwd: dryRunWorktreePath,
            gitPrefix,
          });
          const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);

          return {
            success: false,
            projectResult: {
              projectPath: params.projectArtifact.projectPath,
              projectName: params.projectArtifact.projectName,
              status: "failed",
              conflictPaths,
              failedPatchSubject,
              error:
                errorOutput.length > 0
                  ? errorOutput
                  : `git am failed (exitCode=${amResult.exitCode})`,
              note: mergeNotes(
                patchResolution.note,
                "Dry run failed; the patch does not apply cleanly against the current HEAD. If this is a parent integration workspace, do not attempt a real apply here; delegate conflict resolution to a sub-agent that can replay and resolve the patch. Dedicated reconciliation workspaces can proceed with real apply plus manual conflict resolution (`git am --continue` / `git am --abort`)."
              ),
            },
          };
        }

        const appliedCommits = await getAppliedCommits({
          runtime: params.runtime,
          cwd: dryRunWorktreePath,
          beforeHeadSha,
          commitCountHint: params.projectArtifact.commitCount,
          includeSha: false,
          gitPrefix,
        });

        if (worktreeResolution != null) {
          const worktreeOutcome = await applyWorktreeDiffPatch({
            runtime: params.runtime,
            runtimeTempDir: params.runtimeTempDir,
            repoCwd: dryRunWorktreePath,
            taskId: params.taskId,
            storageKey: params.projectArtifact.storageKey,
            workspaceId: params.workspaceId,
            gitPrefix,
            localPatchPath: worktreeResolution.patchPath,
            abortSignal: params.abortSignal,
          });
          if (!worktreeOutcome.applied) {
            return {
              success: false,
              projectResult: {
                projectPath: params.projectArtifact.projectPath,
                projectName: params.projectArtifact.projectName,
                status: "failed",
                conflictPaths: worktreeOutcome.conflictPaths,
                error: worktreeOutcome.error,
                note: mergeNotes(
                  patchResolution.note,
                  "Dry run failed; the commit series applies cleanly but the child's uncommitted-changes patch does not."
                ),
              },
            };
          }
        }

        return {
          success: true,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "applied",
            appliedCommits,
            note: mergeNotes(
              patchResolution.note,
              "Dry run succeeded; no commits were applied.",
              worktreeCaptureSkippedNote(params.projectArtifact)
            ),
          },
        };
      } finally {
        try {
          const abortResult = await execBuffered(params.runtime, `${gitPrefix}git am --abort`, {
            cwd: dryRunWorktreePath,
            timeout: 30,
          });
          if (abortResult.exitCode !== 0) {
            log.debug("task_apply_git_patch: dry-run git am --abort failed", {
              taskId: params.taskId,
              workspaceId: params.workspaceId,
              cwd: params.repoCwd,
              dryRunWorktreePath,
              exitCode: abortResult.exitCode,
              stderr: abortResult.stderr.trim(),
              stdout: abortResult.stdout.trim(),
            });
          }
        } catch (error: unknown) {
          log.debug("task_apply_git_patch: dry-run git am --abort threw", {
            taskId: params.taskId,
            workspaceId: params.workspaceId,
            cwd: params.repoCwd,
            dryRunWorktreePath,
            error,
          });
        }

        await removeDryRunWorktreeBestEffort({
          runtime: params.runtime,
          repoCwd: params.repoCwd,
          dryRunWorktreePath,
          taskId: params.taskId,
          workspaceId: params.workspaceId,
          gitPrefix,
        });
      }
    }

    // Let `git am --3way` handle unrelated dirty files, but reject dirty paths
    // that overlap the patch series before a multi-commit `git am` can partially
    // advance HEAD and then fail on a later commit.
    const dirtyOverlap = await checkDirtyPatchPathOverlap({
      runtime: params.runtime,
      cwd: params.repoCwd,
      remotePatchPath,
      threeWay: params.threeWay,
      gitPrefix,
    });
    if (dirtyOverlap != null) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: dirtyOverlap.error,
          conflictPaths: dirtyOverlap.conflictPaths,
          note: mergeNotes(
            patchResolution.note,
            "Commit or stash local changes on overlapping patch paths before applying. Unrelated dirty files can remain in place."
          ),
        },
      };
    }

    // Preflight the worktree patch too, BEFORE git am: failing it after the
    // commit series lands would leave a partially applied artifact.
    if (worktreeResolution != null) {
      const worktreeDirtyOverlap = await checkDirtyWorktreePatchPathOverlap({
        gitPrefix,
        runtime: params.runtime,
        cwd: params.repoCwd,
        localPatchPath: worktreeResolution.patchPath,
      });
      if (worktreeDirtyOverlap != null) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            error: worktreeDirtyOverlap.error,
            conflictPaths: worktreeDirtyOverlap.conflictPaths,
            note: mergeNotes(
              patchResolution.note,
              "Commit or stash local changes on overlapping patch paths before applying. Unrelated dirty files can remain in place."
            ),
          },
        };
      }
    }

    const applyHeadError = await checkExpectedHead({
      gitPrefix,
      runtime: params.runtime,
      cwd: params.repoCwd,
      expectedHeadSha: params.expectedHeadSha,
    });
    if (applyHeadError != null) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: applyHeadError,
          note: patchResolution.note,
        },
      };
    }

    const beforeHeadSha = await tryRevParseHead({
      gitPrefix,
      runtime: params.runtime,
      cwd: params.repoCwd,
    });

    // Durable in-progress record BEFORE the irreversible `git am`: a crash
    // after git am succeeds but before any later write would otherwise leave
    // the applied commits unrecorded, and a retry would replay the mbox.
    // Recovery reconciles this record against HEAD: an unchanged HEAD (and
    // no in-progress am session) retries fresh; anything else fails closed.
    // A write failure here happens before anything was applied, so the
    // failure is cleanly retryable.
    try {
      if (params.isReplay) {
        await setLocalPatchPartialApply({
          locks: params.locks,
          workspaceId: params.workspaceId,
          workspaceSessionDir: params.workspaceSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          record: {
            appliedAtMs: Date.now(),
            stage: "am-started",
            ...(beforeHeadSha != null ? { headCommitSha: beforeHeadSha } : {}),
          },
        });
      } else {
        await markSubagentGitPatchArtifactApplied({
          locks: params.locks,
          workspaceId: params.artifactWorkspaceId,
          workspaceSessionDir: params.artifactSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          appliedAtMs: Date.now(),
          partial: true,
          partialStage: "am-started",
          ...(beforeHeadSha != null ? { partialHeadSha: beforeHeadSha } : {}),
        });
      }
    } catch (markerError: unknown) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          error: `Failed to persist the in-progress apply marker: ${getErrorMessage(markerError)}`,
          note: mergeNotes(
            patchResolution.note,
            "Nothing was applied. Fix the persistence failure (e.g. disk space) and retry."
          ),
        },
      };
    }

    const amCmd = `${gitPrefix}git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
    const amResult = await execBuffered(params.runtime, amCmd, {
      cwd: params.repoCwd,
      timeout: 300,
      sandboxRoots: runtimeTempSandboxRoots(remotePatchPath),
    });

    if (amResult.exitCode !== 0) {
      const stderr = amResult.stderr.trim();
      const stdout = amResult.stdout.trim();
      const errorOutput = [stderr, stdout]
        .filter((s) => s.length > 0)
        .join("\n")
        .trim();

      const conflictPaths = await tryGetConflictPaths({
        gitPrefix,
        runtime: params.runtime,
        cwd: params.repoCwd,
      });
      const failedPatchSubject = parseFailedPatchSubjectFromGitAmOutput(errorOutput);
      const gitAmInProgress = await isGitAmInProgress({
        gitPrefix,
        runtime: params.runtime,
        cwd: params.repoCwd,
      });
      const conflictRecoveryNote =
        conflictPaths.length > 0 || gitAmInProgress
          ? "git am stopped in conflict-recovery state. Resolve conflicts/issues and run `git am --continue`, or run `git am --abort` to restore a clean working tree and delegate resolution to a sub-agent."
          : "git am failed before entering conflict-recovery state. Review the error output above and fix the patch/input before retrying.";

      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          conflictPaths,
          failedPatchSubject,
          error:
            errorOutput.length > 0 ? errorOutput : `git am failed (exitCode=${amResult.exitCode})`,
          note: mergeNotes(patchResolution.note, conflictRecoveryNote),
        },
      };
    }

    const headCommitSha = await tryRevParseHead({
      gitPrefix,
      runtime: params.runtime,
      cwd: params.repoCwd,
    });

    const appliedCommits = await getAppliedCommits({
      gitPrefix,
      runtime: params.runtime,
      cwd: params.repoCwd,
      beforeHeadSha,
      commitCountHint: params.projectArtifact.commitCount,
      includeSha: true,
    });

    // git am permanently advanced HEAD, so record the artifact as applied
    // even though the worktree patch failed; a retry must not replay the
    // commit series on top of itself. The partial marker keeps replay
    // integrations from treating this as a completed application. Replay
    // targets record it locally: the ancestor's artifact is shared with
    // other targets and must stay replayable for them.
    const recordPartialApplication = async (): Promise<void> => {
      // The post-am HEAD fences later completion: it must still be an
      // ancestor of the target HEAD or the applied commit series is gone.
      if (params.isReplay) {
        await setLocalPatchPartialApply({
          locks: params.locks,
          workspaceId: params.workspaceId,
          workspaceSessionDir: params.workspaceSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          record: {
            appliedAtMs: Date.now(),
            stage: "commits-applied",
            ...(headCommitSha != null ? { headCommitSha } : {}),
          },
        });
      } else {
        await markSubagentGitPatchArtifactApplied({
          locks: params.locks,
          workspaceId: params.artifactWorkspaceId,
          workspaceSessionDir: params.artifactSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          appliedAtMs: Date.now(),
          partial: true,
          partialStage: "commits-applied",
          ...(headCommitSha != null ? { partialHeadSha: headCommitSha } : {}),
        });
      }
    };

    let worktreeNote: string | undefined;
    if (worktreeResolution != null) {
      // Persist the partial marker BEFORE attempting the worktree patch:
      // recording it only after a failure could itself fail (ENOSPC,
      // EACCES), leaving the applied commit series with no durable record
      // and a retry free to replay `git am`. Persisting up front also covers
      // a crash during the worktree apply. If the marker cannot be written,
      // the worktree patch has not been attempted yet, so the commit series
      // is rolled back (`git reset --keep` refuses to touch unrelated local
      // modifications) to keep the failure cleanly retryable.
      try {
        await recordPartialApplication();
      } catch (markerError: unknown) {
        let rolledBack = false;
        if (beforeHeadSha != null) {
          try {
            const rollbackResult = await execBuffered(
              params.runtime,
              `${gitPrefix}git reset --keep ${shellQuote(beforeHeadSha)}`,
              { cwd: params.repoCwd, timeout: 300 }
            );
            rolledBack = rollbackResult.exitCode === 0;
          } catch {
            // Fall through to the unrecoverable message below.
          }
        }
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            ...(rolledBack ? {} : { appliedCommits, headCommitSha }),
            error: `Failed to persist the partial-application marker: ${getErrorMessage(markerError)}`,
            note: mergeNotes(
              patchResolution.note,
              rolledBack
                ? "The commit series was rolled back; nothing from this artifact remains applied. Fix the persistence failure (e.g. disk space) and retry."
                : "The commit series was applied but could NOT be recorded or rolled back. Do NOT re-apply this task's patch; verify the applied commits manually before retrying."
            ),
          },
        };
      }
      // A rejection here (cancellation, runtime write failure) propagates
      // directly: the partial marker is already durable (persisted above).
      const worktreeOutcome = await applyWorktreeDiffPatch({
        runtime: params.runtime,
        runtimeTempDir: params.runtimeTempDir,
        repoCwd: params.repoCwd,
        taskId: params.taskId,
        storageKey: params.projectArtifact.storageKey,
        workspaceId: params.workspaceId,
        gitPrefix,
        localPatchPath: worktreeResolution.patchPath,
        abortSignal: params.abortSignal,
      });
      if (!worktreeOutcome.applied) {
        return {
          success: false,
          projectResult: {
            projectPath: params.projectArtifact.projectPath,
            projectName: params.projectArtifact.projectName,
            status: "failed",
            appliedCommits,
            headCommitSha,
            conflictPaths: worktreeOutcome.conflictPaths,
            error: worktreeOutcome.error,
            note: mergeNotes(
              patchResolution.note,
              "The commit series was applied successfully and recorded as applied, but the child's uncommitted-changes patch failed. Do not re-apply this task's patch; resolve the leftover conflicts (if any) or apply the uncommitted changes manually."
            ),
          },
        };
      }
      worktreeNote = "Also applied the child's uncommitted changes as uncommitted changes.";
    }

    // A completion-write failure must not read as success: the durable
    // state still says am-started or commits-applied, so a later retry
    // could not reconcile the advanced HEAD against a "successful" apply.
    // The work IS fully applied, so the guidance is never "re-apply".
    try {
      if (params.isReplay) {
        // A full apply (e.g. force retry after manual recovery) clears any
        // earlier target-local partial marker.
        await setLocalPatchPartialApply({
          locks: params.locks,
          workspaceId: params.workspaceId,
          workspaceSessionDir: params.workspaceSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          record: null,
          completedAtMs: Date.now(),
          ...(headCommitSha != null ? { completedHeadSha: headCommitSha } : {}),
        });
      } else {
        await markSubagentGitPatchArtifactApplied({
          locks: params.locks,
          workspaceId: params.artifactWorkspaceId,
          workspaceSessionDir: params.artifactSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          appliedAtMs: Date.now(),
          ...(headCommitSha != null ? { appliedHeadSha: headCommitSha } : {}),
        });
      }
    } catch (persistError: unknown) {
      return {
        success: false,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "failed",
          appliedCommits,
          headCommitSha,
          error: `The child's work was applied, but recording the completion failed: ${getErrorMessage(persistError)}`,
          note: mergeNotes(
            patchResolution.note,
            "Do NOT re-apply. Fix the persistence failure (e.g. permissions, disk space) and re-run; if the retry reports an interrupted apply, verify the work is present and use acknowledge_partial_recovery=true."
          ),
        },
      };
    }

    return {
      success: true,
      projectResult: {
        projectPath: params.projectArtifact.projectPath,
        projectName: params.projectArtifact.projectName,
        status: "applied",
        appliedCommits,
        headCommitSha,
        note: mergeNotes(
          patchResolution.note,
          worktreeNote,
          worktreeCaptureSkippedNote(params.projectArtifact)
        ),
      },
    };
  } finally {
    await cleanupRuntimePatchFile({
      runtime: params.runtime,
      repoCwd: params.repoCwd,
      remotePatchPath,
      taskId: params.taskId,
      workspaceId: params.workspaceId,
    });
  }
}

async function removeDryRunWorktreeBestEffort(params: {
  runtime: ToolConfiguration["runtime"];
  repoCwd: string;
  dryRunWorktreePath: string;
  taskId: string;
  workspaceId: string;
  gitPrefix: string;
}): Promise<void> {
  // `git worktree remove` and `prune` run no hooks. Once the dry-run worktree exists, the
  // sandbox keeps its metadata in the main .git read-only, so a sandboxed cleanup failed and
  // left the worktree behind after every dry run (Codex review); like `git worktree add` for
  // a workspace, Xum's own cleanup runs outside the sandbox. It needs nothing from the
  // user's PATH, where a sandboxed command can plant a git (an activated .venv/bin), so it
  // takes git from the system folders.
  try {
    const removeResult = await execBuffered(
      params.runtime,
      `${params.gitPrefix}git worktree remove --force ${shellQuote(params.dryRunWorktreePath)}`,
      { cwd: params.repoCwd, timeout: 60, sandbox: "internal" }
    );
    if (removeResult.exitCode !== 0) {
      log.debug("task_apply_git_patch: dry-run git worktree remove failed", {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        cwd: params.repoCwd,
        dryRunWorktreePath: params.dryRunWorktreePath,
        exitCode: removeResult.exitCode,
        stderr: removeResult.stderr.trim(),
        stdout: removeResult.stdout.trim(),
      });
    }
  } catch (error: unknown) {
    log.debug("task_apply_git_patch: dry-run git worktree remove threw", {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      cwd: params.repoCwd,
      dryRunWorktreePath: params.dryRunWorktreePath,
      error,
    });
  }

  try {
    const pruneResult = await execBuffered(
      params.runtime,
      `${params.gitPrefix}git worktree prune`,
      {
        cwd: params.repoCwd,
        timeout: 60,
        sandbox: "internal",
      }
    );
    if (pruneResult.exitCode !== 0) {
      log.debug("task_apply_git_patch: dry-run git worktree prune failed", {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        cwd: params.repoCwd,
        exitCode: pruneResult.exitCode,
        stderr: pruneResult.stderr.trim(),
        stdout: pruneResult.stdout.trim(),
      });
    }
  } catch (error: unknown) {
    log.debug("task_apply_git_patch: dry-run git worktree prune threw", {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      cwd: params.repoCwd,
      error,
    });
  }
}

async function applyWorktreeOnlyProjectPatch(params: {
  taskId: string;
  workspaceId: string;
  runtime: ToolConfiguration["runtime"];
  runtimeTempDir: string;
  trusted: boolean;
  repoCwd: string;
  projectArtifact: SubagentGitProjectPatchArtifact;
  artifactWorkspaceId: string;
  artifactSessionDir: string;
  /** The applying workspace's own session dir (target-local replay state). */
  workspaceSessionDir: string;
  artifactLookupNote?: string;
  dryRun: boolean;
  expectedHeadSha?: string;
  isReplay: boolean;
  abortSignal?: AbortSignal;
  worktreePatchLocalPath: string;
  /**
   * Completing an earlier partial application: the commit series already
   * landed, only the uncommitted-changes patch is pending. Success clears
   * the partial marker.
   */
  partialCompletion?: boolean;
  /**
   * Target HEAD recorded when the partial application happened. Completion
   * requires it to still be an ancestor of HEAD; otherwise the target was
   * reset/rebased and the applied commit series may be missing.
   */
  partialCompletionFenceSha?: string;
  /** The artifact workspace's FIFO for the applied watermark write. */
  locks: SessionLocks;
}): Promise<{ success: boolean; projectResult: TaskApplyGitPatchProjectResult }> {
  const partialCompletion = params.partialCompletion === true;
  const gitPrefix = await gitNoRepoAutomationPrefixForRuntime({
    runtime: params.runtime,
    cwd: params.repoCwd,
    trusted: params.trusted,
  });
  const failed = (
    error: string,
    extra?: Pick<TaskApplyGitPatchProjectResult, "conflictPaths" | "note">
  ): { success: boolean; projectResult: TaskApplyGitPatchProjectResult } => ({
    success: false,
    projectResult: {
      projectPath: params.projectArtifact.projectPath,
      projectName: params.projectArtifact.projectName,
      status: "failed",
      error,
      note: extra?.note ?? params.artifactLookupNote,
      ...(extra?.conflictPaths ? { conflictPaths: extra.conflictPaths } : {}),
    },
  });

  // Returns an error message instead of reporting success with an
  // unpersisted completion: the durable partial marker would survive and a
  // later retry could not tell the finished apply from an unrecovered
  // partial. The changes stay applied either way, so the failure guidance
  // is "fix persistence and re-run", never "re-apply".
  const clearPartialAndMarkApplied = async (
    completionHeadSha: string | null | undefined
  ): Promise<string | undefined> => {
    // A completion without its HEAD reads as a legacy record, which
    // revalidation accepts unchecked; keep the partial marker instead.
    if (completionHeadSha == null) {
      return "could not read the target HEAD after applying";
    }
    try {
      if (!params.isReplay) {
        // Marking without `partial` clears an earlier appliedPartial flag.
        await markSubagentGitPatchArtifactApplied({
          locks: params.locks,
          workspaceId: params.artifactWorkspaceId,
          workspaceSessionDir: params.artifactSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          appliedAtMs: Date.now(),
          appliedHeadSha: completionHeadSha,
        });
      } else {
        // Replay success is recorded target-locally; the shared ancestor
        // artifact stays untouched for other replay targets. A fresh
        // worktree-only replay lands here too: its pre-apply partial marker
        // must not survive success, or a later retry would treat the finished
        // apply as an unrecovered partial.
        await setLocalPatchPartialApply({
          locks: params.locks,
          workspaceId: params.workspaceId,
          workspaceSessionDir: params.workspaceSessionDir,
          childTaskId: params.taskId,
          projectPath: params.projectArtifact.projectPath,
          record: null,
          completedAtMs: Date.now(),
          completedHeadSha: completionHeadSha,
        });
      }
      return undefined;
    } catch (error: unknown) {
      return getErrorMessage(error);
    }
  };
  const completionPersistenceFailed = (persistError: string) =>
    failed(
      `The child's uncommitted changes were applied, but recording the completion failed: ${persistError}`,
      {
        note: mergeNotes(
          params.artifactLookupNote,
          "Do NOT re-apply. Fix the persistence failure (e.g. permissions, disk space) and re-run: the retry detects the already-present changes and completes the record."
        ),
      }
    );

  const recordPartialApplication = async (): Promise<void> => {
    // No git am ran here, so the fence HEAD is the current one: completion
    // later requires it to still be an ancestor of the target HEAD.
    const fenceHeadSha = await tryRevParseHead({
      gitPrefix,
      runtime: params.runtime,
      cwd: params.repoCwd,
    });
    if (params.isReplay) {
      await setLocalPatchPartialApply({
        locks: params.locks,
        workspaceId: params.workspaceId,
        workspaceSessionDir: params.workspaceSessionDir,
        childTaskId: params.taskId,
        projectPath: params.projectArtifact.projectPath,
        record: {
          appliedAtMs: Date.now(),
          stage: "commits-applied",
          ...(fenceHeadSha != null ? { headCommitSha: fenceHeadSha } : {}),
        },
      });
    } else {
      await markSubagentGitPatchArtifactApplied({
        locks: params.locks,
        workspaceId: params.artifactWorkspaceId,
        workspaceSessionDir: params.artifactSessionDir,
        childTaskId: params.taskId,
        projectPath: params.projectArtifact.projectPath,
        appliedAtMs: Date.now(),
        partial: true,
        partialStage: "commits-applied",
        ...(fenceHeadSha != null ? { partialHeadSha: fenceHeadSha } : {}),
      });
    }
  };

  // The exact expected_head_sha check is suppressed only for commit-bearing
  // partials, where an earlier `git am` necessarily advanced HEAD and
  // enforcing it would block every fenced retry. A commit-free artifact's
  // earlier attempt never moved HEAD, so the caller's expected head is still
  // meaningful and an advanced target must be rejected.
  const artifactHasCommitSeries =
    params.projectArtifact.commitCount !== 0 ||
    (typeof params.projectArtifact.mboxPath === "string" &&
      params.projectArtifact.mboxPath.length > 0);
  if (!partialCompletion || !artifactHasCommitSeries) {
    const expectedHeadError = await checkExpectedHead({
      gitPrefix,
      runtime: params.runtime,
      cwd: params.repoCwd,
      expectedHeadSha: params.expectedHeadSha,
    });
    if (expectedHeadError != null) {
      return failed(expectedHeadError);
    }
  }
  if (partialCompletion && params.partialCompletionFenceSha != null) {
    // The marker's recorded HEAD is the real fence: it must still be
    // an ancestor of HEAD, or the target was reset/rebased and the applied
    // commit series may no longer be present.
    const stillAncestor = await isCommitAncestorOfHead({
      gitPrefix,
      runtime: params.runtime,
      cwd: params.repoCwd,
      commitSha: params.partialCompletionFenceSha,
    });
    if (!stillAncestor) {
      return failed(
        `Cannot complete the earlier partial application: the target branch no longer contains the HEAD recorded when the commit series was applied (${params.partialCompletionFenceSha}). The target was likely reset or rebased, so the applied commits may be missing.`,
        {
          note: mergeNotes(
            params.artifactLookupNote,
            "Re-apply the whole artifact with force=true (after making sure the branch is at its pre-apply state), or use acknowledge_partial_recovery=true if the child's work is in fact fully present."
          ),
        }
      );
    }
  }

  // Manual recovery may already have put the patch content in place
  // (committed or uncommitted). Detect that BEFORE the dirty-overlap check,
  // which would otherwise reject the recovered content itself as overlap.
  // Runs in dry-run mode too: a dry run against the recovered target would
  // otherwise fail on overlap (uncommitted recovery) or on re-applying
  // already-committed content in the temp worktree.
  if (partialCompletion) {
    const reverseCheck = await applyWorktreeDiffPatch({
      runtime: params.runtime,
      runtimeTempDir: params.runtimeTempDir,
      repoCwd: params.repoCwd,
      taskId: params.taskId,
      storageKey: params.projectArtifact.storageKey,
      workspaceId: params.workspaceId,
      gitPrefix,
      localPatchPath: params.worktreePatchLocalPath,
      abortSignal: params.abortSignal,
      mode: "reverse-check",
    });
    if (reverseCheck.applied) {
      if (!params.dryRun) {
        // Unstage entries the failed earlier attempt left behind before the
        // marker is cleared; see repairStagedWorktreePatchPaths.
        const repairError = await repairStagedWorktreePatchPaths({
          gitPrefix,
          runtime: params.runtime,
          repoCwd: params.repoCwd,
          localPatchPath: params.worktreePatchLocalPath,
        });
        if (repairError != null) {
          return failed(
            `The child's uncommitted changes are already present in the worktree, but the index entries left by the failed earlier attempt could not be unstaged: ${repairError.error}`,
            {
              note: mergeNotes(
                params.artifactLookupNote,
                "Unstage the patch paths manually (`git restore --staged -- <paths>`) and re-run, or re-run with acknowledge_partial_recovery=true to keep the staged entries."
              ),
            }
          );
        }
      }
      const headCommitSha = await tryRevParseHead({
        gitPrefix,
        runtime: params.runtime,
        cwd: params.repoCwd,
      });
      if (!params.dryRun) {
        const persistError = await clearPartialAndMarkApplied(headCommitSha);
        if (persistError != null) {
          return completionPersistenceFailed(persistError);
        }
      }
      return {
        success: true,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "applied",
          appliedCommits: [],
          headCommitSha,
          note: mergeNotes(
            params.artifactLookupNote,
            params.dryRun
              ? "Dry run succeeded: the child's uncommitted changes are already present in the worktree; a real run will clear the partial marker."
              : "Completed the earlier partial application: the child's uncommitted changes are already present in the worktree, so nothing was re-applied."
          ),
        },
      };
    }
  }

  // Preflight against the ACTUAL target's dirty state; the dry-run temp
  // worktree is clean, so this is what keeps dry runs predictive.
  const worktreeDirtyOverlap = await checkDirtyWorktreePatchPathOverlap({
    gitPrefix,
    runtime: params.runtime,
    cwd: params.repoCwd,
    localPatchPath: params.worktreePatchLocalPath,
  });
  if (worktreeDirtyOverlap != null) {
    return failed(worktreeDirtyOverlap.error, {
      conflictPaths: worktreeDirtyOverlap.conflictPaths,
      note: mergeNotes(
        params.artifactLookupNote,
        partialCompletion
          ? "Completing the earlier partial application was blocked by overlapping local changes (likely conflict markers from the failed first attempt). Resolve them to the child's intended content and re-run: a re-run detects already-present changes and clears the partial marker. If your resolution intentionally merges parent and child edits, re-run with acknowledge_partial_recovery=true instead."
          : "Commit or stash local changes on overlapping patch paths before applying. Unrelated dirty files can remain in place."
      ),
    });
  }

  if (params.dryRun) {
    const dryRunWorktree = await createDryRunWorktree({
      runtime: params.runtime,
      runtimeTempDir: params.runtimeTempDir,
      repoCwd: params.repoCwd,
      taskId: params.taskId,
      storageKey: params.projectArtifact.storageKey,
      gitPrefix,
      filenamePrefix: "mux-git-apply-dry-run",
    });
    if ("error" in dryRunWorktree) {
      return failed(dryRunWorktree.error);
    }
    const dryRunWorktreePath = dryRunWorktree.path;

    try {
      const applyOutcome = await applyWorktreeDiffPatch({
        runtime: params.runtime,
        runtimeTempDir: params.runtimeTempDir,
        repoCwd: dryRunWorktreePath,
        taskId: params.taskId,
        storageKey: params.projectArtifact.storageKey,
        workspaceId: params.workspaceId,
        gitPrefix,
        localPatchPath: params.worktreePatchLocalPath,
        abortSignal: params.abortSignal,
      });
      if (!applyOutcome.applied) {
        return failed(applyOutcome.error, {
          conflictPaths: applyOutcome.conflictPaths,
          note: mergeNotes(
            params.artifactLookupNote,
            "Dry run failed; the uncommitted-changes patch does not apply cleanly against the current HEAD."
          ),
        });
      }
      return {
        success: true,
        projectResult: {
          projectPath: params.projectArtifact.projectPath,
          projectName: params.projectArtifact.projectName,
          status: "applied",
          appliedCommits: [],
          note: mergeNotes(
            params.artifactLookupNote,
            partialCompletion
              ? "Dry run succeeded; the uncommitted-changes patch pending from the earlier partial application applies cleanly. No changes were applied."
              : "Dry run succeeded; no changes were applied. The artifact contains only uncommitted changes (no commits)."
          ),
        },
      };
    } finally {
      await removeDryRunWorktreeBestEffort({
        runtime: params.runtime,
        repoCwd: params.repoCwd,
        dryRunWorktreePath,
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        gitPrefix,
      });
    }
  }

  // `git apply --3way` can leave some files applied while another conflicts,
  // so the target may hold part of the patch after a failure OR a crash
  // mid-apply. Without a durable marker a retry would treat the artifact as
  // fresh and the dirty-overlap preflight would permanently reject the
  // partially-applied content; the marker routes retries to the
  // reverse-check completion path instead. It is persisted BEFORE the
  // irreversible apply (and cleared on success below): writing it only after
  // a failure could itself fail (ENOSPC, EACCES) and leave no record. A
  // marker-write failure here happens before anything was applied, so the
  // failure is cleanly retryable.
  if (!partialCompletion) {
    try {
      await recordPartialApplication();
    } catch (markerError: unknown) {
      return failed(
        `Failed to persist the partial-application marker: ${getErrorMessage(markerError)}`,
        {
          note: mergeNotes(
            params.artifactLookupNote,
            "Nothing was applied. Fix the persistence failure (e.g. disk space) and retry."
          ),
        }
      );
    }
  }
  const applyOutcome = await applyWorktreeDiffPatch({
    runtime: params.runtime,
    runtimeTempDir: params.runtimeTempDir,
    repoCwd: params.repoCwd,
    taskId: params.taskId,
    storageKey: params.projectArtifact.storageKey,
    workspaceId: params.workspaceId,
    gitPrefix,
    localPatchPath: params.worktreePatchLocalPath,
    abortSignal: params.abortSignal,
  });
  if (!applyOutcome.applied) {
    return failed(applyOutcome.error, {
      conflictPaths: applyOutcome.conflictPaths,
      note: mergeNotes(
        params.artifactLookupNote,
        partialCompletion
          ? "Completing the earlier partial application failed. Any conflict markers were left in the worktree; resolve them (or apply the changes manually), then re-run: a re-run detects already-present changes and clears the partial marker. If your resolution intentionally merges parent and child edits, re-run with acknowledge_partial_recovery=true instead."
          : "Applying the child's uncommitted changes failed. Any conflict markers were left in the worktree; resolve them to the child's intended content (or discard with `git checkout -- <paths>`), then re-run: a re-run detects already-present changes and completes the application."
      ),
    });
  }

  const headCommitSha = await tryRevParseHead({
    gitPrefix,
    runtime: params.runtime,
    cwd: params.repoCwd,
  });
  const persistError = await clearPartialAndMarkApplied(headCommitSha);
  if (persistError != null) {
    return completionPersistenceFailed(persistError);
  }

  return {
    success: true,
    projectResult: {
      projectPath: params.projectArtifact.projectPath,
      projectName: params.projectArtifact.projectName,
      status: "applied",
      appliedCommits: [],
      headCommitSha,
      note: mergeNotes(
        params.artifactLookupNote,
        partialCompletion
          ? "Completed the earlier partial application: applied the child's uncommitted changes as uncommitted changes (the commit series had already landed)."
          : "Applied the child's uncommitted changes as uncommitted changes (the child produced no commits)."
      ),
    },
  };
}

async function cleanupRuntimePatchFile(params: {
  runtime: ToolConfiguration["runtime"];
  repoCwd: string;
  remotePatchPath: string;
  taskId: string;
  workspaceId: string;
}): Promise<void> {
  try {
    const result = await execBuffered(
      params.runtime,
      `rm -f ${shellQuote(params.remotePatchPath)}`,
      {
        cwd: params.repoCwd,
        timeout: 30,
        sandboxRoots: runtimeTempSandboxRoots(params.remotePatchPath),
      }
    );
    if (result.exitCode !== 0) {
      log.debug("task_apply_git_patch: patch file cleanup failed", {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        remotePatchPath: params.remotePatchPath,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
        stdout: result.stdout.trim(),
      });
    }
  } catch (error: unknown) {
    log.debug("task_apply_git_patch: patch file cleanup threw", {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      remotePatchPath: params.remotePatchPath,
      error,
    });
  }
}

async function applyPatch(
  config: TaskGitPatchApplyConfig,
  args: TaskApplyGitPatchArgs,
  options: TaskGitPatchApplyOptions = {}
): Promise<TaskApplyGitPatchResult> {
  assert(config.workspaceId, "taskGitPatchEngine.applyPatch requires workspaceId");
  const workspaceId = config.workspaceId;
  assert(config.cwd, "taskGitPatchEngine.applyPatch requires cwd");
  assert(config.runtimeTempDir, "taskGitPatchEngine.applyPatch requires runtimeTempDir");
  const workspaceSessionDir = config.workspaceSessionDir;
  assert(workspaceSessionDir, "taskGitPatchEngine.applyPatch requires workspaceSessionDir");

  const parsedArgs = TaskApplyGitPatchToolArgsSchema.parse(args);
  const taskId = parsedArgs.task_id;
  const dryRun = parsedArgs.dry_run === true;
  const threeWay = parsedArgs.three_way !== false;
  const force = parsedArgs.force === true;
  const acknowledgePartialRecovery = parsedArgs.acknowledge_partial_recovery === true;
  const acknowledgeUncapturedChanges = parsedArgs.acknowledge_uncaptured_changes === true;
  const expectedHeadSha = parsedArgs.expected_head_sha ?? undefined;

  if (!isSafeSubagentGitPatchPathComponent(taskId)) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "Invalid task_id.",
      note: "task_id must be a safe path component.",
    };
  }

  await config.runtime.ensureDir(config.runtimeTempDir, options.abortSignal);
  const gitPrefixFor = (cwd: string) =>
    gitNoRepoAutomationPrefixForRuntime({
      runtime: config.runtime,
      cwd,
      trusted: config.trusted === true,
    });

  const artifactLookup = await findPatch({
    workspaceId,
    workspaceSessionDir,
    childTaskId: taskId,
  });

  if (!artifactLookup) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "No git patch artifact found for this taskId.",
    };
  }

  let artifact = artifactLookup.artifact;
  const artifactWorkspaceId = artifactLookup.artifactWorkspaceId;
  const artifactSessionDir = artifactLookup.artifactSessionDir;
  // Applying a descendant's patch from an ancestor is the canonical integration path and must
  // persist its applied watermark. Only applying an ancestor-owned artifact into a descendant is
  // replay behavior that leaves the source metadata unchanged.
  const isReplay = artifactLookup.relation === "ancestor";
  const artifactLookupNote = artifactLookup.note;

  if (artifact.parentWorkspaceId !== artifactWorkspaceId) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "This patch artifact belongs to a different parent workspace.",
      note: mergeNotes(
        artifactLookupNote,
        `Expected parent workspace ${artifactWorkspaceId} but artifact metadata says ${artifact.parentWorkspaceId}.`
      ),
    };
  }

  const requestedProjectPath = parsedArgs.project_path;

  // Patch generation runs in the background after the child task reports, so
  // the artifact may still be "pending" when apply is requested right after
  // task completion. Wait for it to settle before deciding success/failure.
  artifact = await waitForPendingPatchGeneration({
    artifact,
    artifactSessionDir,
    childTaskId: taskId,
    requestedProjectPath,
    waitMs: options.pendingGenerationWaitMs ?? PENDING_PATCH_GENERATION_WAIT_MS,
    pollIntervalMs:
      options.pendingGenerationPollIntervalMs ?? PENDING_PATCH_GENERATION_POLL_INTERVAL_MS,
    abortSignal: options.abortSignal,
    onPoll: options.pendingGenerationOnPoll,
  });

  // The wait exits when aborted, but the artifact may have settled to "ready"
  // on its final re-read. Never start a (destructive) apply for a cancelled
  // call — bail before any repo mutation.
  if (options.abortSignal?.aborted === true) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "Aborted while waiting for patch generation; the patch was not applied.",
      note: artifactLookupNote,
    };
  }

  const projectArtifacts = listRelevantProjectArtifacts(artifact, requestedProjectPath);

  if (parsedArgs.project_path != null && projectArtifacts.length === 0) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: `No project patch artifact found for ${parsedArgs.project_path}.`,
    };
  }

  if (projectArtifacts.length === 0) {
    return {
      success: false as const,
      taskId,
      dryRun,
      error: "This task has no project patch artifacts.",
    };
  }

  // Still-pending here means generation outlived the wait above. Do not
  // partially apply (ready siblings would land while the pending project's
  // commits silently drop, and workflows would checkpoint the step as
  // applied); fail atomically with a retryable, non-conflict error instead.
  if (projectArtifacts.some((projectArtifact) => projectArtifact.status === "pending")) {
    const pendingProjectResults = projectArtifacts.map((projectArtifact) =>
      projectArtifact.status === "ready"
        ? {
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "skipped" as const,
            error:
              "Not attempted because patch generation has not finished for another project in this task.",
          }
        : summarizeNonReadyProjectArtifact({ projectArtifact })
    );
    return {
      success: false as const,
      taskId,
      dryRun,
      projectResults: pendingProjectResults,
      error:
        "Patch generation has not finished for this task yet. This is not an apply conflict; retry task_apply_git_patch shortly.",
      note: artifactLookupNote,
      ...toLegacyFields(pendingProjectResults),
    };
  }

  if (options.allowedPathPrefixes != null && options.allowedPathPrefixes.length > 0) {
    const pathViolation = await getAllowedPatchPathViolation({
      taskId,
      artifactSessionDir,
      projectArtifacts,
      allowedPathPrefixes: options.allowedPathPrefixes,
    });
    if (pathViolation != null) {
      return { success: false as const, taskId, error: pathViolation };
    }
  }

  const repoTargetsByProjectPath = resolveCurrentWorkspaceRepoTargets({
    workspaceId,
    workspaceSessionDir,
  });
  const projectResults: TaskApplyGitPatchProjectResult[] = [];

  const readyProjectArtifacts = projectArtifacts.filter(
    (projectArtifact) => projectArtifact.status === "ready"
  );
  if (readyProjectArtifacts.length === 0) {
    for (const projectArtifact of projectArtifacts) {
      projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
    }

    const legacyFields = toLegacyFields(projectResults);
    return {
      success: false as const,
      taskId,
      dryRun,
      projectResults,
      error: "This task has no ready project patch artifacts.",
      note: artifactLookupNote,
      ...legacyFields,
    };
  }

  // An acknowledgment sweep with nothing to acknowledge is a mistaken flag
  // and must not touch any repository: unmarked projects would otherwise be
  // applied normally before the post-loop check reports the failure. force
  // never reads markers, so it can never acknowledge anything.
  if (acknowledgePartialRecovery) {
    let anyAcknowledgeable = false;
    if (!force) {
      for (const projectArtifact of readyProjectArtifacts) {
        if (!isReplay) {
          if (projectArtifact.appliedPartial === true) {
            anyAcknowledgeable = true;
            break;
          }
          continue;
        }
        const partial = await readLocalPatchPartialApply({
          workspaceSessionDir,
          childTaskId: taskId,
          projectPath: projectArtifact.projectPath,
        });
        const completion =
          partial == null
            ? await readLocalPatchApplyCompletion({
                workspaceSessionDir,
                childTaskId: taskId,
                projectPath: projectArtifact.projectPath,
              })
            : null;
        if (partial != null || completion?.unknown === true) {
          anyAcknowledgeable = true;
          break;
        }
      }
    }
    if (!anyAcknowledgeable) {
      const ackProjectResults = projectArtifacts.map((projectArtifact) =>
        projectArtifact.status !== "ready"
          ? summarizeNonReadyProjectArtifact({ projectArtifact })
          : {
              projectPath: projectArtifact.projectPath,
              projectName: projectArtifact.projectName,
              status: "skipped" as const,
              note: "No partial application recorded for this project; nothing to acknowledge.",
            }
      );
      return {
        success: false as const,
        taskId,
        dryRun,
        projectResults: ackProjectResults,
        error:
          "acknowledge_partial_recovery was set, but no partial application is recorded for any project; nothing to acknowledge.",
        note: artifactLookupNote,
        ...toLegacyFields(ackProjectResults),
      };
    }
  }

  let shouldStopAfterFailure = false;
  let acknowledgedPartialCount = 0;
  for (const projectArtifact of projectArtifacts) {
    if (shouldStopAfterFailure) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "skipped",
        error: "Not attempted because an earlier project apply failed.",
      });
      continue;
    }

    if (projectArtifact.status !== "ready") {
      projectResults.push(summarizeNonReadyProjectArtifact({ projectArtifact }));
      if (parsedArgs.project_path != null) {
        shouldStopAfterFailure = true;
      }
      continue;
    }

    // Replay targets track partial application locally: the ancestor's
    // artifact is shared with other targets, so its applied markers cannot
    // represent this target's state.
    const localPartial =
      isReplay && !force
        ? await readLocalPatchPartialApply({
            workspaceSessionDir,
            childTaskId: taskId,
            projectPath: projectArtifact.projectPath,
          })
        : null;
    const localCompletion =
      isReplay && !force
        ? await readLocalPatchApplyCompletion({
            workspaceSessionDir,
            childTaskId: taskId,
            projectPath: projectArtifact.projectPath,
          })
        : null;
    // A partial application (commits landed, worktree patch failed) must
    // never read as success: a resumed workflow would otherwise checkpoint
    // past the child's still-missing uncommitted changes. A retry completes
    // just the pending uncommitted-changes patch (never re-running git am)
    // and clears the marker on success. The boolean marker alone is
    // authoritative: appliedAtMs is optional metadata, so a marker persisted
    // without a timestamp must still route to worktree-only completion
    // instead of re-running the already-applied commit series.
    const hasPartialMarker =
      localPartial != null || (!isReplay && !force && projectArtifact.appliedPartial === true);
    // "am-started" markers were persisted before an interrupted `git am`;
    // whether the commit series landed is unknown, so they are reconciled
    // below instead of routing to worktree-only completion. Missing stage
    // means "commits-applied" (markers written before the field existed);
    // "unknown" (a corrupted recorded stage) always fails closed.
    const partialStage: SubagentGitPatchPartialStage | "unknown" | undefined = !hasPartialMarker
      ? undefined
      : localPartial != null
        ? (localPartial.stage ?? "commits-applied")
        : (projectArtifact.appliedPartialStage ?? "commits-applied");
    const completePartialWorktreeOnly = hasPartialMarker && partialStage === "commits-applied";
    const partialCompletionFenceSha =
      localPartial?.headCommitSha ??
      (!isReplay && !force ? projectArtifact.appliedPartialHeadSha : undefined);

    // Explicit escape hatch for manual recoveries the automatic
    // already-present reverse check cannot recognize (e.g. a merged conflict
    // resolution that is not patch-reversible): the user asserts the child's
    // work is fully present, so the marker clears without applying anything.
    if (acknowledgePartialRecovery) {
      // Any recorded partial (including an interrupted am-started marker)
      // or an unreadable completion record can be acknowledged: the user
      // asserts the child's work is present.
      const acknowledgeable = hasPartialMarker || localCompletion?.unknown === true;
      if (!acknowledgeable) {
        // An all-project sweep must reach later partial projects, but only a
        // sibling PROVEN fully applied may be skipped: an earlier partial
        // failure stops the loop before later projects are attempted, so an
        // unmarked project may be entirely unapplied and must fall through
        // to a normal apply below (skipping it would let a workflow
        // checkpoint past a whole missing project). Replay targets prove it
        // via their target-local completion record, since a successful
        // replay never stamps the shared artifact's appliedAtMs. An
        // explicitly targeted project keeps the hard failure.
        if (requestedProjectPath == null) {
          // Unknown completions took the acknowledgeable branch, so a
          // present record here is valid proof.
          const provenApplied = isReplay
            ? localCompletion != null
            : Boolean(projectArtifact.appliedAtMs);
          if (provenApplied) {
            // The record proves the apply finished, not that the work is still
            // present: a sweep that skipped a reset sibling would let a workflow
            // checkpoint past its missing work, as an ordinary retry would.
            const staleReason = await findStaleRecordedCompletion({
              config,
              repoCwd:
                repoTargetsByProjectPath.get(projectArtifact.projectPath)?.repoCwd ??
                (artifact.projectArtifacts.length === 1 ? config.cwd : undefined),
              taskId,
              workspaceId,
              projectArtifact,
              artifactSessionDir,
              localCompletion: isReplay ? localCompletion : undefined,
              abortSignal: options.abortSignal,
            });
            if (staleReason != null) {
              projectResults.push({
                projectPath: projectArtifact.projectPath,
                projectName: projectArtifact.projectName,
                status: "failed",
                error: `A completion record says this project's patch was applied, but ${staleReason}.`,
                note: mergeNotes(
                  artifactLookupNote,
                  "Verify the target repository's state, then re-run with force=true to re-apply the child's work."
                ),
              });
              shouldStopAfterFailure = true;
              continue;
            }
            projectResults.push({
              projectPath: projectArtifact.projectPath,
              projectName: projectArtifact.projectName,
              status: "skipped",
              note: "No partial application recorded for this project; nothing to acknowledge.",
            });
            continue;
          }
        } else {
          projectResults.push({
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "failed",
            error:
              "acknowledge_partial_recovery was set, but no partial application is recorded for this project; nothing to acknowledge.",
          });
          shouldStopAfterFailure = true;
          continue;
        }
      } else {
        acknowledgedPartialCount += 1;
        if (!dryRun) {
          // The user asserts the child's work is present RIGHT NOW, so the
          // current HEAD is the post-apply fence for later replay-safe
          // retries (see checkAppliedWorkStillPresent).
          const acknowledgeRepoCwd =
            repoTargetsByProjectPath.get(projectArtifact.projectPath)?.repoCwd ??
            (artifact.projectArtifacts.length === 1 ? config.cwd : undefined);
          const acknowledgeHeadSha =
            acknowledgeRepoCwd != null
              ? await tryRevParseHead({
                  runtime: config.runtime,
                  cwd: acknowledgeRepoCwd,
                  gitPrefix: await gitPrefixFor(acknowledgeRepoCwd),
                })
              : null;
          // An unpersisted acknowledgment must not read as success: the
          // partial marker would survive and keep failing later applies.
          try {
            if (isReplay) {
              await setLocalPatchPartialApply({
                locks: config.sessionLocks,
                workspaceId,
                workspaceSessionDir,
                childTaskId: taskId,
                projectPath: projectArtifact.projectPath,
                record: null,
                completedAtMs: Date.now(),
                ...(acknowledgeHeadSha != null ? { completedHeadSha: acknowledgeHeadSha } : {}),
                completedAcknowledged: true,
              });
            } else {
              await markSubagentGitPatchArtifactApplied({
                locks: config.sessionLocks,
                workspaceId: artifactWorkspaceId,
                workspaceSessionDir: artifactSessionDir,
                childTaskId: taskId,
                projectPath: projectArtifact.projectPath,
                appliedAtMs: Date.now(),
                ...(acknowledgeHeadSha != null ? { appliedHeadSha: acknowledgeHeadSha } : {}),
                appliedAcknowledged: true,
              });
            }
          } catch (persistError: unknown) {
            projectResults.push({
              projectPath: projectArtifact.projectPath,
              projectName: projectArtifact.projectName,
              status: "failed",
              error: `Recording the acknowledged recovery failed: ${getErrorMessage(persistError)}`,
              note: mergeNotes(
                artifactLookupNote,
                "Nothing was changed. Fix the persistence failure (e.g. permissions, disk space) and re-run with acknowledge_partial_recovery=true."
              ),
            });
            shouldStopAfterFailure = true;
            continue;
          }
        }
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "applied",
          appliedCommits: [],
          note: dryRun
            ? "Dry run: would acknowledge the manual recovery of the earlier partial application and clear the partial marker. Nothing was applied or cleared."
            : "Acknowledged manual recovery of the earlier partial application; the partial marker was cleared. Nothing was applied.",
        });
        continue;
      }
    }

    // Only a marker-free project may read as already applied: a stale
    // appliedAtMs can coexist with a partial marker (an interrupted force
    // re-apply of a previously applied artifact), and every marker stage
    // must reach its own recovery handling below. Replay targets prove
    // application via their target-local completion record (a successful
    // replay never stamps the shared artifact's appliedAtMs), so a workflow
    // retry after a crash-before-checkpoint must not replay the mbox.
    const alreadyAppliedAtMs =
      hasPartialMarker || force
        ? undefined
        : isReplay
          ? localCompletion != null && localCompletion.unknown !== true
            ? localCompletion.appliedAtMs
            : undefined
          : projectArtifact.appliedAtMs;
    if (alreadyAppliedAtMs) {
      const appliedAt = new Date(alreadyAppliedAtMs).toISOString();
      if (options.allowAlreadyApplied === true) {
        // The record proves the apply finished, not that the work survived
        // until this retry (see checkAppliedWorkStillPresent). Validate
        // before skipping so a workflow cannot checkpoint past missing work.
        // A project that cannot be resolved in this workspace can be neither
        // validated nor re-applied, so it keeps the legacy skip.
        const staleReason = await findStaleRecordedCompletion({
          config,
          repoCwd:
            repoTargetsByProjectPath.get(projectArtifact.projectPath)?.repoCwd ??
            (artifact.projectArtifacts.length === 1 ? config.cwd : undefined),
          taskId,
          workspaceId,
          projectArtifact,
          artifactSessionDir,
          localCompletion: isReplay ? localCompletion : undefined,
          abortSignal: options.abortSignal,
        });
        if (staleReason != null) {
          projectResults.push({
            projectPath: projectArtifact.projectPath,
            projectName: projectArtifact.projectName,
            status: "failed",
            error: `A completion record from ${appliedAt} says this project's patch was applied, but ${staleReason}.`,
            note: mergeNotes(
              artifactLookupNote,
              "Verify the target repository's state, then re-run with force=true to re-apply the child's work."
            ),
          });
          shouldStopAfterFailure = true;
          continue;
        }
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "applied",
          note: `Patch already applied at ${appliedAt}; treating as applied for replay-safe workflow integration.`,
        });
        continue;
      }
      if (!dryRun) {
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "failed",
          error: `Patch already applied at ${appliedAt}.`,
          note: "Re-run with force=true to apply again.",
        });
        shouldStopAfterFailure = true;
        continue;
      }
    }

    // A corrupted completion record cannot prove this replay target applied
    // the project, and a fresh apply could replay an already-applied series.
    // Fail closed until the user verifies and acknowledges (or forces).
    if (!hasPartialMarker && localCompletion?.unknown === true) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "failed",
        error:
          "A previous apply on this target recorded a completion for this project, but the record is unreadable, so whether the patch was applied cannot be determined.",
        note: "Inspect the target repository history for the child's commits, then re-run with acknowledge_partial_recovery=true once the child's work is confirmed present (or force=true to re-apply).",
      });
      shouldStopAfterFailure = true;
      continue;
    }

    // A corrupted recorded stage means the marker cannot say whether the
    // commit series landed: worktree-only completion could skip a never-run
    // git am, and a fresh apply could replay a landed series. Fail closed.
    if (hasPartialMarker && partialStage === "unknown") {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "failed",
        error:
          "A previous apply attempt recorded a partial application, but its recorded stage is unreadable, so whether the commit series was applied cannot be determined.",
        note: "Inspect the target repository history for the child's commits, then re-run with acknowledge_partial_recovery=true once the child's work is confirmed present (or complete the recovery manually).",
      });
      shouldStopAfterFailure = true;
      continue;
    }

    const repoTarget = repoTargetsByProjectPath.get(projectArtifact.projectPath);
    const repoCwd =
      repoTarget?.repoCwd ?? (artifact.projectArtifacts.length === 1 ? config.cwd : undefined);
    if (!repoCwd) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "failed",
        error: "Could not resolve the current workspace repo root for this project.",
      });
      shouldStopAfterFailure = true;
      continue;
    }

    // Reconcile an interrupted apply (marker persisted before `git am`, but
    // the attempt never recorded an outcome). Only an unchanged HEAD with no
    // in-progress am session proves nothing landed; that retries fresh (the
    // stale marker is refreshed by the next pre-am write or cleared by full
    // success). Anything else is ambiguous between "the series landed" and
    // "unrelated commits advanced HEAD", so it fails closed.
    if (hasPartialMarker && partialStage === "am-started") {
      const repoGitPrefix = await gitPrefixFor(repoCwd);
      const amInProgress = await isGitAmInProgress({
        runtime: config.runtime,
        cwd: repoCwd,
        gitPrefix: repoGitPrefix,
      });
      if (amInProgress) {
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "failed",
          error:
            "A previous apply attempt was interrupted and left a git am session in progress in this repository.",
          note: "Finish it with `git am --continue`, or restore the pre-apply state with `git am --abort`, then re-run.",
        });
        shouldStopAfterFailure = true;
        continue;
      }
      const currentHeadSha = await tryRevParseHead({
        runtime: config.runtime,
        cwd: repoCwd,
        gitPrefix: repoGitPrefix,
      });
      const interruptedFenceSha =
        localPartial?.headCommitSha ?? projectArtifact.appliedPartialHeadSha;
      if (
        interruptedFenceSha == null ||
        currentHeadSha == null ||
        currentHeadSha !== interruptedFenceSha
      ) {
        projectResults.push({
          projectPath: projectArtifact.projectPath,
          projectName: projectArtifact.projectName,
          status: "failed",
          error: `A previous apply attempt was interrupted after \`git am\` may have advanced HEAD${interruptedFenceSha != null ? ` (recorded pre-apply HEAD ${interruptedFenceSha})` : ""}, and the current history no longer matches the recorded pre-apply state. Cannot safely determine whether the commit series landed.`,
          note: "Inspect the target history. If the child's work is fully present, re-run with acknowledge_partial_recovery=true. If the interrupted attempt applied nothing, re-run with force=true to apply the artifact on the current HEAD, or reset the branch to the recorded pre-apply HEAD and retry.",
        });
        shouldStopAfterFailure = true;
        continue;
      }
      // HEAD unchanged: nothing landed; fall through to a fresh apply.
    }

    // Applying only the captured content would silently omit the child's
    // uncaptured work, and workflows would checkpoint the step as applied.
    // Fail (dry runs too, to stay predictive) until the user recovers the
    // uncaptured changes and acknowledges. A present partial marker means an
    // earlier attempt already passed this gate; blocking here would prevent
    // completing its recovery.
    const uncapturedNote = worktreeCaptureSkippedNote(projectArtifact);
    if (uncapturedNote != null && !acknowledgeUncapturedChanges && !hasPartialMarker) {
      projectResults.push({
        projectPath: projectArtifact.projectPath,
        projectName: projectArtifact.projectName,
        status: "failed",
        error: `${uncapturedNote} Applying only the captured content would silently omit that work.`,
        note: mergeNotes(
          artifactLookupNote,
          "Recover the uncaptured changes manually from the child workspace (preserved while they remain unrecovered), then re-run with acknowledge_uncaptured_changes=true to apply the captured content."
        ),
      });
      shouldStopAfterFailure = true;
      continue;
    }

    const applyResult = await applyProjectPatch({
      taskId,
      workspaceId,
      runtime: config.runtime,
      runtimeTempDir: config.runtimeTempDir,
      trusted: config.trusted === true,
      repoCwd,
      projectArtifact,
      artifactWorkspaceId,
      artifactSessionDir,
      workspaceSessionDir,
      artifactLookupNote,
      dryRun,
      threeWay,
      force,
      expectedHeadSha,
      isReplay,
      abortSignal: options.abortSignal,
      locks: config.sessionLocks,
      completePartialWorktreeOnly,
      partialCompletionFenceSha,
    });
    projectResults.push(applyResult.projectResult);
    if (!applyResult.success) {
      shouldStopAfterFailure = true;
    }
  }

  const legacyFields = toLegacyFields(projectResults);
  const attemptedReadyCount = projectArtifacts.filter(
    (projectArtifact) => projectArtifact.status === "ready"
  ).length;
  const appliedReadyCount = projectResults.filter(
    (projectResult) => projectResult.status === "applied"
  ).length;
  const hasApplyFailure = projectResults.some(
    (projectResult, index) =>
      projectResult.status === "failed" && projectArtifacts[index]?.status === "ready"
  );
  const overallNote = mergeNotes(
    artifactLookupNote,
    projectResults
      .map((projectResult) => projectResult.note)
      .filter((note): note is string => typeof note === "string")
      .join("\n") || undefined
  );

  if (hasApplyFailure) {
    const firstFailedProject = projectResults.find(
      (projectResult) => projectResult.status === "failed"
    );
    return {
      success: false as const,
      taskId,
      dryRun,
      projectResults,
      error:
        firstFailedProject?.error ??
        `Failed while applying project patches (${appliedReadyCount}/${attemptedReadyCount} ready projects applied).`,
      note: overallNote,
      ...legacyFields,
    };
  }

  // Backstop for a sweep that acknowledged nothing (the precheck above
  // handles the common case before any repository is touched). A sweep
  // stopped by a real per-project failure reports that failure instead.
  if (acknowledgePartialRecovery && acknowledgedPartialCount === 0 && !shouldStopAfterFailure) {
    return {
      success: false as const,
      taskId,
      dryRun,
      projectResults,
      error:
        "acknowledge_partial_recovery was set, but no partial application is recorded for any project; nothing to acknowledge.",
      note: overallNote,
      ...legacyFields,
    };
  }

  return {
    success: true as const,
    taskId,
    projectResults,
    dryRun,
    note: overallNote,
    ...(projectResults.length === 1 ? legacyFields : {}),
  };
}

async function writeReadableStreamToLocalFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  maxBytes?: number
): Promise<{ truncated: boolean }> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const fileHandle = await fsPromises.open(filePath, "w");
  let bytesWritten = 0;
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value == null) continue;
        // Stop consuming once the cap is exceeded so an oversized stream
        // never lands on local disk, even transiently.
        if (maxBytes != null && bytesWritten + value.length > maxBytes) {
          await reader.cancel();
          return { truncated: true };
        }
        await fileHandle.write(value);
        bytesWritten += value.length;
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fileHandle.close();
  }
  return { truncated: false };
}

async function writeRuntimeCommandOutputToLocalFile(params: {
  runtime: Runtime;
  command: string;
  cwd: string;
  timeout: number;
  filePath: string;
  maxBytes?: number;
}): Promise<{ exitCode: number; stderr: string; truncated: boolean }> {
  const stream = await params.runtime.exec(params.command, {
    cwd: params.cwd,
    timeout: params.timeout,
  });
  await stream.stdin.close();

  const stderrPromise = streamToString(stream.stderr);
  const writePromise = writeReadableStreamToLocalFile(
    stream.stdout,
    params.filePath,
    params.maxBytes
  );
  const [exitCode, stderr, writeResult] = await Promise.all([
    stream.exitCode,
    stderrPromise,
    writePromise,
  ]);
  return { exitCode, stderr, truncated: writeResult.truncated };
}

export type WorktreeCaptureFields = Pick<
  SubagentGitProjectPatchArtifact,
  | "hadUncommittedChanges"
  | "worktreePatchPath"
  | "worktreePatchBytes"
  | "worktreePatchSkippedReason"
>;

/**
 * Best-effort list of submodule paths with uncommitted changes. Uncommitted
 * work inside a submodule cannot be represented in a superproject patch (the
 * temp-index capture stages only the unchanged gitlink), so callers report it
 * as uncaptured instead of claiming the diff was empty. Returns null when a
 * probe fails: the repository is already known dirty at that point, so an
 * unknown submodule state must surface as possibly-uncaptured work rather
 * than pass as "no dirty submodules".
 */
async function listDirtySubmodulePaths(params: {
  runtime: Runtime;
  repoCwd: string;
  gitPrefix: string;
}): Promise<string[] | null> {
  // -z keeps paths verbatim: on line-oriented output core.quotePath wraps
  // exotic names (e.g. non-ASCII) in C-style quotes, and probing that quoted
  // literal matches nothing, silently missing the dirty submodule.
  const lsFilesResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git ls-files -s -z`,
    {
      cwd: params.repoCwd,
      timeout: 60,
    }
  );
  if (lsFilesResult.exitCode !== 0) {
    log.debug("listDirtySubmodulePaths: ls-files probe failed", {
      repoCwd: params.repoCwd,
      stderr: lsFilesResult.stderr.trim(),
    });
    return null;
  }
  // Records are `<mode> <object> <stage>\t<path>`; gitlinks have mode 160000.
  const submodulePaths = lsFilesResult.stdout
    .split("\0")
    .filter((record) => record.startsWith("160000 "))
    .map((record) => record.slice(record.indexOf("\t") + 1));
  if (submodulePaths.length === 0) {
    return [];
  }
  const diffResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git diff --name-only -z --ignore-submodules=none HEAD`,
    { cwd: params.repoCwd, timeout: 60 }
  );
  if (diffResult.exitCode !== 0) {
    log.debug("listDirtySubmodulePaths: diff probe failed", {
      repoCwd: params.repoCwd,
      stderr: diffResult.stderr.trim(),
    });
    return null;
  }
  const changedPaths = new Set(diffResult.stdout.split("\0").filter((line) => line.length > 0));
  return submodulePaths.filter((subPath) => changedPaths.has(subPath));
}

/**
 * Untracked embedded git repositories show up in status as `?? dir/` and
 * would be staged by `git add -A` as a bare gitlink whose commit exists only
 * in the child's checkout, so their contents must be reported as uncaptured
 * and the gitlink kept out of the patch. Status is parsed from `-z` records
 * because core.quotePath wraps exotic names (e.g. containing spaces) in
 * quotes on the line-oriented output, which would hide them from the probe.
 * Returns null when a probe fails, so callers warn about possibly-uncaptured
 * embedded repositories instead of treating the failure as "none exist".
 */
async function listUntrackedEmbeddedRepoPaths(params: {
  runtime: Runtime;
  repoCwd: string;
  gitPrefix: string;
}): Promise<string[] | null> {
  const statusResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git status --porcelain -z --untracked-files=all`,
    { cwd: params.repoCwd, timeout: 60 }
  );
  if (statusResult.exitCode !== 0) {
    log.debug("listUntrackedEmbeddedRepoPaths: status probe failed", {
      repoCwd: params.repoCwd,
      stderr: statusResult.stderr.trim(),
    });
    return null;
  }
  // Even with --untracked-files=all, git will not descend into a directory
  // that is itself a repository, so embedded repos surface as `?? dir/`.
  const candidateDirs = parseGitStatusPorcelainZ(statusResult.stdout)
    .filter((entry) => entry.status === "??" && entry.path.endsWith("/"))
    .map((entry) => entry.path);
  if (candidateDirs.length === 0) {
    return [];
  }

  const probeCommand = candidateDirs
    .map(
      (dir) =>
        `if [ -e ${shellQuote(`${dir}.git`)} ]; then printf '%s\\0' ${shellQuote(dir.replace(/\/+$/, ""))}; fi`
    )
    .join("\n");
  const result = await execBuffered(params.runtime, probeCommand, {
    cwd: params.repoCwd,
    timeout: 60,
  });
  if (result.exitCode !== 0) {
    log.debug("listUntrackedEmbeddedRepoPaths: .git probe failed", {
      repoCwd: params.repoCwd,
      stderr: result.stderr.trim(),
    });
    return null;
  }
  return result.stdout.split("\0").filter((line) => line.length > 0);
}

/**
 * Never rejects: a runtime/filesystem failure mid-capture must not bubble to
 * the generate error path with empty capture fields, because cleanup would
 * then remove a possibly-dirty child with no warning recorded.
 */
export interface CaptureWorktreePatchParams {
  runtime: Runtime;
  repoCwd: string;
  localPatchPath: string;
  maxBytes: number;
  maxStagedBytes: number;
}

async function captureWorktreePatch(
  params: CaptureWorktreePatchParams
): Promise<WorktreeCaptureFields> {
  try {
    // Capture runs on the host outside the agent loop, so repository automation the child's
    // checkout configures (fsmonitor, clean filters selected by attributes) stays off.
    const gitPrefix = gitEnvPrefix(
      await gitNoRepoAutomationEnvForRuntimeRepo(params.runtime, params.repoCwd)
    );
    return await captureWorktreeDiffUnsafe({ ...params, gitPrefix });
  } catch (error: unknown) {
    log.warn("captureWorktreePatch: capture failed", {
      repoCwd: params.repoCwd,
      error: getErrorMessage(error),
    });
    // The exception may have fired after the patch file was created (e.g. a
    // stream failure mid-write), and the apply path probes this canonical
    // location even without metadata, so a leftover incomplete file would
    // be applied as if it were a complete capture. Removal is best-effort:
    // this recovery path must never reject.
    await fsPromises.rm(params.localPatchPath, { force: true }).catch(() => undefined);
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `Could not capture uncommitted changes (${getErrorMessage(error)}); any uncommitted work was NOT captured.`,
    };
  }
}

/** Uses a temporary index so capture never mutates the child's index or worktree. */
async function captureWorktreeDiffUnsafe(
  params: CaptureWorktreePatchParams & { gitPrefix: string }
): Promise<WorktreeCaptureFields> {
  const statusResult = await execBuffered(
    params.runtime,
    `${params.gitPrefix}git status --porcelain -z --untracked-files=all`,
    { cwd: params.repoCwd, timeout: 60 }
  );
  if (statusResult.exitCode !== 0) {
    log.warn("captureWorktreePatch: git status failed; skipping worktree capture", {
      repoCwd: params.repoCwd,
      stderr: statusResult.stderr.trim(),
    });
    // Unknown dirty state must not read as clean: cleanup would silently
    // discard any uncommitted work, so warn the parent explicitly.
    // Invariant: every exit that records no worktreePatchPath leaves no file
    // at the canonical path. A stale patch from a capture that crashed
    // before recording metadata would otherwise be found by apply-side
    // canonical probing and re-apply outdated changes.
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `Could not inspect the worktree for uncommitted changes (git status failed: ${statusResult.stderr.trim() || "unknown error"}); any uncommitted work was NOT captured.`,
    };
  }
  if (statusResult.stdout.trim().length === 0) {
    // Same invariant: the work may have been committed since a crashed
    // capture wrote the file, and the regenerated commit series already
    // contains it.
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {};
  }

  const dirtySubmodulePaths = await listDirtySubmodulePaths({
    runtime: params.runtime,
    repoCwd: params.repoCwd,
    gitPrefix: params.gitPrefix,
  });
  const embeddedRepoPaths = await listUntrackedEmbeddedRepoPaths({
    runtime: params.runtime,
    repoCwd: params.repoCwd,
    gitPrefix: params.gitPrefix,
  });
  // Unknown gitlink discovery must skip capture entirely: with no exclusion
  // list, the later `git add -A` would stage any moved submodule or embedded
  // repo gitlink, emitting a patch that references a commit no target can
  // fetch once child cleanup removes the only repository containing it.
  if (dirtySubmodulePaths == null || embeddedRepoPaths == null) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    const probeFailureReasons = [
      dirtySubmodulePaths == null
        ? "Could not determine whether submodules contain uncommitted changes (probe failed)."
        : undefined,
      embeddedRepoPaths == null
        ? "Could not determine whether untracked embedded git repositories exist (probe failed)."
        : undefined,
    ].filter((reason): reason is string => reason != null);
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: [
        ...probeFailureReasons,
        "The uncommitted changes were not captured.",
      ].join(" "),
    };
  }
  const skipReasons = [
    dirtySubmodulePaths.length > 0
      ? `Uncommitted changes inside submodule(s) ${dirtySubmodulePaths.join(", ")} were NOT captured: submodule contents cannot be represented in a superproject patch.`
      : undefined,
    embeddedRepoPaths.length > 0
      ? `Untracked embedded git repository(ies) ${embeddedRepoPaths.join(", ")} were NOT captured: their contents cannot be represented in a superproject patch.`
      : undefined,
  ].filter((reason): reason is string => reason != null);
  const submoduleSkipReason = skipReasons.length > 0 ? skipReasons.join(" ") : undefined;

  // `git add` writes whole blobs before the capped diff stream produces any
  // output, so the diff byte cap alone does not bound disk usage: a
  // multi-gigabyte dirty file would fill the temporary object dir (and /tmp)
  // before truncation is detected. Preflight the on-disk size of every dirty
  // path and skip capture when staging would exceed the bound. Excluded
  // submodule/embedded-repo paths are directories and are not staged, so
  // they do not count. A preflight exec failure throws into the outer
  // captureWorktreePatch handler, which reports a conservative
  // uncaptured-work skip.
  const excludedRoots = [...dirtySubmodulePaths, ...embeddedRepoPaths].map((repoPath) =>
    repoPath.replace(/\/+$/, "")
  );
  const isExcludedPath = (filePath: string): boolean => {
    const normalized = filePath.replace(/\/+$/, "");
    return excludedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  };
  const candidatePaths = [
    ...new Set(
      parseGitStatusPorcelainZ(statusResult.stdout)
        .map((entry) => entry.path)
        .filter((filePath) => !isExcludedPath(filePath))
    ),
  ];
  let stagedBytes = 0;
  let batch: string[] = [];
  let batchLength = 0;
  const runDuBatch = async (): Promise<void> => {
    if (batch.length === 0) {
      return;
    }
    // du stats rather than reads, so the preflight itself is cheap. -s
    // prints one line per argument (no subdirectory lines to double count).
    const duResult = await execBuffered(params.runtime, `du -sk -- ${batch.join(" ")}`, {
      cwd: params.repoCwd,
      timeout: 60,
    });
    let probeStdout = duResult.stdout;
    if (duResult.exitCode !== 0) {
      // Missing paths (deletions, races) are the only tolerated failure:
      // rerun per path, skipping paths that no longer exist. Any du failure
      // on a path that still exists (du unavailable, unreadable dirs) must
      // throw into the outer captureWorktreePatch handler, which reports an
      // uncaptured-work skip; reading a failed probe as "small" would let a
      // multi-gigabyte dirty file through to `git add`.
      const fallbackResult = await execBuffered(
        params.runtime,
        `ex=0; for p in ${batch.join(" ")}; do if [ -e "$p" ] || [ -L "$p" ]; then du -sk -- "$p" || ex=1; fi; done; exit $ex`,
        { cwd: params.repoCwd, timeout: 60 }
      );
      if (fallbackResult.exitCode !== 0) {
        throw new Error(
          `staging-size preflight failed: ${
            fallbackResult.stderr.trim() || duResult.stderr.trim() || "du failed"
          }`
        );
      }
      probeStdout = fallbackResult.stdout;
    }
    for (const line of probeStdout.split("\n")) {
      const sizeMatch = /^(\d+)\s/.exec(line);
      if (sizeMatch != null) {
        stagedBytes += Number(sizeMatch[1]) * 1024;
      }
    }
    batch = [];
    batchLength = 0;
  };
  for (const filePath of candidatePaths) {
    const quoted = shellQuote(filePath);
    if (batchLength + quoted.length + 1 > 60_000) {
      await runDuBatch();
      if (stagedBytes > params.maxStagedBytes) {
        break;
      }
    }
    batch.push(quoted);
    batchLength += quoted.length + 1;
  }
  if (stagedBytes <= params.maxStagedBytes) {
    await runDuBatch();
  }
  if (stagedBytes > params.maxStagedBytes) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: [
        `Uncommitted files total ${stagedBytes} bytes on disk, exceeding the ${params.maxStagedBytes}-byte staging bound; the uncommitted changes were not captured.`,
        submoduleSkipReason,
      ]
        .filter((reason): reason is string => reason != null)
        .join(" "),
    };
  }

  // Excluding embedded repos keeps their gitlinks (which reference commits
  // that exist only in the child's checkout) out of the patch. Dirty tracked
  // submodules are excluded for the same reason: `git add -A` would stage
  // their moved gitlink, and a submodule commit that exists only in the
  // child's clone becomes unfetchable once cleanup removes the child, so the
  // applied patch would point the target at an unavailable commit. `literal`
  // magic keeps a name like `nested*repo` from glob-matching dirty sibling
  // paths, which would silently drop them from the patch.
  const gitlinkExcludes = [...dirtySubmodulePaths, ...embeddedRepoPaths]
    .map((repoPath) => ` ${shellQuote(`:(exclude,literal)${repoPath}`)}`)
    .join("");
  const diffCommand = [
    "set -e",
    'TMP_INDEX="$(mktemp)"',
    // `git add` writes whole blobs before the diff stream (and its byte cap)
    // produces any output, so staged objects go to a throwaway object dir:
    // a huge dirty file must not permanently grow the repo's object store.
    'TMP_OBJECTS="$(mktemp -d)"',
    'trap \'rm -f "$TMP_INDEX"; rm -rf "$TMP_OBJECTS"\' EXIT',
    `REAL_OBJECTS="$(cd "$(${params.gitPrefix}git rev-parse --git-path objects)" && pwd)"`,
    'export GIT_OBJECT_DIRECTORY="$TMP_OBJECTS"',
    'export GIT_ALTERNATE_OBJECT_DIRECTORIES="$REAL_OBJECTS"',
    `GIT_INDEX_FILE="$TMP_INDEX" ${params.gitPrefix}git read-tree HEAD`,
    `GIT_INDEX_FILE="$TMP_INDEX" ${params.gitPrefix}git add -A -- .${gitlinkExcludes}`,
    // Explicit prefixes: user config like diff.noprefix=true would emit
    // headers the later default `git apply` cannot consume.
    `GIT_INDEX_FILE="$TMP_INDEX" ${params.gitPrefix}git diff --src-prefix=a/ --dst-prefix=b/ --cached --binary HEAD --`,
  ].join("\n");

  const { exitCode, stderr, truncated } = await writeRuntimeCommandOutputToLocalFile({
    runtime: params.runtime,
    command: diffCommand,
    cwd: params.repoCwd,
    timeout: 120,
    filePath: params.localPatchPath,
    maxBytes: params.maxBytes,
  });

  // Check truncation before the exit code: cancelling the stdout stream can
  // make the diff command exit non-zero (EPIPE), and the size skip is the
  // more accurate report in that case.
  if (truncated) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `Uncommitted worktree diff exceeds the ${params.maxBytes}-byte capture cap; the uncommitted changes were not captured.`,
    };
  }

  if (exitCode !== 0) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason: `git diff for uncommitted changes failed (exitCode=${exitCode}): ${stderr.trim() || "unknown error"}`,
    };
  }

  const stat = await fsPromises.stat(params.localPatchPath);
  if (stat.size === 0) {
    await fsPromises.rm(params.localPatchPath, { force: true });
    return {
      hadUncommittedChanges: true,
      worktreePatchSkippedReason:
        submoduleSkipReason ??
        "Worktree reported uncommitted changes but the diff against HEAD was empty.",
    };
  }

  return {
    hadUncommittedChanges: true,
    worktreePatchPath: params.localPatchPath,
    worktreePatchBytes: stat.size,
    // Partial capture: the superproject patch exists, but dirty submodule
    // contents are still lost; surface that alongside the patch.
    ...(submoduleSkipReason != null ? { worktreePatchSkippedReason: submoduleSkipReason } : {}),
  };
}

async function generatePatch(params: GeneratePatchParams): Promise<GeneratePatchResult> {
  const process = await params.runtime.exec(
    "git format-patch --stdout --binary " + params.baseCommitSha + ".." + params.headCommitSha,
    { cwd: params.repoCwd, timeout: 120 }
  );
  await process.stdin.close();
  const [exitCode, stderr] = await Promise.all([
    process.exitCode,
    streamToString(process.stderr),
    writeReadableStreamToLocalFile(process.stdout, params.patchPath),
  ]);
  if (exitCode === 0) return { success: true };
  await fsPromises.rm(params.patchPath, { force: true });
  return {
    success: false,
    error:
      "git format-patch failed (exitCode=" + exitCode + "): " + (stderr.trim() || "unknown error"),
  };
}

export const taskGitPatchEngine: TaskGitPatchEngine = {
  applyPatch,
  captureWorktreePatch,
  findPatch,
  generatePatch,
};
