import { useEffect, useSyncExternalStore } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { DisplayedMessage } from "@/common/types/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { mcpToolDisplayName } from "@/common/utils/mcp/mcpToolDisplayName";
import { mcpServerConsentName, mcpServerDisplayName } from "@/common/utils/mcp/pluginServerKey";
import { MCP_APP_VIEW_RECORDS_MAX_IDS } from "@/common/utils/mcpApps";
import { getNestedToolStatus } from "@/browser/features/Tools/Shared/toolUtils";
import { escapeControls, NAME_CONTROLS } from "./mcpAppText";

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

/** Longest argument summary shown next to a view's label. */
const SUMMARY_MAX_CHARS = 80;

/**
 * One line naming a call by its arguments (`count: 4, sides: 6`), so the palette and tab labels
 * can tell several views of the same tool apart. Strings show unquoted; other values as JSON.
 * The model writes the arguments, so control and bidi characters show as visible escapes.
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
 * Detail per view (same order), for the command palette and app tab labels: the outcome, the
 * argument summary, and `#n` when two views would otherwise read the same (the same call made
 * twice). `#1` is the oldest, so a number stays with its call as newer calls arrive.
 */
export function appViewDetails(views: readonly McpAppViewRef[]): string[] {
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

/**
 * The server name shown per view (same order), for app tab labels and palette entries. A plugin
 * key shows only its server part, unless another view's different key shows the same: then both
 * keep the plugin's instance marker (`tray (plugin 0123abcd)`), so two installs stay apart.
 */
export function appViewServerNames(views: readonly McpAppViewRef[]): string[] {
  const keysByName = new Map<string, Set<string>>();
  for (const view of views) {
    const name = mcpServerDisplayName(view.serverName);
    keysByName.set(name, (keysByName.get(name) ?? new Set()).add(view.serverName));
  }
  return views.map((view) => {
    const name = mcpServerDisplayName(view.serverName);
    return (keysByName.get(name)?.size ?? 0) > 1 ? mcpServerConsentName(view.serverName) : name;
  });
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
 * Lookups of views the loaded transcript lacks, by workspace and tool call: "pending" while the
 * backend is asked, "missing" when it answered that it has no result record, "failed" when the
 * request failed. Only "missing" is final: a failed lookup runs again the next time a tab asks
 * (it remounts, or the API client reconnects). A found view joins the session list
 * (viewsByWorkspace) and its entry is dropped.
 */
const recordLookups = new Map<string, "pending" | "missing" | "failed">();
const lookupKey = (workspaceId: string, toolCallId: string) => `${workspaceId}\u0000${toolCallId}`;

/**
 * Lookups asked for in the current task, per workspace, sent as one getViewRecords request each
 * at the next microtask: every tab of a restored layout mounts in one render, so one request
 * covers all of them (one IPC call, not one per tab).
 */
const queuedLookups = new Map<string, { api: APIClient; toolCallIds: Set<string> }>();

function lookUpViewRecord(api: APIClient, workspaceId: string, toolCallId: string) {
  const state = recordLookups.get(lookupKey(workspaceId, toolCallId));
  if (state === "pending" || state === "missing") return;
  recordLookups.set(lookupKey(workspaceId, toolCallId), "pending");
  emit();
  if (queuedLookups.size === 0) queueMicrotask(flushViewRecordLookups);
  const queued = queuedLookups.get(workspaceId) ?? { api, toolCallIds: new Set<string>() };
  queued.toolCallIds.add(toolCallId);
  queuedLookups.set(workspaceId, queued);
}

function flushViewRecordLookups() {
  const batches = [...queuedLookups];
  queuedLookups.clear();
  for (const [workspaceId, { api, toolCallIds }] of batches) {
    const ids = [...toolCallIds];
    for (let i = 0; i < ids.length; i += MCP_APP_VIEW_RECORDS_MAX_IDS) {
      requestViewRecords(api, workspaceId, ids.slice(i, i + MCP_APP_VIEW_RECORDS_MAX_IDS));
    }
  }
}

function requestViewRecords(api: APIClient, workspaceId: string, toolCallIds: string[]) {
  const fail = () => {
    for (const id of toolCallIds) recordLookups.set(lookupKey(workspaceId, id), "failed");
    emit();
  };
  // Through a resolved promise, so a client that throws synchronously also counts as failed.
  Promise.resolve()
    .then(() => api.mcpApps.getViewRecords({ workspaceId, toolCallIds }))
    .then((result) => {
      if (!result.success) return fail();
      const found: McpAppViewRef[] = [];
      for (const { toolCallId, view } of result.data) {
        if (!toolCallIds.includes(toolCallId)) continue;
        if (view === null) {
          recordLookups.set(lookupKey(workspaceId, toolCallId), "missing");
          continue;
        }
        recordLookups.delete(lookupKey(workspaceId, toolCallId));
        found.push({
          toolCallId,
          serverName: view.serverName,
          resourceUri: view.resourceUri,
          toolName: view.toolName,
          label: mcpToolDisplayName(view.toolName, { key: view.serverName }),
          arguments: view.arguments ?? {},
          // The record does not say how the call ended: a call without a result opens with
          // "Result no longer available" instead of tool-cancelled.
          cancelled: false,
          failed: false,
        });
      }
      // An ID the answer left out was not looked up: it can be asked again.
      for (const id of toolCallIds) {
        if (recordLookups.get(lookupKey(workspaceId, id)) === "pending") {
          recordLookups.set(lookupKey(workspaceId, id), "failed");
        }
      }
      if (found.length > 0) {
        const ids = new Set(found.map((v) => v.toolCallId));
        const current = getMcpAppViews(workspaceId).filter((v) => !ids.has(v.toolCallId));
        viewsByWorkspace.set(workspaceId, [...current, ...found]);
      }
      emit();
    })
    .catch(fail);
}

/**
 * One view of the workspace: the ref, null when the workspace has no such view (any more), or
 * "loading" while that is not known yet. A tab restored after a reload can name a call outside
 * the loaded transcript (before a compaction boundary, or older than the first history page):
 * once the transcript is loaded without it, the backend's result record decides.
 */
export function useMcpAppView(
  workspaceId: string,
  toolCallId: string
): McpAppViewRef | null | "loading" {
  const store = useWorkspaceStoreRaw();
  const { api } = useAPI();
  const views = useMcpAppViews(workspaceId);
  const loading = useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () =>
      !store.hasRegisteredWorkspace(workspaceId) ||
      store.getWorkspaceState(workspaceId).loading ||
      store.getWorkspaceState(workspaceId).isHydratingTranscript
  );
  const view = views.find((v) => v.toolCallId === toolCallId) ?? null;
  const lookup = useSyncExternalStore(subscribe, () =>
    recordLookups.get(lookupKey(workspaceId, toolCallId))
  );
  const lookUp = view === null && !loading && toolCallId !== "" && api != null;
  // Fetching from the backend is an external side effect, so an effect, not render.
  useEffect(() => {
    if (lookUp) lookUpViewRecord(api, workspaceId, toolCallId);
  }, [lookUp, api, workspaceId, toolCallId]);
  if (view !== null) return view;
  // A failed lookup shows as unavailable until it is retried.
  return loading || (lookUp && lookup !== "missing" && lookup !== "failed") ? "loading" : null;
}

/**
 * Open a view in its own right-sidebar tab, or focus the tab it already has (RightSidebar handles
 * OPEN_MCP_APP_VIEW, and on small viewports WorkspaceMenuBar shows that tab in the full-screen
 * sidebar). The ref is kept for the session so a view from outside the loaded transcript window
 * still resolves.
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
 * Where a view is mounted outside its tool card: its app tab (also on phones, where the sidebar
 * shows full-screen). Counted per workspace and tool call, so every place that can show a view
 * yields to it and at most one live instance runs.
 */
export type McpAppViewHost = "tab";
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

export function useMcpAppViewHostedBy(
  workspaceId: string,
  toolCallId: string,
  hosts: readonly McpAppViewHost[]
): boolean {
  return useSyncExternalStore(subscribe, () =>
    hosts.some((host) => hostedViews.has(hostedKey(workspaceId, toolCallId, host)))
  );
}
