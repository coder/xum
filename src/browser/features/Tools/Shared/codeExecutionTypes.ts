/**
 * Shared types for code_execution tool UI components.
 *
 * These mirror the backend PTCExecutionResult/PTCConsoleRecord shapes
 * but are defined separately to avoid browser → node imports.
 */

import type { DisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";

/** Console output record from code execution */
export interface ConsoleRecord {
  level: "log" | "warn" | "error";
  args: unknown[];
  timestamp: number;
}

/** Record of a tool call made during code execution */
export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  duration_ms: number;
  /** RLM kernel-mode compact record (r12): result suppressed, summary only. */
  ok?: boolean;
  bytes?: number;
}

/** Result of code execution (matches PTCExecutionResult) */
export interface CodeExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  toolCalls: ToolCallRecord[];
  consoleOutput: ConsoleRecord[];
  duration_ms: number;
  /** Attachment parts re-attached from nested tool results (e.g.
   * attach_file). Media is delivered to the model as real attachments;
   * display_file parts are user-preview-only. Both render on this card
   * (nested results only carry a stub for the bytes). */
  attachments?: Array<
    { type: "media"; data: string; mediaType: string; filename?: string } | DisplayOnlyFilePart
  >;
}

/** Nested tool call shape from streaming aggregator */
export interface NestedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  state: "input-available" | "output-available" | "output-redacted";
  failed?: boolean;
  timestamp?: number;
}
