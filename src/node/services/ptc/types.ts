/**
 * Programmatic Tool Calling (PTC) Types
 *
 * Event and result types for the sandboxed JS runtime that enables
 * multi-tool workflows via code execution.
 */

/**
 * Event emitted when a tool call starts within the sandbox.
 */
export interface PTCToolCallStartEvent {
  type: "tool-call-start";
  callId: string; // Unique ID for correlation with end event
  toolName: string;
  args: unknown;
  startTime: number;
}

/**
 * Event emitted when a tool call ends within the sandbox.
 */
export interface PTCToolCallEndEvent {
  type: "tool-call-end";
  callId: string; // Same ID as start event for correlation
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  startTime: number;
  endTime: number;
}

/**
 * Event emitted when console.log/warn/error is called in the sandbox.
 */
export interface PTCConsoleEvent {
  type: "console";
  level: "log" | "warn" | "error";
  args: unknown[];
  timestamp: number;
}

export type PTCEvent = PTCToolCallStartEvent | PTCToolCallEndEvent | PTCConsoleEvent;

/**
 * Record of a tool call made during execution.
 */
export interface PTCToolCallRecord {
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  duration_ms: number;
  /**
   * Kernel-mode (RLM persistent mount) compact-record fields: nested results
   * never enter the model context, so `result` is dropped and replaced by
   * `ok` (did the call succeed) plus `bytes` (serialized size of the
   * suppressed result). The guest already received the full value during
   * execution; its channels for surfacing data are the return value, console
   * output, and `vars`. Absent in ephemeral/RLM-off records, which keep full
   * inline results (byte-identical supplement-mode contract).
   */
  ok?: boolean;
  bytes?: number;
}

/**
 * Record of console output during execution.
 */
export interface PTCConsoleRecord {
  level: "log" | "warn" | "error";
  args: unknown[];
  timestamp: number;
}

/**
 * Result of executing code in the PTC sandbox.
 */
export interface PTCExecutionResult {
  success: boolean;
  /** Final return value from the code (if success) */
  result?: unknown;
  /** Error message (if !success) */
  error?: string;
  /** Tool calls made during execution (for partial results on failure) */
  toolCalls: PTCToolCallRecord[];
  /** Console output captured during execution */
  consoleOutput: PTCConsoleRecord[];
  /** Total execution time in milliseconds */
  duration_ms: number;
}
