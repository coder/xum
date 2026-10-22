import {
  formatModelStringForDisplay,
  getModelProvider,
  normalizeToCanonical,
} from "@/common/utils/ai/models";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import type { MuxMessage } from "@/common/types/message";
import { isPlainObject } from "@/common/utils/isPlainObject";
import type { WorkspaceViewTail, WorkspaceViewTailRow } from "@/common/orpc/schemas/api";
import type { AIService } from "./aiService";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import { isMultiProject } from "@/common/utils/multiProject";
import type { RowTreeClient } from "@/node/orpc/staticWorkspaceView/rowTreeClient";

/**
 * The read behind `workspace.history.tail` (T3 #5971): the newest rows for the static first view of
 * `/workspace/<id>`, drawn by an inline early script on every page load before the app JS. So it
 * must stay bounded and cheap: one window read of the active epoch (no replay, never
 * getFullReplay) with fixed caps the client cannot raise, enforced during the window read's scan.
 */
type ViewModel = WorkspaceViewTailRow["model"];

export const WORKSPACE_VIEW_TAIL_CAPS = { maxRows: 40, maxBytes: 256 * 1024 } as const;

// Metadata keys the current send and stream paths write that never change how the live transcript
// draws a row. Any other key (compaction, errors, partial, skill or file snapshots, goal markers)
// makes the row undrawable: the static view then shows nothing rather than something the live app
// does not. Values that matter are checked below (finish reason, command metadata, route).
const keySet = (...lines: string[]) => new Set(lines.join(" ").split(" "));
const SAFE_KEYS = {
  user: keySet(
    "historySequence timestamp toolPolicy disableWorkspaceAgents sendIds sendDigests enqueuedAtMs",
    "retrySendOptions autoModelRouting muxMetadata"
  ),
  assistant: keySet(
    "historySequence requestHistorySequence timestamp model metadataModel agentId mode thinkingLevel",
    "duration ttftMs usage contextUsage providerMetadata contextProviderMetadata systemMessageTokens",
    "costsIncluded toolModelUsages stepStartPartIndices streamFinalized finishReason stopCause",
    "volatileSystemTail anthropicThinkingReplay anthropicThinkingReplayFromStep routeProvider"
  ),
};

/** A plain send's command metadata. More keys (raw command, skill refs, reviews) change the row. */
const isPlainSend = (value: unknown) =>
  value === undefined ||
  (isPlainObject(value) &&
    value.type === "normal" &&
    Object.keys(value).every((key) => key === "type" || key === "requestedModel"));

function hasOnlySafeMetadata(role: "user" | "assistant", metadata: Record<string, unknown>) {
  if (!Object.keys(metadata).every((key) => SAFE_KEYS[role].has(key))) return false;
  // Other finish reasons add a notice under the reply (length, refusal, content filter).
  if (role === "user") return isPlainSend(metadata.muxMetadata);
  return metadata.finishReason === undefined || metadata.finishReason === "stop";
}

/** The row's markdown when the static view can draw it like the live transcript, else null. */
function drawableText(message: MuxMessage, metadata: Record<string, unknown>): string | null {
  if (message.role === "system" || !hasOnlySafeMetadata(message.role, metadata)) return null;
  const texts = message.parts.map((part) => (part.type === "text" ? part.text : null));
  if (texts.length === 0 || texts.includes(null)) return null;
  const text = texts.join("");
  return text.trim().length > 0 ? text : null;
}

/** The "via …" label ModelDisplay adds when the reply was routed through another provider. */
function routeLabel(metadata: Record<string, unknown>, provider: string): string | null {
  const route = typeof metadata.routeProvider === "string" ? metadata.routeProvider : null;
  if (route == null || route === provider) return null;
  // Own keys only: a damaged row's "constructor" must not resolve to Object.prototype.
  return Object.hasOwn(PROVIDER_DEFINITIONS, route)
    ? PROVIDER_DEFINITIONS[route as ProviderName].displayName
    : route;
}

/** The meta row's model as ModelDisplay draws it (label, icon, route); undefined if damaged. */
function modelDisplay(metadata: Record<string, unknown>): ViewModel | undefined {
  const { model, routeProvider } = metadata;
  if (model === undefined) return null;
  if (typeof model !== "string" || !model) return undefined;
  if (routeProvider !== undefined && typeof routeProvider !== "string") return undefined;
  const canonical = normalizeToCanonical(model);
  const provider = getModelProvider(canonical);
  return {
    label: formatModelStringForDisplay(canonical),
    provider,
    via: routeLabel(metadata, provider),
  };
}

const finiteOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The live row's time: an assistant row's first text part (appendAssistantTextRow), else the message's. */
function rowTimestamp(message: MuxMessage, metadata: Record<string, unknown>): number | null {
  const firstText = message.parts.find((part) => part.type === "text");
  const partTime = message.role === "assistant" ? finiteOrNull(firstText?.timestamp) : null;
  return partTime ?? finiteOrNull(metadata.timestamp);
}

/** Persisted metadata is not validated on read: a damaged field degrades this row, never the tail. */
function toWorkspaceViewTailRow(message: MuxMessage): Omit<WorkspaceViewTailRow, "tree"> {
  const metadata: Record<string, unknown> = isPlainObject(message.metadata) ? message.metadata : {};
  const model = message.role === "assistant" ? modelDisplay(metadata) : null;
  return {
    id: message.id,
    role: message.role === "system" ? "other" : message.role,
    text: model === undefined ? null : drawableText(message, metadata),
    timestamp: rowTimestamp(message, metadata),
    model: model ?? null,
  };
}

/**
 * Null when there is nothing to draw: an unknown workspace (checked before any history read), a
 * stream in flight (the live transcript then ends in a row chat.jsonl lacks), a failed read, a
 * tail not windowable within the caps (one turn or row larger than them), or an interrupted
 * stream's partial.json (#6832).
 */
export async function readWorkspaceViewTail(
  deps: {
    config: Pick<Config, "getWorkspaceMetadataById">;
    aiService: Pick<AIService, "isStreaming">;
    historyService: Pick<
      HistoryService,
      "getHistoryWindowFromLatestBoundary" | "readBoundedPartial"
    >;
    rowTreeClient?: Pick<RowTreeClient, "render">;
  },
  workspaceId: string
): Promise<WorkspaceViewTail | null> {
  // Registry only: a checkout probe can wait seconds on a stalled mount. A multi-project
  // workspace gets no view, which also keeps one that getInfo would hide from showing here.
  const options = { probeCheckouts: false, persistMigrations: false } as const;
  const info = await deps.config.getWorkspaceMetadataById(workspaceId, options);
  if (!info || isMultiProject(info) || deps.aiService.isStreaming(workspaceId)) return null;
  // #6832: after a restart isStreaming() is false, but the live replay still shows an interrupted
  // stream's partial.json, and drops every row that shares its historySequence. So any readable
  // partial (and an oversized one, never parsed) means no view. It is read before the window, as
  // the replay reads it: a commit between the two reads then gives the committed rows, never a
  // stale tail. A malformed partial is null here and in readPartial, so both show the rows.
  const caps = WORKSPACE_VIEW_TAIL_CAPS;
  if ((await deps.historyService.readBoundedPartial(workspaceId, caps.maxBytes)) !== null) {
    return null;
  }
  const window = await deps.historyService.getHistoryWindowFromLatestBoundary(workspaceId, caps);
  if (!window.success || window.data.kind !== "window") return null;
  const rows = window.data.messages.map(toWorkspaceViewTailRow);
  return {
    title: info.title ?? info.name,
    project: info.projectName,
    rows: await withRowTrees(deps.rowTreeClient, workspaceId, rows),
  };
}

/**
 * Each drawable row's element tree, rendered by `xum server`'s row-tree worker with the live
 * markdown components. No client (desktop, CLI), a failed worker or one not ready by the request
 * deadline, and a row the static view cannot draw all give tree: null. The client never throws by contract; the catch keeps a
 * broken worker from ever failing the tail.
 */
async function withRowTrees(
  client: Pick<RowTreeClient, "render"> | undefined,
  workspaceId: string,
  rows: Array<Omit<WorkspaceViewTailRow, "tree">>
): Promise<WorkspaceViewTailRow[]> {
  const drawable = rows.flatMap((row) =>
    row.text !== null && row.role !== "other"
      ? [{ row, text: row.text, isUser: row.role === "user" }]
      : []
  );
  const trees =
    client && drawable.length > 0
      ? await client
          .render(
            workspaceId,
            drawable.map(({ text, isUser }) => ({ text, isUser }))
          )
          .catch(() => [])
      : [];
  const treeOf = new Map(drawable.map(({ row }, i) => [row, trees[i] ?? null]));
  return rows.map((row) => ({ ...row, tree: treeOf.get(row) ?? null }));
}
