import { useEffect } from "react";
import { AppWindow } from "lucide-react";
import { mcpServerDisplayName } from "@/common/utils/mcp/pluginServerKey";
import { McpAppFrame } from "../ArtifactsTab/McpAppFrame";
import {
  appViewDetails,
  appViewServerNames,
  markMcpAppViewHosted,
  openMcpAppViewTab,
  reloadMcpAppView,
  useMcpAppView,
  useMcpAppViewLookupFailed,
  useMcpAppViewReloadKey,
  useMcpAppViews,
  type McpAppViewRef,
} from "../ArtifactsTab/mcpAppViewsStore";
import { Notice } from "../ArtifactsTab/SourceText";
import { withEntrypointScope } from "./mcpAppEntrypoints";

/**
 * Shown where a view would otherwise mount a second live instance (its tool card, a tab the
 * hidden sidebar keeps) while it lives elsewhere: "Go to tab" opens or focuses the view's tab.
 */
export function AppViewInTabNotice(props: { workspaceId: string; view: McpAppViewRef }) {
  return (
    <div className="border-border-light text-muted flex items-center gap-2 rounded border px-3 py-2 text-xs">
      <AppWindow className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Open in tab</span>
      <button
        type="button"
        onClick={() => openMcpAppViewTab(props.workspaceId, props.view)}
        className="border-border-light text-foreground focus-visible:ring-accent rounded border px-2 py-0.5 focus-visible:ring-1"
      >
        Go to tab
      </button>
    </div>
  );
}

/** Whether another view of the workspace shows the same label and short server name. */
function sharesLabel(views: readonly McpAppViewRef[], ref: McpAppViewRef): boolean {
  // Compared by what the label shows: two plugin installs share a short server name.
  return views.some(
    (v) =>
      v.toolCallId !== ref.toolCallId &&
      v.label === ref.label &&
      mcpServerDisplayName(v.serverName) === mcpServerDisplayName(ref.serverName)
  );
}

/** The server and detail parts of a view's tab label; `index` is its place in `views`. */
function tabTextOf(views: readonly McpAppViewRef[], ref: McpAppViewRef, index: number) {
  if (index < 0) {
    return { server: ref.serverLabel ?? mcpServerDisplayName(ref.serverName), detail: "" };
  }
  return {
    server: appViewServerNames(views)[index],
    detail: sharesLabel(views, ref) ? appViewDetails(views)[index] : "",
  };
}

/**
 * Tab strip label of an app tab: the tool's title (or name), then its server. When another view
 * of the workspace reads the same, the call's detail (outcome, arguments, `#n`) follows, so tabs
 * of several calls of one tool stay apart. The tooltip shows the same detail.
 */
function useAppViewTabText(workspaceId: string, toolCallId: string | null) {
  const view = useMcpAppView(workspaceId, toolCallId ?? "");
  const views = useMcpAppViews(workspaceId);
  const ref = typeof view === "object" ? view : null;
  if (ref == null) return { ref, server: "", detail: "" };
  const index = views.findIndex((v) => v.toolCallId === ref.toolCallId);
  return { ref, ...tabTextOf(views, ref, index) };
}

export function AppViewTabLabel(props: { workspaceId: string; toolCallId: string | null }) {
  const { ref, server, detail } = useAppViewTabText(props.workspaceId, props.toolCallId);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AppWindow className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{ref?.label ?? "App view"}</span>
      {ref != null && (
        <span className="text-muted shrink-0 text-[10px]">
          {withEntrypointScope(server, ref.entrypointType)}
        </span>
      )}
      {detail !== "" && <span className="text-muted min-w-0 truncate text-[10px]">{detail}</span>}
    </span>
  );
}

/**
 * Tab tooltip of an app tab: the label, the full server key (the label shows its short form),
 * and the call's detail when the label has one, which a narrow tab cuts off.
 */
export function AppViewTabTooltip(props: { workspaceId: string; toolCallId: string | null }) {
  const { ref, detail } = useAppViewTabText(props.workspaceId, props.toolCallId);
  return ref == null ? null : (
    <span className="wrap-anywhere">
      {ref.label} · {withEntrypointScope(ref.serverLabel ?? ref.serverName, ref.entrypointType)}
      {detail !== "" && ` · ${detail}`}
    </span>
  );
}

/**
 * The body of an app tab: the view, mounted again from
 * the result store after a reload, or a short unavailable state when the workspace no longer
 * has the view. While mounted it counts as the view's live instance, so its tool card shows a
 * placeholder instead of a second frame.
 */
export function AppViewTabPanel(props: {
  workspaceId: string;
  toolCallId: string | null;
  onClose: () => void;
}) {
  const viewKey = props.toolCallId ?? "";
  const view = useMcpAppView(props.workspaceId, viewKey);
  const reloadKey = useMcpAppViewReloadKey(props.workspaceId, viewKey);
  const lookupFailed = useMcpAppViewLookupFailed(props.workspaceId, viewKey);
  const { workspaceId, toolCallId } = props;
  useEffect(() => {
    if (toolCallId == null) return;
    return markMcpAppViewHosted(workspaceId, toolCallId, "tab");
  }, [workspaceId, toolCallId]);
  if (view === "loading") return <Notice>Loading…</Notice>;
  if (view == null) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-xs">
        <span className="text-muted">
          {lookupFailed ? "This view could not be loaded." : "This view is no longer available."}
        </span>
        <div className="flex gap-2">
          {lookupFailed && (
            // The record request failed (not a missing record): asking again can find the view.
            <button
              type="button"
              onClick={() => reloadMcpAppView(workspaceId, viewKey)}
              className="border-border-light focus-visible:ring-accent rounded border px-2 py-0.5 focus-visible:ring-1"
            >
              Reload
            </button>
          )}
          <button
            type="button"
            onClick={props.onClose}
            className="border-border-light focus-visible:ring-accent rounded border px-2 py-0.5 focus-visible:ring-1"
          >
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <McpAppFrame
      // A new tool call is a new document, and so is a reload (reloadMcpAppView).
      key={`${view.toolCallId}:${reloadKey}`}
      workspaceId={props.workspaceId}
      view={view}
      onClose={props.onClose}
      onReload={() => reloadMcpAppView(props.workspaceId, view.toolCallId)}
    />
  );
}
