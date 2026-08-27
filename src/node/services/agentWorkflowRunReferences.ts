import * as fs from "node:fs/promises";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import assert from "@/common/utils/assert";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { log } from "@/node/services/log";

export interface AgentWorkflowRunReference {
  runId: string;
  createdAtMs: number;
  /**
   * Message ID of the newest invocation-decision row (manual user/reset supersession, consumed
   * terminal result for this run, or direct invocation part) at record time; null when history
   * had none. Row identity, not wall clock: currentness compares this against the row the
   * history walk stops at, so a backward clock correction cannot reorder the comparison.
   * Absent on legacy entries, which fail safe to not-current.
   */
  afterBoundaryMessageId?: string | null;
}

const AGENT_WORKFLOW_RUN_REFERENCES_FILE = "agent-workflow-runs.json";

// Backward clock corrections (e.g. an NTP step after booting with a fast clock) can make a
// legitimately recorded reference look future-dated. Tolerate that bounded skew so the run's
// terminal wake is not dropped; only implausibly future values are treated as corruption.
const MAX_FUTURE_SKEW_MS = 60 * 60_000;

const referenceFileLocks = new MutexMap<string>();

// Detached record retries keyed by sidecar path and runId so lifecycle events can govern them:
// a full clear cancels the path's retries so a stale retry cannot resurrect a retired
// reference, and a retry only ever fills absence (onlyIfAbsent), so it cannot overwrite newer
// provenance recorded by a later dispatch or workflow_resume.
const pendingRecordRetryTimersByPath = new Map<
  string,
  Map<string, ReturnType<typeof setTimeout>>
>();

function cancelPendingRecordRetries(filePath: string): void {
  const byRunId = pendingRecordRetryTimersByPath.get(filePath);
  if (byRunId == null) {
    return;
  }
  for (const timer of byRunId.values()) {
    clearTimeout(timer);
  }
  pendingRecordRetryTimersByPath.delete(filePath);
}

function referencesPath(workspaceSessionDir: string): string {
  assert(workspaceSessionDir.length > 0, "agent workflow references require session dir");
  return path.join(workspaceSessionDir, AGENT_WORKFLOW_RUN_REFERENCES_FILE);
}

function parseReferences(value: unknown): AgentWorkflowRunReference[] {
  if (value == null || typeof value !== "object") {
    return [];
  }
  const references = (value as Record<string, unknown>).references;
  if (!Array.isArray(references)) {
    return [];
  }

  const parsedByRunId = new Map<string, AgentWorkflowRunReference>();
  const now = Date.now();
  for (const reference of references) {
    if (reference == null || typeof reference !== "object") {
      continue;
    }
    const record = reference as Record<string, unknown>;
    if (typeof record.runId !== "string" || record.runId.length === 0) {
      continue;
    }
    if (typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)) {
      continue;
    }
    // Reject implausibly future-dated references (corruption) instead of clamping at read
    // time: a per-read clamp re-evaluates to "now" on every read, so the entry would outrank
    // every later user/reset boundary until wall time catches up. Values within
    // MAX_FUTURE_SKEW_MS are kept as-is (backward clock correction, not corruption). Rejected
    // entries are replaced with a sane timestamp by the next legitimate record.
    if (record.createdAtMs > now + MAX_FUTURE_SKEW_MS) {
      continue;
    }
    const hasBoundary = "afterBoundaryMessageId" in record;
    const boundaryRaw = record.afterBoundaryMessageId;
    // A present-but-invalid snapshot ("" or a non-string) is corruption, not a legacy record:
    // migrating it into the wall-clock fallback could let a stale reference outrank a newer
    // boundary within the tolerated clock skew. Reject the entry; absence stays reserved for
    // records that genuinely predate the field.
    if (
      hasBoundary &&
      boundaryRaw !== null &&
      (typeof boundaryRaw !== "string" || boundaryRaw.length === 0)
    ) {
      continue;
    }
    const afterBoundaryMessageId = hasBoundary
      ? typeof boundaryRaw === "string"
        ? boundaryRaw
        : null
      : undefined;
    // Collapse corrupted duplicate entries to the newest sane timestamp so order-sensitive
    // consumers cannot pick a stale duplicate and declare a legitimately re-recorded run
    // superseded. The chosen record is kept wholesale, including its boundary snapshot.
    const existing = parsedByRunId.get(record.runId);
    if (existing == null || record.createdAtMs > existing.createdAtMs) {
      parsedByRunId.set(record.runId, {
        runId: record.runId,
        createdAtMs: record.createdAtMs,
        ...(afterBoundaryMessageId !== undefined ? { afterBoundaryMessageId } : {}),
      });
    }
  }
  return Array.from(parsedByRunId.values());
}

export async function readAgentWorkflowRunReferences(
  workspaceSessionDir: string
): Promise<AgentWorkflowRunReference[]> {
  let raw: string;
  try {
    raw = await fs.readFile(referencesPath(workspaceSessionDir), "utf-8");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    // For kernel-launched runs this file is the only durable invocation evidence, and callers
    // deciding wake delivery must distinguish "no reference" from "cannot know right now":
    // flattening a transient read failure into [] would let the terminal drain tombstone the
    // run's wake. Corrupted contents below stay self-healing because rereading cannot repair
    // them, while a failed read can succeed later.
    throw error;
  }
  try {
    return parseReferences(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

/**
 * Retire every reference for this workspace. A full history clear removes all rows without
 * appending a reset boundary, which makes a verified-empty (null) boundary snapshot recorded
 * before the clear indistinguishable from one recorded after it; retiring the references with
 * the transcript keeps pre-clear workflow results out of the fresh conversation. A post-clear
 * workflow_resume re-records provenance. Pending record retries are cancelled first so a stale
 * detached retry cannot recreate a retired reference.
 */
export async function clearAgentWorkflowRunReferences(workspaceSessionDir: string): Promise<void> {
  const filePath = referencesPath(workspaceSessionDir);
  await referenceFileLocks.withLock(filePath, async () => {
    cancelPendingRecordRetries(filePath);
    await fs.rm(filePath, { force: true });
  });
}

export async function recordAgentWorkflowRunReference(input: {
  workspaceSessionDir: string;
  runId: string;
  createdAtMs?: number;
  afterBoundaryMessageId?: string | null;
  /** Fill-absence mode for detached retries: an existing entry (any newer record) wins. */
  onlyIfAbsent?: boolean;
}): Promise<void> {
  assert(input.runId.length > 0, "agent workflow reference requires runId");
  const filePath = referencesPath(input.workspaceSessionDir);

  await referenceFileLocks.withLock(filePath, async () => {
    // A read failure propagates instead of being treated as empty: the atomic rewrite below
    // would otherwise replace valid-but-momentarily-unreadable contents with only this run,
    // destroying every other active run's sole durable provenance. The failed record is
    // retryable (workflow_resume re-records), while parse corruption still self-heals to
    // empty inside readAgentWorkflowRunReferences because rereading cannot repair it.
    const existing = await readAgentWorkflowRunReferences(input.workspaceSessionDir);
    const byRunId = new Map(existing.map((reference) => [reference.runId, reference]));
    // Clamp like parseReferences: never persist a future-dated timestamp.
    const createdAtMs = Math.min(input.createdAtMs ?? Date.now(), Date.now());
    const previous = byRunId.get(input.runId);
    if (input.onlyIfAbsent === true && previous != null) {
      return;
    }
    byRunId.set(input.runId, {
      runId: input.runId,
      // Latest record wins: workflow_resume re-records the reference, and a resume issued after
      // a manual user message must re-establish provenance for supersession-timestamp
      // comparisons (listAgentReferencedWorkflowRunIds).
      createdAtMs: previous ? Math.max(previous.createdAtMs, createdAtMs) : createdAtMs,
      // The new record event defines currentness provenance wholesale; a caller without
      // boundary knowledge produces a legacy-style entry that fails safe to not-current.
      ...(input.afterBoundaryMessageId !== undefined
        ? { afterBoundaryMessageId: input.afterBoundaryMessageId }
        : {}),
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(
      filePath,
      JSON.stringify({ references: Array.from(byRunId.values()) }, null, 2)
    );
  });
}

// Delays for detached record retries; see scheduleAgentWorkflowRunReferenceRecordRetry.
const RECORD_REFERENCE_RETRY_DELAYS_MS: readonly number[] = [1_000, 10_000, 60_000];

/**
 * Retry a failed provenance record in the background. The launching tool has already returned
 * and an untouched active run never hits a natural re-record site, so a single failed write
 * would permanently supersede the run's terminal wake once storage recovers. Retries reuse the
 * launch-time boundary snapshot, only fill absence (a later successful record wins), and are
 * cancelled by a full history clear.
 */
export function scheduleAgentWorkflowRunReferenceRecordRetry(input: {
  workspaceSessionDir: string;
  runId: string;
  createdAtMs: number;
  afterBoundaryMessageId?: string | null;
  retryDelaysMs?: readonly number[] | null;
  attempt?: number;
}): void {
  const retryDelaysMs = input.retryDelaysMs ?? RECORD_REFERENCE_RETRY_DELAYS_MS;
  const attempt = input.attempt ?? 0;
  const delayMs = retryDelaysMs[attempt];
  if (delayMs == null) {
    log.error("Giving up on agent workflow run reference record after retries", {
      runId: input.runId,
      attempts: attempt,
    });
    return;
  }
  const filePath = referencesPath(input.workspaceSessionDir);
  const timer = setTimeout(() => {
    const byRunId = pendingRecordRetryTimersByPath.get(filePath);
    // clearTimeout cannot stop a callback Node already dequeued; registry identity is the
    // authoritative cancellation signal, so a cancelled-but-raced retry aborts here.
    if (byRunId?.get(input.runId) !== timer) {
      return;
    }
    byRunId.delete(input.runId);
    if (byRunId.size === 0) {
      pendingRecordRetryTimersByPath.delete(filePath);
    }
    // Detached by design: the launching tool already returned, so only this chain can finish
    // the write. Failures reschedule until the bounded delays are exhausted.
    void recordAgentWorkflowRunReference({
      workspaceSessionDir: input.workspaceSessionDir,
      runId: input.runId,
      createdAtMs: input.createdAtMs,
      onlyIfAbsent: true,
      ...(input.afterBoundaryMessageId !== undefined
        ? { afterBoundaryMessageId: input.afterBoundaryMessageId }
        : {}),
    }).catch((error: unknown) => {
      log.warn("Agent workflow run reference record retry failed", {
        runId: input.runId,
        attempt: attempt + 1,
        error,
      });
      scheduleAgentWorkflowRunReferenceRecordRetry({ ...input, attempt: attempt + 1 });
    });
  }, delayMs);
  timer.unref?.();
  let byRunId = pendingRecordRetryTimersByPath.get(filePath);
  if (byRunId == null) {
    byRunId = new Map();
    pendingRecordRetryTimersByPath.set(filePath, byRunId);
  }
  const previousTimer = byRunId.get(input.runId);
  if (previousTimer != null) {
    clearTimeout(previousTimer);
  }
  byRunId.set(input.runId, timer);
}
