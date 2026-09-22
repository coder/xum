import assert from "node:assert";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import type { ProjectsConfig, Workspace } from "@/common/types/project";
import type { RuntimeConfig } from "@/common/types/runtime";
import { hasSrcBaseDir } from "@/common/types/runtime";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { getProjectName } from "@/node/utils/runtime/helpers";

/**
 * Structural-mutation refusal for protected agent-task footprints.
 *
 * WHY: task checkouts are shared with cooperating Xum backends over the same
 * config root (a desktop app beside `xum server`). A foreign backend may have
 * admitted a turn on a task workspace from a config read this process cannot
 * observe, and this slice ships no distributed settlement protocol. A late
 * config check fences FUTURE admissions but cannot settle an effect already
 * admitted elsewhere, so nothing that could destroy, move or rebind a task's
 * checkout, registration or session may proceed — regardless of the task's
 * terminal status, `taskAttemptUnproven`, local ownership, an empty local
 * task map or the absence of a stream in THIS process. The same applies to an
 * ordinary workspace whose checkout a task shares (an isolation:none child, a
 * legacy alias, a symlinked or nested spelling).
 *
 * ACCEPTED AVAILABILITY LIMIT (plan: "Structural mutation policy"): sub-agent
 * workspaces cannot be removed, renamed, archive-deleted, archive-snapshotted,
 * restored or have their worktree deleted in this build; refused operations
 * leave registration, checkout and session intact. Keep-only archive,
 * inspection, Stop and authorized execution stay available.
 *
 * Callers (WorkspaceService) serialize the alias scan AND the permitted
 * physical effect against task preparation/publication through the
 * registration lock; this module only classifies and scans.
 */

export type StructuralMutation =
  | "remove"
  | "rename"
  | "archive-delete"
  | "archive-snapshot"
  | "unarchive-restore"
  | "delete-worktree";

const MUTATION_VERBS: Record<StructuralMutation, string> = {
  remove: "remove",
  rename: "rename",
  "archive-delete": "archive (deleting the checkout)",
  "archive-snapshot": "archive (snapshotting and deleting the checkout)",
  "unarchive-restore": "unarchive (restoring the checkout from its archive snapshot)",
  "delete-worktree": "delete the managed worktree of",
};

export type StructuralMutationTarget =
  /** No registered row: nothing known to protect (phantom/session-only cleanup). */
  | { kind: "unregistered" }
  /** A host-local agent-task row (or one carrying a preparation proof): always refused. */
  | { kind: "protected-task"; row: Workspace }
  /** An ordinary workspace on an off-host runtime: no host-local footprint to alias. */
  | { kind: "off-host-root"; row: Workspace }
  /** An ordinary host-local workspace: refused only when a task row aliases its footprint. */
  | { kind: "host-local-root"; row: Workspace; bucketProjectPath: string };

export type StructuralMutationVerdict = { allowed: true } | { allowed: false; error: string };

/** Project-dir local, managed worktree, or a legacy entry without a runtimeConfig. */
export function isHostLocalRuntimeConfig(runtimeConfig: RuntimeConfig | undefined): boolean {
  return (
    runtimeConfig === undefined ||
    runtimeConfig.type === "local" ||
    runtimeConfig.type === "worktree"
  );
}

/**
 * The producer's durable checkout-preparation proof (row field
 * `taskCheckoutPreparation`, owned by taskCheckoutPreparation.ts). Read
 * structurally so a proof written by a newer build — or one whose schema this
 * module has not been taught — still counts as PRESENT: a present proof keeps
 * the row protected even when its runtime later flips off-host, and its saved
 * paths join the protected footprint. Any `path`/`realpath` string fields, at
 * any nesting, are treated as footprint paths (root, gitdir pointer, ...).
 */
function readTaskCheckoutPreparation(row: Workspace): unknown {
  return (row as Workspace & { taskCheckoutPreparation?: unknown }).taskCheckoutPreparation;
}

function collectProofPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "path" || key === "realpath" || key === "pointer") && typeof nested === "string") {
      if (nested.length > 0) out.push(nested);
    } else {
      collectProofPaths(nested, out, depth + 1);
    }
  }
}

/**
 * Every host-local task row is protected (legacy rows without proof, shared children,
 * dedicated forks alike). A PRESENT proof — well-formed or not — protects on its own,
 * whatever the row's parent or runtime now says: a proof on a root or off-host row is a
 * mismatch the validator refuses, never an exemption a mutator may take.
 */
export function isProtectedTaskRow(row: Workspace): boolean {
  if (readTaskCheckoutPreparation(row) !== undefined) return true;
  const parentWorkspaceId = row.parentWorkspaceId;
  if (typeof parentWorkspaceId !== "string" || parentWorkspaceId.length === 0) return false;
  return isHostLocalRuntimeConfig(row.runtimeConfig);
}

/**
 * Name-derived checkout path, mirroring WorktreeManager.getWorkspacePath for
 * worktree-style runtimes (`<srcBaseDir>/<projectName>/<name>`) and the
 * project directory for project-dir local runtimes. Multi-project rows persist
 * only the primary path; the other projects' checkouts are derived this way.
 */
export function deriveHostLocalCheckoutPath(
  runtimeConfig: RuntimeConfig | undefined,
  projectPath: string,
  workspaceName: string
): string {
  assert(projectPath.length > 0, "deriveHostLocalCheckoutPath: projectPath is required");
  if (hasSrcBaseDir(runtimeConfig)) {
    return path.join(runtimeConfig.srcBaseDir, getProjectName(projectPath), workspaceName);
  }
  return projectPath;
}

/** Persisted + derived + proof paths a row's physical footprint consists of. */
function footprintPathsForRow(row: Workspace, bucketProjectPath: string): string[] {
  const paths = [row.path];
  const projects = row.projects ?? [];
  if (projects.length > 1 && typeof row.name === "string" && row.name.length > 0) {
    for (const project of projects) {
      if (project.projectPath !== bucketProjectPath) {
        paths.push(deriveHostLocalCheckoutPath(row.runtimeConfig, project.projectPath, row.name));
      }
    }
  }
  collectProofPaths(readTaskCheckoutPreparation(row), paths);
  return paths.filter((candidate) => candidate.length > 0);
}

export function classifyStructuralMutationTarget(
  snapshot: ProjectsConfig,
  workspaceId: string
): StructuralMutationTarget {
  assert(workspaceId.length > 0, "classifyStructuralMutationTarget: workspaceId is required");
  for (const [bucketProjectPath, project] of snapshot.projects) {
    for (const row of project.workspaces) {
      if (row.id !== workspaceId) continue;
      if (isProtectedTaskRow(row)) return { kind: "protected-task", row };
      if (!isHostLocalRuntimeConfig(row.runtimeConfig)) return { kind: "off-host-root", row };
      return { kind: "host-local-root", row, bucketProjectPath };
    }
  }
  return { kind: "unregistered" };
}

/**
 * Bounded canonicalization. A stalled filesystem backing an UNRELATED task row
 * must not hang every structural operation; a timeout is an unknown identity
 * (refuse), never a fallback to spelling.
 */
const CANONICALIZE_TIMEOUT_MS = 2_000;

type CanonicalPath =
  | { kind: "resolved"; realpath: string }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

async function canonicalize(candidate: string): Promise<CanonicalPath> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const realpath = await Promise.race([
      fsPromises.realpath(stripTrailingSlashes(candidate)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("realpath timed out")), CANONICALIZE_TIMEOUT_MS);
      }),
    ]);
    return { kind: "resolved", realpath };
  } catch (error) {
    // Nothing exists at this spelling: only its spelling can overlap.
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return { kind: "absent" };
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function isSameOrInside(candidate: string, ancestor: string): boolean {
  const normalizedCandidate = stripTrailingSlashes(path.normalize(candidate));
  const normalizedAncestor = stripTrailingSlashes(path.normalize(ancestor));
  return (
    normalizedCandidate === normalizedAncestor ||
    normalizedCandidate.startsWith(normalizedAncestor + path.sep)
  );
}

/** Two footprint paths overlap when either spelling/identity is the other or lies inside it. */
function spellingsOverlap(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}

async function identitiesForPath(
  candidate: string
): Promise<{ identities: string[]; unknown?: string }> {
  const canonical = await canonicalize(candidate);
  const identities = [candidate];
  if (canonical.kind === "resolved") identities.push(canonical.realpath);
  return canonical.kind === "unknown" ? { identities, unknown: canonical.reason } : { identities };
}

export type FootprintOverlap =
  | { kind: "none" }
  | { kind: "overlap"; taskWorkspaceId: string; targetPath: string; taskPath: string }
  | { kind: "unknown"; taskWorkspaceId: string; reason: string };

/**
 * Whether any protected task row's footprint overlaps the target's. Compares
 * every spelling AND canonical identity pairwise (equal or nested), so a
 * symlinked or differently-nested alias is caught. An identity that cannot be
 * established (permission error, dangling loop, timeout) is reported as
 * unknown — callers refuse: ambiguity is not permission.
 */
export async function findProtectedFootprintOverlap(
  snapshot: ProjectsConfig,
  target: { row: Workspace; bucketProjectPath: string; extraPaths?: string[] }
): Promise<FootprintOverlap> {
  const targetPaths = [
    ...footprintPathsForRow(target.row, target.bucketProjectPath),
    ...(target.extraPaths ?? []).filter((candidate) => candidate.length > 0),
  ];
  const targetIdentities = await Promise.all(targetPaths.map(identitiesForPath));

  for (const [bucketProjectPath, project] of snapshot.projects) {
    for (const row of project.workspaces) {
      if (row.id === target.row.id || !isProtectedTaskRow(row)) continue;
      const taskWorkspaceId = row.id ?? row.path;
      for (const taskPath of footprintPathsForRow(row, bucketProjectPath)) {
        const task = await identitiesForPath(taskPath);
        for (const [index, targetPath] of targetPaths.entries()) {
          const targetIdentity = targetIdentities[index];
          for (const a of targetIdentity.identities) {
            for (const b of task.identities) {
              if (spellingsOverlap(a, b)) {
                return { kind: "overlap", taskWorkspaceId, targetPath, taskPath };
              }
            }
          }
          // Spellings are disjoint but one side's physical identity is unknown: it may
          // still be the same directory through a link we could not resolve.
          const unknown = task.unknown ?? targetIdentity.unknown;
          if (unknown !== undefined) {
            return { kind: "unknown", taskWorkspaceId, reason: unknown };
          }
        }
      }
    }
  }
  return { kind: "none" };
}

const AVAILABILITY_LIMIT =
  "Structural changes to agent-task checkouts (removal, rename, archive deletion/snapshot, restore) are unavailable in this build: another Xum process sharing this config may still be operating in that checkout, and completion status or local ownership cannot prove otherwise. The workspace, its checkout and its session were left intact; stop, inspect or keep-only archive it instead.";

export function structuralRefusalForTask(
  mutation: StructuralMutation,
  workspaceId: string
): string {
  return `Refusing to ${MUTATION_VERBS[mutation]} sub-agent task workspace "${workspaceId}". ${AVAILABILITY_LIMIT}`;
}

export function structuralRefusalForOverlap(
  mutation: StructuralMutation,
  workspaceId: string,
  overlap: Exclude<FootprintOverlap, { kind: "none" }>
): string {
  const detail =
    overlap.kind === "overlap"
      ? `its checkout (${overlap.targetPath}) is shared with sub-agent task workspace "${overlap.taskWorkspaceId}" (${overlap.taskPath})`
      : `it cannot be verified whether its checkout overlaps sub-agent task workspace "${overlap.taskWorkspaceId}" (${overlap.reason})`;
  return `Refusing to ${MUTATION_VERBS[mutation]} workspace "${workspaceId}": ${detail}. ${AVAILABILITY_LIMIT}`;
}

/**
 * No registered row: an id-less legacy entry, a stale sidebar item, a row a cooperating
 * backend just re-registered — nothing proves it lies outside a protected footprint, so
 * the former phantom session-only cleanup is refused too. Nothing was touched.
 */
export function structuralRefusalForUnregistered(
  mutation: StructuralMutation,
  workspaceId: string
): string {
  return `Refusing to ${MUTATION_VERBS[mutation]} workspace "${workspaceId}": it is not registered in the config, so it cannot be proven to lie outside a protected sub-agent task checkout. Nothing was changed.`;
}

export function structuralRefusalForUnreadableConfig(
  mutation: StructuralMutation,
  workspaceId: string,
  error: unknown
): string {
  return `Refusing to ${MUTATION_VERBS[mutation]} workspace "${workspaceId}": the config is unreadable (${
    error instanceof Error ? error.message : String(error)
  }), so protected sub-agent task checkouts cannot be verified. Fix the config and retry.`;
}
