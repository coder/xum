import { useTitleEdit } from "@/browser/contexts/WorkspaceTitleEditContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  useContextMenuPosition,
  type UseContextMenuPositionReturn,
} from "@/browser/hooks/useContextMenuPosition";
import {
  getWorkspaceStreamingStatusPhase,
  useWorkspaceStreamingStatusPhase,
} from "@/browser/hooks/useWorkspaceStreamingStatusPhase";
import { useWorkspaceFallbackModel } from "@/browser/hooks/useWorkspaceFallbackModel";
import { useWorkspaceUnread } from "@/browser/hooks/useWorkspaceUnread";
import { useRuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { isEventFromDialogPortal, stopKeyboardPropagation } from "@/browser/utils/events";
import {
  isSidebarSubAgentRunning,
  type AgentRowRenderMeta,
  type WorkspaceDelegatedActivity,
  type WorkspaceSubAgentsSummary,
} from "@/browser/utils/ui/workspaceFiltering";
import assert from "@/common/utils/assert";
import { cn } from "@/common/lib/utils";
import { isDevcontainerRuntime } from "@/common/types/runtime";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useDrag, useDrop } from "react-dnd";
import type { DropTargetMonitor } from "react-dnd";
import { getEmptyImage } from "react-dnd-html5-backend";
import { SubAgentListItem } from "./SubAgentListItem";
import { AvatarCornerIcon, ProjectAvatar } from "./ProjectAvatar";
import {
  LEADING_SLOT_CONTAINER_CLASSES,
  LEADING_SLOT_CONTAINER_STYLE,
  STATUS_DOT_SLOT_CONTAINER_CLASSES,
  AvatarStatusDot,
  StatusDot,
  isStatusDotVisible,
  type VisualState,
} from "./StatusDot";

import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from "../Popover/Popover";
import { PositionedMenu, PositionedMenuItem } from "../PositionedMenu/PositionedMenu";
import {
  getAncestorRailX,
  getSidebarItemPaddingLeft,
  getSubAgentChildStatusCenterX,
  getSubAgentParentRailX,
  type SubAgentConnectorLayout,
} from "../sidebarItemLayout";
import {
  Bot,
  Trash2,
  Trash,
  EllipsisVertical,
  Loader2,
  PenLine,
  MessageCircleQuestionMark,
  ChevronDown,
  HeartPulse,
  Pin,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { isWorkspacePinned } from "@/common/utils/pin";
import { WorkspaceStatusIndicator } from "../WorkspaceStatusIndicator/WorkspaceStatusIndicator";
import { ArchiveIcon } from "../icons/ArchiveIcon/ArchiveIcon";
import { WorkspaceTerminalIcon } from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import {
  WORKSPACE_DRAG_TYPE,
  type WorkspaceDragItem,
} from "../WorkspaceSectionDropZone/WorkspaceSectionDropZone";
import type { PinnedDropEdge } from "@/browser/utils/ui/pinnedReorder";
import { WorkspaceActionsMenuContent } from "../WorkspaceActionsMenuContent/WorkspaceActionsMenuContent";
import { requestGenerateWorkspaceTitle } from "../WorkspaceActionsMenuContent/workspaceActionHandlers";
import { LazyFeature } from "../LazyFeature/LazyFeature";
import { useWorkspaceActionsOptional } from "@/browser/contexts/WorkspaceContext";

// The sidebar is on every page's first load, so its rows load these dialogs only when one opens
// (#6202, the first-load split of #6206). The open state stays outside the lazy module.
const RowSettingsDialog = React.lazy(async () => ({
  default: (await import("./RowSettingsDialog")).RowSettingsDialog,
}));

export interface WorkspaceSelection {
  projectPath: string;
  projectName: string;
  namedWorkspacePath: string; // Worktree path (directory uses workspace name)
  workspaceId: string;
}

/** Props for draft workspace rendering (UI-only placeholders) */
export interface DraftWorkspaceData {
  draftId: string;
  draftNumber: number;
  /** Title derived from draft name state */
  title: string;
  /** Collapsed prompt preview text */
  promptPreview: string;
  onOpen: () => void;
  onDelete: () => void;
}

/** Base props shared by both workspace and draft items */
interface AgentListItemBaseProps {
  projectPath: string;
  isSelected: boolean;
  depth?: number;
  sectionId?: string;
  // Stable primitives (not an object) so React Compiler can skip unchanged rows.
  projectBadgeName?: string;
  projectBadgeColor?: string;
  projectBadgeIcon?: string;
}

/** Props for regular (persisted) workspace items */
export interface AgentListItemProps extends AgentListItemBaseProps {
  variant?: "workspace";
  metadata: FrontendWorkspaceMetadata;
  projectName: string;
  subAgentConnectorLayout?: SubAgentConnectorLayout;
  /**
   * Title of the enclosing task-group header when rendered as an expanded
   * group member. Used to suppress titles that just repeat the header (D8).
   */
  taskGroupHeaderTitle?: string;
  isArchiving?: boolean;
  /** True when deletion is in-flight (optimistic UI while backend removes). */
  isRemoving?: boolean;
  /** Section ID this workspace belongs to (for drag-drop targeting) */
  sectionId?: string;
  /**
   * Identifies the visual pinned block this row renders in (project + section,
   * or the multi-project section). Rows drag-reorder only within their block.
   */
  pinnedReorderGroup?: string;
  /** Present when pinned rows in this list can be drag-reordered. */
  onPinnedReorderDrop?: (draggedId: string, targetId: string, edge: PinnedDropEdge) => void;
  rowRenderMeta?: AgentRowRenderMeta;
  /** Live fallback used while task metadata is catching up to a still-running stream. */
  isWorkspaceLiveActive?: boolean;
  delegatedActivity?: WorkspaceDelegatedActivity;
  hiddenSubAgentsSummary?: WorkspaceSubAgentsSummary;
  /**
   * Workflow name for an own active run, retained beyond worker lifetimes so
   * a run between sequential steps (no live worker) stays labeled.
   */
  getWorkflowRunName?: (runId: string) => string | undefined;
  completedChildrenExpanded?: boolean;
  onToggleCompletedChildren?: (workspaceId: string) => void;
  onSelectWorkspace: (selection: WorkspaceSelection) => void;
  onForkWorkspace: (workspaceId: string, button: HTMLElement) => Promise<void>;
  onStopRuntime?: (workspaceId: string, button?: HTMLElement) => Promise<void>;
  onArchiveWorkspace: (workspaceId: string, button: HTMLElement) => Promise<void>;
  onCancelCreation: (workspaceId: string) => Promise<void>;
}

/** Props for draft (UI-only placeholder) items */
export interface DraftAgentListItemProps extends AgentListItemBaseProps {
  variant: "draft";
  draft: DraftWorkspaceData;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared components and utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Container styles shared between workspace and draft items.
 * Keep row text non-selectable so touch/pointer drags don't highlight titles
 * before react-dnd has locked into a drag session.
 */
const LIST_ITEM_BASE_CLASSES =
  "bg-surface-primary relative flex items-start gap-1.5 rounded-l-sm py-2 pr-1.5 select-none transition-all duration-150";

// The button reveal must stay behind the hover media query, like Tailwind's own `hover:`. iOS
// applies :hover on the tap itself, and when that fades a hidden button in, WebKit treats the tap
// as a hover and drops its click: opening a workspace from the phone drawer took two taps.
const ROW_HOVER_CLASSES =
  "pl-1 hover:bg-surface-secondary [@media(hover:hover)]:[&:hover_button]:opacity-100";

const HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH =
  "[@media(max-width:768px)_and_(hover:none)_and_(pointer:coarse)]:invisible [@media(max-width:768px)_and_(hover:none)_and_(pointer:coarse)]:pointer-events-none";
const SHOW_INLINE_ACTIONS_ON_WIDE_TOUCH =
  "[@media(min-width:769px)_and_(hover:none)_and_(pointer:coarse)]:opacity-100";

// Flat-mode rows (design "2a"): a project avatar column and a full-width text column. Rows keep
// their background in `--row-bg` so the avatar dot's ring and the action scrim match it in every
// state (rest, hover, focus, selected, menu open).
const AVATAR_ROW_BASE_CLASSES =
  "group/row relative grid grid-cols-[22px_minmax(0,1fr)] items-center gap-x-2.5 rounded-md p-2 select-none bg-(--row-bg) transition-colors duration-150";
const AVATAR_ROW_ACTIVE_BG = "[--row-bg:var(--color-surface-secondary)]";
const AVATAR_ROW_REST_BG =
  "[--row-bg:var(--color-surface-primary)] hover:[--row-bg:var(--color-surface-secondary)] focus-within:[--row-bg:var(--color-surface-secondary)]";

function getAvatarRowClasses(isHighlighted: boolean): string {
  return cn(AVATAR_ROW_BASE_CLASSES, isHighlighted ? AVATAR_ROW_ACTIVE_BG : AVATAR_ROW_REST_BG);
}

const AVATAR_ROW_ACTION_BUTTON_CLASSES = "h-6 w-6 rounded-[5px] hover:bg-hover";

// Hidden actions are never an invisible tap target: they take pointer events only while shown.
const ROW_ACTION_OVERLAY_REVEAL =
  "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";
const ROW_ACTION_OVERLAY_WIDE_TOUCH_REVEAL =
  "[@media(min-width:769px)_and_(hover:none)_and_(pointer:coarse)]:pointer-events-auto [@media(min-width:769px)_and_(hover:none)_and_(pointer:coarse)]:opacity-100";

/**
 * Avatar rows' actions float over the end of the title on a scrim that fades in from the left,
 * so the title keeps the full row width while the actions are hidden.
 */
function RowActionOverlay(props: {
  children: React.ReactNode;
  /** Shown regardless of hover/focus (menu open, deleting spinner). */
  forceVisible?: boolean;
  /** Touch tablets have no hover; show the actions there without it. */
  revealOnWideTouch?: boolean;
  /** Touch phones open the same actions by long-press. */
  hideOnNarrowTouch?: boolean;
}) {
  return (
    <div
      className={cn(
        // The 24px buttons center on the title line. A one-line row centers its 18px title on the
        // 22px avatar (title center 19px below the row top); a two-line row's title starts at the
        // 8px padding edge (center 17px).
        "absolute top-[7px] right-1.5 z-10 group-has-[[data-row-subtitle]]/row:top-[5px] flex items-center gap-1 pl-6 transition-opacity duration-100",
        props.forceVisible === true
          ? "opacity-100"
          : cn(
              ROW_ACTION_OVERLAY_REVEAL,
              props.revealOnWideTouch === true && ROW_ACTION_OVERLAY_WIDE_TOUCH_REVEAL
            ),
        props.hideOnNarrowTouch === true && HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH
      )}
      style={{
        backgroundImage:
          "linear-gradient(90deg, transparent, var(--row-bg, var(--color-surface-secondary)) 22px)",
      }}
    >
      {props.children}
    </div>
  );
}

function getVisualState(opts: {
  awaitingUserQuestion: boolean;
  isInitializing: boolean;
  isRemoving: boolean;
  isArchiving: boolean;
  isWorking: boolean;
  isStarting: boolean;
  hasActiveDelegatedWork: boolean;
  isWaitingOnBashMonitor: boolean;
  isUnread: boolean;
  isSelected: boolean;
  hasError: boolean;
}): VisualState {
  if (opts.isRemoving || opts.isArchiving) {
    return "hidden";
  }
  if (opts.hasError) {
    return "error";
  }
  if (opts.awaitingUserQuestion) {
    return "question";
  }
  if (opts.isWorking || opts.isStarting || opts.isInitializing || opts.hasActiveDelegatedWork) {
    return "active";
  }
  // Idle but an armed background bash monitor will wake the agent: keep the row
  // live (not "finished") without the streaming pulse, so users can tell parked
  // wake-waiting apart from active streaming. Real work above wins.
  if (opts.isWaitingOnBashMonitor) {
    return "waiting";
  }
  // Avoid unread flicker for the currently selected workspace while last-read
  // timestamps catch up on the next render.
  if (opts.isSelected) {
    return "seen";
  }
  // Figma distinguishes idle unseen (ringed dot + primary title) from seen (subtle square + secondary title).
  return opts.isUnread ? "idle" : "seen";
}

function HeartbeatFallbackIcon(props: { className?: string }) {
  return (
    <HeartPulse
      aria-hidden="true"
      className={cn("text-muted h-4 w-4", props.className)}
      data-testid="heartbeat-icon"
    />
  );
}

function formatSubAgentCount(count: number, label: "active" | "queued"): string {
  return `${count} sub-agent${count === 1 ? "" : "s"} ${label}`;
}

function formatDelegatedActivityText(activity: WorkspaceDelegatedActivity): string | null {
  const parts: string[] = [];
  if (activity.activeCount > 0) {
    if (activity.workflowActiveCount > 0) {
      parts.push("Workflow running");
    }
    parts.push(formatSubAgentCount(activity.activeCount, "active"));
  } else if (activity.queuedCount > 0) {
    if (activity.workflowQueuedCount > 0) {
      parts.push("Workflow queued");
    }
    parts.push(formatSubAgentCount(activity.queuedCount, "queued"));
  }

  if (activity.activeCount > 0 && activity.queuedCount > 0) {
    parts.push(`${activity.queuedCount} queued`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

const EMPTY_WORKFLOW_RUN_IDS: readonly string[] = [];
/**
 * Status line for a parent whose sub-agent rows are hidden, styled after the
 * transcript's sub-agent decoration. Workflow and user-owned segments are both
 * rendered when both have activity, since the hidden rows leave no other
 * surface for either; the running family leads.
 */
function formatHiddenSubAgentsPresentation(
  summary: WorkspaceSubAgentsSummary,
  ownActiveWorkflowRunIds: readonly string[],
  getWorkflowRunName?: (runId: string) => string | undefined
): { icon: LucideIcon; text: string } | null {
  // An own active run without a live worker (between sequential steps, or
  // before its first worker spawns) is still in progress; count it as running
  // so a concurrent run's workers cannot make it look finished while its rows
  // are hidden.
  const gapRunIds = ownActiveWorkflowRunIds.filter((runId) => !summary.workflowRunIds.has(runId));
  const runningRunCount = summary.runningWorkflowRunCount + gapRunIds.length;

  let workflowText: string | null = null;
  if (runningRunCount > 0 || summary.queuedWorkflowRunCount > 0) {
    // Queued-only runs must not read as running (parallelism limits can park
    // every worker), mirroring the delegated-status running/queued split.
    const hasRunningRun = runningRunCount > 0;
    const verb = hasRunningRun ? "running" : "queued";
    const runCount = hasRunningRun ? runningRunCount : summary.queuedWorkflowRunCount;
    // When only gap runs are active, summary.workflowName may belong to a queued run.
    // Only a single gap run has an unambiguous name.
    const workflowName =
      hasRunningRun && summary.runningWorkflowRunCount === 0
        ? gapRunIds.length === 1
          ? getWorkflowRunName?.(gapRunIds[0])
          : undefined
        : summary.workflowName;
    // The lone running worker's title is the run's current step; counts only
    // add signal once several workers or runs are in flight.
    if (
      hasRunningRun &&
      runCount === 1 &&
      summary.runningWorkflowAgentCount === 1 &&
      summary.runningWorkflowStepTitle != null
    ) {
      const queuedSuffix =
        summary.queuedWorkflowAgentCount > 0 ? ` · ${summary.queuedWorkflowAgentCount} queued` : "";
      workflowText = `${workflowName ?? "Workflow"} · ${summary.runningWorkflowStepTitle}${queuedSuffix}`;
    } else {
      const base =
        runCount === 1 ? `${workflowName ?? "Workflow"} ${verb}` : `${runCount} workflows ${verb}`;
      const agentCount = hasRunningRun
        ? summary.runningWorkflowAgentCount
        : summary.queuedWorkflowAgentCount;
      // Gap-only runs have no countable workers; skip the "(0 agents)" noise.
      const agentSuffix =
        agentCount > 0 ? ` (${agentCount} agent${agentCount === 1 ? "" : "s"})` : "";
      const queuedSuffix =
        hasRunningRun && summary.queuedWorkflowAgentCount > 0
          ? ` · ${summary.queuedWorkflowAgentCount} queued`
          : "";
      workflowText = `${base}${agentSuffix}${queuedSuffix}`;
    }
  }

  let subAgentText: string | null = null;
  if (summary.runningSubAgentCount > 0) {
    subAgentText = formatSubAgentCount(summary.runningSubAgentCount, "active");
    if (summary.queuedSubAgentCount > 0) {
      subAgentText += ` · ${summary.queuedSubAgentCount} queued`;
    }
  } else if (summary.queuedSubAgentCount > 0) {
    subAgentText = formatSubAgentCount(summary.queuedSubAgentCount, "queued");
  }

  if (workflowText != null && subAgentText != null) {
    // Running activity must not hide behind a queued-only family; ties keep
    // the workflow first as the more specific signal.
    const subAgentsLead = summary.runningSubAgentCount > 0 && runningRunCount === 0;
    return subAgentsLead
      ? { icon: Bot, text: `${subAgentText} · ${workflowText}` }
      : { icon: Workflow, text: `${workflowText} · ${subAgentText}` };
  }
  if (workflowText != null) {
    return { icon: Workflow, text: workflowText };
  }
  if (subAgentText != null) {
    return { icon: Bot, text: subAgentText };
  }
  return null;
}

function formatWorkflowRunCount(count: number): string {
  assert(count > 0, "formatWorkflowRunCount requires a positive count");
  return count === 1 ? "Workflow running" : `${count} workflows running`;
}

function formatBashMonitorCount(count: number): string {
  assert(count > 0, "formatBashMonitorCount requires a positive count");
  return count === 1 ? "Watching background bash" : `Watching ${count} background bashes`;
}

function SidebarActivityIndicator(props: { text: string; testId: string; icon?: LucideIcon }) {
  const Icon = props.icon;
  return (
    <div
      className="text-muted flex min-w-0 items-center gap-1.5 text-xs leading-4"
      data-testid={props.testId}
    >
      {Icon != null && <Icon className="h-3 w-3 shrink-0" strokeWidth={1.8} aria-hidden="true" />}
      {/* Activity texts embed live counts; tabular figures stop width jitter. */}
      <span className="counter-nums min-w-0 truncate">{props.text}</span>
    </div>
  );
}

function WorkflowActivityIndicator(props: { workspaceId: string; activeWorkflowRunCount: number }) {
  const statusText = formatWorkflowRunCount(props.activeWorkflowRunCount);

  return (
    <SidebarActivityIndicator
      text={statusText}
      testId={`workspace-workflow-activity-${props.workspaceId}`}
    />
  );
}

function DelegatedActivityIndicator(props: {
  workspaceId: string;
  activity: WorkspaceDelegatedActivity;
}) {
  const statusText = formatDelegatedActivityText(props.activity);
  if (!statusText) {
    return null;
  }

  return (
    <SidebarActivityIndicator
      text={statusText}
      testId={`workspace-delegated-activity-${props.workspaceId}`}
    />
  );
}

function QuickArchiveButton(props: {
  displayTitle: string;
  onArchiveWorkspace: (button: HTMLElement) => void;
}) {
  return (
    <div className={LEADING_SLOT_CONTAINER_CLASSES} style={LEADING_SLOT_CONTAINER_STYLE}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted hover:text-foreground focus-visible:text-foreground pointer-events-none inline-flex h-4 w-4 cursor-pointer items-center justify-center border-none bg-transparent p-0 opacity-0 transition-[color,opacity] duration-200 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100"
            onKeyDown={stopKeyboardPropagation}
            onClick={(event) => {
              event.stopPropagation();
              props.onArchiveWorkspace(event.currentTarget);
            }}
            aria-label={`Archive workspace ${props.displayTitle}`}
          >
            <ArchiveIcon className="h-3 w-3 shrink-0" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Archive workspace</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Action button wrapper (archive/delete) with consistent sizing and alignment */
function ActionButtonWrapper(props: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative order-last ml-auto mt-1 inline-flex shrink-0 items-center gap-1 self-start",
        props.className
      )}
    >
      {/* Keep the kebab trigger aligned with the title row. */}
      {props.children}
    </div>
  );
}

/** Leading column of a persisted row: the project avatar (flat mode) or the status slot. */
function RegularRowLeadingSlot(props: {
  workspaceId: string;
  displayTitle: string;
  visualState: VisualState;
  isSubAgentRow: boolean;
  isPinned: boolean;
  avatarName: string | undefined;
  avatarColor: string | undefined;
  avatarIcon: string | undefined;
  showCompletedChildrenIndicator: boolean;
  showHeartbeatFallback: boolean;
  showQuickArchiveButton: boolean;
  onArchiveWorkspace: (button: HTMLElement) => void;
}) {
  const completedChildrenIndicator = props.showCompletedChildrenIndicator ? (
    <ChevronDown
      aria-hidden="true"
      className={cn("text-muted", props.avatarName != null ? "h-2.5 w-2.5" : "h-3 w-3")}
      data-testid={`completed-children-expanded-indicator-${props.workspaceId}`}
    />
  ) : undefined;

  if (props.avatarName != null) {
    return (
      <ProjectAvatar
        name={props.avatarName}
        color={props.avatarColor}
        icon={props.avatarIcon}
        testId={`workspace-project-avatar-${props.workspaceId}`}
        corner={
          completedChildrenIndicator != null ? (
            <AvatarCornerIcon>{completedChildrenIndicator}</AvatarCornerIcon>
          ) : props.showHeartbeatFallback ? (
            <AvatarCornerIcon>
              <HeartbeatFallbackIcon className="h-2.5 w-2.5" />
            </AvatarCornerIcon>
          ) : (
            // Pinned chats keep their section calm: only attention states show there.
            <AvatarStatusDot state={props.visualState} hideIdle={props.isPinned} />
          )
        }
      />
    );
  }
  if (props.showHeartbeatFallback) {
    return (
      <div className={STATUS_DOT_SLOT_CONTAINER_CLASSES} style={LEADING_SLOT_CONTAINER_STYLE}>
        <HeartbeatFallbackIcon />
      </div>
    );
  }
  if (props.showQuickArchiveButton) {
    return (
      <QuickArchiveButton
        displayTitle={props.displayTitle}
        onArchiveWorkspace={props.onArchiveWorkspace}
      />
    );
  }
  return (
    <StatusDot
      state={props.visualState}
      isSubAgent={props.isSubAgentRow}
      overlay={completedChildrenIndicator}
    />
  );
}

function getCancelCreationButtonClasses(isAvatarRow: boolean, isRemoving: boolean): string {
  return cn(
    "text-muted inline-flex items-center justify-center border-none bg-transparent p-0 transition-colors duration-200",
    isAvatarRow ? AVATAR_ROW_ACTION_BUTTON_CLASSES : "h-4 w-4",
    // Keep cancel affordance hidden until row-hover while initializing,
    // but force it visible as a spinner once deletion starts. Avatar rows
    // reveal the whole overlay instead of the button.
    isRemoving
      ? "cursor-default opacity-100"
      : cn(
          "cursor-pointer hover:text-destructive",
          !isAvatarRow && "opacity-0 focus-visible:opacity-100"
        )
  );
}

/** Initializing rows: a hover-revealed cancel button that turns into a spinner while deleting. */
function CancelCreationButton(props: {
  workspaceId: string;
  displayTitle: string;
  isRemoving: boolean;
  isAvatarRow: boolean;
  onCancelCreation: (workspaceId: string) => Promise<void>;
}) {
  const { isRemoving } = props;
  const button = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={getCancelCreationButtonClasses(props.isAvatarRow, isRemoving)}
          disabled={isRemoving}
          onKeyDown={stopKeyboardPropagation}
          onClick={(e) => {
            e.stopPropagation();
            if (isRemoving) return;
            void props.onCancelCreation(props.workspaceId);
          }}
          aria-label={
            isRemoving
              ? `Deleting workspace ${props.displayTitle}`
              : `Cancel workspace creation ${props.displayTitle}`
          }
          data-workspace-id={props.workspaceId}
        >
          {isRemoving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4 shrink-0" strokeWidth={1.8} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent align="start">
        {isRemoving ? "Deleting..." : "Cancel creation"}
      </TooltipContent>
    </Tooltip>
  );
  return props.isAvatarRow ? (
    <RowActionOverlay forceVisible={isRemoving}>{button}</RowActionOverlay>
  ) : (
    <ActionButtonWrapper className="mt-0 self-center">{button}</ActionButtonWrapper>
  );
}

/**
 * Hide menu content for one frame while Radix/Floating UI recalculates anchor
 * placement. This avoids first-frame flashes at stale trigger/fallback coords.
 */
function useHiddenFirstFrameRef(isOpen: boolean) {
  const frameRef = useRef<number | null>(null);
  return useCallback(
    (node: HTMLDivElement | null) => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      if (!node || !isOpen) {
        return;
      }

      node.style.visibility = "hidden";
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (!node.isConnected) {
          return;
        }
        node.style.visibility = "visible";
      });
    },
    [isOpen]
  );
}

const MENU_AT_CURSOR_PLACEMENT = { align: "start", side: "right", sideOffset: 0 } as const;
const MENU_AT_TRIGGER_PLACEMENT = { align: "end", side: "bottom", sideOffset: 6 } as const;

function getRowMenuTriggerClasses(
  isAvatarRow: boolean,
  isOpen: boolean
): { button: string; icon: string } {
  const base =
    "text-muted hover:text-foreground inline-flex cursor-pointer items-center justify-center border-none bg-transparent p-0 transition-colors duration-200";
  if (isAvatarRow) {
    // Avatar rows reveal the whole overlay instead of the button.
    return { button: cn(base, AVATAR_ROW_ACTION_BUTTON_CLASSES), icon: "h-3.5 w-3.5 shrink-0" };
  }
  return {
    button: cn(
      base,
      "h-4 w-4",
      isOpen ? "opacity-100" : "opacity-0",
      HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH,
      SHOW_INLINE_ACTIONS_ON_WIDE_TOUCH
    ),
    icon: "h-4 w-4 shrink-0",
  };
}

/**
 * The row's overflow menu: opens from the kebab button (dropdown) or right-click/long-press
 * (positioned). Uses a Popover so it can anchor at either the trigger button or the cursor.
 */
function WorkspaceRowMenu(props: {
  ctxMenu: UseContextMenuPositionReturn;
  triggerRef: React.Ref<HTMLButtonElement>;
  workspaceId: string;
  displayTitle: string;
  isAvatarRow: boolean;
  isSelected: boolean;
  children: React.ReactNode;
}) {
  // Destructured: reading `props.triggerRef` in render makes React Compiler skip this component.
  const { ctxMenu, triggerRef } = props;
  const setContentRef = useHiddenFirstFrameRef(ctxMenu.isOpen);
  const placement = ctxMenu.position ? MENU_AT_CURSOR_PLACEMENT : MENU_AT_TRIGGER_PLACEMENT;
  const triggerClasses = getRowMenuTriggerClasses(props.isAvatarRow, ctxMenu.isOpen);

  const menu = (
    <Popover open={ctxMenu.isOpen} onOpenChange={ctxMenu.onOpenChange}>
      {/* When opened via right-click/long-press, anchor at cursor position */}
      {ctxMenu.position && (
        <PopoverAnchor asChild>
          <span
            style={{
              position: "fixed",
              left: ctxMenu.position.x,
              top: ctxMenu.position.y,
              width: 0,
              height: 0,
            }}
          />
        </PopoverAnchor>
      )}
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className={triggerClasses.button}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Workspace actions for ${props.displayTitle}`}
          data-workspace-id={props.workspaceId}
        >
          <EllipsisVertical className={triggerClasses.icon} strokeWidth={1.8} />
        </button>
      </PopoverTrigger>

      <PopoverContent
        ref={setContentRef}
        {...placement}
        // Size to the widest row ("Archive workspace" + its shortcut overflowed a
        // fixed 250px), but never wider than the viewport, like the menu bar's menu.
        className="bg-surface-primary w-max max-w-[calc(100vw-1rem)] min-w-[250px]! p-1"
        onClick={(event: React.MouseEvent<HTMLDivElement>) => {
          event.stopPropagation();
        }}
      >
        {props.children}
      </PopoverContent>
    </Popover>
  );

  return props.isAvatarRow ? (
    // Touch tablets have no hover: only the selected row shows its kebab there.
    <RowActionOverlay
      forceVisible={ctxMenu.isOpen}
      revealOnWideTouch={props.isSelected}
      hideOnNarrowTouch
    >
      {menu}
    </RowActionOverlay>
  ) : (
    <ActionButtonWrapper>{menu}</ActionButtonWrapper>
  );
}

function getRowStateClasses(opts: {
  isDragging: boolean;
  isRemoving: boolean;
  isArchiving: boolean;
  isDisabled: boolean;
}): string {
  return cn(
    opts.isDragging && "opacity-50",
    opts.isRemoving && "opacity-70",
    opts.isArchiving && "pointer-events-none opacity-70",
    opts.isDisabled ? "cursor-default" : "cursor-pointer"
  );
}

function getRegularRowClasses(opts: {
  isAvatarRow: boolean;
  /** Avatar rows: selected, or their menu is open. */
  isHighlighted: boolean;
  sectionId: string | undefined;
  isDragging: boolean;
  isRemoving: boolean;
  isArchiving: boolean;
  isDisabled: boolean;
}): string {
  if (opts.isAvatarRow) {
    return cn(getAvatarRowClasses(opts.isHighlighted), getRowStateClasses(opts));
  }
  return cn(
    LIST_ITEM_BASE_CLASSES,
    "group/row",
    // No left margin — status dot aligns with the project folder icon.
    // Section members get a small indent for visual grouping.
    opts.sectionId != null ? "ml-2" : "ml-0",
    // Keep hover styles enabled for initializing workspaces so the row feels interactive.
    !opts.isArchiving && ROW_HOVER_CLASSES,
    getRowStateClasses(opts),
    opts.isHighlighted && "bg-surface-secondary"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft Workspace Item (UI-only placeholder)
// ─────────────────────────────────────────────────────────────────────────────

function DraftRowActions(props: {
  draft: DraftWorkspaceData;
  projectPath: string;
  ctxMenu: UseContextMenuPositionReturn;
  isAvatarRow: boolean;
  isSelected: boolean;
}) {
  const { draft, ctxMenu } = props;
  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "text-muted hover:text-content-destructive inline-flex cursor-pointer items-center justify-center border-none bg-transparent p-0 transition-colors duration-200",
              // Avatar rows reveal the whole overlay instead of the button.
              props.isAvatarRow
                ? AVATAR_ROW_ACTION_BUTTON_CLASSES
                : cn(
                    "h-4 w-4 opacity-0",
                    // Keep long-press as the compact mobile affordance on narrow
                    // touch layouts, but show the button on wider touch screens so
                    // it never becomes an invisible tappable hotspot.
                    HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH,
                    SHOW_INLINE_ACTIONS_ON_WIDE_TOUCH
                  )
            )}
            onKeyDown={stopKeyboardPropagation}
            onClick={(e) => {
              e.stopPropagation();
              draft.onDelete();
            }}
            aria-label={`Delete workspace draft ${draft.draftNumber}`}
            data-project-path={props.projectPath}
            data-draft-id={draft.draftId}
          >
            <Trash className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          </button>
        </TooltipTrigger>
        <TooltipContent align="start">Delete draft</TooltipContent>
      </Tooltip>

      {/* Mobile: context menu opened by long-press / right-click */}
      <PositionedMenu
        open={ctxMenu.isOpen}
        onOpenChange={ctxMenu.onOpenChange}
        position={ctxMenu.position}
        className="w-[150px]"
      >
        <PositionedMenuItem
          icon={<Trash className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
          label="Delete draft"
          onClick={() => {
            ctxMenu.close();
            draft.onDelete();
          }}
        />
      </PositionedMenu>
    </>
  );

  return props.isAvatarRow ? (
    // Same touch rule as the chat kebab: tablets show it on the selected row only.
    <RowActionOverlay revealOnWideTouch={props.isSelected} hideOnNarrowTouch>
      {actions}
    </RowActionOverlay>
  ) : (
    <ActionButtonWrapper>{actions}</ActionButtonWrapper>
  );
}

function DraftRowText(props: {
  draft: DraftWorkspaceData;
  isSelected: boolean;
  isAvatarRow: boolean;
}) {
  const textColorClass = props.isSelected ? "text-content-primary" : "text-muted";
  return (
    <div
      className={cn("flex min-w-0 flex-col", props.isAvatarRow ? "gap-[3px]" : "flex-1 gap-0.5")}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 text-[14px]",
          props.isAvatarRow ? "leading-[18px]" : "leading-6"
        )}
      >
        <PenLine className={cn("h-3 w-3 shrink-0", textColorClass)} strokeWidth={1.8} />
        <span className={cn("min-w-0 truncate text-left italic", textColorClass)}>
          {props.draft.title}
        </span>
      </div>
      {props.draft.promptPreview.length > 0 && (
        <span
          className={cn("block truncate text-left text-xs leading-4", textColorClass)}
          data-row-subtitle
        >
          {props.draft.promptPreview}
        </span>
      )}
    </div>
  );
}

function DraftAgentListItemInner(props: DraftAgentListItemProps) {
  const { projectPath, isSelected, depth, sectionId, draft } = props;
  const paddingLeft = getSidebarItemPaddingLeft(depth);
  const isAvatarRow = props.projectBadgeName != null;
  const draftBorderStyle: React.CSSProperties = {
    backgroundImage: [
      "repeating-linear-gradient(to right, var(--color-border) 0 5px, transparent 5px 10px)",
      "repeating-linear-gradient(to right, var(--color-border) 0 5px, transparent 5px 10px)",
      "repeating-linear-gradient(to bottom, var(--color-border) 0 5px, transparent 5px 10px)",
    ].join(", "),
    backgroundSize: "100% 1.5px, 100% 1.5px, 1.5px 100%",
    backgroundPosition: "left top, left bottom, left top",
    backgroundRepeat: "no-repeat",
  };

  const ctxMenu = useContextMenuPosition({ longPress: true });

  return (
    <div
      className={cn(
        isAvatarRow
          ? getAvatarRowClasses(isSelected)
          : cn(
              LIST_ITEM_BASE_CLASSES,
              sectionId != null ? "ml-2" : "ml-0",
              ROW_HOVER_CLASSES,
              isSelected && "bg-surface-secondary"
            ),
        "cursor-pointer"
      )}
      // Avatar rows are flat-mode roots: their padding is fixed, not depth-indented.
      style={isAvatarRow ? draftBorderStyle : { paddingLeft, ...draftBorderStyle }}
      onClick={() => {
        if (ctxMenu.suppressClickIfLongPress()) return;
        draft.onOpen();
      }}
      {...ctxMenu.touchHandlers}
      onContextMenu={ctxMenu.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          draft.onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={isSelected ? "true" : undefined}
      aria-label={
        props.projectBadgeName != null
          ? `Open workspace draft ${draft.draftNumber} (${props.projectBadgeName})`
          : `Open workspace draft ${draft.draftNumber}`
      }
      data-project-path={projectPath}
      data-draft-id={draft.draftId}
    >
      {props.projectBadgeName != null ? (
        <ProjectAvatar
          name={props.projectBadgeName}
          color={props.projectBadgeColor}
          icon={props.projectBadgeIcon}
          testId={`workspace-project-avatar-draft-${draft.draftId}`}
        />
      ) : (
        <StatusDot state="idle" isDraft />
      )}
      <DraftRowText draft={draft} isSelected={isSelected} isAvatarRow={isAvatarRow} />
      <DraftRowActions
        draft={draft}
        projectPath={projectPath}
        ctxMenu={ctxMenu}
        isAvatarRow={isAvatarRow}
        isSelected={isSelected}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Regular Workspace Item (persisted workspace)
// ─────────────────────────────────────────────────────────────────────────────

function RegularAgentListItemInner(props: AgentListItemProps) {
  const {
    metadata,
    projectPath,
    projectName,
    isSelected,
    isArchiving,
    isRemoving: isRemovingProp,
    depth,
    sectionId,
    rowRenderMeta,
    delegatedActivity,
    hiddenSubAgentsSummary,
    getWorkflowRunName,
    completedChildrenExpanded,
    onToggleCompletedChildren,
    onSelectWorkspace,
    onForkWorkspace,
    onStopRuntime,
    onArchiveWorkspace,
    onCancelCreation,
  } = props;

  // Destructure metadata for convenience
  const { id: workspaceId, namedWorkspacePath } = metadata;
  const isInitializing = metadata.isInitializing === true;
  const isRemoving = isRemovingProp === true || metadata.isRemoving === true;
  const isDisabled = isRemoving || isArchiving === true;

  const { isUnread } = useWorkspaceUnread(workspaceId);
  const runtimeStatus = useRuntimeStatus(workspaceId);

  // Get title edit context — manages inline title editing state across the sidebar
  const { editingWorkspaceId, requestEdit, confirmEdit, cancelEdit, generatingTitleWorkspaceIds } =
    useTitleEdit();
  const isGeneratingTitle = generatingTitleWorkspaceIds.has(workspaceId);
  const isPendingAutoTitle = metadata.pendingAutoTitle === true;
  // Route pin toggles through the context wrapper: it applies an optimistic
  // pinnedAt (instant reorder on click) and works with mock API clients.
  // Optional because stories/tests render this row without WorkspaceProvider.
  const setWorkspacePinned = useWorkspaceActionsOptional()?.setWorkspacePinned;

  // Local state for title editing
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [titleError, setTitleError] = useState<string | null>(null);

  // Display title (fallback to name for legacy workspaces without title)
  const workspaceTitle = metadata.title ?? metadata.name;
  // Best-of children use a compact alphabetical candidate label (A, B, C…).
  const groupLabel =
    metadata.bestOf != null ? String.fromCharCode(65 + (metadata.bestOf.index ?? 0)) : undefined;
  // D8: expanded group members drop a title that merely repeats the group
  // header; the remaining label must stay readable on its own, so bare best-of
  // letters render as "Candidate A". Custom titles still show (self-healing).
  const suppressGroupMemberTitle =
    props.taskGroupHeaderTitle !== undefined &&
    props.taskGroupHeaderTitle === workspaceTitle &&
    groupLabel !== undefined;
  const memberOnlyLabel = groupLabel !== undefined ? `Candidate ${groupLabel}` : undefined;
  const displayTitle = suppressGroupMemberTitle
    ? (memberOnlyLabel ?? workspaceTitle)
    : groupLabel
      ? `${workspaceTitle}, scope ${groupLabel}`
      : workspaceTitle;
  const isEditing = editingWorkspaceId === workspaceId;
  const isPinned = isWorkspacePinned(metadata);
  // The menu's settings dialogs mount on demand, so a row with its menu closed runs none of
  // their hooks or subscriptions (#6202).
  const [openModal, setOpenModal] = useState<"heartbeat" | "mcp" | "messaging" | null>(null);
  const overflowMenuButtonRef = useRef<HTMLButtonElement | null>(null);

  // Context menu via right-click / long-press. The hook manages position + long-press state.
  // The regular item also has a ⋮ trigger button, so we bridge the hook's isOpen into a
  // Popover that can be anchored either at the cursor position or the trigger button.
  const canOpenMenu = useCallback(() => !isDisabled && !isEditing, [isDisabled, isEditing]);
  const ctxMenu = useContextMenuPosition({ longPress: true, canOpen: canOpenMenu });
  useEffect(() => {
    if (isEditing) {
      ctxMenu.close();
    }
  }, [isEditing, ctxMenu]);

  const wasEditingRef = useRef(false);
  useEffect(() => {
    if (isEditing && !wasEditingRef.current) {
      // Initialize draft title exactly once per edit session so metadata refreshes
      // never overwrite what the user has typed in the input.
      setEditingTitle(workspaceTitle);
      setTitleError(null);
    }
    wasEditingRef.current = isEditing;
  }, [isEditing, workspaceTitle]);

  const handleEditInputRef = useCallback((node: HTMLInputElement | null) => {
    if (!node) {
      return;
    }

    node.focus();
  }, []);

  const startEditing = () => {
    if (requestEdit(workspaceId, workspaceTitle)) {
      setEditingTitle(workspaceTitle);
      setTitleError(null);
    }
  };

  const handleConfirmEdit = async () => {
    if (!editingTitle.trim()) {
      setTitleError("Title cannot be empty");
      return;
    }

    const result = await confirmEdit(workspaceId, editingTitle);
    if (!result.success) {
      setTitleError(result.error ?? "Failed to update title");
    } else {
      setTitleError(null);
    }
  };

  const handleCancelEdit = () => {
    cancelEdit();
    setEditingTitle("");
    setTitleError(null);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    // Always stop propagation to prevent parent div's onKeyDown and global handlers from interfering
    stopKeyboardPropagation(e);
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirmEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const {
    canInterrupt,
    awaitingUserQuestion,
    isStarting,
    agentStatus,
    activeWorkflowRunIds,
    activeWorkflowRunCount,
    activeBashMonitorCount,
    terminalActiveCount,
    lastAbortReason,
  } = useWorkspaceSidebarState(workspaceId);

  const fallbackModel = useWorkspaceFallbackModel(workspaceId);
  const streamingStatusPhase = getWorkspaceStreamingStatusPhase({
    canInterrupt,
    isStarting,
    isCreating: isInitializing,
  });
  const { displayPhase: displayStreamingStatusPhase } =
    useWorkspaceStreamingStatusPhase(streamingStatusPhase);
  const isWorking = displayStreamingStatusPhase !== null && !awaitingUserQuestion;
  const hasError = lastAbortReason?.reason === "system";
  const hasActiveWorkflowRun = activeWorkflowRunCount > 0;
  // An armed background bash monitor means the workspace is still waiting to be
  // woken, so keep the row live (distinct "waiting" dot) instead of letting it
  // look finished — but don't let it masquerade as active streaming.
  const hasActiveBashMonitor = activeBashMonitorCount > 0;
  const hasActiveDelegatedWork = (delegatedActivity?.activeCount ?? 0) > 0;
  const delegatedStatusText = delegatedActivity
    ? formatDelegatedActivityText(delegatedActivity)
    : null;
  const hasDelegatedStatusText = delegatedStatusText != null;
  const shouldShowWorkflowStatus =
    hasActiveWorkflowRun && !agentStatus && displayStreamingStatusPhase === null;
  const shouldShowBashMonitorStatus =
    hasActiveBashMonitor &&
    !agentStatus &&
    displayStreamingStatusPhase === null &&
    !shouldShowWorkflowStatus;
  const hasOwnLiveStatusText =
    awaitingUserQuestion ||
    displayStreamingStatusPhase !== null ||
    isRemoving ||
    shouldShowWorkflowStatus ||
    // Own-workspace signals (like workflow status above) outrank delegated text so a
    // coordinator waiting on an armed monitor still surfaces the watching state.
    shouldShowBashMonitorStatus;
  const shouldShowDelegatedStatus = hasDelegatedStatusText && !hasOwnLiveStatusText && !hasError;
  const hiddenSubAgentsPresentation = hiddenSubAgentsSummary
    ? formatHiddenSubAgentsPresentation(
        hiddenSubAgentsSummary,
        activeWorkflowRunIds ?? EMPTY_WORKFLOW_RUN_IDS,
        getWorkflowRunName
      )
    : null;
  // With sub-agent rows hidden, the summary outranks the coordinator's own
  // streaming/todo/bash-monitor status text (the status dot still shows own
  // work). Questions, deletion, and errors still win.
  const shouldShowHiddenSubAgentsStatus =
    hiddenSubAgentsPresentation != null && !awaitingUserQuestion && !isRemoving && !hasError;
  const visualState = getVisualState({
    awaitingUserQuestion,
    isInitializing,
    isRemoving,
    isArchiving: isArchiving === true,
    isWorking,
    isStarting: displayStreamingStatusPhase === "starting",
    hasActiveDelegatedWork: hasActiveDelegatedWork || hasActiveWorkflowRun,
    isWaitingOnBashMonitor: hasActiveBashMonitor,
    isUnread,
    isSelected,
    hasError,
  });
  const isSubAgentRow = rowRenderMeta?.rowKind === "subagent";
  // Flat mode passes a project identity for root rows; those render the avatar layout. Sub-agent
  // rows keep their nested connector layout.
  const avatarName = isSubAgentRow ? undefined : props.projectBadgeName;
  const isAvatarRow = avatarName != null;
  const showsVisibleStatusDot = isStatusDotVisible(visualState, false, isSubAgentRow);
  const hasStatusText =
    shouldShowHiddenSubAgentsStatus ||
    shouldShowDelegatedStatus ||
    Boolean(agentStatus) ||
    awaitingUserQuestion ||
    displayStreamingStatusPhase !== null ||
    isRemoving ||
    shouldShowWorkflowStatus ||
    shouldShowBashMonitorStatus;
  // Keep archiving feedback inline with the title so the row doesn't jump to a
  // two-line layout right before it disappears from the sidebar.
  const shouldShowInlineArchivingStatus = isArchiving === true && !isRemoving;
  // Note: we intentionally render the secondary row even while the workspace is still
  // initializing so users can see early streaming/status information immediately.
  const hasSecondaryRow = !shouldShowInlineArchivingStatus && hasStatusText;
  const secondaryStatusDescriptionId = hasSecondaryRow
    ? `workspace-status-description-${workspaceId}`
    : undefined;
  const hasCompletedChildren =
    (rowRenderMeta?.hasHiddenCompletedChildren ?? false) ||
    (rowRenderMeta?.visibleCompletedChildrenCount ?? 0) > 0;
  const canToggleCompletedChildren = hasCompletedChildren && onToggleCompletedChildren != null;
  const isCompletedChildrenExpanded = completedChildrenExpanded === true;
  const showCompletedChildrenIndicator =
    canToggleCompletedChildren && isCompletedChildrenExpanded && !showsVisibleStatusDot;
  // Keep one-click archive in the empty "seen" slot for regular workspaces, but leave
  // sub-agents on the existing status-dot lifecycle because parent cleanup owns them.
  // Avatar rows have no empty slot for it; archive stays in the menu and its keybind.
  const shouldShowQuickArchiveButton =
    !isAvatarRow &&
    !isDisabled &&
    !isEditing &&
    !isSubAgentRow &&
    !showCompletedChildrenIndicator &&
    !showsVisibleStatusDot;
  const shouldShowHeartbeatFallback =
    metadata.heartbeat?.enabled === true &&
    !isSubAgentRow &&
    !showCompletedChildrenIndicator &&
    visualState === "seen" &&
    !isDisabled;
  const toggleCompletedChildren = () => {
    if (!canToggleCompletedChildren) {
      return false;
    }
    onToggleCompletedChildren?.(workspaceId);
    return true;
  };
  const isDevcontainerWorkspace = isDevcontainerRuntime(metadata.runtimeConfig);
  const isRuntimeRunning = isDevcontainerWorkspace && runtimeStatus === "running";
  const titleColorClass =
    !isSelected && visualState === "idle"
      ? "text-content-primary"
      : !isSelected && visualState === "seen"
        ? "text-content-tertiary"
        : "text-content-primary";

  const paddingLeft = getSidebarItemPaddingLeft(depth);

  const workspaceSelection: WorkspaceSelection = {
    projectPath,
    projectName,
    namedWorkspacePath,
    workspaceId,
  };

  // Drag handle for moving workspace between sections (and reordering pinned rows)
  const [{ isDragging }, drag, dragPreview] = useDrag(
    () => ({
      type: WORKSPACE_DRAG_TYPE,
      item: (): WorkspaceDragItem & { displayTitle?: string; runtimeConfig?: unknown } => ({
        type: WORKSPACE_DRAG_TYPE,
        workspaceId,
        projectPath,
        // Flat rows render without the sectionId prop (no section indent), so
        // fall back to the row's own sub-project scope; drop zones use this to
        // treat same-section drops as no-ops.
        currentSectionId: sectionId ?? metadata.subProjectPath,
        pinned: isPinned,
        pinnedReorderGroup: props.pinnedReorderGroup,
        // Extra fields for custom drag layer preview
        displayTitle,
        runtimeConfig: metadata.runtimeConfig,
      }),
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
      canDrag: !isDisabled,
    }),
    [
      workspaceId,
      projectPath,
      sectionId,
      metadata.subProjectPath,
      isDisabled,
      isPinned,
      props.pinnedReorderGroup,
      displayTitle,
      metadata.runtimeConfig,
    ]
  );

  // Hide native drag preview; we render a custom preview via WorkspaceDragLayer
  useEffect(() => {
    dragPreview(getEmptyImage(), { captureDraggingState: true });
  }, [dragPreview]);

  // Pinned rows double as drop targets so pinned chats can be reordered by
  // dragging within their own block. The drop edge (insert before/after) comes
  // from the pointer position relative to the row midpoint; it is computed
  // fresh in drop() so the result never depends on stale hover state.
  const rowNodeRef = useRef<HTMLDivElement | null>(null);
  const [pinnedDropEdge, setPinnedDropEdge] = useState<PinnedDropEdge | null>(null);
  const onPinnedReorderDrop = props.onPinnedReorderDrop;
  const pinnedReorderGroup = props.pinnedReorderGroup;
  const computePinnedDropEdge = (monitor: DropTargetMonitor): PinnedDropEdge => {
    const node = rowNodeRef.current;
    const offset = monitor.getClientOffset();
    if (!node || !offset) return "after";
    const rect = node.getBoundingClientRect();
    return offset.y < rect.top + rect.height / 2 ? "before" : "after";
  };
  const [{ isPinnedReorderTarget }, pinnedReorderDrop] = useDrop(
    () => ({
      accept: WORKSPACE_DRAG_TYPE,
      canDrop: (item: WorkspaceDragItem) =>
        onPinnedReorderDrop !== undefined &&
        isPinned &&
        item.pinned === true &&
        item.pinnedReorderGroup !== undefined &&
        item.pinnedReorderGroup === pinnedReorderGroup &&
        item.workspaceId !== workspaceId,
      hover: (_item: WorkspaceDragItem, monitor) => {
        if (!monitor.canDrop()) return;
        setPinnedDropEdge(computePinnedDropEdge(monitor));
      },
      drop: (item: WorkspaceDragItem, monitor) => {
        onPinnedReorderDrop?.(item.workspaceId, workspaceId, computePinnedDropEdge(monitor));
      },
      collect: (monitor) => ({
        isPinnedReorderTarget: monitor.isOver() && monitor.canDrop(),
      }),
    }),
    [onPinnedReorderDrop, isPinned, pinnedReorderGroup, workspaceId]
  );
  const attachRowDndRef = (node: HTMLDivElement | null) => {
    rowNodeRef.current = node;
    drag(node);
    pinnedReorderDrop(node);
  };

  return (
    <React.Fragment>
      <div
        ref={attachRowDndRef}
        className={getRegularRowClasses({
          isAvatarRow,
          // Avatar rows keep the hover background while their menu is open.
          isHighlighted: (isSelected && !isDisabled) || (isAvatarRow && ctxMenu.isOpen),
          sectionId,
          isDragging,
          isRemoving,
          isArchiving: isArchiving === true,
          isDisabled,
        })}
        // Avatar rows are flat-mode roots: their padding is fixed, not depth-indented.
        style={isAvatarRow ? undefined : { paddingLeft }}
        onClick={(event) => {
          if (isDisabled) return;
          if (isEventFromDialogPortal(event.target)) return;
          if (ctxMenu.suppressClickIfLongPress()) return;
          onSelectWorkspace(workspaceSelection);
        }}
        onDoubleClick={(event) => {
          if (isDisabled || isEditing || isEventFromDialogPortal(event.target)) {
            return;
          }
          const doubleClickTarget =
            event.target instanceof Element
              ? event.target
              : event.target instanceof Node
                ? event.target.parentElement
                : null;
          if (doubleClickTarget?.closest("button,input,textarea,[contenteditable='true']")) {
            return;
          }
          startEditing();
          event.stopPropagation();
        }}
        onTouchStart={(event) => {
          if (isEventFromDialogPortal(event.target)) return;
          ctxMenu.touchHandlers.onTouchStart(event);
        }}
        onTouchMove={(event) => {
          if (isEventFromDialogPortal(event.target)) return;
          ctxMenu.touchHandlers.onTouchMove(event);
        }}
        onTouchEnd={(event) => {
          if (isEventFromDialogPortal(event.target)) return;
          ctxMenu.touchHandlers.onTouchEnd();
        }}
        onKeyDown={(e) => {
          if (isDisabled || isEditing) return;
          // Only treat these shortcuts as row-level controls when the row itself is
          // focused so child buttons keep their own keyboard behavior.
          if (e.target !== e.currentTarget) return;
          // Keep completed-child expansion reachable from the same focusable row.
          // The chevron is only a visual indicator, not an interactive control.
          if (
            e.key === "ArrowRight" &&
            canToggleCompletedChildren &&
            !isCompletedChildrenExpanded
          ) {
            e.preventDefault();
            e.stopPropagation();
            toggleCompletedChildren();
            return;
          }
          if (e.key === "ArrowLeft" && canToggleCompletedChildren && isCompletedChildrenExpanded) {
            e.preventDefault();
            e.stopPropagation();
            toggleCompletedChildren();
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectWorkspace(workspaceSelection);
          }
        }}
        onContextMenu={(event) => {
          if (isEventFromDialogPortal(event.target)) return;
          ctxMenu.onContextMenu(event);
        }}
        role="button"
        tabIndex={isDisabled ? -1 : 0}
        aria-current={isSelected ? "true" : undefined}
        aria-expanded={canToggleCompletedChildren ? isCompletedChildrenExpanded : undefined}
        aria-keyshortcuts={canToggleCompletedChildren ? "ArrowRight ArrowLeft" : undefined}
        aria-label={(() => {
          // The explicit label overrides descendant badge text, so include the
          // project identity whenever the badge is the only visible project cue.
          const accessibleTitle =
            props.projectBadgeName != null
              ? `${displayTitle} (${props.projectBadgeName})`
              : displayTitle;
          return isRemoving
            ? `Deleting workspace ${accessibleTitle}`
            : isInitializing
              ? `Initializing workspace ${accessibleTitle}`
              : isArchiving
                ? `Archiving workspace ${accessibleTitle}`
                : `Select workspace ${accessibleTitle}`;
        })()}
        aria-describedby={secondaryStatusDescriptionId}
        aria-disabled={isDisabled}
        data-workspace-path={namedWorkspacePath}
        data-workspace-id={workspaceId}
        data-section-id={sectionId ?? ""}
      >
        {/* Pinned-reorder insertion indicator: marks the edge the dragged row will land on. */}
        {isPinnedReorderTarget && (
          <div
            aria-hidden
            data-testid="pinned-reorder-indicator"
            className={cn(
              "bg-accent pointer-events-none absolute inset-x-0 z-10 h-0.5",
              (pinnedDropEdge ?? "after") === "before" ? "top-0" : "bottom-0"
            )}
          />
        )}
        <RegularRowLeadingSlot
          workspaceId={workspaceId}
          displayTitle={displayTitle}
          visualState={visualState}
          isSubAgentRow={isSubAgentRow}
          isPinned={isPinned}
          avatarName={avatarName}
          avatarColor={props.projectBadgeColor}
          avatarIcon={props.projectBadgeIcon}
          showCompletedChildrenIndicator={showCompletedChildrenIndicator}
          showHeartbeatFallback={shouldShowHeartbeatFallback}
          showQuickArchiveButton={shouldShowQuickArchiveButton}
          onArchiveWorkspace={(button) => {
            void onArchiveWorkspace(workspaceId, button);
          }}
        />

        {/* Action button: cancel/delete spinner for initializing workspaces, overflow menu otherwise */}
        {isInitializing ? (
          <CancelCreationButton
            workspaceId={workspaceId}
            displayTitle={displayTitle}
            isRemoving={isRemoving}
            isAvatarRow={isAvatarRow}
            onCancelCreation={onCancelCreation}
          />
        ) : isDisabled ? (
          // Invisible spacer preserves title alignment during archive/remove transitions
          !isAvatarRow && <div className="order-last ml-auto h-4 w-4 shrink-0" />
        ) : (
          !isEditing && (
            <WorkspaceRowMenu
              ctxMenu={ctxMenu}
              triggerRef={overflowMenuButtonRef}
              workspaceId={workspaceId}
              displayTitle={displayTitle}
              isAvatarRow={isAvatarRow}
              isSelected={isSelected}
            >
              <WorkspaceActionsMenuContent
                state={{
                  surface: "sidebar",
                  workspace: metadata,
                  showsSubAgent: isSubAgentRow,
                  isRuntimeRunning,
                  canMarkUnread: !isSelected && !isUnread,
                  canToggleSubAgents: canToggleCompletedChildren,
                }}
                actions={{
                  editTitle: startEditing,
                  generateTitle: () => requestGenerateWorkspaceTitle(workspaceId),
                  configureMcp: () => setOpenModal("mcp"),
                  configureHeartbeat: () => setOpenModal("heartbeat"),
                  configureMessaging: () => setOpenModal("messaging"),
                  togglePinned: setWorkspacePinned
                    ? () => {
                        // Fire-and-forget: optimistic reorder happens synchronously
                        // inside setWorkspacePinned; errors are logged there.
                        void setWorkspacePinned(workspaceId, !isPinned);
                      }
                    : undefined,
                  // Reset the read marker to epoch so existing activity is treated as unseen.
                  markUnread: () => updatePersistedState(getWorkspaceLastReadKey(workspaceId), 0),
                  toggleSubAgents: toggleCompletedChildren,
                  fork: (anchorEl) => void onForkWorkspace(workspaceId, anchorEl),
                  stopRuntime: onStopRuntime
                    ? () =>
                        void onStopRuntime(workspaceId, overflowMenuButtonRef.current ?? undefined)
                    : undefined,
                  archive: (anchorEl) => void onArchiveWorkspace(workspaceId, anchorEl),
                }}
                isPinned={isPinned}
                subAgentsExpanded={isCompletedChildrenExpanded}
                onCloseMenu={() => ctxMenu.close()}
              />
            </WorkspaceRowMenu>
          )
        )}

        {/* Keep title row anchored so status dot/title align across single+double-line states. */}
        <div className={cn("flex min-w-0 flex-col", isAvatarRow ? "gap-[3px]" : "flex-1 gap-0.5")}>
          <div
            className={cn(
              // Keep the title column shrinkable on narrow/mobile viewports so the
              // right-side status badges never force horizontal sidebar scrolling.
              "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5"
            )}
          >
            {isEditing ? (
              <input
                className="bg-input-bg text-input-text border-input-border font-inherit focus:border-input-border-focus col-span-2 min-w-0 flex-1 rounded-sm border px-1 text-left text-[13px] outline-none select-text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={() => void handleConfirmEdit()}
                ref={handleEditInputRef}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Edit title for workspace ${displayTitle}`}
                data-workspace-id={workspaceId}
              />
            ) : (
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span
                  className={cn(
                    "min-w-0 truncate text-left text-[14px] transition-colors duration-200",
                    isAvatarRow ? "leading-[18px]" : "leading-6",
                    groupLabel && !suppressGroupMemberTitle ? "max-w-[45%] shrink-0" : "flex-1",
                    !isDisabled && "cursor-pointer",
                    (isGeneratingTitle || isPendingAutoTitle) && "italic",
                    titleColorClass
                  )}
                >
                  {suppressGroupMemberTitle ? memberOnlyLabel : workspaceTitle}
                </span>
                {groupLabel && !suppressGroupMemberTitle && (
                  <span
                    data-testid={`workspace-scope-label-${workspaceId}`}
                    className="text-muted min-w-0 flex-1 truncate text-[11px] leading-6"
                  >
                    scope: {groupLabel}
                  </span>
                )}
              </div>
            )}

            {!isInitializing && !isEditing && (
              <div className="flex items-center gap-1">
                {/* Avatar rows show pinning by their section instead. */}
                {isPinned && !isAvatarRow && (
                  <Pin className="text-muted h-3 w-3 shrink-0" aria-label="Pinned" role="img" />
                )}
                {shouldShowInlineArchivingStatus ? (
                  <div
                    className="text-muted flex shrink-0 items-center gap-1 text-xs whitespace-nowrap"
                    data-testid={`workspace-inline-archiving-status-${workspaceId}`}
                  >
                    <ArchiveIcon className="h-3 w-3 shrink-0" />
                    <span>Archiving...</span>
                  </div>
                ) : (
                  terminalActiveCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-muted flex items-center gap-0.5">
                          <WorkspaceTerminalIcon className="h-3 w-3" />
                          <span className="text-[11px]">{terminalActiveCount}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {terminalActiveCount} terminal{terminalActiveCount !== 1 ? "s" : ""} running
                        commands
                      </TooltipContent>
                    </Tooltip>
                  )
                )}
              </div>
            )}
          </div>
          {hasSecondaryRow && (
            <div
              id={secondaryStatusDescriptionId}
              className="min-w-0"
              data-testid={`workspace-secondary-row-${workspaceId}`}
              data-row-subtitle
            >
              {isRemoving ? (
                <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  <span className="min-w-0 truncate">Deleting...</span>
                </div>
              ) : awaitingUserQuestion ? (
                <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs leading-4">
                  <MessageCircleQuestionMark className="h-3 w-3 shrink-0" strokeWidth={1.8} />
                  <span className="min-w-0 truncate">Xum has a few questions</span>
                </div>
              ) : shouldShowHiddenSubAgentsStatus && hiddenSubAgentsPresentation ? (
                <SidebarActivityIndicator
                  icon={hiddenSubAgentsPresentation.icon}
                  text={hiddenSubAgentsPresentation.text}
                  testId={`workspace-hidden-subagents-${workspaceId}`}
                />
              ) : shouldShowDelegatedStatus && delegatedActivity ? (
                <DelegatedActivityIndicator
                  workspaceId={workspaceId}
                  activity={delegatedActivity}
                />
              ) : shouldShowWorkflowStatus ? (
                <WorkflowActivityIndicator
                  workspaceId={workspaceId}
                  activeWorkflowRunCount={activeWorkflowRunCount}
                />
              ) : shouldShowBashMonitorStatus ? (
                <SidebarActivityIndicator
                  text={formatBashMonitorCount(activeBashMonitorCount)}
                  testId={`workspace-bash-monitor-activity-${workspaceId}`}
                />
              ) : (
                <WorkspaceStatusIndicator
                  workspaceId={workspaceId}
                  fallbackModel={fallbackModel}
                  isCreating={isInitializing}
                />
              )}
            </div>
          )}
        </div>
      </div>
      {/* Outside the clickable row: React bubbles a portal's events through its React parents,
          and a click on a dialog's backdrop (outside [role="dialog"]) would select the row. */}
      {openModal !== null && (
        // No loading fallback: the small chunk arrives in a moment, and an empty slot keeps the
        // sidebar rows still. A failed load shows LazyFeature's Reload message under the row.
        <LazyFeature name="Workspace settings">
          <RowSettingsDialog
            kind={openModal}
            workspace={metadata}
            projectPath={projectPath}
            onClose={() => setOpenModal(null)}
          />
        </LazyFeature>
      )}
      {titleError && isEditing && (
        <div className="bg-error-bg border-error text-error absolute top-full right-8 left-8 z-10 mt-1 rounded-sm border px-2 py-1.5 text-xs">
          {titleError}
        </div>
      )}
    </React.Fragment>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Export (dispatches based on variant)
// ─────────────────────────────────────────────────────────────────────────────

type UnifiedAgentListItemProps = AgentListItemProps | DraftAgentListItemProps;

function AgentListItemInner(props: UnifiedAgentListItemProps) {
  if (props.variant === "draft") {
    return <DraftAgentListItemInner {...props} />;
  }

  const rowMeta = props.rowRenderMeta;
  if (rowMeta?.rowKind === "subagent") {
    // Connector geometry is driven by render metadata so visible siblings keep
    // consistent single/middle/last shapes as parents expand/collapse children.
    const isElbowActive = isSidebarSubAgentRunning(props.metadata, {
      isWorkspaceLiveActive: () => props.isWorkspaceLiveActive === true,
    });
    const connectorLayout = props.subAgentConnectorLayout ?? "default";
    const connectorDepth = props.depth ?? rowMeta.depth;
    const connectorRailX = getSubAgentParentRailX(connectorDepth, connectorLayout);
    const childStatusCenterX = getSubAgentChildStatusCenterX(connectorDepth);
    const ancestorTrunks = rowMeta.ancestorTrunks.map((trunk) => ({
      left: getAncestorRailX(trunk.depth, connectorLayout),
      active: trunk.active,
    }));

    return (
      <SubAgentListItem
        connectorPosition={rowMeta.connectorPosition}
        connectorStartsAtParent={rowMeta.connectorStartsAtParent}
        sharedTrunkActiveThroughRow={rowMeta.sharedTrunkActiveThroughRow}
        sharedTrunkActiveBelowRow={rowMeta.sharedTrunkActiveBelowRow}
        ancestorTrunks={ancestorTrunks}
        connectorRailX={connectorRailX}
        childStatusCenterX={childStatusCenterX}
        isSelected={props.isSelected}
        isElbowActive={isElbowActive}
      >
        <RegularAgentListItemInner {...props} />
      </SubAgentListItem>
    );
  }

  return <RegularAgentListItemInner {...props} />;
}

export const AgentListItem = React.memo(AgentListItemInner);
