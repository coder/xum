import * as fsPromises from "fs/promises";
import * as path from "node:path";

import writeFileAtomic from "@/node/utils/writeFileAtomic";

import type {
  SubagentGitPatchArtifact,
  SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";

export interface SubagentGitPatchArtifactsFile {
  version: 2;
  artifactsByChildTaskId: Record<string, SubagentGitPatchArtifact>;
}

interface LegacySubagentGitPatchArtifactV1 {
  childTaskId: string;
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs?: number;
  status: SubagentGitPatchArtifact["status"];
  baseCommitSha?: string;
  headCommitSha?: string;
  commitCount?: number;
  mboxPath?: string;
  error?: string;
  appliedAtMs?: number;
}

const SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION = 2 as const;

const SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_NAME = "subagent-patches.json";
const SUBAGENT_GIT_PATCH_DIR_NAME = "subagent-patches";
export const SUBAGENT_GIT_PATCH_MBOX_FILE_NAME = "series.mbox";
export const SUBAGENT_GIT_PATCH_WORKTREE_FILE_NAME = "worktree.patch";
const LEGACY_SINGLE_PROJECT_NAME = "project";
const LEGACY_SINGLE_PROJECT_PATH = "";
const LEGACY_SINGLE_PROJECT_STORAGE_KEY = "legacy-single-project";

export function isLegacySingleProjectArtifact(
  artifact: Pick<SubagentGitProjectPatchArtifact, "projectPath" | "storageKey">
): boolean {
  return (
    artifact.projectPath.length === 0 && artifact.storageKey === LEGACY_SINGLE_PROJECT_STORAGE_KEY
  );
}

export function matchesProjectArtifactProjectPath(
  artifact: Pick<SubagentGitProjectPatchArtifact, "projectPath" | "storageKey">,
  projectPath: string
): boolean {
  return artifact.projectPath === projectPath;
}

export function matchesProjectArtifactProjectPathForUpdate(
  artifact: Pick<SubagentGitProjectPatchArtifact, "projectPath" | "storageKey">,
  projectPath: string
): boolean {
  return artifact.projectPath === projectPath || isLegacySingleProjectArtifact(artifact);
}

export function isSafeSubagentGitPatchPathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !path.isAbsolute(value) &&
    !value.includes(path.sep) &&
    !value.includes(path.posix.sep) &&
    !value.includes("\\")
  );
}

function assertSafeSubagentGitPatchPathComponent(value: string, label: string): void {
  if (!isSafeSubagentGitPatchPathComponent(value)) {
    throw new Error(`${label} must be a safe path component`);
  }
}

function createEmptyArtifactsFile(): SubagentGitPatchArtifactsFile {
  return { version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
}

function summarizeProjectArtifacts(
  projectArtifacts: SubagentGitProjectPatchArtifact[]
): Pick<
  SubagentGitPatchArtifact,
  "status" | "readyProjectCount" | "failedProjectCount" | "skippedProjectCount" | "totalCommitCount"
> {
  const readyProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "ready"
  ).length;
  const failedProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "failed"
  ).length;
  const skippedProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "skipped"
  ).length;
  const pendingProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "pending"
  ).length;
  const totalCommitCount = projectArtifacts.reduce(
    (sum, artifact) => sum + (artifact.commitCount ?? 0),
    0
  );

  if (projectArtifacts.length === 0) {
    return {
      status: "failed",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  if (pendingProjectCount > 0) {
    return {
      status: "pending",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  if (readyProjectCount > 0) {
    return {
      status: "ready",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  if (projectArtifacts.length > 0 && skippedProjectCount === projectArtifacts.length) {
    return {
      status: "skipped",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  return {
    status: failedProjectCount > 0 ? "failed" : "skipped",
    readyProjectCount,
    failedProjectCount,
    skippedProjectCount,
    totalCommitCount,
  };
}

/**
 * The dirty-capture and partial-application fields flow into shell commands
 * and file reads on retry paths, so a corrupted persisted value (e.g. a
 * number where the fence SHA belongs) would otherwise throw on every retry
 * until the file is edited by hand. Coerce or drop invalid values instead.
 * Corrupt application evidence must fail closed: a corrupt appliedPartial
 * stays a partial marker (coercing falsey corruption to false would erase
 * it and let an already-applied check skip the pending worktree patch), and
 * a corrupt appliedAtMs degrades to a partial/unknown marker (dropping the
 * only record that an application happened would let a retry replay the
 * already-landed commit series). A dropped corrupt fence falls back to
 * fence-less completion, a state the schema already allows because
 * recording the fence is best-effort.
 */
function sanitizeDirtyCaptureFields(
  artifact: SubagentGitProjectPatchArtifact
): SubagentGitProjectPatchArtifact {
  const sanitized = { ...artifact };
  if (
    sanitized.hadUncommittedChanges !== undefined &&
    typeof sanitized.hadUncommittedChanges !== "boolean"
  ) {
    // Corrupt dirty-work evidence degrades to dirty, never clean: falsey
    // corruption (null, 0, "") coerced to false would let the apply gate
    // and cleanup treat explicitly-recorded uncaptured work as absent.
    sanitized.hadUncommittedChanges = true;
  }
  if (
    sanitized.worktreePatchPath !== undefined &&
    (typeof sanitized.worktreePatchPath !== "string" || sanitized.worktreePatchPath.length === 0)
  ) {
    delete sanitized.worktreePatchPath;
  }
  // One file cannot be both patch kinds: an aliased pair would be consumed
  // twice on apply (git am, then again as a raw worktree diff) and bypasses
  // the roll-up's basename-collision renaming. Keep the kind matching the
  // artifact's shape: the mbox for a commit-bearing artifact, the worktree
  // patch for a commit-free one.
  if (
    typeof sanitized.mboxPath === "string" &&
    sanitized.mboxPath.length > 0 &&
    typeof sanitized.worktreePatchPath === "string" &&
    sanitized.worktreePatchPath.length > 0 &&
    path.resolve(sanitized.mboxPath) === path.resolve(sanitized.worktreePatchPath)
  ) {
    if (sanitized.commitCount !== 0) {
      delete sanitized.worktreePatchPath;
    } else {
      delete sanitized.mboxPath;
    }
  }
  // Match the schema's integer/nonnegative constraints: a corrupt -1 or 1.5
  // would otherwise fail result validation on every task_await retrieval.
  if (
    sanitized.worktreePatchBytes !== undefined &&
    !(Number.isInteger(sanitized.worktreePatchBytes) && sanitized.worktreePatchBytes >= 0)
  ) {
    delete sanitized.worktreePatchBytes;
  }
  if (
    sanitized.worktreePatchSkippedReason !== undefined &&
    typeof sanitized.worktreePatchSkippedReason !== "string"
  ) {
    delete sanitized.worktreePatchSkippedReason;
  }
  if (sanitized.appliedPartial !== undefined && typeof sanitized.appliedPartial !== "boolean") {
    sanitized.appliedPartial = true;
  }
  // Positive integer, matching completion records: consumers test the
  // timestamp by truthiness, so an accepted 0 would neither prove
  // application nor leave a fail-closed marker, and a retry could replay
  // the commit series.
  if (
    sanitized.appliedAtMs !== undefined &&
    !(Number.isInteger(sanitized.appliedAtMs) && sanitized.appliedAtMs > 0)
  ) {
    delete sanitized.appliedAtMs;
    if (sanitized.appliedPartial !== true) {
      sanitized.appliedPartial = true;
      sanitized.appliedPartialStage = "unknown";
    }
  }
  if (
    sanitized.appliedPartialHeadSha !== undefined &&
    (typeof sanitized.appliedPartialHeadSha !== "string" ||
      sanitized.appliedPartialHeadSha.trim().length === 0)
  ) {
    delete sanitized.appliedPartialHeadSha;
  }
  // Same policy as a corrupt appliedAtMs: dropping just the field would
  // silently change what replay-safe validation checks, so the record
  // degrades to a fail-closed partial/unknown marker instead.
  if (
    sanitized.appliedHeadSha !== undefined &&
    (typeof sanitized.appliedHeadSha !== "string" || sanitized.appliedHeadSha.trim().length === 0)
  ) {
    delete sanitized.appliedHeadSha;
    if (sanitized.appliedPartial !== true) {
      sanitized.appliedPartial = true;
      sanitized.appliedPartialStage = "unknown";
    }
  }
  if (sanitized.appliedAcknowledged !== undefined && sanitized.appliedAcknowledged !== true) {
    delete sanitized.appliedAcknowledged;
    if (sanitized.appliedPartial !== true) {
      sanitized.appliedPartial = true;
      sanitized.appliedPartialStage = "unknown";
    }
  }
  if (
    sanitized.appliedPartialStage !== undefined &&
    sanitized.appliedPartialStage !== "am-started" &&
    sanitized.appliedPartialStage !== "commits-applied" &&
    sanitized.appliedPartialStage !== "unknown"
  ) {
    // Absent means legacy "commits-applied", so a corrupted stage must not
    // be dropped: an interrupted am-started record would then skip git am
    // and clear the marker with the commit series missing. "unknown" makes
    // recovery fail closed instead.
    sanitized.appliedPartialStage = "unknown";
  }
  return sanitized;
}

function normalizeProjectArtifacts(
  projectArtifacts: SubagentGitProjectPatchArtifact[]
): SubagentGitProjectPatchArtifact[] {
  const normalizedProjectArtifacts = projectArtifacts.map((artifact) => {
    const storageKey = (artifact.storageKey || artifact.projectName).trim();
    assertSafeSubagentGitPatchPathComponent(storageKey, "storageKey");
    return {
      ...sanitizeDirtyCaptureFields(artifact),
      projectName: artifact.projectName.trim(),
      storageKey,
    };
  });

  const storageKeys = normalizedProjectArtifacts.map((artifact) => artifact.storageKey);
  if (new Set(storageKeys).size !== storageKeys.length) {
    throw new Error(`normalizeProjectArtifacts: duplicate storage keys ${storageKeys.join(", ")}`);
  }

  return normalizedProjectArtifacts;
}

function normalizeLegacyArtifact(
  legacyArtifact: LegacySubagentGitPatchArtifactV1
): SubagentGitPatchArtifact {
  return normalizeSubagentGitPatchArtifact({
    childTaskId: legacyArtifact.childTaskId,
    parentWorkspaceId: legacyArtifact.parentWorkspaceId,
    createdAtMs: legacyArtifact.createdAtMs,
    updatedAtMs: legacyArtifact.updatedAtMs,
    status: legacyArtifact.status,
    projectArtifacts: [
      {
        projectPath: LEGACY_SINGLE_PROJECT_PATH,
        projectName: LEGACY_SINGLE_PROJECT_NAME,
        storageKey: LEGACY_SINGLE_PROJECT_STORAGE_KEY,
        status: legacyArtifact.status,
        baseCommitSha: legacyArtifact.baseCommitSha,
        headCommitSha: legacyArtifact.headCommitSha,
        commitCount: legacyArtifact.commitCount,
        mboxPath: legacyArtifact.mboxPath,
        error: legacyArtifact.error,
        appliedAtMs: legacyArtifact.appliedAtMs,
      },
    ],
    readyProjectCount: 0,
    failedProjectCount: 0,
    skippedProjectCount: 0,
    totalCommitCount: 0,
  });
}

export function normalizeSubagentGitPatchArtifact(
  artifact: SubagentGitPatchArtifact
): SubagentGitPatchArtifact {
  assertSafeSubagentGitPatchPathComponent(artifact.childTaskId, "childTaskId");
  const normalizedProjectArtifacts = normalizeProjectArtifacts(artifact.projectArtifacts);
  const summary = summarizeProjectArtifacts(normalizedProjectArtifacts);

  return {
    childTaskId: artifact.childTaskId,
    parentWorkspaceId: artifact.parentWorkspaceId,
    createdAtMs: artifact.createdAtMs,
    updatedAtMs: artifact.updatedAtMs,
    status: summary.status,
    projectArtifacts: normalizedProjectArtifacts,
    readyProjectCount: summary.readyProjectCount,
    failedProjectCount: summary.failedProjectCount,
    skippedProjectCount: summary.skippedProjectCount,
    totalCommitCount: summary.totalCommitCount,
  };
}

function normalizeArtifactsByChildTaskId(
  artifactsByChildTaskId: Record<string, unknown>,
  version: number | undefined,
  options?: {
    /**
     * Rethrow entry-level normalization failures instead of skipping the
     * entry. Cleanup reads need this: a malformed entry read as absent
     * would let removal delete that task's only patch files.
     */
    propagateEntryErrors?: boolean;
  }
): Record<string, SubagentGitPatchArtifact> {
  const normalizedEntries: Array<readonly [string, SubagentGitPatchArtifact]> = [];

  for (const [childTaskId, artifact] of Object.entries(artifactsByChildTaskId)) {
    try {
      if (!artifact || typeof artifact !== "object") {
        throw new Error(`Invalid subagent git patch artifact for task ${childTaskId}`);
      }

      // The map key, not the entry's own childTaskId, names the patch folder
      // (getSubagentGitPatchMboxPath), so it needs the same path check. A bad
      // key skips only its own entry instead of failing every later write.
      assertSafeSubagentGitPatchPathComponent(childTaskId, "childTaskId key");

      const normalizedArtifact =
        version === 1
          ? normalizeLegacyArtifact(artifact as LegacySubagentGitPatchArtifactV1)
          : normalizeSubagentGitPatchArtifact(artifact as SubagentGitPatchArtifact);

      normalizedEntries.push([childTaskId, { ...normalizedArtifact, childTaskId }] as const);
    } catch (error) {
      if (options?.propagateEntryErrors === true) {
        throw new Error(
          `Invalid subagent git patch artifact entry for task ${childTaskId}: ${getErrorMessage(error)}`
        );
      }
      log.error("Skipping invalid subagent git patch artifact entry", {
        childTaskId,
        error,
      });
    }
  }

  return Object.fromEntries(normalizedEntries);
}

export function getSubagentGitPatchArtifactsFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_NAME);
}

export function getSubagentGitPatchTaskDir(
  workspaceSessionDir: string,
  childTaskId: string
): string {
  return path.join(workspaceSessionDir, SUBAGENT_GIT_PATCH_DIR_NAME, childTaskId);
}

export function getSubagentGitPatchProjectDir(
  workspaceSessionDir: string,
  childTaskId: string,
  storageKey: string
): string {
  return path.join(getSubagentGitPatchTaskDir(workspaceSessionDir, childTaskId), storageKey);
}

export function getSubagentGitPatchMboxPath(
  workspaceSessionDir: string,
  childTaskId: string,
  storageKey = LEGACY_SINGLE_PROJECT_STORAGE_KEY
): string {
  return path.join(
    getSubagentGitPatchProjectDir(workspaceSessionDir, childTaskId, storageKey),
    SUBAGENT_GIT_PATCH_MBOX_FILE_NAME
  );
}

export function getSubagentGitPatchWorktreePatchPath(
  workspaceSessionDir: string,
  childTaskId: string,
  storageKey = LEGACY_SINGLE_PROJECT_STORAGE_KEY
): string {
  return path.join(
    getSubagentGitPatchProjectDir(workspaceSessionDir, childTaskId, storageKey),
    SUBAGENT_GIT_PATCH_WORKTREE_FILE_NAME
  );
}

export async function readSubagentGitPatchArtifactsFile(
  workspaceSessionDir: string,
  options?: {
    /**
     * Throw instead of self-healing to an empty file when the file exists
     * but is unreadable or malformed. Cleanup decisions must use this: an
     * unreadable index read as empty would let deletion proceed and destroy
     * the only copies of the patch files it references. A missing file
     * (ENOENT) still reads as empty because it genuinely has no artifacts.
     */
    propagateReadErrors?: boolean;
  }
): Promise<SubagentGitPatchArtifactsFile> {
  try {
    const filePath = getSubagentGitPatchArtifactsFilePath(workspaceSessionDir);
    const raw = await fsPromises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object") {
      throw new Error("subagent git patch artifacts file is not an object");
    }

    const obj = parsed as {
      version?: unknown;
      artifactsByChildTaskId?: unknown;
    };

    const version = typeof obj.version === "number" ? obj.version : undefined;
    const artifactsByChildTaskId = obj.artifactsByChildTaskId;

    if (version !== 1 && version !== SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION) {
      throw new Error(
        `subagent git patch artifacts file has unsupported version ${String(obj.version)}`
      );
    }

    if (!artifactsByChildTaskId || typeof artifactsByChildTaskId !== "object") {
      throw new Error("subagent git patch artifacts file has no artifact map");
    }

    return {
      version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION,
      artifactsByChildTaskId: normalizeArtifactsByChildTaskId(
        artifactsByChildTaskId as Record<string, unknown>,
        version,
        // Entry-level failures must also propagate: a malformed entry
        // silently skipped here would read as absent, and cleanup would
        // delete that task's only patch files.
        { propagateEntryErrors: options?.propagateReadErrors === true }
      ),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return createEmptyArtifactsFile();
    }
    if (options?.propagateReadErrors === true) {
      throw error;
    }

    log.error("Failed to read subagent git patch artifacts file", { error });
    return createEmptyArtifactsFile();
  }
}

export async function readSubagentGitPatchArtifact(
  workspaceSessionDir: string,
  childTaskId: string
): Promise<SubagentGitPatchArtifact | null> {
  const file = await readSubagentGitPatchArtifactsFile(workspaceSessionDir);
  return file.artifactsByChildTaskId[childTaskId] ?? null;
}

export async function updateSubagentGitPatchArtifactsFile(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  /**
   * Runs under the workspace file lock, so async side effects that must be
   * serialized with the freshly read state (e.g. roll-up file replication)
   * can happen here without a read-then-act race.
   */
  update: (file: SubagentGitPatchArtifactsFile) => void | Promise<void>;
  /** The workspace FIFO (phase 4: SessionLocks). */
  locks: SessionLocks;
  /**
   * Write failures are best-effort (logged) by default. Safety-critical
   * markers (partial application) must fail loudly instead: a silently
   * missing marker lets a retry replay the already-applied commit series.
   */
  propagateWriteErrors?: boolean;
  /**
   * See readSubagentGitPatchArtifactsFile: updates that must not persist a
   * reduced map when the existing file (or one entry) is malformed, e.g.
   * the roll-up's parent-index update, need the strict read; the default
   * self-healing read would silently drop the malformed state and this
   * write would make the loss durable.
   */
  propagateReadErrors?: boolean;
}): Promise<SubagentGitPatchArtifactsFile> {
  const fileLocks = params.locks.workspaceFiles;
  return fileLocks.withLock(params.workspaceId, async () => {
    const file = await readSubagentGitPatchArtifactsFile(params.workspaceSessionDir, {
      propagateReadErrors: params.propagateReadErrors,
    });
    await params.update(file);
    file.version = SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION;
    file.artifactsByChildTaskId = Object.fromEntries(
      Object.entries(file.artifactsByChildTaskId).map(([childTaskId, artifact]) => [
        childTaskId,
        normalizeSubagentGitPatchArtifact({ ...artifact, childTaskId }),
      ])
    );
    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentGitPatchArtifactsFilePath(params.workspaceSessionDir);
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    } catch (error) {
      log.error("Failed to write subagent git patch artifacts file", { error });
      if (params.propagateWriteErrors === true) {
        throw new Error(`Could not persist patch artifact state: ${getErrorMessage(error)}`);
      }
    }
    return file;
  });
}

export async function upsertSubagentGitPatchArtifact(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  updater: (existing: SubagentGitPatchArtifact | null) => SubagentGitPatchArtifact;
  /** The workspace FIFO (phase 4: SessionLocks). */
  locks: SessionLocks;
  /** See updateSubagentGitPatchArtifactsFile: safety-critical markers must fail loudly. */
  propagateWriteErrors?: boolean;
}): Promise<SubagentGitPatchArtifact> {
  let updated: SubagentGitPatchArtifact | null = null;

  await updateSubagentGitPatchArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    locks: params.locks,
    propagateWriteErrors: params.propagateWriteErrors,
    update: (file) => {
      const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
      updated = normalizeSubagentGitPatchArtifact(params.updater(existing));
      file.artifactsByChildTaskId[params.childTaskId] = updated;
    },
  });

  if (!updated) {
    throw new Error("upsertSubagentGitPatchArtifact: updater returned no artifact");
  }

  return updated;
}

export async function markSubagentGitPatchArtifactApplied(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  projectPath: string;
  appliedAtMs: number;
  /**
   * Target HEAD after the full application. Replay-safe retries verify the
   * applied work is still present against it before skipping. Ignored for
   * partial stamps (the partial marker gates those retries instead).
   */
  appliedHeadSha?: string;
  /**
   * The application was asserted via acknowledge_partial_recovery: the
   * user's manual recovery may not be reverse-applicable, so replay-safe
   * validation must not re-run the content check against it.
   */
  appliedAcknowledged?: boolean;
  /** Only the commit series landed; the uncommitted-changes patch failed. */
  partial?: boolean;
  /** Target HEAD at partial recording time (ancestry fence for completion). */
  partialHeadSha?: string;
  /** Only meaningful with partial: true; absent means "commits-applied". */
  partialStage?: SubagentGitPatchPartialStage;
  /** The workspace FIFO (phase 4: SessionLocks). */
  locks: SessionLocks;
}): Promise<SubagentGitPatchArtifact | null> {
  let updated: SubagentGitPatchArtifact | null = null;

  await updateSubagentGitPatchArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    locks: params.locks,
    // Every write here records application evidence, so all failures must
    // surface: a silently unpersisted partial marker would let a retry
    // replay the already-applied commit series, and a silently unpersisted
    // completion (which also clears the marker) would report success while
    // the durable state still says partial/am-started, leaving later
    // retries unable to reconcile the advanced HEAD.
    propagateWriteErrors: true,
    update: (file) => {
      const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
      if (!existing) {
        updated = null;
        return;
      }

      updated = normalizeSubagentGitPatchArtifact({
        ...existing,
        updatedAtMs: params.appliedAtMs,
        projectArtifacts: existing.projectArtifacts.map((artifact) => {
          if (!matchesProjectArtifactProjectPathForUpdate(artifact, params.projectPath)) {
            return artifact;
          }
          const {
            appliedPartial: _cleared,
            appliedPartialHeadSha: _clearedSha,
            appliedPartialStage: _clearedStage,
            // Always cleared so a stale post-apply HEAD (or acknowledged
            // flag) from an earlier full application cannot validate a
            // newer one.
            appliedHeadSha: _clearedAppliedSha,
            appliedAcknowledged: _clearedAcknowledged,
            ...rest
          } = artifact;
          return {
            ...rest,
            // An am-started record is in-progress state, not an application:
            // stamping appliedAtMs would misread as applied (and trip
            // already-applied gates) if the attempt is interrupted.
            ...(params.partialStage === "am-started" ? {} : { appliedAtMs: params.appliedAtMs }),
            ...(params.partial !== true && params.appliedHeadSha != null
              ? { appliedHeadSha: params.appliedHeadSha }
              : {}),
            ...(params.partial !== true && params.appliedAcknowledged === true
              ? { appliedAcknowledged: true }
              : {}),
            // A full apply clears any earlier partial marker.
            ...(params.partial === true ? { appliedPartial: true } : {}),
            ...(params.partial === true && params.partialHeadSha != null
              ? { appliedPartialHeadSha: params.partialHeadSha }
              : {}),
            ...(params.partial === true && params.partialStage != null
              ? { appliedPartialStage: params.partialStage }
              : {}),
          };
        }),
      });
      file.artifactsByChildTaskId[params.childTaskId] = updated;
    },
  });

  return updated;
}

/**
 * Target-local partial-application state for REPLAY targets. When a
 * descendant or reconciliation workspace applies an ancestor's artifact, the
 * shared artifact file must stay untouched (other targets replay it too), so
 * the "commits landed but the worktree patch failed" state is recorded in the
 * applying workspace's own session dir. Without it, a retry would replay the
 * already-applied commit series through git am.
 */
export type SubagentGitPatchPartialStage = "am-started" | "commits-applied";

export interface LocalPatchPartialApplyRecord {
  appliedAtMs: number;
  /** Target HEAD when the partial application was recorded (ancestry fence). */
  headCommitSha?: string;
  /**
   * Absent means "commits-applied" (markers written before this field
   * existed). "unknown" is read-side only: a present-but-unreadable stage
   * degrades to it so recovery fails closed instead of skipping git am.
   */
  stage?: SubagentGitPatchPartialStage | "unknown";
}

export interface LocalPatchApplyCompletionRecord {
  appliedAtMs: number;
  /**
   * Target HEAD when the full application completed. Replay-safe retries
   * (allowAlreadyApplied) verify the applied work is still present against
   * it before skipping; absent on records written before the field existed.
   */
  headCommitSha?: string;
  /**
   * Written by acknowledge_partial_recovery: the user asserted the child's
   * work is present in a form the reverse check cannot recognize (e.g. a
   * merged conflict resolution), so replay-safe validation must not re-run
   * the content check against it. The ancestry check still applies.
   */
  acknowledged?: true;
  /**
   * Read-side only: a present-but-malformed record degrades to unknown.
   * Consumers must fail closed instead of treating it as proof that this
   * target applied the project.
   */
  unknown?: true;
}

interface LocalPatchApplyStateFile {
  version: 1;
  partialsByChildTaskId: Record<string, Record<string, LocalPatchPartialApplyRecord>>;
  // Full applications by THIS replay target. The shared ancestor artifact's
  // appliedAtMs cannot record them (other targets replay it too), and
  // acknowledgment sweeps need proof a sibling was applied to skip it.
  completionsByChildTaskId: Record<string, Record<string, LocalPatchApplyCompletionRecord>>;
}

const SUBAGENT_GIT_PATCH_LOCAL_APPLY_FILE_NAME = "subagent-patches-local-apply.json";

function getLocalPatchApplyStateFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, SUBAGENT_GIT_PATCH_LOCAL_APPLY_FILE_NAME);
}

async function readLocalPatchApplyStateFile(
  workspaceSessionDir: string
): Promise<LocalPatchApplyStateFile> {
  const empty: LocalPatchApplyStateFile = {
    version: 1,
    partialsByChildTaskId: {},
    completionsByChildTaskId: {},
  };
  let raw: string;
  try {
    raw = await fsPromises.readFile(getLocalPatchApplyStateFilePath(workspaceSessionDir), "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return empty;
    }
    // Fail closed: an unreadable file (EACCES, transient I/O) may hide a
    // recorded partial application, and treating it as empty would let a
    // retry replay an already-applied commit series.
    throw new Error(`Could not read local patch apply state: ${getErrorMessage(error)}`);
  }
  let parsed: Partial<LocalPatchApplyStateFile> | null;
  try {
    parsed = JSON.parse(raw) as Partial<LocalPatchApplyStateFile> | null;
  } catch (error) {
    // Fail closed like the read failure above: malformed or truncated JSON
    // may hide a recorded partial application.
    throw new Error(`Could not read local patch apply state: ${getErrorMessage(error)}`);
  }
  if (parsed == null || typeof parsed !== "object") {
    throw new Error("Could not read local patch apply state: not a JSON object");
  }
  // Fail closed on present-but-malformed containers at every level (like
  // the file-level corruption above): silently treating one as empty would
  // hide recorded partial applications and completions, letting a retry
  // replay an already-applied commit series. Absence stays valid (clears
  // delete keys entirely; legacy files predate completionsByChildTaskId).
  const requirePlainObjectContainer = (value: unknown, what: string): Record<string, unknown> => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Could not read local patch apply state: ${what} is malformed`);
    }
    return value as Record<string, unknown>;
  };
  // A corrupted record degrades to a conservative marker instead of
  // vanishing. Its contents are unreadable, so the stage is "unknown"
  // (fails closed) rather than the legacy commits-applied default.
  const partialsByChildTaskId: LocalPatchApplyStateFile["partialsByChildTaskId"] = {};
  if (parsed.partialsByChildTaskId !== undefined) {
    const byChildTask = requirePlainObjectContainer(
      parsed.partialsByChildTaskId,
      "partialsByChildTaskId"
    );
    for (const [childTaskId, byProjectRaw] of Object.entries(byChildTask)) {
      const byProject = requirePlainObjectContainer(
        byProjectRaw,
        `partial records for task ${childTaskId}`
      );
      const validByProject: Record<string, LocalPatchPartialApplyRecord> = {};
      for (const [projectPath, record] of Object.entries(byProject)) {
        if (record == null || typeof record !== "object" || Array.isArray(record)) {
          validByProject[projectPath] = { appliedAtMs: 0, stage: "unknown" };
          continue;
        }
        const candidate = record as Partial<LocalPatchPartialApplyRecord>;
        const appliedAtMs = candidate.appliedAtMs;
        const headCommitSha = candidate.headCommitSha;
        const stage = candidate.stage;
        // Positive integer, like completion records: an out-of-range value
        // (e.g. -1, 1.5) is corruption and must not qualify the record for
        // the legacy absent-stage commits-applied default below.
        const hasValidAppliedAtMs =
          typeof appliedAtMs === "number" && Number.isInteger(appliedAtMs) && appliedAtMs > 0;
        validByProject[projectPath] = {
          appliedAtMs: hasValidAppliedAtMs ? appliedAtMs : 0,
          ...(typeof headCommitSha === "string" && headCommitSha.length > 0
            ? { headCommitSha }
            : {}),
          // A present-but-invalid stage degrades to "unknown", not absence:
          // absent means legacy "commits-applied", which would skip git am
          // for what may be an interrupted am-started record. The legacy
          // absent-stage default is reserved for otherwise valid records
          // (valid appliedAtMs): a structurally empty record like {} proves
          // nothing about the commit series and must also fail closed.
          ...(stage === "am-started" || stage === "commits-applied" || stage === "unknown"
            ? { stage }
            : stage !== undefined || !hasValidAppliedAtMs
              ? { stage: "unknown" as const }
              : {}),
        };
      }
      if (Object.keys(validByProject).length > 0) {
        partialsByChildTaskId[childTaskId] = validByProject;
      }
    }
  }
  const completionsByChildTaskId: LocalPatchApplyStateFile["completionsByChildTaskId"] = {};
  if (parsed.completionsByChildTaskId !== undefined) {
    const byChildTask = requirePlainObjectContainer(
      parsed.completionsByChildTaskId,
      "completionsByChildTaskId"
    );
    for (const [childTaskId, byProjectRaw] of Object.entries(byChildTask)) {
      const byProject = requirePlainObjectContainer(
        byProjectRaw,
        `completion records for task ${childTaskId}`
      );
      const validByProject: Record<string, LocalPatchApplyCompletionRecord> = {};
      for (const [projectPath, record] of Object.entries(byProject)) {
        const candidate =
          record != null && typeof record === "object"
            ? (record as Partial<LocalPatchApplyCompletionRecord>)
            : undefined;
        const appliedAtMs = candidate?.appliedAtMs;
        const headCommitSha = candidate?.headCommitSha;
        const acknowledged = candidate?.acknowledged;
        const hasValidAppliedAtMs =
          typeof appliedAtMs === "number" && Number.isInteger(appliedAtMs) && appliedAtMs > 0;
        // A present-but-invalid headCommitSha or acknowledged flag is
        // corruption like an invalid appliedAtMs: dropping just the field
        // would silently change what replay-safe validation checks.
        const hasInvalidHeadSha =
          headCommitSha !== undefined &&
          !(typeof headCommitSha === "string" && headCommitSha.trim().length > 0);
        const hasInvalidAcknowledged = acknowledged !== undefined && acknowledged !== true;
        // A malformed completion must not manufacture proof of application
        // (sweeps skip proven-applied siblings) nor vanish (a retry would
        // replay the series): degrade to unknown, which fails closed.
        validByProject[projectPath] =
          hasValidAppliedAtMs && !hasInvalidHeadSha && !hasInvalidAcknowledged
            ? {
                appliedAtMs,
                ...(typeof headCommitSha === "string" ? { headCommitSha } : {}),
                ...(acknowledged === true ? { acknowledged: true as const } : {}),
              }
            : { appliedAtMs: 0, unknown: true };
      }
      if (Object.keys(validByProject).length > 0) {
        completionsByChildTaskId[childTaskId] = validByProject;
      }
    }
  }
  return { version: 1, partialsByChildTaskId, completionsByChildTaskId };
}

export async function readLocalPatchPartialApply(params: {
  workspaceSessionDir: string;
  childTaskId: string;
  projectPath: string;
}): Promise<LocalPatchPartialApplyRecord | null> {
  const file = await readLocalPatchApplyStateFile(params.workspaceSessionDir);
  return file.partialsByChildTaskId[params.childTaskId]?.[params.projectPath] ?? null;
}

export async function readLocalPatchApplyCompletion(params: {
  workspaceSessionDir: string;
  childTaskId: string;
  projectPath: string;
}): Promise<LocalPatchApplyCompletionRecord | null> {
  const file = await readLocalPatchApplyStateFile(params.workspaceSessionDir);
  return file.completionsByChildTaskId[params.childTaskId]?.[params.projectPath] ?? null;
}

export async function setLocalPatchPartialApply(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  projectPath: string;
  /** A record marks the partial application; null clears it after a full apply. */
  record: LocalPatchPartialApplyRecord | null;
  /**
   * Only meaningful with record: null. Records, in the same atomic write,
   * that this target fully applied the project, so acknowledgment sweeps can
   * prove a marker-free replay sibling needs no re-apply.
   */
  completedAtMs?: number;
  /** Target HEAD at completion time; see LocalPatchApplyCompletionRecord. */
  completedHeadSha?: string;
  /** Completion was asserted via acknowledge_partial_recovery, not applied. */
  completedAcknowledged?: boolean;
  /** The applying workspace's FIFO (phase 4: SessionLocks). */
  locks: SessionLocks;
}): Promise<void> {
  // Marker SETS and completion writes must surface failures: an undurable
  // marker lets a retry replay the already-applied commit series, and an
  // undurable completion reports success while the stale partial marker
  // survives. Only a bare CLEAR (no completion) stays best-effort, because
  // a stale marker there only blocks a redundant retry.
  const mustSurfaceFailures = params.record != null || params.completedAtMs != null;
  await params.locks.workspaceFiles.withLock(params.workspaceId, async () => {
    let file: LocalPatchApplyStateFile;
    try {
      file = await readLocalPatchApplyStateFile(params.workspaceSessionDir);
    } catch (error) {
      if (mustSurfaceFailures) {
        throw new Error(
          `Could not persist partial-application state for task ${params.childTaskId}: ${getErrorMessage(error)}`
        );
      }
      log.error("Failed to read local patch apply state file", { error });
      return;
    }
    const byProject = file.partialsByChildTaskId[params.childTaskId] ?? {};
    if (params.record == null) {
      delete byProject[params.projectPath];
    } else {
      byProject[params.projectPath] = params.record;
    }
    if (Object.keys(byProject).length === 0) {
      delete file.partialsByChildTaskId[params.childTaskId];
    } else {
      file.partialsByChildTaskId[params.childTaskId] = byProject;
    }
    if (params.record == null && params.completedAtMs != null) {
      const completionsByProject = file.completionsByChildTaskId[params.childTaskId] ?? {};
      completionsByProject[params.projectPath] = {
        appliedAtMs: params.completedAtMs,
        ...(params.completedHeadSha != null ? { headCommitSha: params.completedHeadSha } : {}),
        ...(params.completedAcknowledged === true ? { acknowledged: true as const } : {}),
      };
      file.completionsByChildTaskId[params.childTaskId] = completionsByProject;
    }
    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      await writeFileAtomic(
        getLocalPatchApplyStateFilePath(params.workspaceSessionDir),
        JSON.stringify(file, null, 2)
      );
    } catch (error) {
      log.error("Failed to write local patch apply state file", { error });
      if (mustSurfaceFailures) {
        throw new Error(
          `Could not persist partial-application state for task ${params.childTaskId}: ${getErrorMessage(error)}`
        );
      }
    }
  });
}
