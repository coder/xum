import * as fsPromises from "fs/promises";
import * as path from "node:path";

import writeFileAtomic from "@/node/utils/writeFileAtomic";

import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

/**
 * Durable terminal-failure artifacts for sub-agent tasks.
 *
 * Mirrors subagentReportArtifacts but as an explicit discriminated FAILURE
 * variant: a terminal failure (e.g. model_refusal) must never masquerade as a
 * completed report. Reports and failures live in separate files; report lookup
 * always takes precedence in waitForAgentReport, so a stale failure artifact
 * can never mask a real report (report monotonicity).
 *
 * These artifacts exist so background children, app restarts, and
 * post-cleanup `task_await`s still observe the typed failure after the child
 * workspace entry (and its `taskLaunchError`) is gone.
 */
export interface SubagentFailureArtifactsFile {
  version: 1;
  failuresByChildTaskId: Record<string, SubagentFailureArtifact>;
}

export interface SubagentFailureArtifact {
  childTaskId: string;
  /** Immediate parent in the agent-task tree (matches WorkspaceConfigEntry.parentWorkspaceId). */
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** StreamErrorType that terminally failed the task (e.g. "model_refusal"). */
  errorType: string;
  /** Human-readable failure message; waiters reject with exactly this text. */
  errorMessage: string;
  /** Full ancestor chain (parent first). Used for descendant scope checks after cleanup. */
  ancestorWorkspaceIds: string[];
  /** Ancestors for which this child is owned by a workflow step. */
  workflowOwnedAncestorWorkspaceIds?: string[];
  /** Task-level model string used when running the sub-agent. */
  model?: string;
}

const SUBAGENT_FAILURE_ARTIFACTS_FILE_VERSION = 1 as const;
const SUBAGENT_FAILURE_ARTIFACTS_FILE_NAME = "subagent-failures.json";

export function getSubagentFailureArtifactsFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, SUBAGENT_FAILURE_ARTIFACTS_FILE_NAME);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function emptyFile(): SubagentFailureArtifactsFile {
  return { version: SUBAGENT_FAILURE_ARTIFACTS_FILE_VERSION, failuresByChildTaskId: {} };
}

export async function readSubagentFailureArtifactsFile(
  workspaceSessionDir: string
): Promise<SubagentFailureArtifactsFile> {
  try {
    const filePath = getSubagentFailureArtifactsFilePath(workspaceSessionDir);
    const raw = await fsPromises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return emptyFile();
    }

    const obj = parsed as { version?: unknown; failuresByChildTaskId?: unknown };
    if (obj.version !== SUBAGENT_FAILURE_ARTIFACTS_FILE_VERSION) {
      // Unknown version; treat as empty.
      return emptyFile();
    }
    if (!obj.failuresByChildTaskId || typeof obj.failuresByChildTaskId !== "object") {
      return emptyFile();
    }

    return {
      version: SUBAGENT_FAILURE_ARTIFACTS_FILE_VERSION,
      failuresByChildTaskId: obj.failuresByChildTaskId as Record<string, SubagentFailureArtifact>,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyFile();
    }

    log.error("Failed to read subagent failure artifacts file", { error });
    return emptyFile();
  }
}

export async function readSubagentFailureArtifact(
  workspaceSessionDir: string,
  childTaskId: string
): Promise<SubagentFailureArtifact | null> {
  const file = await readSubagentFailureArtifactsFile(workspaceSessionDir);
  const entry = file.failuresByChildTaskId[childTaskId];
  if (!entry) {
    return null;
  }

  // Self-healing: drop malformed entries instead of surfacing partial data.
  return isWellFormedFailureArtifact(entry) ? entry : null;
}

function isWellFormedFailureArtifact(entry: SubagentFailureArtifact): boolean {
  return (
    typeof entry.errorMessage === "string" &&
    entry.errorMessage.length > 0 &&
    typeof entry.errorType === "string" &&
    isStringArray(entry.ancestorWorkspaceIds)
  );
}

/**
 * Fail-closed read for attempt classification (G2): unlike readSubagentFailureArtifact, which
 * self-heals a damaged file to "no failure", a present but unparseable file or entry is
 * `unreadable`, so a terminal failure is never mistaken for an attempt that merely ended.
 */
export async function readSubagentFailureArtifactStrict(
  workspaceSessionDir: string,
  childTaskId: string
): Promise<
  | { kind: "found"; artifact: SubagentFailureArtifact }
  | { kind: "not_found" }
  | { kind: "unreadable"; error: string }
> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(
      getSubagentFailureArtifactsFilePath(workspaceSessionDir),
      "utf-8"
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { kind: "not_found" };
    }
    return { kind: "unreadable", error: getErrorMessage(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: "unreadable", error: getErrorMessage(error) };
  }
  const file = parsed as { version?: unknown; failuresByChildTaskId?: unknown } | null;
  if (
    file?.version !== SUBAGENT_FAILURE_ARTIFACTS_FILE_VERSION ||
    file.failuresByChildTaskId == null ||
    typeof file.failuresByChildTaskId !== "object"
  ) {
    return { kind: "unreadable", error: "unexpected failure artifacts file shape" };
  }
  const failures = file.failuresByChildTaskId as Record<string, SubagentFailureArtifact>;
  if (!Object.hasOwn(failures, childTaskId)) return { kind: "not_found" };
  const artifact = failures[childTaskId];
  return artifact != null && typeof artifact === "object" && isWellFormedFailureArtifact(artifact)
    ? { kind: "found", artifact }
    : { kind: "unreadable", error: "malformed failure artifact entry" };
}

export async function upsertSubagentFailureArtifact(params: {
  /** Workspace id that owns the session dir we're writing into (used for file locking). */
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  parentWorkspaceId: string;
  ancestorWorkspaceIds: string[];
  errorType: string;
  errorMessage: string;
  workflowOwnedAncestorWorkspaceIds?: string[];
  model?: string;
  nowMs?: number;
}): Promise<void> {
  await workspaceFileLocks.withLock(params.workspaceId, async () => {
    const nowMs = params.nowMs ?? Date.now();

    const file = await readSubagentFailureArtifactsFile(params.workspaceSessionDir);
    const existing = file.failuresByChildTaskId[params.childTaskId] ?? null;

    file.failuresByChildTaskId[params.childTaskId] = {
      childTaskId: params.childTaskId,
      parentWorkspaceId: params.parentWorkspaceId,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      errorType: params.errorType,
      errorMessage: params.errorMessage,
      ancestorWorkspaceIds: params.ancestorWorkspaceIds,
      workflowOwnedAncestorWorkspaceIds: params.workflowOwnedAncestorWorkspaceIds,
      model: params.model,
    };

    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentFailureArtifactsFilePath(params.workspaceSessionDir);
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    } catch (error) {
      log.error("Failed to write subagent failure artifacts file", { error });
    }
  });
}
