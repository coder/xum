import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AppWindow } from "lucide-react";
import { mcpServerDisplayName } from "@/common/utils/mcp/pluginServerKey";
import { McpAppFrame } from "../ArtifactsTab/McpAppFrame";
import {
  appViewDetails,
  appViewServerNames,
  markMcpAppViewHosted,
  openMcpAppViewTab,
  setMcpAppViewMaximized,
  useMcpAppViewMaximized,
  useMcpAppView,
  useMcpAppViewReloadKey,
  useMcpAppViews,
  type McpAppViewRef,
} from "../ArtifactsTab/mcpAppViewsStore";
import { Notice } from "../ArtifactsTab/SourceText";
import { withEntrypointScope } from "./mcpAppEntrypoints";
import { makeOthersInert } from "@/browser/utils/ui/makeOthersInert";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { refocusFallenFocus } from "@/browser/utils/ui/refocusFallenFocus";
import { stopKeyboardPropagation } from "@/browser/utils/events";

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

/**
 * Tab strip label of an app tab: the tool's title (or name), then its server. When another view
 * of the workspace reads the same, the call's detail (outcome, arguments, `#n`) follows, so tabs
 * of several calls of one tool stay apart.
 */
export function AppViewTabLabel(props: { workspaceId: string; toolCallId: string | null }) {
  const view = useMcpAppView(props.workspaceId, props.toolCallId ?? "");
  const views = useMcpAppViews(props.workspaceId);
  const ref = typeof view === "object" ? view : null;
  const index = ref == null ? -1 : views.findIndex((v) => v.toolCallId === ref.toolCallId);
  // Compared by what the label shows: two plugin installs share a short server name.
  const ambiguous =
    ref != null &&
    views.some(
      (v) =>
        v.toolCallId !== ref.toolCallId &&
        v.label === ref.label &&
        mcpServerDisplayName(v.serverName) === mcpServerDisplayName(ref.serverName)
    );
  const detail = ambiguous && index >= 0 ? appViewDetails(views)[index] : "";
  const server =
    ref == null
      ? ""
      : index >= 0
        ? appViewServerNames(views)[index]
        : (ref.serverLabel ?? mcpServerDisplayName(ref.serverName));
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

/** Tab tooltip of an app tab: the label and the full server key (the label shows its short form). */
export function AppViewTabTooltip(props: { workspaceId: string; toolCallId: string | null }) {
  const view = useMcpAppView(props.workspaceId, props.toolCallId ?? "");
  const ref = typeof view === "object" ? view : null;
  return ref == null ? null : (
    <span className="wrap-anywhere">
      {ref.label} · {withEntrypointScope(ref.serverLabel ?? ref.serverName, ref.entrypointType)}
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
    <MaximizablePanel workspaceId={props.workspaceId} toolCallId={view.toolCallId}>
      {(maximized, setMaximized) => (
        <McpAppFrame
          // A new tool call is a new document, and so is a reload (reloadMcpAppView).
          key={`${view.toolCallId}:${reloadKey}`}
          workspaceId={props.workspaceId}
          view={view}
          onClose={props.onClose}
          maximized={maximized}
          onToggleMaximized={() => setMaximized(!maximized)}
          // Keys inside the frame never reach the panel's onKeyDown: the frame forwards them.
          onExitKey={() => setMaximized(false)}
        />
      )}
    </MaximizablePanel>
  );
}

/**
 * The app tab's box, pinned over the window while maximized (#6165). Pinned in place, not moved
 * into a portal: a portal remounts the frame, which reloads the view and loses its state (the
 * same reason as Artifacts fullscreen). Everything outside goes inert meanwhile, Escape on the
 * panel restores it, and closing the tab restores it too.
 */
function MaximizablePanel(props: {
  workspaceId: string;
  toolCallId: string;
  children: (maximized: boolean, setMaximized: (next: boolean) => void) => ReactNode;
}) {
  const { workspaceId, toolCallId } = props;
  const maximized = useMcpAppViewMaximized(workspaceId, toolCallId);
  const setMaximized = (next: boolean) => setMcpAppViewMaximized(workspaceId, toolCallId, next);
  const panelRef = useRef<HTMLDivElement>(null);
  usePinnedOverWindow(panelRef, maximized, () => setMaximized(false));
  // A closed tab must not come back maximized.
  useEffect(
    () => () => setMcpAppViewMaximized(workspaceId, toolCallId, false),
    [workspaceId, toolCallId]
  );
  return (
    <div
      ref={panelRef}
      data-testid="app-view-tab-panel"
      tabIndex={-1}
      aria-label={maximized ? "Maximized app view" : undefined}
      // While maximized the rest of the window is inert: announce it as a modal dialog, like
      // the Artifacts fullscreen panel.
      role={maximized ? "dialog" : undefined}
      aria-modal={maximized ? true : undefined}
      // The Artifacts fullscreen shortcut toggles it while focus is in the panel (outside the
      // view's frame, which keeps its own keys); Escape restores it.
      onKeyDown={(event) => {
        if (matchesKeybind(event, KEYBINDS.TOGGLE_ARTIFACT_FULLSCREEN)) {
          event.preventDefault();
          setMaximized(!maximized);
        } else if (maximized && event.key === "Escape") {
          event.preventDefault();
          // The panel is not editable, so without this Escape-to-interrupt would also fire.
          stopKeyboardPropagation(event);
          setMaximized(false);
        }
      }}
      // z-[1500] matches the shared Dialog layer (and Artifacts fullscreen), so portaled menus
      // and tooltips stay above it.
      className={
        maximized
          ? "bg-background ios-standalone:top-px fixed inset-0 z-[1500] flex flex-col outline-none"
          : "flex h-full min-h-0 flex-col outline-none"
      }
    >
      {props.children(maximized, setMaximized)}
    </div>
  );
}

/**
 * While `active`, the rest of the window is inert, focus that falls out with a removed node
 * returns to the panel, and the panel leaves the window when it has no box any more (a hidden
 * sidebar would otherwise leave the app inert behind nothing). Focus returns to the panel after.
 */
function usePinnedOverWindow(
  panelRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  onLostBox: () => void
) {
  const lostBox = useRef(onLostBox);
  useEffect(() => {
    lostBox.current = onLostBox;
  });
  useEffect(() => {
    const panel = panelRef.current;
    if (!active || panel == null) return;
    const restore = makeOthersInert(panel);
    panel.focus();
    const stopRefocus = refocusFallenFocus(panel);
    const sizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (panel.getClientRects().length === 0) lostBox.current();
          })
        : null;
    sizeObserver?.observe(panel);
    return () => {
      sizeObserver?.disconnect();
      stopRefocus();
      restore();
      if (panel.isConnected) panel.focus();
    };
  }, [panelRef, active]);
}
