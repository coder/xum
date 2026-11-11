export type CodeExecutionViewMode = "tools" | "result" | "code" | "console";

interface ResolveCodeExecutionViewModeOptions {
  isComplete: boolean;
  hasToolCalls: boolean;
  noToolCallsDefaultView: Extract<CodeExecutionViewMode, "result" | "code">;
}

/**
 * Nested calls a completed or running execution shows before "Show N earlier": the most recent
 * ones, since the tail is where a long run's progress (or failure) is.
 */
export const COLLAPSED_NESTED_CALL_LIMIT = 4;

/** Count of leading nested calls hidden behind "Show N earlier" (0 when all fit or are shown). */
export function getHiddenNestedCallCount(totalCalls: number, showAll: boolean): number {
  return showAll ? 0 : Math.max(0, totalCalls - COLLAPSED_NESTED_CALL_LIMIT);
}

/**
 * One line of the script for the collapsed header (like Claude Code's `Bash(cmd)`): the first
 * line that is not blank or a comment, so a run with no nested calls still says what it did.
 */
export function getCodePreviewLine(code: string): string {
  for (const rawLine of code.split("\n")) {
    const line = rawLine.trim();
    if (
      line.length === 0 ||
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*")
    ) {
      continue;
    }
    return line;
  }
  return "";
}

export function resolveCodeExecutionViewMode(
  mode: CodeExecutionViewMode,
  options: ResolveCodeExecutionViewModeOptions
): CodeExecutionViewMode {
  if (mode === "tools" && options.isComplete && !options.hasToolCalls) {
    return options.noToolCallsDefaultView;
  }

  return mode;
}
