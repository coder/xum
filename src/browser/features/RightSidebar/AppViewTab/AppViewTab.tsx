import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AppWindow } from "lucide-react";
import { mcpServerDisplayName } from "@/common/utils/mcp/pluginServerKey";
import { McpAppFrame } from "../ArtifactsTab/McpAppFrame";
import {
  appViewDetails,
  appViewServerNames,
  markMcpAppViewHosted,
  openMcpAppViewTab,
  reloadMcpAppView,
  setMcpAppViewMaximized,
  useMcpAppViewMaximized,
  useMcpAppView,
  useMcpAppViewLookupFailed,
  useMcpAppViewReloadKey,
  useMcpAppViews,
  type McpAppViewRef,
} from "../ArtifactsTab/mcpAppViewsStore";
import { Notice } from "../ArtifactsTab/SourceText";
import { withEntrypointScope } from "./mcpAppEntrypoints";
import { makeOthersInert } from "@/browser/utils/ui/makeOthersInert";
import {
  KEYBINDS,
  MODAL_DIALOG_OVERLAY_ATTRIBUTE,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
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
      <AppViewUnavailable
        lookupFailed={lookupFailed}
        onReload={() => reloadMcpAppView(workspaceId, viewKey)}
        onClose={props.onClose}
      />
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
          onReload={() => reloadMcpAppView(props.workspaceId, view.toolCallId)}
          maximized={maximized}
          onToggleMaximized={() => setMaximized(!maximized)}
          // Keys inside the frame never reach the panel's onKeyDown: the frame forwards them.
          onExitKey={() => setMaximized(false)}
        />
      )}
    </MaximizablePanel>
  );
}

/** Marks a maximized app tab panel (a modal dialog that belongs to the right sidebar). */
const MAXIMIZED_APP_PANEL_ATTRIBUTE = "data-maximized-app-panel";

/**
 * The maximized app tab panel inside `container`, when it is the only open modal. The panel is a
 * modal dialog (aria-modal), so isDialogOpen() is true while it is up. The sidebar still owns it as
 * its tab, so Cmd/Ctrl+W closes it (#6181). Any other open modal returns null: it keeps the keys.
 */
export function findOwnMaximizedAppPanel(container: Element | null): HTMLElement | null {
  if (container == null) return null;
  if (document.querySelector(`[${MODAL_DIALOG_OVERLAY_ATTRIBUTE}][data-state="open"]`)) return null;
  const modals = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (modals.length !== 1) return null;
  const modal = modals[0];
  return modal.hasAttribute(MAXIMIZED_APP_PANEL_ATTRIBUTE) && container.contains(modal)
    ? modal
    : null;
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
      {...(maximized ? { [MAXIMIZED_APP_PANEL_ATTRIBUTE]: "" } : {})}
      // The Artifacts fullscreen shortcut toggles it while focus is in the panel (outside the
      // view's frame, which keeps its own keys); Escape restores it.
      onKeyDown={(event) => {
        if (matchesKeybind(event, KEYBINDS.TOGGLE_ARTIFACT_FULLSCREEN)) {
          event.preventDefault();
          // A held key auto-repeats: toggle once per press, not on every repeat.
          if (!event.repeat) setMaximized(!maximized);
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

/**
 * An app tab without its view: gone (only Close), or its record lookup failed (Reload too,
 * since asking again can find it).
 */
function AppViewUnavailable(props: {
  lookupFailed: boolean;
  onReload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 p-4 text-xs">
      <span className="text-muted">
        {props.lookupFailed
          ? "This view could not be loaded."
          : "This view is no longer available."}
      </span>
      <div className="flex gap-2">
        {props.lookupFailed && (
          // The record request failed (not a missing record): asking again can find the view.
          <button
            type="button"
            onClick={props.onReload}
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
