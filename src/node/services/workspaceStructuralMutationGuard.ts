import assert from "node:assert";
import type { Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import type { RuntimeConfig } from "@/common/types/runtime";
import { hasSrcBaseDir } from "@/common/types/runtime";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { readSmallRegularFile } from "@/node/services/taskCheckoutPreparation";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { STRUCTURAL_FOOTPRINT_SCAN_TIMEOUT_MS } from "@/constants/terminationTimeouts";
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
  /**
   * No registered row: refused. Absent metadata or a cached record cannot prove the id lies
   * outside a protected footprint (an id-less legacy task, a row a cooperating backend just
   * re-registered), so the former phantom session-only cleanup is gone with it.
   */
  | { kind: "unregistered" }
  /**
   * More than one persisted row carries the id (malformed config): refused. The effects are
   * keyed by id, not by row — Config.removeWorkspace drops every row with the id across buckets
   * and removal deletes the id's session directory — so classifying by the first row would let
   * an ordinary (or off-host, scan-skipping) first row take a protected task row down with it.
   */
  | { kind: "ambiguous"; count: number }
  /** A host-local agent-task row (or one carrying a preparation proof): always refused. */
  | { kind: "protected-task"; row: Workspace }
  /** An ordinary workspace on an off-host runtime: no host-local footprint to alias. */
  | { kind: "off-host-root"; row: Workspace }
  /** An ordinary host-local workspace: refused only when a task row aliases its footprint. */
  | { kind: "host-local-root"; row: Workspace; bucketProjectPath: string };

export type StructuralMutationVerdict = { allowed: true } | { allowed: false; error: string };

/**
 * Runtimes whose checkout lives on this host: project-dir local, managed worktree, a legacy
 * entry without a runtimeConfig, and devcontainer — DevcontainerRuntime keeps its checkout as
 * a host worktree (WorktreeManager) that the container only bind-mounts, and its remove/rename
 * delete/move that worktree. Wider than checkout preparation's set on purpose: devcontainer
 * tasks stay exempt from preparation (no plugin consent to protect, see isHostLocalRuntime in
 * taskCheckoutPreparation.ts) but their checkouts are structurally protected like any other.
 */
export function isHostLocalRuntimeConfig(runtimeConfig: RuntimeConfig | undefined): boolean {
  return (
    runtimeConfig === undefined ||
    runtimeConfig.type === "local" ||
    runtimeConfig.type === "worktree" ||
    runtimeConfig.type === "devcontainer"
  );
}

/**
 * The producer's durable checkout-preparation proof (row field
 * `taskCheckoutPreparation`, owned by taskCheckoutPreparation.ts). Read
 * structurally so a proof written by a newer build — or one whose schema this
 * module has not been taught — still counts as PRESENT: a present proof keeps
 * the row protected even when its runtime later flips off-host, and its saved
 * paths join the protected footprint. Any `path`/`realpath` string fields, at
 * any nesting — lists included (a v2 proof lists every secondary checkout of a
 * multi-project task) — are treated as footprint paths (root, gitdir pointer, ...).
 */
function readTaskCheckoutPreparation(row: Workspace): unknown {
  return (row as Workspace & { taskCheckoutPreparation?: unknown }).taskCheckoutPreparation;
}

function collectProofPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value === null || typeof value !== "object") return;
  // Arrays descend through their (numeric) entries: their keys never name a path themselves.
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
  // Parent PRESENCE decides, exactly as classifyTaskCheckoutKind does: a malformed persisted
  // value (an empty string) is still a task row the validator refuses, so it must stay protected
  // here too (fail closed) rather than read as an ordinary root.
  if (row.parentWorkspaceId == null) return false;
  return isHostLocalRuntimeConfig(row.runtimeConfig);
}

/**
 * The runtime a row actually runs under: Config.getAllMetadata substitutes
 * DEFAULT_RUNTIME_CONFIG for a missing runtimeConfig before any runtime is
 * created, so a legacy row without one is a worktree row under the default
 * srcBaseDir, not a row that derives nothing.
 */
function effectiveRuntimeConfig(runtimeConfig: RuntimeConfig | undefined): RuntimeConfig {
  return runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
}

/**
 * The srcBaseDir a worktree-backed runtime derives its checkouts under, or undefined for a
 * project-dir local runtime. A devcontainer runtimeConfig carries none: runtimeFactory roots
 * its WorktreeManager at `new Config().srcDir`, i.e. `<getXumHome()>/src` — exactly what the
 * default worktree config's `~/.xum/src` expands to (XUM_ROOT and dev suffixes included).
 */
function worktreeSrcBaseDir(runtime: RuntimeConfig): string | undefined {
  if (hasSrcBaseDir(runtime)) return runtime.srcBaseDir;
  if (runtime.type !== "devcontainer") return undefined;
  assert(hasSrcBaseDir(DEFAULT_RUNTIME_CONFIG), "the default runtime is a worktree runtime");
  return DEFAULT_RUNTIME_CONFIG.srcBaseDir;
}

/**
 * Name-derived checkout path, mirroring WorktreeManager.getWorkspacePath for
 * worktree-style runtimes (`<srcBaseDir>/<projectName>/<name>`, with the
 * srcBaseDir tilde expanded exactly as the WorktreeManager constructor does)
 * and the project directory for project-dir local runtimes. Multi-project rows
 * persist only the primary path; the other projects' checkouts are derived
 * this way.
 */
export function deriveHostLocalCheckoutPath(
  runtimeConfig: RuntimeConfig | undefined,
  projectPath: string,
  workspaceName: string
): string {
  assert(projectPath.length > 0, "deriveHostLocalCheckoutPath: projectPath is required");
  const srcBaseDir = worktreeSrcBaseDir(effectiveRuntimeConfig(runtimeConfig));
  if (srcBaseDir !== undefined) {
    return path.join(expandTilde(srcBaseDir), getProjectName(projectPath), workspaceName);
  }
  return projectPath;
}

/**
 * Bounded realpath probes. A stalled filesystem backing an UNRELATED task row
 * must not hang every structural operation; a timeout is an unknown identity
 * (refuse), never a fallback to spelling. (`.git` pointer reads are bounded by
 * construction in `readGitBacking` instead: a timer cannot cancel a blocked
 * read, so the reader never issues one.)
 */
const CANONICALIZE_TIMEOUT_MS = 2_000;

/**
 * Persisted + runtime-derived + proof paths a row's physical footprint consists of.
 *
 * The runtime-derived paths are REQUIRED, not a fallback: WorktreeRuntime's (and
 * DevcontainerRuntime's, through the same WorktreeManager)
 * deleteWorkspace/renameWorkspace act on `<srcBaseDir>/<project>/<name>` for
 * every project of the row (WorktreeManager derives by name), not on the
 * persisted `path`. A stale or re-pointed stored path must never let an
 * operation land on a derived target the scan did not cover, so both the
 * stored path and every derived target are footprint.
 *
 * Project-dir LocalRuntime rows (`local` WITHOUT a srcBaseDir — runtimeFactory
 * maps a legacy `local` WITH one to the worktree runtime) execute in the
 * PROJECT directory of every project they belong to (LocalRuntime.forkWorkspace
 * shares the project directory), so those directories are footprint too — a
 * stored path that is stale or points elsewhere must not hide the directory
 * the task actually runs in.
 */
function footprintPathsForRow(row: Workspace, bucketProjectPath: string): string[] {
  const paths = [row.path];
  const runtime = effectiveRuntimeConfig(row.runtimeConfig);
  const projectPaths =
    row.projects !== undefined && row.projects.length > 0
      ? row.projects.map((project) => project.projectPath)
      : [bucketProjectPath];
  if (
    worktreeSrcBaseDir(runtime) !== undefined &&
    typeof row.name === "string" &&
    row.name.length > 0
  ) {
    for (const projectPath of projectPaths) {
      paths.push(deriveHostLocalCheckoutPath(runtime, projectPath, row.name));
    }
  }
  if (runtime.type === "local" && !hasSrcBaseDir(runtime)) {
    paths.push(bucketProjectPath, ...projectPaths);
  }
  collectProofPaths(readTaskCheckoutPreparation(row), paths);
  return paths.filter((candidate) => candidate.length > 0);
}

/** Bounded read of a worktree's `.git` pointer file; longer files are not pointers. */
const GIT_POINTER_MAX_BYTES = 4096;

type GitBacking =
  | { kind: "admin-dir"; adminDir: string }
  /** No checkout, no `.git`, or `.git` is the repository itself (backing lives inside). */
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

/**
 * The Git admin dir a checkout's `.git` FILE points at (`gitdir: <path>`),
 * resolved against the checkout. Legacy task rows carry no proof, so this is
 * the only way to learn that a task checkout OUTSIDE an ordinary root is backed
 * by a repository nested INSIDE it — deleting or moving the root would destroy
 * that backing.
 *
 * The entry is inspected with lstat and read through the producer core's
 * bounded reader (no symlink following, non-blocking open, fstat re-check,
 * size cap), so the scan never blocks a libuv worker on a FIFO/device and never
 * follows a symlink: a literal `.git` DIRECTORY has its backing inside the
 * checkout (none), a regular pointer file names the backing, and every other
 * entry type — symlink, FIFO, socket, device, or an entry that changed under
 * the read — is unknown backing that cannot authorize a mutation. A missing
 * `.git` is no backing at all.
 */
async function readGitBacking(checkoutPath: string): Promise<GitBacking> {
  const pointerPath = path.join(checkoutPath, ".git");
  let entry: Stats;
  try {
    entry = await fsPromises.lstat(pointerPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return { kind: "none" };
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
  if (entry.isDirectory()) return { kind: "none" };
  if (!entry.isFile()) return { kind: "unknown", reason: `${pointerPath} is not a regular file` };
  try {
    const content = await readSmallRegularFile(pointerPath, GIT_POINTER_MAX_BYTES);
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    if (!match?.[1]) return { kind: "unknown", reason: `${pointerPath} is not a git pointer file` };
    return { kind: "admin-dir", adminDir: path.resolve(checkoutPath, match[1]) };
  } catch (error) {
    // lstat saw a regular file, so any failure here (vanished, swapped for a
    // symlink or special file, grown past the cap) is a concurrent change.
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Footprint paths plus the Git admin dirs backing the row's checkouts. `unknown`
 * names the first backing that could not be established.
 */
async function footprintWithGitBacking(
  row: Workspace,
  bucketProjectPath: string
): Promise<{ paths: string[]; unknown?: string }> {
  const paths = footprintPathsForRow(row, bucketProjectPath);
  let unknown: string | undefined;
  for (const checkoutPath of [...paths]) {
    const backing = await readGitBacking(checkoutPath);
    if (backing.kind === "admin-dir") paths.push(backing.adminDir);
    else if (backing.kind === "unknown") unknown ??= backing.reason;
  }
  return unknown === undefined ? { paths } : { paths, unknown };
}

export function classifyStructuralMutationTarget(
  snapshot: ProjectsConfig,
  workspaceId: string
): StructuralMutationTarget {
  assert(workspaceId.length > 0, "classifyStructuralMutationTarget: workspaceId is required");
  const matches: Array<{ row: Workspace; bucketProjectPath: string }> = [];
  for (const [bucketProjectPath, project] of snapshot.projects) {
    for (const row of project.workspaces) {
      if (row.id === workspaceId) matches.push({ row, bucketProjectPath });
    }
  }
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  if (matches.length === 0) return { kind: "unregistered" };
  const [{ row, bucketProjectPath }] = matches;
  if (isProtectedTaskRow(row)) return { kind: "protected-task", row };
  if (!isHostLocalRuntimeConfig(row.runtimeConfig)) return { kind: "off-host-root", row };
  return { kind: "host-local-root", row, bucketProjectPath };
}

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
  /** `taskWorkspaceId` is absent when the scan as a whole expired before naming a row. */
  | { kind: "unknown"; taskWorkspaceId?: string; reason: string };

/**
 * Whether any protected task row's footprint overlaps the target's. Compares
 * every spelling AND canonical identity pairwise (equal or nested), so a
 * symlinked or differently-nested alias is caught. An identity that cannot be
 * established (permission error, dangling loop, timeout) is reported as
 * unknown — callers refuse: ambiguity is not permission.
 *
 * The whole scan has one deadline: callers hold the registration lock across
 * it, and the Git-backing probes (`lstat` + bounded read) have no timer of
 * their own, so a stalled FUSE/NFS mount under ANY row would otherwise hang the
 * mutation and every publication waiting on that lock. On expiry the stalled
 * read-only probes are abandoned (they never reject; their late verdict is
 * discarded) and the overlap is unknown, so the mutation is refused.
 */
export async function findProtectedFootprintOverlap(
  snapshot: ProjectsConfig,
  target: { row: Workspace; bucketProjectPath: string; extraPaths?: string[] },
  options: { timeoutMs?: number } = {}
): Promise<FootprintOverlap> {
  const timeoutMs = options.timeoutMs ?? STRUCTURAL_FOOTPRINT_SCAN_TIMEOUT_MS;
  assert(timeoutMs > 0, "findProtectedFootprintOverlap: timeoutMs must be positive");
  const scan = await raceWithAbortAndTimeout(scanProtectedFootprintOverlap(snapshot, target), {
    timeoutMs,
  });
  return scan.kind === "ok"
    ? scan.value
    : { kind: "unknown", reason: `the footprint scan timed out after ${timeoutMs}ms` };
}

async function scanProtectedFootprintOverlap(
  snapshot: ProjectsConfig,
  target: { row: Workspace; bucketProjectPath: string; extraPaths?: string[] }
): Promise<FootprintOverlap> {
  const targetFootprint = await footprintWithGitBacking(target.row, target.bucketProjectPath);
  const targetPaths = [
    ...targetFootprint.paths,
    ...(target.extraPaths ?? []).filter((candidate) => candidate.length > 0),
  ];
  const targetIdentities = await Promise.all(targetPaths.map(identitiesForPath));

  for (const [bucketProjectPath, project] of snapshot.projects) {
    for (const row of project.workspaces) {
      // Exclude only the exact target entry (same snapshot object), not every row sharing its
      // id: a malformed duplicate id must not hide a protected row from the scan.
      if (row === target.row || !isProtectedTaskRow(row)) continue;
      const taskWorkspaceId = row.id ?? row.path;
      // Either side's Git backing could not be established: with a protected row in
      // play, that unknown may be exactly the backing the mutation would destroy.
      const taskFootprint = await footprintWithGitBacking(row, bucketProjectPath);
      const unknownBacking = targetFootprint.unknown ?? taskFootprint.unknown;
      if (unknownBacking !== undefined) {
        return { kind: "unknown", taskWorkspaceId, reason: unknownBacking };
      }
      for (const taskPath of taskFootprint.paths) {
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
      : overlap.taskWorkspaceId === undefined
        ? `it cannot be verified whether its checkout overlaps a sub-agent task checkout (${overlap.reason})`
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

/** Duplicate rows for one id (see the `ambiguous` target): nothing was touched. */
export function structuralRefusalForAmbiguous(
  mutation: StructuralMutation,
  workspaceId: string,
  count: number
): string {
  assert(count > 1, "structuralRefusalForAmbiguous: an ambiguous target has several rows");
  return `Refusing to ${MUTATION_VERBS[mutation]} workspace "${workspaceId}": ${count} config rows share this id, so the change cannot be confined to one of them or proven to spare a protected sub-agent task. Nothing was changed; fix the duplicate rows in the config and retry.`;
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
