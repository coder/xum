import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/common/lib/utils";
import { LazyFeature } from "../LazyFeature/LazyFeature";
import {
  LEFT_SIDEBAR_WIDTH_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getReviewImmersiveKey,
} from "@/common/constants/storage";
import { useResizableSidebar } from "@/browser/hooks/useResizableSidebar";
import { useResizeObserver } from "@/browser/hooks/useResizeObserver";
import { useOpenTerminal } from "@/browser/hooks/useOpenTerminal";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { RightSidebar } from "@/browser/features/RightSidebar/RightSidebar";
import { isWorkspaceRightSidebarHidden } from "@/browser/features/RightSidebar/rightSidebarVisibility";
import type { SidebarMenuItem } from "@/browser/features/RightSidebar/Tabs/tabConfig";
import { useEscapeToDismiss } from "@/browser/hooks/useEscapeToDismiss";
import { PopoverError } from "../PopoverError/PopoverError";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useBackgroundBashError } from "@/browser/contexts/BackgroundBashContext";
import { useWorkspaceShellStatus } from "@/browser/stores/WorkspaceStore";
import { useReviews } from "@/browser/hooks/useReviews";
import type { ReviewNoteData } from "@/common/types/review";
import { ConnectionStatusToast } from "../ConnectionStatusToast/ConnectionStatusToast";
import {
  LEFT_SIDEBAR_COLLAPSED_WIDTH_PX,
  LEFT_SIDEBAR_DEFAULT_WIDTH_PX,
  LEFT_SIDEBAR_MAX_WIDTH_PX,
  LEFT_SIDEBAR_MIN_WIDTH_PX,
} from "@/constants/layout";
import { ChatPane } from "../ChatPane/ChatPane";

// ChatPane uses tailwind `min-w-96`.
const CHAT_PANE_MIN_WIDTH_PX = 384;

const RIGHT_SIDEBAR_DEFAULT_WIDTH_PX = 400;
const RIGHT_SIDEBAR_MIN_WIDTH_PX = 300;
const RIGHT_SIDEBAR_ABS_MAX_WIDTH_PX = 1200;

// Guard against subpixel rounding (e.g. zoom/devicePixelRatio) producing a 1px horizontal
// overflow that would trigger the WorkspaceShell scrollbar.
const RIGHT_SIDEBAR_OVERFLOW_GUARD_PX = 1;

export function estimateWorkspaceShellFallbackWidthPx(args: {
  viewportWidthPx: number;
  isStacked: boolean;
  leftSidebarCollapsed: boolean;
  persistedLeftSidebarWidthPx: unknown;
}): number {
  if (args.isStacked) {
    return args.viewportWidthPx;
  }

  const persistedLeftSidebarWidthPx =
    typeof args.persistedLeftSidebarWidthPx === "number" &&
    Number.isFinite(args.persistedLeftSidebarWidthPx)
      ? args.persistedLeftSidebarWidthPx
      : LEFT_SIDEBAR_DEFAULT_WIDTH_PX;

  const estimatedLeftSidebarWidthPx = args.leftSidebarCollapsed
    ? LEFT_SIDEBAR_COLLAPSED_WIDTH_PX
    : Math.max(
        LEFT_SIDEBAR_MIN_WIDTH_PX,
        Math.min(LEFT_SIDEBAR_MAX_WIDTH_PX, persistedLeftSidebarWidthPx)
      );

  return Math.max(0, args.viewportWidthPx - estimatedLeftSidebarWidthPx);
}

interface WorkspaceShellProps {
  workspaceId: string;
  projectPath: string;
  projectName: string;
  workspaceName: string;
  namedWorkspacePath: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** True if workspace is still being initialized (postCreateSetup or initWorkspace running) */
  isInitializing?: boolean;
}

// lottie-web calls direct `eval`, which stops esbuild from minifying top-level names in any
// chunk that holds it, so keep it off the first load (T3, #5971).
const LoadingAnimation = React.lazy(() =>
  import("../LoadingAnimation/LoadingAnimation").then((m) => ({ default: m.LoadingAnimation }))
);

const WorkspacePlaceholder: React.FC<{
  title: string;
  description?: string;
  className?: string;
  showAnimation?: boolean;
}> = (props) => (
  // `main`: the placeholder stands in for ChatPane, which holds the page's `main` landmark. Each
  // page needs exactly one (Lighthouse landmark-one-main, #5998).
  <main
    className={cn(
      "relative flex flex-1 flex-row bg-surface-primary text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
      props.className
    )}
    style={{ containerType: "inline-size" }}
  >
    <div className="pointer-events-none absolute right-[15px] bottom-[15px] left-[15px] z-[1000] [&>*]:pointer-events-auto">
      <ConnectionStatusToast wrap={false} />
    </div>

    <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center">
      {props.showAnimation && (
        <LazyFeature
          name="Loading animation"
          // Reserves the Lottie SVG's box (419x98 at 150 px wide) so nothing shifts on arrival.
          fallback={<div aria-hidden="true" className="mb-4 aspect-[419/98] w-[150px]" />}
        >
          <LoadingAnimation className="mb-4" />
        </LazyFeature>
      )}
      <h3 className="m-0 mb-2.5 text-base font-medium">{props.title}</h3>
      {props.description && <p className="m-0 text-[13px]">{props.description}</p>}
    </div>
  </main>
);

export const WorkspaceShell: React.FC<WorkspaceShellProps> = (props) => {
  const shellRef = useRef<HTMLDivElement>(null);
  const shellSize = useResizeObserver(shellRef);

  // WorkspaceShell switches to flex-col at this breakpoint, so in that stacked mode the
  // right sidebar doesn't need to "leave room" for ChatPane beside it.
  const isStacked =
    typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;

  const [persistedLeftSidebarWidthPx] = usePersistedState<unknown>(
    LEFT_SIDEBAR_WIDTH_KEY,
    LEFT_SIDEBAR_DEFAULT_WIDTH_PX,
    { listener: true }
  );
  const containerWidthPx = shellSize?.width ?? 0;
  // Before ResizeObserver reports the real shell width, estimate it from the persisted left
  // sidebar width so a wide right sidebar doesn't first paint at a viewport-wide clamp and
  // then visibly snap narrower once the shell is measured.
  const usableWidthPx =
    containerWidthPx > 0
      ? containerWidthPx
      : estimateWorkspaceShellFallbackWidthPx({
          viewportWidthPx: typeof window !== "undefined" ? window.innerWidth : 1200,
          isStacked,
          leftSidebarCollapsed: props.leftSidebarCollapsed,
          persistedLeftSidebarWidthPx,
        });

  // Prevent ChatPane + RightSidebar from overflowing the workspace shell (which would show a
  // horizontal scrollbar due to WorkspaceShell's `overflow-x-auto`).
  const effectiveMaxWidthPx = isStacked
    ? RIGHT_SIDEBAR_ABS_MAX_WIDTH_PX
    : Math.min(
        RIGHT_SIDEBAR_ABS_MAX_WIDTH_PX,
        Math.max(
          RIGHT_SIDEBAR_MIN_WIDTH_PX,
          usableWidthPx - CHAT_PANE_MIN_WIDTH_PX - RIGHT_SIDEBAR_OVERFLOW_GUARD_PX
        )
      );

  const sidebar = useResizableSidebar({
    enabled: true,
    defaultWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH_PX,
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH_PX,
    maxWidth: effectiveMaxWidthPx,
    storageKey: RIGHT_SIDEBAR_WIDTH_KEY,
  });

  const { width: sidebarWidth, isResizing, startResize } = sidebar;
  const addTerminalRef = useRef<((options?: TerminalSessionCreateOptions) => void) | null>(null);
  const openTerminalPopout = useOpenTerminal();
  const handleOpenTerminal = useCallback(
    (options?: TerminalSessionCreateOptions) => {
      // A tab in a hidden right sidebar is invisible, so open a popout instead. The narrow-layout
      // CSS hides the sidebar for any pointer type (a narrow window with a mouse too), so check the
      // sidebar itself rather than a touch-only media query.
      if (isWorkspaceRightSidebarHidden(shellRef.current)) {
        void openTerminalPopout(props.workspaceId, props.runtimeConfig, options);
      } else {
        addTerminalRef.current?.(options);
      }
    },
    [openTerminalPopout, props.workspaceId, props.runtimeConfig]
  );

  const reviews = useReviews(props.workspaceId);
  const { addReview } = reviews;
  const handleReviewNote = useCallback(
    (data: ReviewNoteData) => {
      addReview(data);
    },
    [addReview]
  );

  const workspaceShellStatus = useWorkspaceShellStatus(props.workspaceId);
  const [isReviewImmersive] = usePersistedState(getReviewImmersiveKey(props.workspaceId), false, {
    listener: true,
  });

  // Phones: the narrow layout hides the right sidebar, so the workspace menu lists its tools and
  // opens them in the sidebar itself, shown full-screen. The real sidebar (not a copy in a
  // dialog) keeps its tabs and panel state. Keyed by workspace: a switch closes it for good
  // (render-time reset, so it does not reopen on the way back). Immersive review covers the
  // workspace on its own, so it wins and closes it.
  const [fullscreenSidebarWorkspaceId, setFullscreenSidebarWorkspaceId] = useState<string | null>(
    null
  );
  // Immersive review closes it for good too: it is not reopened once immersive review ends.
  if (
    fullscreenSidebarWorkspaceId !== null &&
    (fullscreenSidebarWorkspaceId !== props.workspaceId || isReviewImmersive)
  ) {
    setFullscreenSidebarWorkspaceId(null);
  }
  const sidebarFullscreen = fullscreenSidebarWorkspaceId === props.workspaceId;
  const openSidebarToolRef = useRef<((tool: SidebarMenuItem) => void) | null>(null);
  // Focus returns here when the full-screen sidebar closes (the menu button, or wherever the
  // shortcut was pressed).
  const fullscreenReturnFocusRef = useRef<HTMLElement | null>(null);
  const openSidebarFullscreen = (returnFocusTo: HTMLElement | null) => {
    fullscreenReturnFocusRef.current = returnFocusTo;
    setFullscreenSidebarWorkspaceId(props.workspaceId);
  };
  const handleOpenSidebarTool = (tool: SidebarMenuItem, returnFocusTo: HTMLElement | null) => {
    openSidebarToolRef.current?.(tool);
    openSidebarFullscreen(returnFocusTo);
  };
  const handleRequestSidebarFullscreen = () => {
    openSidebarFullscreen(
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
  };
  const closeSidebarFullscreen = () => setFullscreenSidebarWorkspaceId(null);
  // Layer 1: the full-screen sidebar is drawn above the narrow-screen drawer (layer 0), so it
  // answers Escape first when both are open.
  useEscapeToDismiss(sidebarFullscreen, closeSidebarFullscreen, 1);
  // After RightSidebar lifts `inert` from the rest of the page (effect cleanups run before
  // effects), so the element can take focus again.
  useEffect(() => {
    if (sidebarFullscreen) return;
    const target = fullscreenReturnFocusRef.current;
    fullscreenReturnFocusRef.current = null;
    if (target?.isConnected) target.focus();
  }, [sidebarFullscreen]);
  // The tools the sidebar's New tab launcher offers (RightSidebar loads their availability),
  // relayed to the workspace menu. An unchanged list keeps the old state, so the chat pane does
  // not re-render.
  const [sidebarTools, setSidebarTools] = useState<{
    workspaceId: string;
    tools: readonly SidebarMenuItem[];
  } | null>(null);
  const handleLauncherToolsChange = (tools: readonly SidebarMenuItem[]) => {
    const workspaceId = props.workspaceId;
    setSidebarTools((prev) =>
      prev?.workspaceId === workspaceId &&
      prev.tools.length === tools.length &&
      prev.tools.every((tool, index) => tool === tools[index])
        ? prev
        : { workspaceId, tools }
    );
  };
  const backgroundBashError = useBackgroundBashError();

  const shouldKeepChatPaneMountedDuringHydration =
    workspaceShellStatus.isHydratingTranscript && !workspaceShellStatus.isStreamStarting;

  // User rationale: a just-created chat should keep showing its startup barrier instead of
  // flashing generic loading/catch-up placeholders before the first send reaches onChat.
  // Keep the chat pane mounted during transcript hydration so the composer does not disappear
  // while a workspace is opening. ChatPane already owns the transcript-level loading placeholder,
  // so swapping the whole shell here causes the vertical tear reproduced in both browser and
  // Electron repros when an unseen workspace is opened.
  if (
    workspaceShellStatus.loading &&
    !workspaceShellStatus.isStreamStarting &&
    !shouldKeepChatPaneMountedDuringHydration
  ) {
    return (
      <WorkspacePlaceholder
        title="Loading workspace..."
        showAnimation
        className={props.className}
      />
    );
  }

  if (!props.projectName || !props.workspaceName) {
    return (
      <WorkspacePlaceholder
        title="No Workspace Selected"
        description="Select a workspace from the sidebar to view and interact with Claude"
        className={props.className}
      />
    );
  }

  return (
    <div
      ref={shellRef}
      // Lets descendants (WorkspaceMenuBar's timeline gate) locate the shell that
      // owns the right-sidebar container query without prop-drilling layout state.
      data-workspace-shell=""
      className={cn(
        "relative flex flex-1 flex-row bg-surface-primary text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
        props.className
      )}
      style={{ containerType: "inline-size" }}
    >
      {/* Keep the transcript viewport mounted across workspace switches so the browser doesn't
          visually tear the pane while the new workspace content hydrates. ChatPane resets its
          per-workspace local UI state internally, and the composer remains keyed by workspaceId. */}
      <ChatPane
        workspaceId={props.workspaceId}
        projectPath={props.projectPath}
        projectName={props.projectName}
        workspaceName={props.workspaceName}
        namedWorkspacePath={props.namedWorkspacePath}
        leftSidebarCollapsed={props.leftSidebarCollapsed}
        onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
        runtimeConfig={props.runtimeConfig}
        onOpenTerminal={handleOpenTerminal}
        immersiveHidden={isReviewImmersive}
        sidebarTools={
          sidebarTools?.workspaceId === props.workspaceId ? sidebarTools.tools : undefined
        }
        onOpenSidebarTool={handleOpenSidebarTool}
        sidebarFullscreen={sidebarFullscreen}
      />

      <RightSidebar
        key={props.workspaceId}
        workspaceId={props.workspaceId}
        workspacePath={props.namedWorkspacePath}
        projectPath={props.projectPath}
        width={sidebarWidth}
        onStartResize={startResize}
        isResizing={isResizing}
        onReviewNote={handleReviewNote}
        isCreating={props.isInitializing === true}
        immersiveHidden={isReviewImmersive}
        addTerminalRef={addTerminalRef}
        fullscreen={sidebarFullscreen}
        onCloseFullscreen={closeSidebarFullscreen}
        onRequestFullscreen={handleRequestSidebarFullscreen}
        openToolRef={openSidebarToolRef}
        onLauncherToolsChange={handleLauncherToolsChange}
      />

      {/* Portal target for immersive review mode overlay */}
      <div
        id="review-immersive-root"
        hidden={!isReviewImmersive}
        className="bg-surface-primary absolute inset-0 z-50"
        data-testid="review-immersive-root"
      />

      <PopoverError
        error={backgroundBashError.error}
        prefix="Failed to terminate:"
        onDismiss={backgroundBashError.clearError}
      />
    </div>
  );
};
