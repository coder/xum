/**
 * Small pure helpers shared by TaskService and GitPatchArtifactService.
 * Extracted to a standalone module to avoid circular imports.
 */
import assert from "node:assert/strict";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { resolveModelFallbackChain } from "@/common/utils/ai/modelFallbacks";

export function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function tryReadGitHeadCommitSha(
  runtime: Runtime,
  workspacePath: string
): Promise<string | undefined> {
  assert(workspacePath.length > 0, "tryReadGitHeadCommitSha: workspacePath must be non-empty");

  try {
    const result = await execBuffered(runtime, "git rev-parse HEAD", {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }

    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Branch currently checked out in the workspace, or undefined when it cannot be
 * determined (no git, detached HEAD, unreachable runtime). Callers use this as
 * proof of a checkout's base branch, so "unknown" must stay distinguishable
 * from any real branch name.
 */
export async function tryReadGitCurrentBranch(
  runtime: Runtime,
  workspacePath: string
): Promise<string | undefined> {
  assert(workspacePath.length > 0, "tryReadGitCurrentBranch: workspacePath must be non-empty");

  try {
    const result = await execBuffered(runtime, "git rev-parse --abbrev-ref HEAD", {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }

    const branch = result.stdout.trim();
    // Detached HEAD reports the literal string "HEAD" — not a branch identity.
    if (branch.length === 0 || branch === "HEAD") {
      return undefined;
    }
    return branch;
  } catch {
    return undefined;
  }
}

/**
 * True when the checkout has no uncommitted changes (including untracked files)
 * under the given pathspecs; undefined when this cannot be determined (no git,
 * unreachable runtime). Callers use this as proof that the committed base equals
 * the working tree for those paths, so "unknown" must stay distinguishable from
 * "clean".
 */
export async function tryReadGitPathsClean(
  runtime: Runtime,
  workspacePath: string,
  pathspecs: readonly string[]
): Promise<boolean | undefined> {
  assert(workspacePath.length > 0, "tryReadGitPathsClean: workspacePath must be non-empty");
  assert(pathspecs.length > 0, "tryReadGitPathsClean: pathspecs must be non-empty");

  try {
    const quoted = pathspecs.map((pathspec) => `'${pathspec}'`).join(" ");
    const result = await execBuffered(runtime, `git status --porcelain -- ${quoted}`, {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return result.stdout.trim().length === 0;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective refusal-fallback chain for a workspace's turn.
 * Task children can opt out via taskOnRefusal: "fail" (e.g. workflow verifier
 * steps that demand an honest terminal failure instead of a silent model
 * swap). Workspaces not found in config (non-task sends) keep the configured
 * chain.
 */
export function resolveWorkspaceModelFallbackChain(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string,
  modelString: string,
  providersConfig?: Record<string, unknown> | null
): string[] {
  assert(workspaceId.length > 0, "resolveWorkspaceModelFallbackChain: workspaceId required");
  const chain = resolveModelFallbackChain(config.modelFallbacks, modelString, providersConfig);
  if (chain.length === 0) {
    return chain;
  }
  const entry = findWorkspaceEntry(config, workspaceId);
  return entry?.workspace.taskOnRefusal === "fail" ? [] : chain;
}

export function findWorkspaceEntry(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): { projectPath: string; workspace: WorkspaceConfigEntry } | null {
  for (const [projectPath, project] of config.projects) {
    for (const workspace of project.workspaces) {
      if (workspace.id === workspaceId) {
        return { projectPath, workspace };
      }
    }
  }
  return null;
}

/**
 * Walk the parentWorkspaceId chain to compute task nesting depth.
 * Detects cycles (max 32 hops).
 */
export function getTaskDepthFromConfig(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): number {
  const parentById = new Map<string, string | undefined>();
  for (const project of config.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  let depth = 0;
  let current = workspaceId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) break;
    depth += 1;
    current = parent;
  }

  if (depth >= 32) {
    throw new Error(
      `getTaskDepthFromConfig: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  return depth;
}
