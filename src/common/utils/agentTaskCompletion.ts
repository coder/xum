export interface AgentTaskCompletionCandidate {
  taskStatus?:
    | "queued"
    | "starting"
    | "running"
    | "awaiting_report"
    | "interrupted"
    | "reported"
    | null;
  reportedAt?: string | null;
}

/**
 * Self-heal persisted task metadata that still carries a stale interrupted status after a
 * successful report finalization. `reportedAt` is written only during agent_report finalization,
 * but only terminal task states should count as completed so resumed descendants stay visible.
 */
export function hasCompletedAgentReport(value: AgentTaskCompletionCandidate): boolean {
  return (
    value.taskStatus === "reported" ||
    (value.taskStatus === "interrupted" && Boolean(value.reportedAt))
  );
}
