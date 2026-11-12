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

/**
 * The nested calls a script shows: all of them once the user asks, else the latest few plus every
 * earlier call the cut must not hide:
 *  - A call that has not finished. It may be waiting for the user (its row holds the approval
 *    card and its shortcuts).
 *  - A call that carries an MCP App view. The view is something the user works in, and cutting
 *    its row while the script makes more calls would unmount a view the user has open. The work
 *    line keeps such a script in the conversation for the same reason (see showsAppView).
 * `hiddenCount` is how many calls sit behind "Show N earlier".
 */
export function selectVisibleNestedCalls<
  T extends { state: string; mcpServer?: { app?: unknown } },
>(calls: T[], showAll: boolean): { visible: T[]; hiddenCount: number } {
  const firstRecent = Math.max(0, calls.length - COLLAPSED_NESTED_CALL_LIMIT);
  if (showAll || firstRecent === 0) {
    return { visible: calls, hiddenCount: 0 };
  }
  const visible = calls.filter(
    (call, index) =>
      index >= firstRecent || call.state === "input-available" || call.mcpServer?.app != null
  );
  return { visible, hiddenCount: calls.length - visible.length };
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
