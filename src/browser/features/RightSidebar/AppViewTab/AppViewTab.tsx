import { useEffect } from "react";
import { AppWindow } from "lucide-react";
import { mcpServerDisplayName } from "@/common/utils/mcp/pluginServerKey";
import { McpAppFrame } from "../ArtifactsTab/McpAppFrame";
import {
  markMcpAppViewHosted,
  openMcpAppViewTab,
  useMcpAppView,
  type McpAppViewRef,
} from "../ArtifactsTab/mcpAppViewsStore";
import { Notice } from "../ArtifactsTab/SourceText";

/**
 * Shown where a view would otherwise mount a second live instance (its tool card, Artifacts)
 * while it lives elsewhere: "Go to tab" opens or focuses the view's tab.
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

/** Tab strip label of an app tab: the tool's title (or name), then its server. */
export function AppViewTabLabel(props: { workspaceId: string; toolCallId: string | null }) {
  const view = useMcpAppView(props.workspaceId, props.toolCallId ?? "");
  const ref = typeof view === "object" ? view : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AppWindow className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{ref?.label ?? "App view"}</span>
      {ref != null && (
        <span className="text-muted shrink-0 text-[10px]">
          {mcpServerDisplayName(ref.serverName)}
        </span>
      )}
    </span>
  );
}

/** Tab tooltip of an app tab: the label and the full server key (the label shows its short form). */
export function AppViewTabTooltip(props: { workspaceId: string; toolCallId: string | null }) {
  const view = useMcpAppView(props.workspaceId, props.toolCallId ?? "");
  const ref = typeof view === "object" ? view : null;
  return ref == null ? null : (
    <span className="wrap-anywhere">
      {ref.label} · {ref.serverName}
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
  const view = useMcpAppView(props.workspaceId, props.toolCallId ?? "");
  const { workspaceId, toolCallId } = props;
  useEffect(() => {
    if (toolCallId == null) return;
    return markMcpAppViewHosted(workspaceId, toolCallId, "tab");
  }, [workspaceId, toolCallId]);
  if (view === "loading") return <Notice>Loading…</Notice>;
  if (view == null) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-xs">
        <span className="text-muted">This view is no longer available.</span>
        <button
          type="button"
          onClick={props.onClose}
          className="border-border-light focus-visible:ring-accent rounded border px-2 py-0.5 focus-visible:ring-1"
        >
          Close
        </button>
      </div>
    );
  }
  return (
    <McpAppFrame
      // A new tool call is a new document.
      key={view.toolCallId}
      workspaceId={props.workspaceId}
      view={view}
      onClose={props.onClose}
    />
  );
}
