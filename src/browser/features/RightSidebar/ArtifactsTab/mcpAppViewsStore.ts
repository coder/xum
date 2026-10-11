import { useSyncExternalStore } from "react";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { DisplayedMessage } from "@/common/types/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { mcpToolDisplayName } from "@/common/utils/mcp/mcpToolDisplayName";
import { getNestedToolStatus } from "@/browser/features/Tools/Shared/toolUtils";

/**
 * MCP Apps views (artifacts experiment), per workspace, for app tabs and the command palette:
 * every settled view-declaring tool call in the loaded transcript, so a restored tab resolves
 * its view after a reload. Views opened from cards outside the loaded transcript window are
 * kept in a session-only list on top. The view resource and result are re-fetched from the backend
 * whenever a view mounts; listing a view never calls the tool again.
 */
export interface McpAppViewRef {
  toolCallId: string;
  serverName: string;
  resourceUri: string;
  toolName: string;
  /** Tool title (or name) shown in the tab label. */
  label: string;
  arguments: unknown;
  /** The call was interrupted or failed: the view gets tool-cancelled instead of a result. */
  cancelled: boolean;
  /** The call returned an error (a subset of `cancelled`). */
  failed: boolean;
}

/** The view key of an app view (its app tab is "app:<viewKey>"). */
export const MCP_APP_SELECTION_PREFIX = "mcp-app:";

export function mcpAppSelectionKey(toolCallId: string): string {
  return `${MCP_APP_SELECTION_PREFIX}${toolCallId}`;
}

/** The tool call of a view key, or null for anything else. */
export function toolCallIdFromMcpAppKey(key: string): string | null {
  return key.startsWith(MCP_APP_SELECTION_PREFIX) && key.length > MCP_APP_SELECTION_PREFIX.length
    ? key.slice(MCP_APP_SELECTION_PREFIX.length)
    : null;
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
 * Transcript views, newest first. The messages array changes on every stream delta; the list
 * keeps its identity until the set of views really changes, which useSyncExternalStore needs
 * and which spares the panel a re-render per delta. Messages arrays are held only weakly, and
 * a workspace's last list is dropped once the store no longer has the workspace.
 */
const viewsByMessages = new WeakMap<readonly DisplayedMessage[], readonly McpAppViewRef[]>();
const lastTranscriptViews = new Map<string, readonly McpAppViewRef[]>();

export function transcriptViews(
  workspaceId: string,
  messages: readonly DisplayedMessage[]
): readonly McpAppViewRef[] {
  const known = viewsByMessages.get(messages);
  if (known !== undefined) return known;
  const views: McpAppViewRef[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type !== "tool") continue;
    // MCP tools called from code_execution render as nested cards with their own views.
    const nested = message.nestedCalls ?? [];
    for (let j = nested.length - 1; j >= 0; j--) {
      const call = nested[j];
      const view = mcpAppViewRefFor({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.input,
        // The status its nested card shows (NestedToolsContainer).
        status: getNestedToolStatus(
          call.state,
          call.output,
          message.status === "interrupted",
          call.failed
        ),
        mcpServer: call.mcpServer,
      });
      if (view != null) views.push(view);
    }
    const view = mcpAppViewRefFor(message);
    if (view != null) views.push(view);
  }
  const previous = lastTranscriptViews.get(workspaceId);
  const stable = previous !== undefined && sameViews(previous, views) ? previous : views;
  viewsByMessages.set(messages, stable);
  lastTranscriptViews.set(workspaceId, stable);
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
    () => {
      if (store.hasRegisteredWorkspace(workspaceId)) {
        return transcriptViews(workspaceId, store.getWorkspaceState(workspaceId).messages);
      }
      lastTranscriptViews.delete(workspaceId);
      return EMPTY;
    }
  );
  return mergeViews(fromTranscript, opened);
}

/**
 * One view of the workspace: the ref, null when the workspace has no such view (any more), or
 * "loading" while the transcript is not loaded yet (a tab restored after a reload).
 */
export function useMcpAppView(
  workspaceId: string,
  toolCallId: string
): McpAppViewRef | null | "loading" {
  const store = useWorkspaceStoreRaw();
  const views = useMcpAppViews(workspaceId);
  const loading = useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () =>
      !store.hasRegisteredWorkspace(workspaceId) ||
      store.getWorkspaceState(workspaceId).loading ||
      store.getWorkspaceState(workspaceId).isHydratingTranscript
  );
  const view = views.find((v) => v.toolCallId === toolCallId) ?? null;
  return view ?? (loading ? "loading" : null);
}

/**
 * Open a view in its own right-sidebar tab, or focus the tab it already has (RightSidebar and,
 * on small viewports, WorkspaceMenuBar's sheet handle OPEN_MCP_APP_VIEW). The ref is kept for
 * the session so a view from outside the loaded transcript window still resolves.
 */
export function openMcpAppViewTab(workspaceId: string, view: McpAppViewRef) {
  const current = getMcpAppViews(workspaceId).filter((v) => v.toolCallId !== view.toolCallId);
  viewsByWorkspace.set(workspaceId, [view, ...current]);
  emit();
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_MCP_APP_VIEW, { workspaceId, toolCallId: view.toolCallId })
  );
}

/**
 * Where a view is mounted outside its tool card: its app tab, or the phone sheet standing in
 * for that tab. Counted per workspace, tool call and host, so every place that can show a
 * view yields to the others and at most one live instance runs. "card" is an expanded tool
 * card, which shows the view (inline) whenever no tab or sheet has it.
 */
export type McpAppViewHost = "tab" | "sheet" | "card";
const hostedViews = new Map<string, number>();
const hostedKey = (workspaceId: string, toolCallId: string, host: McpAppViewHost) =>
  `${workspaceId}\u0000${toolCallId}\u0000${host}`;

/** Mark a view hosted while that host's frame is mounted; returns the unmark. */
export function markMcpAppViewHosted(
  workspaceId: string,
  toolCallId: string,
  host: McpAppViewHost
): () => void {
  const key = hostedKey(workspaceId, toolCallId, host);
  hostedViews.set(key, (hostedViews.get(key) ?? 0) + 1);
  emit();
  return () => {
    const left = (hostedViews.get(key) ?? 1) - 1;
    if (left > 0) hostedViews.set(key, left);
    else hostedViews.delete(key);
    emit();
  };
}

export function isMcpAppViewHosted(
  workspaceId: string,
  toolCallId: string,
  host: McpAppViewHost
): boolean {
  return hostedViews.has(hostedKey(workspaceId, toolCallId, host));
}

export function useMcpAppViewHostedBy(
  workspaceId: string,
  toolCallId: string,
  hosts: readonly McpAppViewHost[]
): boolean {
  return useSyncExternalStore(subscribe, () =>
    hosts.some((host) => isMcpAppViewHosted(workspaceId, toolCallId, host))
  );
}
