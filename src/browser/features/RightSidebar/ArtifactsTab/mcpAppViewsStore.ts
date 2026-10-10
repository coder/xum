import { useSyncExternalStore } from "react";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { McpAppPluginView } from "@/common/orpc/schemas/mcpApps";
import type { DisplayedMessage } from "@/common/types/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { mcpToolDisplayName } from "@/common/utils/mcp/mcpToolDisplayName";
import { readArtifactSelection, writeArtifactSelection } from "./artifactSelection";
import { getNestedToolStatus } from "@/browser/features/Tools/Shared/toolUtils";
import { escapeControls, NAME_CONTROLS } from "./mcpAppText";

/**
 * MCP Apps views (artifacts experiment), per workspace, for the Artifacts tab's "App views"
 * picker group. The group lists every settled view-declaring tool call in the loaded
 * transcript, so views are reachable without first clicking "Open in Artifacts" and after a
 * reload. Views opened from cards outside the loaded transcript window are kept in a
 * session-only list on top. The view resource and result are re-fetched from the backend
 * whenever a view mounts; listing a view never calls the tool again.
 */
export interface McpAppViewRef {
  /** Optional so tool card refs stay unchanged; plugin views set "plugin". */
  kind?: "tool";
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

/**
 * A view a plugin declares in its manifest (`contributes.views`), opened from the command
 * palette without a tool call. The renderer knows it only by its plugin view ID: the backend
 * maps that ID to the plugin's server and ui:// resource. `serverKey` (from listPluginViews)
 * is the view's own server for its tools/call.
 */
export interface McpAppPluginViewRef extends McpAppPluginView {
  kind: "plugin";
}

/** Any view the Artifacts tab can show. */
export type McpAppViewEntry = McpAppViewRef | McpAppPluginViewRef;

export function pluginViewRef(view: McpAppPluginView): McpAppPluginViewRef {
  return {
    kind: "plugin",
    pluginViewId: view.pluginViewId,
    title: view.title,
    pluginName: view.pluginName,
    serverName: view.serverName,
    serverKey: view.serverKey,
    // Kept so an open frame refetches after the user enables the view's server.
    enabled: view.enabled,
  };
}

/**
 * Plugin views for the picker: the listed ones (listPluginViews), then opened ones the list
 * lacks (opened from a palette list that has since been refreshed), each once.
 */
export function pluginViewEntries(
  listed: readonly McpAppPluginView[],
  opened: readonly McpAppViewEntry[]
): McpAppPluginViewRef[] {
  const entries = listed.map(pluginViewRef);
  const known = new Set(entries.map(mcpAppViewKey));
  for (const view of opened) {
    if (view.kind === "plugin" && !known.has(mcpAppViewKey(view))) entries.push(view);
  }
  return entries;
}

/** Longest argument summary shown next to a view's label. */
const SUMMARY_MAX_CHARS = 80;

/**
 * One line naming a call by its arguments (`count: 4, sides: 6`), so the picker can tell
 * several views of the same tool apart. Strings show unquoted; other values as JSON. The model
 * writes the arguments, so control and bidi characters show as visible escapes.
 */
export function summarizeToolArguments(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ")
    .replace(/\s+/g, " ");
  const short = text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text;
  return escapeControls(short, NAME_CONTROLS);
}

/**
 * Picker detail per view (same order): the outcome, the argument summary, and `#n` when two
 * views would otherwise read the same (the same call made twice). `#1` is the oldest, so a
 * number stays with its call as newer calls arrive.
 */
export function appViewPickerDetails(views: readonly McpAppViewRef[]): string[] {
  const details = views.map(
    (view) =>
      `${view.failed ? "failed · " : view.cancelled ? "interrupted · " : ""}` +
      summarizeToolArguments(view.arguments)
  );
  const keys = views.map((view, i) => `${view.label}\u0000${view.serverName}\u0000${details[i]}`);
  const total = new Map<string, number>();
  for (const key of keys) total.set(key, (total.get(key) ?? 0) + 1);
  const seen = new Map<string, number>();
  return details.map((detail, i) => {
    const count = total.get(keys[i]) ?? 0;
    if (count < 2) return detail;
    // Views are newest first: the first one met is the newest, number `count`.
    const index = count - (seen.get(keys[i]) ?? 0);
    seen.set(keys[i], (seen.get(keys[i]) ?? 0) + 1);
    return detail === "" ? `#${index}` : `${detail} · #${index}`;
  });
}

/** Artifacts picker value for an app view; file paths never start with this prefix. */
export const MCP_APP_SELECTION_PREFIX = "mcp-app:";
/** Picker value prefix for a plugin view: a different prefix, so no tool call ID can collide. */
export const MCP_PLUGIN_VIEW_SELECTION_PREFIX = "mcp-plugin-view:";

export function mcpAppSelectionKey(toolCallId: string): string {
  return `${MCP_APP_SELECTION_PREFIX}${toolCallId}`;
}

/** A view's identity: its picker value, unique across tool and plugin views. */
export function mcpAppViewKey(view: McpAppViewEntry): string {
  return view.kind === "plugin"
    ? `${MCP_PLUGIN_VIEW_SELECTION_PREFIX}${view.pluginViewId}`
    : mcpAppSelectionKey(view.toolCallId);
}

const EMPTY: readonly McpAppViewEntry[] = [];
const EMPTY_TRANSCRIPT: readonly McpAppViewRef[] = [];
const viewsByWorkspace = new Map<string, readonly McpAppViewEntry[]>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMcpAppViews(workspaceId: string): readonly McpAppViewEntry[] {
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

function transcriptViews(
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
  opened: readonly McpAppViewEntry[]
): readonly McpAppViewEntry[] {
  if (opened.length === 0) return fromTranscript;
  const known = new Set(fromTranscript.map(mcpAppViewKey));
  const extra = opened.filter((view) => !known.has(mcpAppViewKey(view)));
  return extra.length === 0 ? fromTranscript : [...fromTranscript, ...extra];
}

/** Tool views from the transcript plus opened views (tool and plugin), each once. */
export function useMcpAppViews(workspaceId: string): readonly McpAppViewEntry[] {
  const store = useWorkspaceStoreRaw();
  const opened = useSyncExternalStore(subscribe, () => getMcpAppViews(workspaceId));
  const fromTranscript = useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => {
      if (store.hasRegisteredWorkspace(workspaceId)) {
        return transcriptViews(workspaceId, store.getWorkspaceState(workspaceId).messages);
      }
      lastTranscriptViews.delete(workspaceId);
      return EMPTY_TRANSCRIPT;
    }
  );
  return mergeViews(fromTranscript, opened);
}

/**
 * Add (or refresh) a view, select it in the Artifacts tab, and ask the layout to reveal the
 * tab (OPEN_MCP_APP_VIEW).
 */
export function openMcpAppView(workspaceId: string, view: McpAppViewEntry) {
  const key = mcpAppViewKey(view);
  const current = getMcpAppViews(workspaceId).filter((v) => mcpAppViewKey(v) !== key);
  viewsByWorkspace.set(workspaceId, [view, ...current]);
  emit();
  writeArtifactSelection(workspaceId, { scope: "artifact", path: key, version: null });
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_MCP_APP_VIEW, { workspaceId, viewKey: key })
  );
}

/**
 * Close a view: the panel returns to its files. A view from the transcript stays in the
 * picker (it can be reopened); an opened-only view leaves it.
 */
export function closeMcpAppView(workspaceId: string, view: McpAppViewEntry) {
  const key = mcpAppViewKey(view);
  const next = getMcpAppViews(workspaceId).filter((v) => mcpAppViewKey(v) !== key);
  if (next.length === 0) viewsByWorkspace.delete(workspaceId);
  else viewsByWorkspace.set(workspaceId, next);
  emit();
  if (readArtifactSelection(workspaceId).path === key) {
    writeArtifactSelection(workspaceId, { scope: "artifact", path: null, version: null });
  }
}
