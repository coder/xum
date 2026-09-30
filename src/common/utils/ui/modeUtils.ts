/**
 * Generate runtime-only instructions for plan-like agents.
 *
 * These instructions carry workspace-specific facts that agent specs cannot encode,
 * such as the exact plan file path, whether a plan already exists, and the
 * non-overridable file-edit restrictions enforced by plan mode.
 * Opinionated planning guidance lives in the agent spec so users can override it.
 */
export function getPlanModeInstruction(planFilePath: string, planExists: boolean): string {
  const exactPlanPathRule = planFilePath.startsWith("~/")
    ? "You must use the plan file path exactly as shown (including the leading `~/`); do not expand `~` or use alternate paths that resolve to the same file."
    : "You must use the plan file path exactly as shown; do not rewrite it or use alternate paths that resolve to the same file.";
  const fileStatus = planExists
    ? `A plan file already exists at ${planFilePath}. First, read it to determine if it's relevant to the current request. After any compaction/context reset (when earlier messages are replaced by a summary), re-read the plan before continuing. If the current request is unrelated to the existing plan, delete the file and start fresh. If relevant, make incremental edits using the file_edit_* tools.`
    : `No plan file exists yet. You should create your plan at ${planFilePath} using the file_edit_* tools.`;

  return `Plan file path: ${planFilePath} (MUST use this exact path string for tool calls; do NOT rewrite it into another form, even if it resolves to the same file)

${fileStatus}

Build your plan incrementally by writing to or editing this file.
NOTE: The \`file_edit_*\` tools are locked to the plan file — it is the only file they can modify. ${exactPlanPathRule} You may freely create, rewrite, or delete the plan file itself.

When the plan is ready for user review, call \`propose_plan\`.
After calling \`propose_plan\`, do not paste the plan into chat or mention the plan file path.
`;
}

/**
 * Lightweight plan file context for non-plan modes.
 *
 * We intentionally include only the path (not the contents) to avoid prompt bloat.
 */
export function getPlanFileHint(planFilePath: string, planExists: boolean): string | null {
  if (!planExists) return null;

  return `A plan file exists at: ${planFilePath}. If the plan is already included in the chat history (e.g., after “Replace all chat history with this plan” or a <plan> block from an agent transition), do NOT re-read the plan file. Otherwise, if you are continuing previous work—especially after any compaction/context reset (when earlier messages are replaced by a summary)—read it before proceeding and use it as the source of truth for what remains. If it is unrelated to the current request, ignore it.`;
}
