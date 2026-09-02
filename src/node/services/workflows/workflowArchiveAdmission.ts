import assert from "node:assert/strict";

/**
 * Process-global archive admission pairing for workflow runs.
 *
 * WorkflowService instances are constructed per-request (oRPC routes, the AI workflow tool
 * context, the CLI), so admission state shared with the long-lived WorkspaceService must live
 * at module scope. WorkspaceService registers a guard reporting workspaces an agent-driven
 * archive is currently gating (or that are already archived); workflow start/resume entry
 * points acquire an admission in the same synchronous block that checks the guard. Whichever
 * side runs first is observed by the other: an armed archive gate refuses new workflow
 * admissions, while a held admission (or an in-process runner registered at lease
 * acquisition) is observed by the archive sink via hasInProcessWorkflowWork before it
 * persists archivedAt.
 */

let admissionGuard: ((workspaceId: string) => string | null) | null = null;

const inProcessWorkflowWorkByWorkspace = new Map<string, number>();
// Per-run view of the same admissions, for callers that must not confuse unrelated runs in one
// workspace (startup recovery of a terminal run's children while another run is active).
const inProcessWorkflowWorkByRun = new Map<string, number>();

/** Register the archive-side guard. Returns a refusal message or null when admission is allowed. */
export function setWorkflowArchiveAdmissionGuard(
  guard: (workspaceId: string) => string | null
): void {
  admissionGuard = guard;
}

function incrementCount(counts: Map<string, number>, key: string): () => void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (counts.get(key) ?? 1) - 1;
    if (remaining <= 0) {
      counts.delete(key);
    } else {
      counts.set(key, remaining);
    }
  };
}

function incrementInProcessWorkflowWork(workspaceId: string, runId?: string): () => void {
  assert(workspaceId.length > 0, "workflowArchiveAdmission: workspaceId is required");
  const releaseWorkspace = incrementCount(inProcessWorkflowWorkByWorkspace, workspaceId);
  const releaseRun = runId != null ? incrementCount(inProcessWorkflowWorkByRun, runId) : null;
  return () => {
    releaseWorkspace();
    releaseRun?.();
  };
}

/**
 * Admit a workflow start/resume/retry for this workspace. Throws when an archive gate is
 * armed or the workspace is archived; otherwise counts the admission as in-process workflow
 * work until disposed. Entry points hold the admission across the whole method so the
 * archive sink observes work that has not yet produced a durably active run record.
 */
export function acquireWorkflowArchiveAdmission(workspaceId: string, runId?: string): Disposable {
  const refusal = admissionGuard?.(workspaceId) ?? null;
  if (refusal != null) {
    throw new Error(refusal);
  }
  const release = incrementInProcessWorkflowWork(workspaceId, runId);
  return { [Symbol.dispose]: release };
}

/**
 * Count an in-process workflow runner (lease acquired) as workflow work until released.
 * Registration overlaps the admission that started it (lease acquisition happens while the
 * admission is still held), so coverage is continuous from admission entry to terminal
 * settlement even before the runner durably appends its "running" status.
 */
export function registerInProcessWorkflowRun(workspaceId: string, runId?: string): () => void {
  return incrementInProcessWorkflowWork(workspaceId, runId);
}

/** Whether any workflow admission or in-process runner exists for this workspace. */
export function hasInProcessWorkflowWork(workspaceId: string): boolean {
  return (inProcessWorkflowWorkByWorkspace.get(workspaceId) ?? 0) > 0;
}

/** Whether an admission (resume/retry) or in-process runner exists for this specific run. */
export function hasInProcessWorkflowRun(runId: string): boolean {
  return (inProcessWorkflowWorkByRun.get(runId) ?? 0) > 0;
}
