import type { StreamErrorType } from "@/common/types/errors";
import type {
  StreamAbortEvent,
  StreamEndEvent,
  StreamStartEvent,
  ToolCallEndEvent,
} from "@/common/types/stream";
import { coerceAgentStatus, type ExtensionAgentStatus } from "@/node/utils/extensionMetadata";

// Runtime guards for EventEmitter payloads (aiService, initStateManager): listeners receive
// `unknown`, so WorkspaceService checks the fields it reads before trusting an event.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isWorkspaceEvent(value: unknown): value is { workspaceId: string } {
  return isObject(value) && "workspaceId" in value && typeof value.workspaceId === "string";
}

export function isStreamStartEvent(value: unknown): value is StreamStartEvent {
  return (
    isWorkspaceEvent(value) &&
    "model" in value &&
    typeof (value as { model: unknown }).model === "string"
  );
}

/** `metadata` is optional, but when present it must be an object. */
export function isStreamEndEvent(value: unknown): value is StreamEndEvent {
  return (
    isWorkspaceEvent(value) &&
    (!("metadata" in (value as Record<string, unknown>)) ||
      isObject((value as StreamEndEvent).metadata))
  );
}

export function isStreamAbortEvent(value: unknown): value is StreamAbortEvent {
  return isWorkspaceEvent(value);
}

export function isStreamErrorEvent(
  value: unknown
): value is { workspaceId: string; error: string; errorType?: StreamErrorType } {
  return (
    isWorkspaceEvent(value) &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

export function isToolCallEndEvent(value: unknown): value is ToolCallEndEvent {
  return (
    isWorkspaceEvent(value) &&
    "toolName" in value &&
    typeof (value as { toolName: unknown }).toolName === "string" &&
    "result" in value
  );
}

export function isSuccessfulToolResult(result: unknown): result is { success: true } {
  return isObject(result) && result.success === true;
}

/** The agent status a successful `status_set` result carries, or null. */
export function statusSetResultStatus(result: unknown): ExtensionAgentStatus | null {
  return isObject(result) && result.success === true ? coerceAgentStatus(result) : null;
}
