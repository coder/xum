import React from "react";
import {
  GitCompare,
  HeartPulse,
  MessageCircle,
  PanelRightOpen,
  Plus,
  SquareTerminal,
  Target,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { goalActiveMode, isGoalPendingPersistence, type GoalSnapshot } from "@/common/types/goal";
import { formatHeartbeatInterval } from "@/constants/heartbeat";
import { SIDE_CHAT_INITIAL_TITLE } from "@/constants/workspaceDefaults";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useOptionalWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { makeSideChatTabType, type TabType } from "@/browser/types/rightSidebar";

/**
 * Side chats listed before the card collapses the rest into one row. The card floats over the
 * chat, so every list in it is capped to keep its footprint bounded.
 */
export const OVERVIEW_MAX_SIDE_CHATS = 3;

interface RightSidebarOverviewProps {
  workspaceId: string;
  /** Reopen the full sidebar without changing its tabs. */
  onExpand: () => void;
  /** Reopen the full sidebar on this tab (added to the focused pane when it is not open). */
  onOpenTab: (tab: TabType) => void;
  /** Start a side chat; absent where side chats cannot start (a side chat itself). */
  onNewSideChat?: () => void;
  creatingSideChat: boolean;
}

/** Side chats of this workspace, newest first. */
function getOverviewSideChats(
  workspaceMetadata: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  workspaceId: string
): FrontendWorkspaceMetadata[] {
  return [...workspaceMetadata.values()]
    .filter((meta) => meta.sideChatParentWorkspaceId === workspaceId)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

function getGoalStatus(goal: GoalSnapshot): { label: string; className?: string } {
  // Pending (mid-stream, unsaved) goals stay unaccented, like the Goal tab label, so the accent
  // does not flicker during a stream.
  const mode = isGoalPendingPersistence(goal) ? null : goalActiveMode(goal.status);
  switch (mode) {
    case "running":
      return { label: "Active", className: "text-success" };
    case "paused":
      return { label: "Paused", className: "text-warning" };
    case "budget_limited":
      return { label: "Budget limit", className: "text-warning" };
    case null:
      return { label: goal.status === "complete" ? "Complete" : "Active" };
  }
}

/**
 * What the collapsed right sidebar shows instead of a bare rail (Codex desktop style): a small
 * card over the chat's top-right corner that summarizes the workspace (goal, changes, side
 * chats, running work, heartbeat) and jumps to the matching sidebar tab. Sections without
 * content are left out, so the card stays as small as the workspace allows.
 */
export const RightSidebarOverview: React.FC<RightSidebarOverviewProps> = (props) => {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const metadata = workspaceMetadata.get(props.workspaceId) ?? null;
  const sidebarState = useOptionalWorkspaceSidebarState(props.workspaceId);
  const gitStatus = useGitStatus(props.workspaceId);

  const goal = sidebarState?.goal ?? null;
  const goalStatus = goal != null ? getGoalStatus(goal) : null;
  const hasRepository = hasWorkspaceRepository(metadata);
  // Git reports an empty branch for a detached HEAD; the workspace name stands in for it then.
  const branch =
    gitStatus != null && gitStatus.branch.length > 0 ? gitStatus.branch : metadata?.name;
  const sideChats = getOverviewSideChats(workspaceMetadata, props.workspaceId);
  const hiddenSideChatCount = Math.max(0, sideChats.length - OVERVIEW_MAX_SIDE_CHATS);
  const showSideChats = sideChats.length > 0 || props.onNewSideChat != null;
  const runningTerminals = sidebarState?.terminalActiveCount ?? 0;
  const runningWorkflows = sidebarState?.activeWorkflowRunCount ?? 0;
  const heartbeat = metadata?.heartbeat?.enabled === true ? metadata.heartbeat : null;

  return (
    <div className="divide-border-light flex flex-col divide-y px-3 pb-1.5 text-xs">
      <div className="flex items-center justify-between gap-2 py-2">
        <span className="text-muted text-[11px] font-medium">Overview</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={props.onExpand}
              className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent -mr-1 flex h-6 w-6 items-center justify-center rounded-md focus-visible:ring-1"
            >
              <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent align="center">Expand sidebar</TooltipContent>
        </Tooltip>
      </div>

      {goal != null && goalStatus != null && (
        <OverviewSection title="Goal">
          <OverviewRow
            Icon={Target}
            label={goal.objective}
            detail={<span className={goalStatus.className}>{goalStatus.label}</span>}
            onClick={() => props.onOpenTab("goal")}
          />
        </OverviewSection>
      )}

      {hasRepository && (
        <OverviewSection title={branch ?? "Changes"}>
          <OverviewRow
            Icon={GitCompare}
            label="Changes"
            detail={
              gitStatus != null && (
                <span className="counter-nums flex gap-1.5">
                  <span className="text-success-light">
                    +{gitStatus.outgoingAdditions.toLocaleString()}
                  </span>
                  <span className="text-danger-light">
                    -{gitStatus.outgoingDeletions.toLocaleString()}
                  </span>
                </span>
              )
            }
            onClick={() => props.onOpenTab("review")}
          />
        </OverviewSection>
      )}

      {showSideChats && (
        <OverviewSection
          title="Side chats"
          action={
            props.onNewSideChat != null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="New side chat"
                    onClick={props.onNewSideChat}
                    disabled={props.creatingSideChat}
                    className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent -mr-1 flex h-5 w-5 items-center justify-center rounded-md focus-visible:ring-1 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="center">New side chat</TooltipContent>
              </Tooltip>
            )
          }
        >
          {sideChats.length === 0 ? (
            <p className="text-muted px-1.5 py-1">
              Ask a side question without derailing this chat
            </p>
          ) : (
            <>
              {sideChats.slice(0, OVERVIEW_MAX_SIDE_CHATS).map((sideChat) => (
                <OverviewRow
                  key={sideChat.id}
                  Icon={MessageCircle}
                  label={
                    sideChat.title != null && sideChat.title.length > 0
                      ? sideChat.title
                      : SIDE_CHAT_INITIAL_TITLE
                  }
                  onClick={() => props.onOpenTab(makeSideChatTabType(sideChat.id))}
                />
              ))}
              {hiddenSideChatCount > 0 && (
                <OverviewRow label={`${hiddenSideChatCount} more`} muted onClick={props.onExpand} />
              )}
            </>
          )}
        </OverviewSection>
      )}

      {(runningTerminals > 0 || runningWorkflows > 0) && (
        <OverviewSection title="Running">
          {runningWorkflows > 0 && (
            <OverviewRow
              Icon={Workflow}
              label="Workflows"
              detail={<span className="counter-nums">{runningWorkflows}</span>}
              onClick={() => props.onOpenTab("workflows")}
            />
          )}
          {runningTerminals > 0 && (
            <OverviewRow
              Icon={SquareTerminal}
              label="Terminals"
              detail={<span className="counter-nums">{runningTerminals}</span>}
              onClick={props.onExpand}
            />
          )}
        </OverviewSection>
      )}

      {heartbeat != null && (
        <OverviewSection title="Scheduled">
          <OverviewRow
            Icon={HeartPulse}
            label="Heartbeat"
            detail={
              heartbeat.intervalMs != null &&
              `Every ${formatHeartbeatInterval(heartbeat.intervalMs)}`
            }
          />
        </OverviewSection>
      )}
    </div>
  );
};

const OverviewSection: React.FC<{
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = (props) => (
  <section aria-label={props.title} className="flex flex-col gap-0.5 py-2">
    <div className="flex min-w-0 items-center justify-between gap-2 px-1.5 pb-0.5">
      <h3 className="text-muted truncate text-[11px] font-medium">{props.title}</h3>
      {props.action}
    </div>
    {props.children}
  </section>
);

/** One line of the card: a button when it leads somewhere, plain text otherwise. */
const OverviewRow: React.FC<{
  Icon?: LucideIcon;
  label: string;
  detail?: React.ReactNode;
  muted?: boolean;
  onClick?: () => void;
}> = (props) => {
  const content = (
    <>
      {props.Icon != null && (
        <props.Icon className="text-muted h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span
        className={cn("min-w-0 flex-1 truncate", props.muted ? "text-muted" : "text-foreground")}
      >
        {props.label}
      </span>
      {props.detail != null && props.detail !== false && (
        <span className="text-muted shrink-0">{props.detail}</span>
      )}
    </>
  );
  const className = "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left";
  if (props.onClick == null) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        className,
        "hover:bg-hover focus-visible:bg-hover transition-colors focus-visible:outline-none"
      )}
    >
      {content}
    </button>
  );
};
