import { useSyncExternalStore } from "react";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { DisplayedMessage } from "@/common/types/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { mcpToolDisplayName } from "@/common/utils/mcp/mcpToolDisplayName";
import { readArtifactSelection, writeArtifactSelection } from "./artifactSelection";

/**
 * MCP Apps views (artifacts experiment), per workspace, for the Artifacts tab's "App views"
 * picker group. The group lists every settled view-declaring tool call in the loaded
 * transcript, so views are reachable without first clicking "Open in Artifacts" and after a
 * reload. Views opened from cards outside the loaded transcript window are kept in a
 * session-only list on top. The view resource and result are re-fetched from the backend
 * whenever a view mounts; listing a view never calls the tool again.
 */
export interface McpAppViewRef {
  toolCallId: string;
  serverName: string;
  resourceUri: string;
  toolName: string;
  /** Tool title (or name) shown in the picker. */
  label: string;
  arguments: unknown;
  /** The call was interrupted or failed: the view gets tool-cancelled instead of a result. */
  cancelled: boolean;
  /** The call returned an error (a subset of `cancelled`). */
  failed: boolean;
}

/** Longest argument summary shown next to a view's label. */
const SUMMARY_MAX_CHARS = 80;

/**
 * One line naming a call by its arguments (`count: 4, sides: 6`), so the picker can tell
 * several views of the same tool apart. Strings show unquoted; other values as JSON.
 */
export function summarizeToolArguments(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ")
    .replace(/\s+/g, " ");
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text;
}

/** Artifacts picker value for an app view; file paths never start with this prefix. */
export const MCP_APP_SELECTION_PREFIX = "mcp-app:";

export function mcpAppSelectionKey(toolCallId: string): string {
  return `${MCP_APP_SELECTION_PREFIX}${toolCallId}`;
}

const EMPTY: readonly McpAppViewRef[] = [];
const viewsByWorkspace = new Map<string, readonly McpAppViewRef[]>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMcpAppViews(workspaceId: string): readonly McpAppViewRef[] {
  return viewsByWorkspace.get(workspaceId) ?? EMPTY;
}

/** The fields of a tool call that decide whether, and which, app view it has. */
export interface McpAppToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: string;
  mcpServer?: MCPToolCallDisplay;
}

/**
 * The view of a tool call, or null when the tool declares none or the call has not settled.
 * Only settled calls have one: the view's result (or tool-cancelled) is decided when it opens,
 * so a still-running call would wrongly show "Result no longer available".
 */
export function mcpAppViewRefFor(call: McpAppToolCall): McpAppViewRef | null {
  const app = call.mcpServer?.app;
  if (call.mcpServer == null || app == null) return null;
  const failed = call.status === "failed";
  const cancelled = call.status === "interrupted" || failed;
  if (call.status !== "completed" && !cancelled) return null;
  return {
    toolCallId: call.toolCallId,
    serverName: call.mcpServer.connection.key,
    resourceUri: app.resourceUri,
    toolName: call.toolName,
    label: mcpToolDisplayName(call.toolName, call.mcpServer.connection),
    arguments: call.args ?? {},
    cancelled,
    failed,
  };
}

function sameViews(a: readonly McpAppViewRef[], b: readonly McpAppViewRef[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (view, i) =>
        view.toolCallId === b[i].toolCallId &&
        view.cancelled === b[i].cancelled &&
        view.failed === b[i].failed &&
        view.serverName === b[i].serverName &&
        view.resourceUri === b[i].resourceUri &&
        view.label === b[i].label
    )
  );
}

/**
 * Transcript views per workspace, newest first. The messages array changes on every stream
 * delta; the cached list keeps its identity until the set of views really changes, which
 * useSyncExternalStore needs and which spares the panel a re-render per delta.
 */
const transcriptCache = new Map<
  string,
  { messages: readonly DisplayedMessage[]; views: readonly McpAppViewRef[] }
>();

function transcriptViews(
  workspaceId: string,
  messages: readonly DisplayedMessage[]
): readonly McpAppViewRef[] {
  const cached = transcriptCache.get(workspaceId);
  if (cached?.messages === messages) return cached.views;
  const views: McpAppViewRef[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type !== "tool") continue;
    const view = mcpAppViewRefFor(message);
    if (view != null) views.push(view);
  }
  const stable = cached != null && sameViews(cached.views, views) ? cached.views : views;
  transcriptCache.set(workspaceId, { messages, views: stable });
  return stable;
}

/** Transcript views first (newest first), then opened views the loaded transcript lacks. */
function mergeViews(
  fromTranscript: readonly McpAppViewRef[],
  opened: readonly McpAppViewRef[]
): readonly McpAppViewRef[] {
  if (opened.length === 0) return fromTranscript;
  const known = new Set(fromTranscript.map((view) => view.toolCallId));
  const extra = opened.filter((view) => !known.has(view.toolCallId));
  return extra.length === 0 ? fromTranscript : [...fromTranscript, ...extra];
}

export function useMcpAppViews(workspaceId: string): readonly McpAppViewRef[] {
  const store = useWorkspaceStoreRaw();
  const opened = useSyncExternalStore(subscribe, () => getMcpAppViews(workspaceId));
  const fromTranscript = useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () =>
      store.hasRegisteredWorkspace(workspaceId)
        ? transcriptViews(workspaceId, store.getWorkspaceState(workspaceId).messages)
        : EMPTY
  );
  return mergeViews(fromTranscript, opened);
}

/**
 * Add (or refresh) a view, select it in the Artifacts tab, and ask the layout to reveal the
 * tab (OPEN_MCP_APP_VIEW).
 */
export function openMcpAppView(workspaceId: string, view: McpAppViewRef) {
  const current = getMcpAppViews(workspaceId).filter((v) => v.toolCallId !== view.toolCallId);
  viewsByWorkspace.set(workspaceId, [view, ...current]);
  emit();
  writeArtifactSelection(workspaceId, {
    scope: "artifact",
    path: mcpAppSelectionKey(view.toolCallId),
    version: null,
  });
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_MCP_APP_VIEW, { workspaceId, toolCallId: view.toolCallId })
  );
}

/**
 * Close a view: the panel returns to its files. A view from the transcript stays in the
 * picker (it can be reopened); an opened-only view leaves it.
 */
export function closeMcpAppView(workspaceId: string, toolCallId: string) {
  const next = getMcpAppViews(workspaceId).filter((v) => v.toolCallId !== toolCallId);
  if (next.length === 0) viewsByWorkspace.delete(workspaceId);
  else viewsByWorkspace.set(workspaceId, next);
  emit();
  if (readArtifactSelection(workspaceId).path === mcpAppSelectionKey(toolCallId)) {
    writeArtifactSelection(workspaceId, { scope: "artifact", path: null, version: null });
  }
}
