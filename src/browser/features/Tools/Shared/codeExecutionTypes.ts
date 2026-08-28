export type {
  CodeExecutionConsoleRecord as ConsoleRecord,
  CodeExecutionResult,
  CodeExecutionToolCallRecord as ToolCallRecord,
} from "@/common/types/codeExecution";

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
