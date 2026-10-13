// Leaf module: no React, icon or component imports. The eager command palette reaches
// getNestedToolStatus through mcpAppViewsStore, so anything imported here lands in every
// page's first-load JS (#6349). Rendering helpers stay in toolUtils.tsx.

export type ToolStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "interrupted"
  | "backgrounded"
  | "redacted";

/**
 * Determine if a tool output indicates failure.
 * Handles both `{ success: false }` and `{ error: "..." }` shapes.
 * Note: Use isToolErrorResult() when you need type narrowing.
 */
export function isFailedToolOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  if ("success" in output && (output as { success: unknown }).success === false) return true;
  if ("error" in output) return true;
  return false;
}

/**
 * Determine the display status for a nested tool call.
 * - output-available + failure → "failed"
 * - output-available + success → "completed"
 * - input-available + parentInterrupted → "interrupted"
 * - input-available + running → "executing"
 *
 * An explicit `failed` flag wins over shape-derived detection: reload-time
 * reconstruction of RLM kernel-mode records persists no output to sniff, so
 * failure travels out-of-band (never as a synthetic output shape that a real
 * tool result could collide with).
 */
export function getNestedToolStatus(
  state: "input-available" | "output-available" | "output-redacted",
  output: unknown,
  parentInterrupted: boolean,
  failed?: boolean
): ToolStatus {
  if (state === "output-available") {
    return (failed ?? isFailedToolOutput(output)) ? "failed" : "completed";
  }
  if (state === "output-redacted") return failed ? "failed" : "redacted";
  return parentInterrupted ? "interrupted" : "executing";
}
