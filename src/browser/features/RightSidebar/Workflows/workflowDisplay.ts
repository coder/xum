/**
 * Presentation helpers for the Workflows tab: status → label/tone mapping, tone
 * → token color, and the small formatters the run header / timeline share.
 * Pure (no JSX) so it can be imported anywhere and unit tested.
 */
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import type { WorkflowRunStatus } from "@/common/types/workflow";
import type { WorkflowStepDisplayStatus } from "./projectWorkflowRun";

export type WorkflowTone = "muted" | "running" | "warning" | "success" | "destructive";

export interface WorkflowStatusMeta {
  label: string;
  tone: WorkflowTone;
}

export const WORKFLOW_STATUS_META: Record<WorkflowRunStatus, WorkflowStatusMeta> = {
  pending: { label: "Pending", tone: "muted" },
  running: { label: "Running", tone: "running" },
  backgrounded: { label: "Backgrounded", tone: "warning" },
  interrupted: { label: "Interrupted", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
};

/**
 * Tone → CSS custom property. Colored chrome (pills, status dots, rail nodes)
 * uses these vars directly via inline style / color-mix so the accent reads
 * correctly across themes — never hardcoded hex.
 */
export const WORKFLOW_TONE_VAR: Record<WorkflowTone, string> = {
  muted: "var(--color-muted)",
  running: "var(--color-accent)",
  warning: "var(--color-warning)",
  success: "var(--color-success)",
  destructive: "var(--color-danger)",
};

export function getWorkflowStepTone(status: WorkflowStepDisplayStatus): WorkflowTone {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    case "interrupted":
      return "warning";
  }
}

/** "12s" / "1m 12s"; em dash when unknown. */
export function formatWorkflowDuration(ms: number | null | undefined): string {
  if (ms == null) {
    return "—";
  }
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}

/** Compact token count: 9.2k / 41k. */
export function formatWorkflowTokens(tokens: number | null | undefined): string {
  if (tokens == null) {
    return "—";
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  }
  return String(tokens);
}

export function formatWorkflowCost(costUsd: number | null | undefined): string {
  if (costUsd == null) {
    return "—";
  }
  if (costUsd > 0 && costUsd < 0.01) {
    return "$<0.01";
  }
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Auto-surface gate for the Workflows tab: activate only when a mounted
 * workspace transitions from zero to some active runs. A `null` previous count
 * means "first observation" (workspace open / remount) — activating there
 * would steal the user's persisted tab choice every time they visit a
 * workspace with a run already in flight.
 */
export function shouldAutoActivateWorkflowsTab(
  previousActiveRunCount: number | null,
  activeRunCount: number
): boolean {
  return previousActiveRunCount === 0 && activeRunCount > 0;
}

/** Coarse relative time for run-history rows ("just now" / "5m ago" / "3h ago" / "2d ago"). */
export function formatWorkflowTimeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Whether a report's markdown is worth rendering. Schema-shaped agent reports
 * carry only `structuredOutput` plus a placeholder markdown for backend
 * compatibility — rendering that placeholder would be noise, so suppress it when
 * structured output is present. Mirrors WorkflowRunToolCall's gating.
 */
export function hasDisplayableWorkflowReport(
  reportMarkdown: string | null | undefined,
  hasStructuredOutput: boolean
): reportMarkdown is string {
  if (reportMarkdown == null) {
    return false;
  }
  const trimmed = reportMarkdown.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !(trimmed === STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN && hasStructuredOutput);
}

/** Structured-output entries that are safe to render as compact stat chips. */
export function workflowStructuredOutputEntries(
  structuredOutput: unknown
): Array<{ key: string; value: string }> {
  if (
    structuredOutput == null ||
    typeof structuredOutput !== "object" ||
    Array.isArray(structuredOutput)
  ) {
    return [];
  }
  const entries: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(structuredOutput as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      entries.push({ key, value: String(value) });
    }
  }
  return entries;
}
