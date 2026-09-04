/**
 * Projects a durable `WorkflowRunRecord` into the view-model the Workflows tab
 * renders (the "Timeline" layout: phases → steps).
 *
 * Why a projector: the persisted run record is intentionally lean. A
 * `WorkflowStepRecord` carries only `{ stepId, status, taskId, timestamps,
 * result, error }` — it has no phase, title, or per-step usage. Those are
 * reconstructed here from the ordered event log:
 *   - phase grouping comes from `phase` events (a step belongs to the phase
 *     that was current at its first `task` event, by sequence);
 *   - the step title comes from its `task` event (falling back to the step's
 *     result title, then the stepId);
 *   - duration is derived from the step timestamps;
 *   - per-step token/cost usage is an optional overlay keyed by the persisted
 *     step `taskId`. UI navigation uses `taskWorkspaceId`, which is present only
 *     for direct agent-task events so patch rows do not link to their source task.
 *
 * Keeping this pure (no React, no IPC) makes the non-trivial folding logic unit
 * testable and keeps the components dumb.
 */
import {
  isActiveWorkflowRunStatus,
  type StructuredTaskOutput,
  type WorkflowResult,
  type WorkflowRunEvent,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStepStatus,
} from "@/common/types/workflow";

/** UI-facing step status. The persisted "started" maps to "running". */
export type WorkflowStepDisplayStatus = "running" | "completed" | "failed" | "interrupted";

export interface WorkflowStepUsage {
  tokens?: number;
  costUsd?: number;
}

export interface WorkflowStepView {
  stepId: string;
  /** Persisted task id associated with the step; patch steps may reference their source task. */
  taskId?: string;
  /** Child workspace id created by this step's direct agent task event. */
  taskWorkspaceId?: string;
  status: WorkflowStepDisplayStatus;
  /** Human title (task title or nested-workflow name → step result title → stepId). */
  title: string;
  /** Owning phase name, or null when no phase was announced before the step. */
  phaseName: string | null;
  startedAt: string;
  completedAt?: string;
  /** Wall-clock duration once the step has settled. */
  durationMs?: number;
  result?: StructuredTaskOutput;
  error?: string;
  /** Optional usage overlay resolved from the step's task workspace. */
  usage?: WorkflowStepUsage;
  /** Nested workflow run spawned by this step, when the step delegates to another workflow. */
  nestedWorkflowRunId?: string;
  nestedWorkflowName?: string;
  nestedWorkflowStatus?: Extract<WorkflowRunEvent, { type: "workflow" }>["status"];
}

export interface WorkflowPhaseView {
  /** Phase id; "" for the implicit bucket holding steps with no announced phase. */
  name: string;
  label: string;
  detail?: string;
  /** Raw `details` from the phase event — often a structured info object the UI can expand. */
  details?: unknown;
  steps: WorkflowStepView[];
  /** Completed steps observed so far in this phase. */
  done: number;
  /**
   * Steps observed so far in this phase. NOT the eventual count: the run record
   * never declares how many steps a phase will ultimately spawn, so totals grow
   * as steps start. Render as "done / observed", not "done / planned".
   */
  total: number;
  running: boolean;
  failed: boolean;
}

export interface WorkflowRunStats {
  total: number;
  done: number;
  running: number;
  failed: number;
  /** updatedAt − createdAt; the components can show a live ticker on top. */
  elapsedMs: number;
  /** Aggregate usage, present only when a usage overlay was supplied. */
  usage?: WorkflowStepUsage;
}

export interface WorkflowArgEntry {
  /** null for a single positional/primitive arg with no name. */
  key: string | null;
  value: string;
  stages?: Array<{ name: string; role?: string; brief?: string }>;
}

export interface WorkflowRunView {
  id: string;
  workflow: WorkflowRunRecord["workflow"];
  status: WorkflowRunStatus;
  argEntries: WorkflowArgEntry[];
  createdAt: string;
  updatedAt: string;
  phases: WorkflowPhaseView[];
  steps: WorkflowStepView[];
  /** Final report, present once a `result` event has been recorded. */
  result: WorkflowResult | null;
  /** Last `error` event message — surfaces a run-level failure with no step error. */
  errorMessage: string | null;
  stats: WorkflowRunStats;
}

export interface ProjectWorkflowRunOptions {
  /** Per-task usage keyed by the persisted step `taskId`. */
  usageByTaskId?: ReadonlyMap<string, WorkflowStepUsage>;
}

const STEP_STATUS_TO_DISPLAY: Record<WorkflowStepStatus, WorkflowStepDisplayStatus> = {
  started: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

function parseTime(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

/** Render an arbitrary workflow arg value for display (primitives verbatim, else JSON). */
export function stringifyWorkflowArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function derivePlannedStages(value: unknown): WorkflowArgEntry["stages"] {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: unknown[] = value;
  const stages: NonNullable<WorkflowArgEntry["stages"]> = [];
  for (const item of items) {
    if (
      item == null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      item.name.trim().length === 0
    ) {
      return undefined;
    }
    const role = "role" in item ? item.role : undefined;
    const brief = "brief" in item ? item.brief : undefined;
    if (
      (role !== undefined && typeof role !== "string") ||
      (brief !== undefined && typeof brief !== "string")
    ) {
      return undefined;
    }
    stages.push({ name: item.name, role, brief });
  }
  return stages;
}

function deriveArgEntries(args: unknown): WorkflowArgEntry[] {
  if (args != null && typeof args === "object" && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>).map(([key, value]) => {
      const entry: WorkflowArgEntry = { key, value: stringifyWorkflowArgValue(value) };
      const stages = key === "stages" ? derivePlannedStages(value) : undefined;
      if (stages != null) entry.stages = stages;
      return entry;
    });
  }
  const value = stringifyWorkflowArgValue(args);
  return value.length > 0 ? [{ key: null, value }] : [];
}

// Phase events carry a freeform `details` JSON value; pull a human detail string
// out of it when present (string, or an object with a detail-ish field).
function derivePhaseDetail(details: unknown): string | undefined {
  if (typeof details === "string") {
    return details.length > 0 ? details : undefined;
  }
  if (details != null && typeof details === "object" && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    for (const key of ["detail", "description", "summary"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  }
  return undefined;
}

function buildPhaseView(
  name: string,
  label: string,
  detail: string | undefined,
  details: unknown,
  steps: WorkflowStepView[]
): WorkflowPhaseView {
  return {
    name,
    label,
    detail,
    details,
    steps,
    done: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    running: steps.some((step) => step.status === "running"),
    failed: steps.some((step) => step.status === "failed"),
  };
}

// Events that belong to a step. Steps are recorded via task events (agent steps) and also via
// patch (apply-patch), workflow (nested-workflow), and legacy action/validation events. Phase
// assignment keys off the first of ANY of these per stepId so every step lands in its phase.
function stepBearingEventStepId(event: WorkflowRunEvent): string | null {
  switch (event.type) {
    case "agent-step":
    case "task":
    case "workflow":
    case "patch":
    case "action":
    case "validation":
      return event.stepId;
    default:
      return null;
  }
}

type WorkflowChildEvent = Extract<WorkflowRunEvent, { type: "workflow" }>;

interface WorkflowChildAttempt {
  firstEvent: WorkflowChildEvent;
  latestEvent: WorkflowChildEvent;
}

function getWorkflowChildAttempts(events: readonly WorkflowRunEvent[]): WorkflowChildAttempt[] {
  const attempts: WorkflowChildAttempt[] = [];
  const attemptsByKey = new Map<string, WorkflowChildAttempt>();
  for (const event of events) {
    if (event.type !== "workflow") {
      continue;
    }
    const key = `${event.stepId}:${event.runId}`;
    const existing = attemptsByKey.get(key);
    if (existing != null) {
      existing.latestEvent = event;
      continue;
    }
    const attempt = { firstEvent: event, latestEvent: event };
    attemptsByKey.set(key, attempt);
    attempts.push(attempt);
  }
  return attempts;
}

function workflowChildAttemptOverlapsStep(
  attempt: WorkflowChildAttempt,
  step: WorkflowRunRecord["steps"][number]
): boolean {
  const childStartedAt = parseTime(attempt.firstEvent.at);
  const stepStartedAt = parseTime(step.startedAt);
  const stepCompletedAt =
    step.completedAt != null ? parseTime(step.completedAt) : Number.POSITIVE_INFINITY;
  return childStartedAt >= stepStartedAt && childStartedAt < stepCompletedAt;
}

function findNestedWorkflowAttemptForStep(
  step: WorkflowRunRecord["steps"][number],
  attempts: readonly WorkflowChildAttempt[]
): WorkflowChildAttempt | null {
  const matchingAttempts = attempts.filter(
    (attempt) =>
      attempt.firstEvent.stepId === step.stepId && workflowChildAttemptOverlapsStep(attempt, step)
  );
  if (matchingAttempts.length > 0) {
    return (
      [...matchingAttempts].sort((a, b) => b.latestEvent.sequence - a.latestEvent.sequence)[0] ??
      null
    );
  }

  const sameStepAttempts = attempts.filter((attempt) => attempt.firstEvent.stepId === step.stepId);
  return sameStepAttempts.length === 1 ? (sameStepAttempts[0] ?? null) : null;
}

export function projectWorkflowRun(
  run: WorkflowRunRecord,
  options: ProjectWorkflowRunOptions = {}
): WorkflowRunView {
  const events = run.events;

  // Named phases in first-appearance order, plus an ordered index of phase
  // changes so each step can be assigned the phase current at its first task.
  const phaseOrder: string[] = [];
  const phaseMeta = new Map<string, { label: string; detail?: string; details?: unknown }>();
  const phaseChanges: Array<{ sequence: number; name: string }> = [];
  for (const event of events) {
    if (event.type === "phase") {
      if (!phaseMeta.has(event.name)) {
        phaseOrder.push(event.name);
        phaseMeta.set(event.name, {
          label: event.name,
          detail: derivePhaseDetail(event.details),
          details: event.details,
        });
      }
      phaseChanges.push({ sequence: event.sequence, name: event.name });
    }
  }

  // First step-bearing event sequence + title per step. A step can be recorded via task,
  // patch, workflow, action, or validation events, so phase assignment must use whichever of
  // those comes first — keying only off task events would drop patch/nested-workflow steps into
  // the ungrouped bucket even when a phase was active.
  const stepFirstEventSeq = new Map<string, number>();
  const stepTitle = new Map<string, string>();
  const stepTaskEventIds = new Map<string, Set<string>>();
  const nestedWorkflowAttempts = getWorkflowChildAttempts(events);
  for (const event of events) {
    const stepId = stepBearingEventStepId(event);
    if (stepId == null) {
      continue;
    }
    if (!stepFirstEventSeq.has(stepId)) {
      stepFirstEventSeq.set(stepId, event.sequence);
    }
    if (event.type === "task") {
      const taskEventIds = stepTaskEventIds.get(stepId);
      if (taskEventIds != null) {
        taskEventIds.add(event.taskId);
      } else {
        stepTaskEventIds.set(stepId, new Set([event.taskId]));
      }
    }
    if (!stepTitle.has(stepId)) {
      if (
        (event.type === "agent-step" || event.type === "task") &&
        event.title != null &&
        event.title.length > 0
      ) {
        stepTitle.set(stepId, event.title);
      } else if (event.type === "workflow") {
        // Nested-workflow steps have no task title; use the child workflow's name.
        stepTitle.set(stepId, event.name);
      }
    }
  }

  // phaseChanges is already in ascending sequence order (event order).
  const phaseAtSequence = (sequence: number): string | null => {
    let current: string | null = null;
    for (const change of phaseChanges) {
      if (change.sequence <= sequence) {
        current = change.name;
      } else {
        break;
      }
    }
    return current;
  };

  const usageByTaskId = options.usageByTaskId;

  const steps: WorkflowStepView[] = run.steps.map((step) => {
    const startSequence = stepFirstEventSeq.get(step.stepId);
    const phaseName = startSequence != null ? phaseAtSequence(startSequence) : null;
    const durationMs =
      step.completedAt != null
        ? Math.max(0, parseTime(step.completedAt) - parseTime(step.startedAt))
        : undefined;
    const usage = step.taskId != null ? usageByTaskId?.get(step.taskId) : undefined;
    const taskWorkspaceId =
      step.taskId != null && stepTaskEventIds.get(step.stepId)?.has(step.taskId) === true
        ? step.taskId
        : undefined;
    const nestedWorkflowEvent = findNestedWorkflowAttemptForStep(
      step,
      nestedWorkflowAttempts
    )?.latestEvent;
    return {
      stepId: step.stepId,
      taskId: step.taskId,
      taskWorkspaceId,
      status: STEP_STATUS_TO_DISPLAY[step.status],
      title: stepTitle.get(step.stepId) ?? step.result?.title ?? step.stepId,
      phaseName,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs,
      result: step.result,
      error: step.error,
      usage,
      nestedWorkflowRunId: nestedWorkflowEvent?.runId,
      nestedWorkflowName: nestedWorkflowEvent?.name,
      nestedWorkflowStatus: nestedWorkflowEvent?.status,
    };
  });

  const recordedStepKeys = new Set(run.steps.map((step) => `${step.stepId}\0${step.inputHash}`));
  const reservationByStepKey = new Map<
    string,
    {
      first: Extract<WorkflowRunEvent, { type: "agent-step" }>;
      latest: Extract<WorkflowRunEvent, { type: "agent-step" }>;
    }
  >();
  for (const event of events) {
    if (event.type !== "agent-step") {
      continue;
    }
    const key = `${event.stepId}\0${event.inputHash}`;
    if (recordedStepKeys.has(key)) {
      continue;
    }
    const existing = reservationByStepKey.get(key);
    if (existing != null) {
      existing.latest = event;
    } else {
      reservationByStepKey.set(key, { first: event, latest: event });
    }
  }

  for (const reservation of reservationByStepKey.values()) {
    const status = reservation.latest.status === "failed" ? "failed" : "running";
    const errorDetails = reservation.latest.details;
    const error =
      errorDetails != null &&
      typeof errorDetails === "object" &&
      !Array.isArray(errorDetails) &&
      typeof (errorDetails as Record<string, unknown>).error === "string"
        ? (errorDetails as Record<string, string>).error
        : undefined;
    steps.push({
      stepId: reservation.first.stepId,
      status,
      title: reservation.first.title ?? reservation.first.stepId,
      phaseName: phaseAtSequence(reservation.first.sequence),
      startedAt: reservation.first.at,
      completedAt: status === "failed" ? reservation.latest.at : undefined,
      durationMs:
        status === "failed"
          ? Math.max(0, parseTime(reservation.latest.at) - parseTime(reservation.first.at))
          : undefined,
      error,
    });
  }

  // Group steps by phase, preserving declared phase order.
  const stepsByPhase = new Map<string | null, WorkflowStepView[]>();
  for (const step of steps) {
    const bucket = stepsByPhase.get(step.phaseName);
    if (bucket != null) {
      bucket.push(step);
    } else {
      stepsByPhase.set(step.phaseName, [step]);
    }
  }

  const phases: WorkflowPhaseView[] = [];
  for (const name of phaseOrder) {
    const meta = phaseMeta.get(name);
    phases.push(
      buildPhaseView(
        name,
        meta?.label ?? name,
        meta?.detail,
        meta?.details,
        stepsByPhase.get(name) ?? []
      )
    );
  }
  const ungrouped = stepsByPhase.get(null) ?? [];
  if (ungrouped.length > 0) {
    // Steps with no announced phase precede the named phases chronologically. When
    // the run declares no phases at all, this is the sole flat group.
    const label = phaseOrder.length === 0 ? "Steps" : "Other steps";
    phases.unshift(buildPhaseView("", label, undefined, undefined, ungrouped));
  }

  let result: WorkflowResult | null = null;
  let errorMessage: string | null = null;
  for (const event of events) {
    if (event.type === "result") {
      result = event.result;
    } else if (event.type === "error") {
      errorMessage = event.message;
    }
  }

  let usageTotal: WorkflowStepUsage | undefined;
  if (usageByTaskId != null) {
    let tokens = 0;
    let costUsd = 0;
    let hasUsage = false;
    for (const step of steps) {
      if (step.usage == null) {
        continue;
      }
      tokens += step.usage.tokens ?? 0;
      costUsd += step.usage.costUsd ?? 0;
      hasUsage = true;
    }
    if (hasUsage) {
      usageTotal = { tokens, costUsd };
    }
  }

  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    argEntries: deriveArgEntries(run.args),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    phases,
    steps,
    result,
    errorMessage,
    stats: {
      total: steps.length,
      done: steps.filter((step) => step.status === "completed").length,
      running: steps.filter((step) => step.status === "running").length,
      failed: steps.filter((step) => step.status === "failed").length,
      elapsedMs: Math.max(0, parseTime(run.updatedAt) - parseTime(run.createdAt)),
      usage: usageTotal,
    },
  };
}

/**
 * Picks the run the tab should focus by default: the most recently updated
 * active (pending/running/backgrounded) run, else the most recently updated run.
 */
export function selectPrimaryWorkflowRun<
  T extends Pick<WorkflowRunRecord, "id" | "status" | "updatedAt">,
>(runs: readonly T[]): T | null {
  if (runs.length === 0) {
    return null;
  }
  const active = runs.filter((run) => isActiveWorkflowRunStatus(run.status));
  const pool = active.length > 0 ? active : runs;
  return [...pool].sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))[0] ?? null;
}
