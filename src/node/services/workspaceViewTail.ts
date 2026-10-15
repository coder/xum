import { assert } from "@/common/utils/assert";
import {
  formatModelStringForDisplay,
  getModelProvider,
  normalizeToCanonical,
} from "@/common/utils/ai/models";
import type { MuxMessage } from "@/common/types/message";
import type { WorkspaceViewTail, WorkspaceViewTailRow } from "@/common/orpc/schemas/api";
import type { AIService } from "./aiService";
import type { HistoryService } from "./historyService";
import type { WorkspaceService } from "./workspaceService";

/**
 * The read behind `workspace.history.tail` (T3 #5971, Option C): the newest transcript rows for the
 * static first view of `/workspace/<id>`, which an inline early script draws before the app JS
 * loads. That caller runs on every page load, so this read must stay bounded and cheap: one bounded
 * window read of the active epoch (no replay, never getFullReplay), and fixed caps the client
 * cannot raise. The window read enforces the byte cap during its scan, so a huge transcript or one
 * oversized row never builds more than WORKSPACE_VIEW_TAIL_CAPS.maxBytes of rows.
 */
export const WORKSPACE_VIEW_TAIL_CAPS = { maxRows: 40, maxBytes: 256 * 1024 } as const;

// Metadata keys that never change how the live transcript draws a row. Any other key (commands,
// compaction, errors, partial, routing, skill or file snapshots, goal markers) makes the row
// undrawable: the static view then shows nothing rather than something the live app does not.
const keySet = (...lines: string[]) => new Set(lines.join(" ").split(" "));
const SAFE_KEYS = {
  user: keySet(
    "historySequence timestamp toolPolicy disableWorkspaceAgents sendIds sendDigests enqueuedAtMs"
  ),
  assistant: keySet(
    "historySequence requestHistorySequence timestamp model metadataModel agentId mode thinkingLevel",
    "duration ttftMs usage contextUsage providerMetadata contextProviderMetadata systemMessageTokens",
    "costsIncluded toolModelUsages stepStartPartIndices streamFinalized finishReason"
  ),
};

function hasOnlySafeMetadata(message: MuxMessage): boolean {
  const role = message.role;
  if (role === "system") return false;
  const metadata = message.metadata ?? {};
  const safe = Object.keys(metadata).every((key) => SAFE_KEYS[role].has(key));
  // Other finish reasons add a notice under the reply (length, refusal, content filter).
  return safe && (role === "user" || metadata.finishReason === "stop");
}

/** The row's markdown when the static view can draw it like the live transcript, else null. */
function drawableText(message: MuxMessage): string | null {
  if (!hasOnlySafeMetadata(message) || message.parts.length === 0) return null;
  if (!message.parts.every((part) => part.type === "text")) return null;
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return text.trim().length > 0 ? text : null;
}

/** The meta row's model label, formatted as ModelDisplay does, so the client needs no model table. */
function modelLabel(message: MuxMessage): WorkspaceViewTailRow["model"] {
  const model = message.role === "assistant" ? message.metadata?.model : undefined;
  if (!model) return null;
  const canonical = normalizeToCanonical(model);
  return { label: formatModelStringForDisplay(canonical), provider: getModelProvider(canonical) };
}

function toWorkspaceViewTailRow(message: MuxMessage): WorkspaceViewTailRow {
  return {
    id: message.id,
    role: message.role === "system" ? "other" : message.role,
    text: drawableText(message),
    timestamp: message.metadata?.timestamp ?? null,
    model: modelLabel(message),
  };
}

/**
 * Null when there is nothing to draw: an unknown workspace (checked before any history read), a
 * stream in flight or interrupted (the live transcript then ends in a row chat.jsonl lacks), a
 * failed read, or a tail not windowable within the caps (one turn or row larger than them).
 */
export async function readWorkspaceViewTail(
  deps: {
    workspaceService: Pick<WorkspaceService, "getInfo">;
    aiService: Pick<AIService, "isStreaming">;
    historyService: Pick<HistoryService, "getHistoryWindowFromLatestBoundary" | "hasPartial">;
  },
  workspaceId: string
): Promise<WorkspaceViewTail | null> {
  assert(workspaceId.trim().length > 0, "workspaceId is required");
  const info = await deps.workspaceService.getInfo(workspaceId);
  if (!info || deps.aiService.isStreaming(workspaceId)) return null;
  if (await deps.historyService.hasPartial(workspaceId)) return null;
  const window = await deps.historyService.getHistoryWindowFromLatestBoundary(
    workspaceId,
    WORKSPACE_VIEW_TAIL_CAPS
  );
  if (!window.success || window.data.kind !== "window") return null;
  return {
    title: info.title ?? info.name,
    project: info.projectName,
    hasOlder: !window.data.reachedEpochStart,
    rows: window.data.messages.map(toWorkspaceViewTailRow),
  };
}
