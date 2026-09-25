import * as crypto from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { z } from "zod";

import writeFileAtomic from "@/node/utils/writeFileAtomic";

import {
  WorkflowEventSequenceSchema,
  WorkflowRunEventSchema,
  WorkflowRunIdSchema,
  WorkflowRunRecordSchema,
  WorkflowStepRecordSchema,
} from "@/common/orpc/schemas";
import {
  isActiveWorkflowRunStatus,
  type StructuredTaskOutput,
  type WorkflowScriptDescriptor,
  type WorkflowRunEvent,
  type WorkflowRunParent,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStepRecord,
} from "@/common/types/workflow";
import type { BackgroundWorkAttentionPolicy } from "@/common/types/backgroundWorkAttention";
import type { EvaluationAdmission } from "@/common/types/evaluation";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isErrnoException, isErrnoWithCode } from "@/node/utils/fs";
import {
  acquireCrossProcessLock,
  CrossProcessLockTimeoutError,
} from "@/node/utils/main/crossProcessLock";
import { workflowRunStreamHub } from "@/node/services/workflows/workflowRunStreamHub";

const WorkflowRunStatusSnapshotSchema = WorkflowRunRecordSchema.pick({
  id: true,
  workspaceId: true,
  status: true,
  parentWorkflow: true,
  createdAt: true,
  updatedAt: true,
});

export type WorkflowRunStatusSnapshot = z.infer<typeof WorkflowRunStatusSnapshotSchema>;

// Owner IDs feed directly into host-side session paths. Reject separators and dot segments
// before constructing a store so a malformed reference cannot escape the sessions root.
export function isPathSafeWorkspaceId(workspaceId: string): boolean {
  return (
    workspaceId.length > 0 &&
    workspaceId !== "." &&
    workspaceId !== ".." &&
    !workspaceId.includes("/") &&
    !workspaceId.includes("\\") &&
    path.basename(workspaceId) === workspaceId
  );
}

export async function getWorkflowRunStatusesForOwners(
  context: { sessionsDir: string },
  refs: ReadonlyArray<{ workspaceId: string; runId: string }>
) {
  const stores = new Map<string, WorkflowRunStore>();
  const entries = await Promise.all(
    refs.map(async (ref) => {
      if (!isPathSafeWorkspaceId(ref.workspaceId)) {
        return null;
      }
      try {
        let store = stores.get(ref.workspaceId);
        if (store == null) {
          store = new WorkflowRunStore({
            sessionDir: path.join(context.sessionsDir, ref.workspaceId),
          });
          stores.set(ref.workspaceId, store);
        }
        const status = await store.getRunStatusForLiveness(ref);
        return { runId: ref.runId, status };
      } catch {
        return null;
      }
    })
  );
  return entries.filter((entry) => entry != null);
}

export async function listActiveWorkflowRunsForOwners(
  context: { sessionsDir: string },
  workspaceIds: readonly string[]
) {
  const results = await Promise.all(
    workspaceIds.filter(isPathSafeWorkspaceId).map(async (workspaceId) => {
      const store = new WorkflowRunStore({
        sessionDir: path.join(context.sessionsDir, workspaceId),
      });
      const summaries = await store.listActiveRunSummaries({ workspaceId });
      return summaries.map((summary) => ({ workspaceId, ...summary }));
    })
  );
  return results.flat();
}

export interface WorkflowRunStoreOptions {
  sessionDir: string;
  staleLeaseMs?: number;
  /** Test seam: how long a journal/lease mutation waits for its locks before timing out. */
  mutationLockWaitTimeoutMs?: number;
}

export interface CreateWorkflowRunInput {
  id: string;
  workspaceId: string;
  workflow: WorkflowScriptDescriptor;
  source: string;
  args: unknown;
  agentOutputSchemaRequired?: boolean;
  /** Existing persisted source snapshots may still contain agentType; new runs default to false. */
  agentTypeAliasAllowed?: boolean;
  parentWorkflow?: WorkflowRunParent;
  /** Background runs persist "notify_on_terminal"; foreground/default omit (defaults to blocking). */
  attentionPolicy?: BackgroundWorkAttentionPolicy;
  now: string;
}

export interface AppendWorkflowRunEventOptions {
  /**
   * Only explicit Resume may reopen an interrupted run; stale active runners must preserve the
   * interrupt.
   */
  allowInterruptedResume?: boolean;
  /** Only explicit failed-run checkpoint retry may reopen a failed run. */
  allowFailedCheckpointRetry?: boolean;
  /** Fence a journal/step mutation so only the current lease owner can write it. */
  expectedLeaseOwnerId?: string;
}

/**
 * Options for writes that settle one agent attempt (completed/failed/timeout metadata).
 * Every such write is fenced INSIDE the store lock to the current merged `started` record with
 * the exact `(stepId, inputHash, taskId)`; a caller-side check followed by an awaited write is
 * never enough because a replacement attempt or a Stop can land in between.
 */
export interface WorkflowAgentAttemptWriteOptions extends AppendWorkflowRunEventOptions {
  /**
   * Draining-owner capability from `openCancellationSettlement`. The only way to settle an
   * attempt on an `interrupted` run: a Stop persists `interrupted` while the runner still holds
   * a valid lease, so lease validity alone is not evidence that a late callback is authorized.
   */
  settlement?: WorkflowCancellationSettlement;
}

/**
 * Invocation-scoped, in-memory capability handed only to the runner instance whose abort fired.
 * The store recognizes it by identity (never by a string flag), binds it to the lease owner that
 * opened it, and forgets it on `close()`, so a foreign writer, a stale instance, or a plain flag
 * cannot borrow the interrupted-run exception. Not persisted: a process restart has no draining
 * owner, so its attempts are disposed by the next resume instead.
 */
export class WorkflowCancellationSettlement {
  constructor(
    readonly runId: string,
    readonly ownerId: string,
    private readonly onClose: (settlement: WorkflowCancellationSettlement) => void
  ) {
    assert(runId.length > 0, "WorkflowCancellationSettlement: runId is required");
    assert(ownerId.length > 0, "WorkflowCancellationSettlement: ownerId is required");
  }

  close(): void {
    this.onClose(this);
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

type WorkflowRunEventDraft = WorkflowRunEvent extends infer Event
  ? Event extends WorkflowRunEvent
    ? Omit<Event, "sequence">
    : never
  : never;

const WORKFLOW_SOURCE_FILENAME = "source.js";
const LEGACY_WORKFLOW_SOURCE_FILENAME = "definition.js";

interface LeaseRecord {
  ownerId: string;
  acquiredAtMs: number;
}

interface WorkflowStepLookup {
  stepId: string;
  inputHash: string;
}

export class WorkflowRunStore {
  private readonly sessionDir: string;
  private readonly staleLeaseMs: number;
  private readonly mutationLockWaitTimeoutMs: number | undefined;
  /** Live draining-owner capabilities by run id; see WorkflowCancellationSettlement. */
  private readonly cancellationSettlements = new Map<string, WorkflowCancellationSettlement>();

  constructor(options: WorkflowRunStoreOptions) {
    assert(options.sessionDir.length > 0, "WorkflowRunStore: sessionDir is required");
    this.sessionDir = options.sessionDir;
    this.staleLeaseMs = options.staleLeaseMs ?? 30_000;
    assert(
      options.mutationLockWaitTimeoutMs == null || options.mutationLockWaitTimeoutMs > 0,
      "WorkflowRunStore: mutationLockWaitTimeoutMs must be positive"
    );
    this.mutationLockWaitTimeoutMs = options.mutationLockWaitTimeoutMs;
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    assert(input.id.length > 0, "WorkflowRunStore.createRun: id is required");
    assert(input.workspaceId.length > 0, "WorkflowRunStore.createRun: workspaceId is required");
    assert(input.source.length > 0, "WorkflowRunStore.createRun: source is required");

    const runDir = this.runDir(input.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, WORKFLOW_SOURCE_FILENAME), input.source, "utf-8");
    await fs.writeFile(path.join(runDir, "events.jsonl"), "", { flag: "a" });
    await fs.writeFile(path.join(runDir, "steps.jsonl"), "", { flag: "a" });

    const run = WorkflowRunRecordSchema.parse({
      id: input.id,
      workspaceId: input.workspaceId,
      workflow: input.workflow,
      source: input.source,
      sourceHash: hashSource(input.source),
      args: input.args,
      agentOutputSchemaRequired: input.agentOutputSchemaRequired ?? true,
      agentTypeAliasAllowed: input.agentTypeAliasAllowed ?? false,
      ...(input.parentWorkflow != null ? { parentWorkflow: input.parentWorkflow } : {}),
      ...(input.attentionPolicy != null ? { attentionPolicy: input.attentionPolicy } : {}),
      status: "pending",
      createdAt: input.now,
      updatedAt: input.now,
      events: [],
      steps: [],
    });

    await this.writeRunFile(input.id, run);
    return run;
  }

  async createRunIfAbsent(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    assert(input.id.length > 0, "WorkflowRunStore.createRunIfAbsent: id is required");
    assert(
      input.workspaceId.length > 0,
      "WorkflowRunStore.createRunIfAbsent: workspaceId is required"
    );
    assert(input.source.length > 0, "WorkflowRunStore.createRunIfAbsent: source is required");

    const runDir = this.runDir(input.id);
    await fs.mkdir(this.workflowsDir(), { recursive: true });
    // Outside runDir on purpose: an incomplete create below removes runDir recursively.
    return await withWorkflowFileLock(
      `${runDir}.create${WORKFLOW_LOCK_FILE_SUFFIX}`,
      this.workflowLockOptions(),
      async () => {
        const existing = await this.getRunIfFullyCreated(input.id);
        if (existing != null) {
          assertSameWorkflowRunIdentity(existing, input);
          return existing;
        }

        // A deterministic child run ID must be recoverable after a crash between mkdir and
        // run.json. Treat an unreadable run directory as an incomplete create, not identity.
        await fs.rm(runDir, { recursive: true, force: true });
        await fs.mkdir(runDir, { recursive: false });
        try {
          await fs.writeFile(path.join(runDir, WORKFLOW_SOURCE_FILENAME), input.source, "utf-8");
          await fs.writeFile(path.join(runDir, "events.jsonl"), "", { flag: "a" });
          await fs.writeFile(path.join(runDir, "steps.jsonl"), "", { flag: "a" });

          const run = WorkflowRunRecordSchema.parse({
            id: input.id,
            workspaceId: input.workspaceId,
            workflow: input.workflow,
            source: input.source,
            sourceHash: hashSource(input.source),
            args: input.args,
            agentOutputSchemaRequired: input.agentOutputSchemaRequired ?? true,
            agentTypeAliasAllowed: input.agentTypeAliasAllowed ?? false,
            ...(input.parentWorkflow != null ? { parentWorkflow: input.parentWorkflow } : {}),
            status: "pending",
            createdAt: input.now,
            updatedAt: input.now,
            events: [],
            steps: [],
          });

          await this.writeRunFile(input.id, run);
          return run;
        } catch (error) {
          await fs.rm(runDir, { recursive: true, force: true });
          throw error;
        }
      }
    );
  }

  private async getRunIfFullyCreated(runId: string): Promise<WorkflowRunRecord | null> {
    try {
      return await this.getRun(runId);
    } catch {
      return null;
    }
  }

  async getRun(runId: string): Promise<WorkflowRunRecord> {
    // UI polling must not wait behind the writer lock; while a mutation is in progress,
    // fall back to the last atomic run.json snapshot instead of reading half-updated journals.
    if (await this.hasActiveWorkflowMutationLock(runId)) {
      return await this.getRunFileSnapshot(runId);
    }
    return await this.getRunUnlocked(runId);
  }

  async getRunStatusSnapshot(runId: string): Promise<WorkflowRunStatusSnapshot> {
    assertValidWorkflowRunId(runId);
    const rawRun = JSON.parse(await fs.readFile(this.runFile(runId), "utf-8")) as unknown;
    const snapshot = WorkflowRunStatusSnapshotSchema.parse(rawRun);
    if (await this.hasActiveWorkflowMutationLock(runId)) {
      return snapshot;
    }

    // Crash recovery: status events hit the journal before run.json is rewritten.
    // Status snapshots consult the journal so recovered workflows do not keep stale
    // active or inactive sidebar state forever after a mid-transition crash.
    const events = await this.readEvents(runId);
    const latestEvent = events.at(-1);
    return WorkflowRunStatusSnapshotSchema.parse({
      ...snapshot,
      status: getRunStatusFromEvents(events) ?? snapshot.status,
      updatedAt: latestEvent?.at ?? snapshot.updatedAt,
    });
  }

  async listRunStatusSnapshots(options?: {
    strict?: boolean;
  }): Promise<WorkflowRunStatusSnapshot[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.workflowsDir(), { withFileTypes: true });
    } catch (error) {
      // A missing workflows dir means no runs (fresh or deleted workspace).
      // Strict callers (discovery) need any other failure to propagate so it
      // is not mistaken for an authoritative empty result.
      if (
        options?.strict !== true ||
        isErrnoWithCode(error, "ENOENT") ||
        isErrnoWithCode(error, "ENOTDIR")
      ) {
        return [];
      }
      throw error;
    }

    const snapshots = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<WorkflowRunStatusSnapshot | null> => {
          try {
            return await this.getRunStatusSnapshot(entry.name);
          } catch (error) {
            // ENOENT/ENOTDIR: the run vanished between readdir and read —
            // legitimately absent in any mode. Other errno failures (EACCES,
            // EIO, ...) are retryable IO, so strict callers reject instead of
            // reporting a false-success omission of an active run. Non-errno
            // failures (invalid JSON/schema, stray non-run dirs) are permanent
            // data problems: self-heal by skipping so one corrupt record
            // cannot hide every other run forever.
            if (
              options?.strict === true &&
              isErrnoException(error) &&
              !isErrnoWithCode(error, "ENOENT") &&
              !isErrnoWithCode(error, "ENOTDIR")
            ) {
              throw error;
            }
            log.warn(
              `Skipping unreadable workflow run status '${entry.name}': ${getErrorMessage(error)}`
            );
            return null;
          }
        })
    );

    return snapshots
      .filter((snapshot): snapshot is WorkflowRunStatusSnapshot => snapshot != null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Liveness read for the bulk run-status endpoint. Reads the status snapshot
   * (durable run.json + status journal) rather than the full record so a
   * missing presentation-only file (source.js, step outputs) cannot read as
   * "run gone": only a definitively-missing durable record (ENOENT / ENOTDIR)
   * or a workspace mismatch maps to null; transient read/parse failures
   * propagate so callers can treat them as retryable instead of as a
   * settled/missing run.
   */
  async getRunStatusForLiveness(input: {
    workspaceId: string;
    runId: string;
  }): Promise<WorkflowRunStatus | null> {
    assert(
      input.workspaceId.length > 0,
      "WorkflowRunStore.getRunStatusForLiveness: workspaceId is required"
    );
    assert(input.runId.length > 0, "WorkflowRunStore.getRunStatusForLiveness: runId is required");
    try {
      const snapshot = await this.getRunStatusSnapshot(input.runId);
      return snapshot.workspaceId === input.workspaceId ? snapshot.status : null;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Active-run discovery for the sub-agent tray's cold mount. Unlike listRuns(),
   * nested (parentWorkflow) runs are included: they are deliberately absent from
   * workspace activity, so a tray mounting during a nested run's between-workers
   * gap has no other way to learn the run exists. Name reads degrade to a
   * nameless entry, but directory-level and per-record IO failures reject
   * (strict mode) so discovery callers retry instead of caching an empty or
   * incomplete result for the rest of the gap.
   */
  async listActiveRunSummaries(input: {
    workspaceId: string;
  }): Promise<Array<{ runId: string; workflowName: string | null; nested: boolean }>> {
    assert(
      input.workspaceId.length > 0,
      "WorkflowRunStore.listActiveRunSummaries: workspaceId is required"
    );
    const snapshots = await this.listRunStatusSnapshots({ strict: true });
    return await Promise.all(
      snapshots
        .filter(
          (snapshot) =>
            snapshot.workspaceId === input.workspaceId && isActiveWorkflowRunStatus(snapshot.status)
        )
        .map(async (snapshot) => {
          let workflowName: string | null = null;
          try {
            workflowName = (await this.getRun(snapshot.id)).workflow.name ?? null;
          } catch {
            // Name is presentation-only; the id still seeds the tray group.
          }
          return { runId: snapshot.id, workflowName, nested: snapshot.parentWorkflow != null };
        })
    );
  }

  async listRuns(): Promise<WorkflowRunRecord[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.workflowsDir(), { withFileTypes: true });
    } catch {
      return [];
    }

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<WorkflowRunRecord | null> => {
          try {
            return await this.getRun(entry.name);
          } catch (error) {
            log.warn(`Skipping unreadable workflow run '${entry.name}': ${getErrorMessage(error)}`);
            return null;
          }
        })
    );

    return runs
      .filter((run): run is WorkflowRunRecord => run != null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Like listRuns, but strict for archive-gating activity scans: only ENOENT/ENOTDIR mean
   * "no runs" — any other directory read failure, and any unreadable run record, throws
   * instead of being silently skipped. Archive gates must be able to prove the absence of
   * active runs; assuming absence on a transient read failure would let a snapshot archive
   * remove a checkout while a crash-recovered run later resumes into it.
   */
  async listRunsForActivityScan(): Promise<WorkflowRunRecord[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.workflowsDir(), { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
        return [];
      }
      throw error;
    }

    const runs = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.getRun(entry.name))
    );
    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendNextEvent(
    runId: string,
    event: WorkflowRunEventDraft,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    assert(runId.length > 0, "WorkflowRunStore.appendNextEvent: runId is required");
    const eventWithMaybeSequence = event as WorkflowRunEventDraft & { sequence?: unknown };
    assert(
      eventWithMaybeSequence.sequence == null,
      "WorkflowRunStore.appendNextEvent: event sequence is assigned by the store"
    );
    return await this.withWorkflowMutationLock(
      runId,
      async () =>
        await this.withExpectedLeaseOwner(
          runId,
          options.expectedLeaseOwnerId,
          async () => await this.appendNextEventUnlocked(runId, event, options)
        )
    );
  }

  async appendEvent(
    runId: string,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    return await this.withWorkflowMutationLock(
      runId,
      async () =>
        await this.withExpectedLeaseOwner(
          runId,
          options.expectedLeaseOwnerId,
          async () => await this.appendEventUnlocked(runId, event, options)
        )
    );
  }

  async appendStatus(
    runId: string,
    status: WorkflowRunStatus,
    at: string,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    return await this.appendNextEvent(runId, { type: "status", at, status }, options);
  }

  /**
   * Persist the attention policy on an existing run record. Used when a foreground/default run is
   * resumed in the background and must become non-blocking (notify_on_terminal) for future
   * stream-ends. No-op when the policy already matches.
   */
  async setAttentionPolicy(
    runId: string,
    attentionPolicy: BackgroundWorkAttentionPolicy
  ): Promise<void> {
    await this.withWorkflowMutationLock(runId, async () => {
      const run = await this.getRunUnlocked(runId);
      if (run.attentionPolicy === attentionPolicy) {
        return;
      }
      await this.writeRunFile(runId, { ...run, attentionPolicy });
    });
  }

  async recordStepStarted(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      startedAt: string;
      /** `evaluate()` steps: the admission, written atomically with the started record. */
      evaluation?: EvaluationAdmission;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.appendStepRecord(
      runId,
      {
        stepId: input.stepId,
        inputHash: input.inputHash,
        taskId: input.taskId,
        startedAt: input.startedAt,
        status: "started",
        ...(input.evaluation !== undefined ? { evaluation: input.evaluation } : {}),
      },
      options
    );
  }

  async recordStepCompleted(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      result: StructuredTaskOutput;
      startedAt: string;
      completedAt: string;
      /** `evaluate()` steps re-carry the admission: the merge is latest-wins per record. */
      evaluation?: EvaluationAdmission;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.appendStepRecord(
      runId,
      {
        stepId: input.stepId,
        inputHash: input.inputHash,
        taskId: input.taskId,
        result: input.result,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        status: "completed",
        ...(input.evaluation !== undefined ? { evaluation: input.evaluation } : {}),
      },
      options
    );
  }

  async recordStepCompletedAndAppendTaskEvent(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId: string;
      // Agent-spec title for the task event row; distinct from result.title,
      // which is the sub-agent's self-reported report title.
      title?: string;
      result: StructuredTaskOutput;
      startedAt: string;
      completedAt: string;
    },
    options: WorkflowAgentAttemptWriteOptions = {}
  ): Promise<void> {
    // Fail fast on empty titles: the event schema enforces min(1), and letting it
    // surface as a ZodError mid-write would abort step persistence with a less
    // actionable error.
    assert(
      input.title == null || input.title.length > 0,
      "WorkflowRunStore.recordStepCompletedAndAppendTaskEvent: title must be non-empty when provided"
    );
    const record = WorkflowStepRecordSchema.parse({
      stepId: input.stepId,
      inputHash: input.inputHash,
      taskId: input.taskId,
      result: input.result,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: "completed",
    });
    await this.settleAgentAttempt(runId, input, options, {
      record,
      taskEvent: {
        type: "task",
        at: input.completedAt,
        stepId: input.stepId,
        taskId: input.taskId,
        status: "completed",
        title: input.title,
      },
      leadingEvents: [],
    });
  }

  async recordStepFailedAndAppendTaskEvent(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId: string;
      // Agent-spec title for the task event row (see recordStepCompletedAndAppendTaskEvent).
      title?: string;
      error: string;
      startedAt: string;
      completedAt: string;
      validationAt: string;
      taskFailedAt?: string;
    },
    options: WorkflowAgentAttemptWriteOptions = {}
  ): Promise<void> {
    assert(
      input.title == null || input.title.length > 0,
      "WorkflowRunStore.recordStepFailedAndAppendTaskEvent: title must be non-empty when provided"
    );
    const record = WorkflowStepRecordSchema.parse({
      stepId: input.stepId,
      inputHash: input.inputHash,
      taskId: input.taskId,
      error: input.error,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: "failed",
    });
    await this.settleAgentAttempt(runId, input, options, {
      record,
      taskEvent: {
        type: "task",
        at: input.taskFailedAt ?? input.completedAt,
        stepId: input.stepId,
        taskId: input.taskId,
        status: "failed",
        title: input.title,
      },
      leadingEvents: [
        {
          type: "validation",
          at: input.validationAt,
          stepId: input.stepId,
          success: false,
          message: input.error,
        },
      ],
    });
  }

  /**
   * Terminal disposition for an attempt whose child settled without a report (no validation
   * event: nothing was validated). Rejected unless the exact attempt is still the current
   * `started` record, so an obsolete attempt can never fail its replacement.
   */
  async recordStepFailedIfCurrent(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId: string;
      title?: string;
      error: string;
      startedAt: string;
      completedAt: string;
    },
    options: WorkflowAgentAttemptWriteOptions = {}
  ): Promise<void> {
    assert(
      input.title == null || input.title.length > 0,
      "WorkflowRunStore.recordStepFailedIfCurrent: title must be non-empty when provided"
    );
    const record = WorkflowStepRecordSchema.parse({
      stepId: input.stepId,
      inputHash: input.inputHash,
      taskId: input.taskId,
      error: input.error,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: "failed",
    });
    await this.settleAgentAttempt(runId, input, options, {
      record,
      taskEvent: {
        type: "task",
        at: input.completedAt,
        stepId: input.stepId,
        taskId: input.taskId,
        status: "failed",
        title: input.title,
      },
      leadingEvents: [],
    });
  }

  /**
   * Shared locked section for the agent-attempt write family: lease fence, run-state fence,
   * attempt fence, then the step record and its task event land in one section so a crash can
   * only split them at the append boundary (see the crash-split replay tests).
   */
  private async settleAgentAttempt(
    runId: string,
    attempt: { stepId: string; inputHash: string; taskId: string },
    options: WorkflowAgentAttemptWriteOptions,
    write: {
      record: WorkflowStepRecord;
      taskEvent: Extract<WorkflowRunEventDraft, { type: "task" }>;
      leadingEvents: WorkflowRunEventDraft[];
    }
  ): Promise<void> {
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const run = await this.getRunUnlocked(runId);
        this.assertCanSettleAgentAttempt(runId, run, attempt, options);
        const { record, taskEvent, leadingEvents } = write;
        // The attempt fence above is the authorization for these events too: on an interrupted
        // run they may only accompany an authorized settlement write, never stand alone.
        const settlementAuthorized = run.status === "interrupted";

        let updatedRun = run;
        const eventsToAppend: WorkflowRunEvent[] = [];
        for (const draft of leadingEvents) {
          const event = this.createNextEventForRun(runId, updatedRun, draft, options, {
            settlementAuthorized,
          });
          eventsToAppend.push(event);
          updatedRun = this.withEvent(updatedRun, event);
        }
        updatedRun = this.withStepRecord(updatedRun, record);
        if (
          !updatedRun.events.some(
            (event) =>
              event.type === "task" &&
              event.status === taskEvent.status &&
              event.stepId === taskEvent.stepId &&
              event.taskId === taskEvent.taskId
          )
        ) {
          const event = this.createNextEventForRun(runId, updatedRun, taskEvent, options, {
            settlementAuthorized,
          });
          eventsToAppend.push(event);
          updatedRun = this.withEvent(updatedRun, event);
        }

        await appendJsonLine(this.stepsFile(runId), record);
        await appendJsonLines(this.eventsFile(runId), eventsToAppend);
        await this.writeRunFile(runId, updatedRun);
      });
    });
  }

  /**
   * Hands the interrupted-run settlement capability to the runner whose abort fired. Verified
   * under the lease lock so only the current lease owner can hold it; replaces any earlier
   * capability for the run so a superseded instance loses it.
   */
  async openCancellationSettlement(
    runId: string,
    ownerId: string,
    abortSignal: AbortSignal
  ): Promise<WorkflowCancellationSettlement> {
    assert(ownerId.length > 0, "WorkflowRunStore.openCancellationSettlement: ownerId is required");
    if (!abortSignal.aborted) {
      throw new Error(
        `Workflow cancellation settlement requires an aborted runner: ${runId} (${ownerId})`
      );
    }
    return await this.withExpectedLeaseOwner(runId, ownerId, () => {
      const settlement = new WorkflowCancellationSettlement(runId, ownerId, (closing) => {
        if (this.cancellationSettlements.get(runId) === closing) {
          this.cancellationSettlements.delete(runId);
        }
      });
      this.cancellationSettlements.set(runId, settlement);
      return Promise.resolve(settlement);
    });
  }

  /** Lease owner and freshness for `already active` diagnostics; null when unleased. */
  async getLeaseDiagnostics(
    runId: string,
    nowMs = Date.now()
  ): Promise<{ ownerId: string; renewedAgoMs: number } | null> {
    const lease = await readLease(this.leaseFile(runId));
    if (lease == null) {
      return null;
    }
    // acquiredAtMs is refreshed by every renewal, so this is lease freshness, not run age.
    return { ownerId: lease.ownerId, renewedAgoMs: Math.max(0, nowMs - lease.acquiredAtMs) };
  }

  async appendTaskEventIfMissing(
    runId: string,
    // title is the agent-spec title for the task event row (see recordStepCompletedAndAppendTaskEvent).
    task: { stepId: string; taskId: string; status: string; at: string; title?: string },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    assert(task.stepId.length > 0, "WorkflowRunStore.appendTaskEventIfMissing: stepId is required");
    assert(task.taskId.length > 0, "WorkflowRunStore.appendTaskEventIfMissing: taskId is required");
    assert(task.status.length > 0, "WorkflowRunStore.appendTaskEventIfMissing: status is required");
    assert(
      task.title == null || task.title.length > 0,
      "WorkflowRunStore.appendTaskEventIfMissing: title must be non-empty when provided"
    );
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const run = await this.getRunUnlocked(runId);
        const alreadyRecorded = run.events.some(
          (event) =>
            event.type === "task" &&
            event.status === task.status &&
            event.stepId === task.stepId &&
            event.taskId === task.taskId
        );
        if (alreadyRecorded) {
          return;
        }
        this.assertCanAppendStepRecord(runId, run);
        const event = this.createNextEventForRun(
          runId,
          run,
          {
            type: "task",
            at: task.at,
            stepId: task.stepId,
            taskId: task.taskId,
            status: task.status,
            title: task.title,
          },
          options
        );
        await appendJsonLine(this.eventsFile(runId), event);
        await this.writeRunFile(runId, this.withEvent(run, event));
      });
    });
  }

  async recordStepTimeoutMetadata(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId: string;
      startedAt: string;
      timeout: NonNullable<WorkflowStepRecord["timeout"]>;
    },
    options: WorkflowAgentAttemptWriteOptions = {}
  ): Promise<void> {
    const record = WorkflowStepRecordSchema.parse({
      stepId: input.stepId,
      inputHash: input.inputHash,
      taskId: input.taskId,
      startedAt: input.startedAt,
      status: "started",
      timeout: input.timeout,
    });
    // Timeout metadata re-merges the started record, so an obsolete attempt writing it late would
    // silently point the checkpoint back at its own task id; fence it like a terminal write.
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const run = await this.getRunUnlocked(runId);
        this.assertCanSettleAgentAttempt(runId, run, input, options);
        await appendJsonLine(this.stepsFile(runId), record);
      });
    });
  }

  async recordStepFailed(
    runId: string,
    input: {
      stepId: string;
      inputHash: string;
      taskId?: string;
      error: string;
      startedAt: string;
      completedAt: string;
      /** `evaluate()` steps re-carry the admission so a later retry can validate against it. */
      evaluation?: EvaluationAdmission;
    },
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.appendStepRecord(
      runId,
      {
        stepId: input.stepId,
        inputHash: input.inputHash,
        taskId: input.taskId,
        error: input.error,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        status: "failed",
        ...(input.evaluation !== undefined ? { evaluation: input.evaluation } : {}),
      },
      options
    );
  }

  async getStep(
    runId: string,
    stepId: string,
    inputHash: string
  ): Promise<WorkflowStepRecord | null> {
    const [step] = await this.getSteps(runId, [{ stepId, inputHash }]);
    return step ?? null;
  }

  async getCompletedStep(
    runId: string,
    stepId: string,
    inputHash: string
  ): Promise<WorkflowStepRecord | null> {
    const step = await this.getStep(runId, stepId, inputHash);
    return step?.status === "completed" ? step : null;
  }

  async getSteps(
    runId: string,
    lookups: readonly WorkflowStepLookup[]
  ): Promise<Array<WorkflowStepRecord | null>> {
    if (lookups.length === 0) {
      return [];
    }
    const requestedKeys = new Set(lookups.map(getWorkflowStepKey));
    const byKey = new Map<string, WorkflowStepRecord>();
    for (const step of await this.readSteps(runId)) {
      const key = getWorkflowStepKey(step);
      if (requestedKeys.has(key)) {
        byKey.set(key, step);
      }
    }
    return lookups.map((lookup) => byKey.get(getWorkflowStepKey(lookup)) ?? null);
  }

  async acquireLease(runId: string, ownerId: string, nowMs = Date.now()): Promise<boolean> {
    assert(ownerId.length > 0, "WorkflowRunStore.acquireLease: ownerId is required");
    const leaseFile = this.leaseFile(runId);
    // Single attempt, as before: a busy lease lock reads as "another runner is active".
    const attempt = await tryWithWorkflowFileLock(
      this.leaseLockFile(runId),
      this.leaseMutationLockStaleMs(),
      async () => {
        const existing = await readLease(leaseFile);
        if (existing != null && nowMs - existing.acquiredAtMs <= this.staleLeaseMs) {
          return false;
        }
        await writeJsonAtomic(leaseFile, { ownerId, acquiredAtMs: nowMs } satisfies LeaseRecord);
        return true;
      }
    );
    return attempt.acquired && attempt.value;
  }

  async getLeaseRetryDelayMs(runId: string, nowMs = Date.now()): Promise<number> {
    const lease = await readLease(this.leaseFile(runId));
    if (lease == null) {
      return 0;
    }
    const remainingMs = this.staleLeaseMs - (nowMs - lease.acquiredAtMs);
    return Math.max(0, Math.ceil(remainingMs) + 1);
  }

  getLeaseRenewalIntervalMs(): number {
    return Math.max(1, Math.floor(this.staleLeaseMs / 2));
  }

  private leaseMutationLockStaleMs(): number {
    return Math.max(1_000, this.staleLeaseMs);
  }

  private leaseMutationWaitTimeoutMs(): number {
    // Journal and lease mutations are short, but CI coverage and busy filesystems can stall
    // waiters for longer than test-sized stale leases.
    return this.mutationLockWaitTimeoutMs ?? Math.max(30_000, this.leaseMutationLockStaleMs() * 4);
  }

  private workflowLockOptions(): { staleMs: number; acquireTimeoutMs: number } {
    return {
      staleMs: this.leaseMutationLockStaleMs(),
      acquireTimeoutMs: this.leaseMutationWaitTimeoutMs(),
    };
  }

  async renewLease(runId: string, ownerId: string, nowMs = Date.now()): Promise<boolean> {
    assert(ownerId.length > 0, "WorkflowRunStore.renewLease: ownerId is required");
    const leaseFile = this.leaseFile(runId);
    try {
      return await withWorkflowFileLock(
        this.leaseLockFile(runId),
        this.workflowLockOptions(),
        async () => {
          const existing = await readLease(leaseFile);
          if (existing?.ownerId !== ownerId) {
            return false;
          }
          await writeJsonAtomic(leaseFile, { ownerId, acquiredAtMs: nowMs } satisfies LeaseRecord);
          return true;
        }
      );
    } catch {
      // A lock that cannot be taken reads as a lost renewal, as before. A failed lease write now
      // does too instead of rejecting; the runner marks the lease lost on either outcome.
      return false;
    }
  }

  async releaseLease(runId: string, ownerId: string): Promise<void> {
    const leaseFile = this.leaseFile(runId);
    await withWorkflowFileLock(this.leaseLockFile(runId), this.workflowLockOptions(), async () => {
      const existing = await readLease(leaseFile);
      if (existing?.ownerId === ownerId) {
        await fs.rm(leaseFile, { force: true });
      }
    });
  }

  private async withWorkflowMutationLock<T>(runId: string, mutation: () => Promise<T>): Promise<T> {
    return await withWorkflowFileLock(
      this.eventsLockFile(runId),
      this.workflowLockOptions(),
      mutation
    );
  }

  private async withExpectedLeaseOwner<T>(
    runId: string,
    expectedLeaseOwnerId: string | undefined,
    mutation: () => Promise<T>
  ): Promise<T> {
    if (expectedLeaseOwnerId == null) {
      return await mutation();
    }
    assert(
      expectedLeaseOwnerId.length > 0,
      "WorkflowRunStore: expected lease owner id must be non-empty"
    );
    const leaseFile = this.leaseFile(runId);
    // Held across the owner check AND the awaited write (#4452 gap 1): no other runner can take
    // the lease between them, because the lock is never taken from a live holder.
    return await withWorkflowFileLock(
      this.leaseLockFile(runId),
      this.workflowLockOptions(),
      async () => {
        const lease = await readLease(leaseFile);
        if (lease?.ownerId !== expectedLeaseOwnerId) {
          throw new Error(`Workflow run lease lost: ${runId}`);
        }
        return await mutation();
      }
    );
  }

  /**
   * Whether a writer appears to be mid-mutation, so reads should prefer the atomic run.json
   * snapshot. A holder's crossProcessLock re-publishes its record (temp file + rename, so a fresh
   * mtime) every staleMs/4 while held, so a fresh mtime still means "a live holder is renewing"; a
   * record leaked by a crashed holder ages out and reads fall back to the journal, as before.
   */
  private async hasActiveWorkflowMutationLock(runId: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.eventsLockFile(runId));
      return Date.now() - stat.mtimeMs <= this.leaseMutationLockStaleMs();
    } catch {
      return false;
    }
  }

  private async readWorkflowSource(runId: string): Promise<string> {
    const runDir = this.runDir(runId);
    try {
      return await fs.readFile(path.join(runDir, WORKFLOW_SOURCE_FILENAME), "utf-8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      return await fs.readFile(path.join(runDir, LEGACY_WORKFLOW_SOURCE_FILENAME), "utf-8");
    }
  }

  private async getRunFileSnapshot(runId: string): Promise<WorkflowRunRecord> {
    const rawRun = JSON.parse(await fs.readFile(this.runFile(runId), "utf-8")) as unknown;
    const run = WorkflowRunRecordSchema.parse(normalizeWorkflowRunRecord(rawRun));
    const source = await this.readWorkflowSource(runId);
    return WorkflowRunRecordSchema.parse({
      ...run,
      source,
      sourceHash: hashSource(source),
    });
  }

  private async getRunUnlocked(runId: string): Promise<WorkflowRunRecord> {
    const rawRun = JSON.parse(await fs.readFile(this.runFile(runId), "utf-8")) as unknown;
    const partial = WorkflowRunRecordSchema.omit({ events: true, steps: true }).parse(
      normalizeWorkflowRunRecord(rawRun)
    );
    const source = await this.readWorkflowSource(runId);
    const events = await this.readEvents(runId);
    const steps = await this.readSteps(runId);

    const latestEvent = events.at(-1);
    const status = getRunStatusFromEvents(events) ?? partial.status;
    return WorkflowRunRecordSchema.parse({
      ...partial,
      source,
      sourceHash: hashSource(source),
      status,
      updatedAt: latestEvent?.at ?? partial.updatedAt,
      events,
      steps,
    });
  }

  private async appendNextEventUnlocked(
    runId: string,
    event: WorkflowRunEventDraft,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    const run = await this.getRunUnlocked(runId);
    const parsedEvent = this.createNextEventForRun(runId, run, event, options);
    await appendJsonLine(this.eventsFile(runId), parsedEvent);
    const updatedRun = this.withEvent(run, parsedEvent);
    await this.writeRunFile(runId, updatedRun);
    return updatedRun;
  }

  private async appendEventUnlocked(
    runId: string,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<WorkflowRunRecord> {
    const run = await this.getRunUnlocked(runId);
    const parsedEvent = WorkflowRunEventSchema.parse(event);
    this.assertCanAppendEvent(runId, run, parsedEvent, options);
    await appendJsonLine(this.eventsFile(runId), parsedEvent);
    const updatedRun = this.withEvent(run, parsedEvent);
    await this.writeRunFile(runId, updatedRun);
    return updatedRun;
  }

  private createNextEventForRun(
    runId: string,
    run: WorkflowRunRecord,
    event: WorkflowRunEventDraft,
    options: AppendWorkflowRunEventOptions = {},
    fence: { settlementAuthorized: boolean } = { settlementAuthorized: false }
  ): WorkflowRunEvent {
    const parsedEvent = WorkflowRunEventSchema.parse({
      ...event,
      sequence: (run.events.at(-1)?.sequence ?? 0) + 1,
    });
    this.assertCanAppendEvent(runId, run, parsedEvent, options, fence);
    return parsedEvent;
  }

  private assertCanAppendEvent(
    runId: string,
    run: WorkflowRunRecord,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions,
    // Internal: set only by settleAgentAttempt after the attempt fence admitted a cancellation
    // settlement write on an interrupted run (non-status events accompanying that write).
    fence: { settlementAuthorized: boolean } = { settlementAuthorized: false }
  ): void {
    const ordered = WorkflowEventSequenceSchema.safeParse([...run.events, event]);
    if (!ordered.success) {
      throw new Error(`Workflow events must be strictly ordered: ${ordered.error.message}`);
    }

    const isInterruptedResumeEvent =
      (event.type === "status" &&
        options.allowInterruptedResume === true &&
        event.status === "running") ||
      (event.type !== "status" && fence.settlementAuthorized);
    const isFailedCheckpointRetryEvent =
      event.type === "status" &&
      options.allowFailedCheckpointRetry === true &&
      run.status === "failed" &&
      event.status === "running";
    const isRepeatedInterruptedStatus = event.type === "status" && event.status === "interrupted";
    if (run.status === "interrupted" && !isInterruptedResumeEvent && !isRepeatedInterruptedStatus) {
      throw new Error(`Workflow run interrupted: ${runId}`);
    }
    if (
      event.type === "status" &&
      isTerminalRunStatus(run.status) &&
      !isFailedCheckpointRetryEvent
    ) {
      throw new Error(`Cannot transition workflow run from ${run.status} to ${event.status}`);
    }
  }

  /**
   * Run-state fence for ordinary (non-settlement) step and task-event writes. Checked inside the
   * locked section and independently of the lease: interrupted runs observed in the field kept
   * valid leases, so a late callback's lease is not evidence that it is still authorized.
   */
  private assertCanAppendStepRecord(runId: string, run: WorkflowRunRecord): void {
    if (run.status === "interrupted") {
      throw new Error(`Workflow run interrupted: ${runId}`);
    }
    if (isTerminalRunStatus(run.status)) {
      throw new Error(`Workflow run ${run.status}: ${runId}`);
    }
  }

  /**
   * Agent-attempt fence: the merged current record for `(stepId, inputHash)` must still be the
   * exact `started` attempt (`taskId`). An interrupted run admits the write only through a live
   * cancellation settlement opened by the same lease owner; completed/failed runs never do.
   */
  private assertCanSettleAgentAttempt(
    runId: string,
    run: WorkflowRunRecord,
    attempt: { stepId: string; inputHash: string; taskId: string },
    options: WorkflowAgentAttemptWriteOptions
  ): void {
    assert(attempt.taskId.length > 0, "WorkflowRunStore: agent attempt taskId is required");
    if (isTerminalRunStatus(run.status)) {
      throw new Error(`Workflow run ${run.status}: ${runId}`);
    }
    if (run.status === "interrupted") {
      const settlement = options.settlement;
      if (
        settlement == null ||
        this.cancellationSettlements.get(runId) !== settlement ||
        settlement.runId !== runId ||
        // The capability is bound to the lease owner that opened it; the lease itself was
        // already verified by withExpectedLeaseOwner for that same id.
        options.expectedLeaseOwnerId !== settlement.ownerId
      ) {
        throw new Error(`Workflow run interrupted: ${runId}`);
      }
    }
    const current = run.steps.find(
      (step) => step.stepId === attempt.stepId && step.inputHash === attempt.inputHash
    );
    if (current?.status !== "started" || current.taskId !== attempt.taskId) {
      throw new Error(
        `Workflow step ${attempt.stepId} task ${attempt.taskId} is not the current started attempt: ${runId}`
      );
    }
  }

  private withEvent(run: WorkflowRunRecord, event: WorkflowRunEvent): WorkflowRunRecord {
    return WorkflowRunRecordSchema.parse({
      ...run,
      events: [...run.events, event],
      status: event.type === "status" ? event.status : run.status,
      updatedAt: event.at,
    });
  }

  private withStepRecord(run: WorkflowRunRecord, record: WorkflowStepRecord): WorkflowRunRecord {
    return WorkflowRunRecordSchema.parse({
      ...run,
      steps: mergeWorkflowStepRecords(run.steps, record),
    });
  }

  private async readEvents(runId: string): Promise<WorkflowRunEvent[]> {
    const events = await readJsonLines(this.eventsFile(runId), WorkflowRunEventSchema);
    return WorkflowEventSequenceSchema.parse(events);
  }

  private async readSteps(runId: string): Promise<WorkflowStepRecord[]> {
    const records = await readJsonLines(this.stepsFile(runId), WorkflowStepRecordSchema);
    return mergeWorkflowStepRecords(records);
  }

  private async appendStepRecord(
    runId: string,
    record: unknown,
    options: AppendWorkflowRunEventOptions = {}
  ): Promise<void> {
    await this.withWorkflowMutationLock(runId, async () => {
      await this.withExpectedLeaseOwner(runId, options.expectedLeaseOwnerId, async () => {
        const parsedRecord = WorkflowStepRecordSchema.parse(record);
        const run = await this.getRunUnlocked(runId);
        this.assertCanAppendStepRecord(runId, run);
        await appendJsonLine(this.stepsFile(runId), parsedRecord);
      });
    });
  }

  private async writeRunFile(runId: string, run: WorkflowRunRecord): Promise<void> {
    // workflow.phaseManifest is derived, hydrated-on-read data (see
    // workflowPhaseManifest.ts). Strip it defensively so a hydrated outbound
    // copy accidentally fed back into the store can never reach run.json —
    // disk records must stay byte-compatible with older builds.
    const { phaseManifest: _hydratedOnly, ...workflowForDisk } = run.workflow;
    const runForDisk = WorkflowRunRecordSchema.parse({ ...run, workflow: workflowForDisk });
    await writeJsonAtomic(this.runFile(runId), runForDisk);
    // Notify live subscribers (workflows.subscribe) after the durable write. The hub is a
    // module-level bus, so any store instance — regardless of which flow constructed it —
    // feeds the same stream. Persist-before-notify keeps disk and observers consistent.
    workflowRunStreamHub.notifyRunPersisted(runForDisk);
  }

  getStepArtifactsDir(runId: string, stepId: string, inputHash: string): string {
    assertValidWorkflowRunId(runId);
    assert(stepId.length > 0, "WorkflowRunStore.getStepArtifactsDir: stepId is required");
    assert(inputHash.length > 0, "WorkflowRunStore.getStepArtifactsDir: inputHash is required");
    const stepKey = crypto.createHash("sha256").update(`${stepId}\0${inputHash}`).digest("hex");
    return path.join(this.runDir(runId), "artifacts", stepKey);
  }

  private workflowsDir(): string {
    return path.join(this.sessionDir, "workflows");
  }

  private runDir(runId: string): string {
    assertValidWorkflowRunId(runId);
    return path.join(this.workflowsDir(), runId);
  }

  private runFile(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  private eventsFile(runId: string): string {
    return path.join(this.runDir(runId), "events.jsonl");
  }

  private stepsFile(runId: string): string {
    return path.join(this.runDir(runId), "steps.jsonl");
  }

  private leaseFile(runId: string): string {
    return path.join(this.runDir(runId), "lease.json");
  }

  private eventsLockFile(runId: string): string {
    return `${this.eventsFile(runId)}${WORKFLOW_LOCK_FILE_SUFFIX}`;
  }

  private leaseLockFile(runId: string): string {
    return `${this.leaseFile(runId)}${WORKFLOW_LOCK_FILE_SUFFIX}`;
  }
}

function normalizeWorkflowRunRecord(rawRun: unknown): unknown {
  if (!isRecord(rawRun)) {
    return rawRun;
  }
  const run = stripPersistedPhaseManifest(rawRun);
  if (run.workflow != null && run.source != null && run.sourceHash != null) {
    return run;
  }
  if (run.definition == null && run.definitionSource == null && run.definitionHash == null) {
    return run;
  }

  // Older run.json snapshots used definition* fields. Normalize before schema parsing so
  // existing durable runs stay visible/resumable long enough to hydrate source from disk.
  return {
    ...run,
    workflow: run.workflow ?? run.definition,
    source: run.source ?? run.definitionSource,
    sourceHash: run.sourceHash ?? run.definitionHash,
  };
}

/**
 * `workflow.phaseManifest` is derived on read and never written by this store, so
 * any persisted value (hand-edited or corrupted run.json) is dropped BEFORE schema
 * validation: a malformed one must not make the durable run unreadable.
 */
function stripPersistedPhaseManifest(rawRun: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(rawRun.workflow) || !("phaseManifest" in rawRun.workflow)) {
    return rawRun;
  }
  const { phaseManifest: _persisted, ...workflow } = rawRun.workflow;
  return { ...rawRun, workflow };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// API callers provide run IDs when reading/resuming; validate before path joins so a malformed
// ID cannot escape the workspace-scoped workflows directory.
function assertValidWorkflowRunId(runId: string): void {
  assert(
    WorkflowRunIdSchema.safeParse(runId).success,
    "WorkflowRunStore: runId must match wfr_[A-Za-z0-9_-]+"
  );
}

function assertSameWorkflowRunIdentity(
  run: WorkflowRunRecord,
  input: CreateWorkflowRunInput
): void {
  const sameIdentity =
    run.id === input.id &&
    run.workspaceId === input.workspaceId &&
    run.workflow.name === input.workflow.name &&
    JSON.stringify(run.args) === JSON.stringify(input.args) &&
    JSON.stringify(run.parentWorkflow ?? null) === JSON.stringify(input.parentWorkflow ?? null);
  assert(
    sameIdentity,
    `WorkflowRunStore.createRunIfAbsent: existing run identity does not match requested run ${input.id}`
  );
}

function getWorkflowStepKey(step: WorkflowStepLookup): string {
  return `${step.stepId}\0${step.inputHash}`;
}

function mergeWorkflowStepRecords(
  records: readonly WorkflowStepRecord[],
  nextRecord?: WorkflowStepRecord
): WorkflowStepRecord[] {
  const byKey = new Map<string, WorkflowStepRecord>();
  const mergeRecord = (record: WorkflowStepRecord): void => {
    const key = getWorkflowStepKey(record);
    const previous = byKey.get(key);
    byKey.set(key, {
      ...record,
      timeout: mergeWorkflowStepTimeoutMetadata(previous, record),
    });
  };
  for (const record of records) {
    mergeRecord(record);
  }
  if (nextRecord !== undefined) {
    mergeRecord(nextRecord);
  }
  return Array.from(byKey.values());
}

function mergeWorkflowStepTimeoutMetadata(
  previous: WorkflowStepRecord | undefined,
  next: WorkflowStepRecord
): WorkflowStepRecord["timeout"] {
  if (next.timeout != null) {
    if (previous?.timeout != null && previous.taskId === next.taskId) {
      return { ...previous.timeout, ...next.timeout };
    }
    return next.timeout;
  }
  if (previous?.timeout == null) {
    return undefined;
  }
  if (previous.taskId != null && next.taskId != null && previous.taskId !== next.taskId) {
    return undefined;
  }
  return previous.timeout;
}

export function hashSource(source: string): string {
  return `sha256:${crypto.createHash("sha256").update(source).digest("hex")}`;
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

async function appendJsonLines(filePath: string, values: readonly unknown[]): Promise<void> {
  if (values.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(
    filePath,
    values.map((value) => JSON.stringify(value)).join("\n") + "\n",
    "utf-8"
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJsonLines<T>(
  filePath: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    // A journal that does not exist yet is a normal state. Other IO failures
    // must propagate: after a crash the newest status can live only in the
    // journal, so swallowing e.g. EACCES here would let status reads act on a
    // stale run.json and (in strict discovery) silently omit an active run.
    if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }

  const records: T[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const parsedJson = JSON.parse(line) as unknown;
      const parsedRecord = schema.safeParse(parsedJson);
      if (parsedRecord.success) {
        records.push(parsedRecord.data);
      } else {
        log.warn(`Skipping malformed workflow journal line ${index + 1} in ${filePath}`);
      }
    } catch (error) {
      log.warn(
        `Skipping malformed workflow journal line ${index + 1} in ${filePath}: ${getErrorMessage(error)}`
      );
    }
  }

  return records;
}

function getRunStatusFromEvents(
  events: readonly WorkflowRunEvent[]
): WorkflowRunStatus | undefined {
  return events.findLast((event) => event.type === "status")?.status;
}

function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * Lock FILES taken through crossProcessLock. New names on purpose: the pre-#4452 locks were
 * directories at `<file>.lock`, and crossProcessLock treats a directory left at its path (by an
 * older build or a crash) as an unreadable holder that it never takes over, which would block the
 * run forever. The cost matches #4415's mixed-version caveat: an older build running at the same
 * time on the same root still uses the old directories, so the two builds do not exclude each
 * other.
 */
const WORKFLOW_LOCK_FILE_SUFFIX = ".xlock";

/**
 * In-process queue in front of the cross-process lock, keyed by lock path and shared by every
 * store instance in this process: without it, same-process contenders would find each other's
 * live record and wait out crossProcessLock's 250 ms retry sleep. Different paths are different
 * keys, so the nested events -> lease acquisition cannot deadlock against itself.
 */
const workflowLockQueue = new MutexMap<string>();

/**
 * #4452 gap 1: the former mkdir locks were reclaimed once their mtime aged past the stale window,
 * which a live holder stalled inside its owner-check-then-write section never refreshed, and every
 * finally removed the lock unconditionally, deleting a successor's. crossProcessLock never takes a
 * lock from a live holder and its release removes only its own record.
 */
async function withWorkflowFileLock<T>(
  lockPath: string,
  options: { staleMs: number; acquireTimeoutMs: number },
  operation: () => Promise<T>
): Promise<T> {
  // One budget covers the in-process queue and the cross-process acquire. A waiter behind a hung
  // in-process holder gives up its place at the deadline with the same timeout error as before;
  // it never takes the lock, and the holder keeps it.
  const timeoutMessage = `Timed out acquiring workflow mutation lock: ${lockPath}`;
  const deadline = Date.now() + options.acquireTimeoutMs;
  const result = await workflowLockQueue.withLockBounded(
    lockPath,
    async () => {
      await assertLockParentExists(lockPath);
      const release = await acquireCrossProcessLock({
        lockPath,
        acquireTimeoutMs: Math.max(0, deadline - Date.now()),
        staleMs: options.staleMs,
        timeoutMessage,
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    },
    deadline
  );
  if (result.kind === "timeout") {
    throw new Error(timeoutMessage);
  }
  return result.value;
}

/**
 * acquireCrossProcessLock creates missing parent directories; the former mkdir lock failed with
 * ENOENT instead. Keep failing, so a late writer (e.g. a runner's lease release after its
 * workspace was deleted) cannot recreate a removed run or session directory.
 */
async function assertLockParentExists(lockPath: string): Promise<void> {
  await fs.access(path.dirname(lockPath));
}

/** One attempt, in-process and cross-process; `{ acquired: false }` while anyone holds the lock. */
async function tryWithWorkflowFileLock<T>(
  lockPath: string,
  staleMs: number,
  operation: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const attempt = await workflowLockQueue.tryWithLock(
    lockPath,
    async (): Promise<{ acquired: true; value: T } | { acquired: false }> => {
      await assertLockParentExists(lockPath);
      let release: () => Promise<void>;
      try {
        release = await acquireCrossProcessLock({
          lockPath,
          acquireTimeoutMs: 0,
          staleMs,
          timeoutMessage: `Workflow mutation lock is busy: ${lockPath}`,
        });
      } catch (error) {
        if (error instanceof CrossProcessLockTimeoutError) {
          return { acquired: false };
        }
        throw error;
      }
      try {
        return { acquired: true, value: await operation() };
      } finally {
        await release();
      }
    }
  );
  return attempt.acquired ? attempt.value : attempt;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readLease(leaseFile: string): Promise<LeaseRecord | null> {
  try {
    const raw = JSON.parse(await fs.readFile(leaseFile, "utf-8")) as Partial<LeaseRecord>;
    if (typeof raw.ownerId === "string" && typeof raw.acquiredAtMs === "number") {
      return { ownerId: raw.ownerId, acquiredAtMs: raw.acquiredAtMs };
    }
  } catch {
    return null;
  }
  return null;
}
