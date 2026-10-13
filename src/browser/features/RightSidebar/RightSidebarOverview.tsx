import React from "react";
import {
  FileText,
  HeartPulse,
  MessageCircle,
  PanelRightOpen,
  Plus,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ArtifactEntry } from "@/common/orpc/schemas/artifacts";
import { goalActiveMode, isGoalPendingPersistence, type GoalSnapshot } from "@/common/types/goal";
import { hasGoalBudgetLimit } from "@/common/utils/goals/budgetPricing";
import {
  formatCostWithDollar,
  getTotalCost,
  sumUsageHistory,
  type ChatUsageDisplay,
} from "@/common/utils/tokens/usageAggregator";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";
import { formatHeartbeatIntervalShort, HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";
import { useAppConfig } from "@/browser/stores/AppConfigStore";
import { SIDE_CHAT_INITIAL_TITLE } from "@/constants/workspaceDefaults";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useOptionalAPI } from "@/browser/contexts/API";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import {
  formatGoalBudgetSummary,
  formatGoalTurns,
} from "@/browser/features/Tools/Goal/goalToolUtils";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import {
  useOptionalWorkspaceSidebarState,
  useWorkspaceUsage,
  workspaceStore,
} from "@/browser/stores/WorkspaceStore";
import { isAbortError } from "@/browser/utils/isAbortError";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { makeSideChatTabType, type TabType } from "@/browser/types/rightSidebar";
import { openArtifact } from "./ArtifactsTab/openArtifact";
import { appViewDetails, useMcpAppViews } from "./ArtifactsTab/mcpAppViewsStore";
import { appViewTabFor } from "./AppViewTab/appViewTabs";
import { TAB_ICONS } from "./Tabs/tabIcons";

/**
 * Rows a list section (side chats, outputs) shows before folding the rest into one "N more"
 * row. The card floats over the chat, so every list in it is capped to keep it bounded.
 */
export const OVERVIEW_MAX_LIST_ROWS = 3;

interface RightSidebarOverviewProps {
  workspaceId: string;
  /** Reopen the full sidebar without changing its tabs. */
  onExpand: () => void;
  /** Reopen the full sidebar on this tab (added to the focused pane when it is not open). */
  onOpenTab: (tab: TabType) => void;
  /** Reopen the full sidebar on a terminal tab; absent until the layout has one. */
  onOpenTerminals?: () => void;
  /** Start a side chat; absent where side chats cannot start (a side chat itself). */
  onNewSideChat?: () => void;
  creatingSideChat: boolean;
  /** The Artifacts experiment is on, so the card lists the newest outputs. */
  artifactsEnabled: boolean;
  /** Agent-flagged review hunks the user has not read (the Review tab's attention cue). */
  unreadAssisted: number;
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

/**
 * Second line per side chat (same order): `#n` when its title is shared, so several untitled
 * chats ("New chat") read apart. `#1` is the oldest, so a number stays with its chat as newer ones
 * arrive.
 */
function getSideChatOrdinals(labels: readonly string[]): Array<string | null> {
  const total = new Map<string, number>();
  for (const label of labels) total.set(label, (total.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  // Labels are newest first: the first one met is the newest, number `total`.
  return labels.map((label) => {
    const count = total.get(label) ?? 0;
    if (count < 2) return null;
    const met = seen.get(label) ?? 0;
    seen.set(label, met + 1);
    return `#${count - met}`;
  });
}

function getGoalStatus(goal: GoalSnapshot): { label: string; className?: string } {
  const status = getGoalStatusLabel(goal);
  // Pending (mid-stream, unsaved) goals stay unaccented, like the Goal tab label, so the accent
  // does not flicker during a stream. The label still follows the queued status: a pause queued
  // mid-stream reads "Paused", not "Active".
  return isGoalPendingPersistence(goal) ? { label: status.label } : status;
}

function getGoalStatusLabel(goal: GoalSnapshot): { label: string; className?: string } {
  switch (goalActiveMode(goal.status)) {
    case "running":
      return { label: "Active", className: "text-success" };
    case "paused":
      return { label: "Paused", className: "text-warning" };
    case "budget_limited":
      return { label: "Budget limit", className: "text-warning" };
    case null:
      return { label: "Complete" };
  }
}

/** The goal's spend and turns against its limits; null when it has neither limit. */
function getGoalLimits(goal: GoalSnapshot): string | null {
  const parts: string[] = [];
  if (hasGoalBudgetLimit(goal.budgetCents)) {
    parts.push(formatGoalBudgetSummary(goal.costCents, goal.budgetCents));
  }
  if (goal.turnCap != null) parts.push(formatGoalTurns(goal.turnsUsed, goal.turnCap));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Session cost and tokens, as the Stats tab totals them (persisted session plus live stream).
 * `costIncomplete`: some usage has unknown pricing, so `cost` is only the priced part.
 */
function useSessionStats(
  workspaceId: string
): { cost?: number; costIncomplete: boolean; tokens: number } | null {
  const usage = useWorkspaceUsage(workspaceId);
  const parts: ChatUsageDisplay[] = [];
  if (usage.sessionTotal) parts.push(usage.sessionTotal);
  if (usage.liveCostUsage) parts.push(usage.liveCostUsage);
  const total = parts.length > 0 ? sumUsageHistory(parts) : undefined;
  if (total == null) return null;
  const tokens =
    total.input.tokens +
    total.cached.tokens +
    total.cacheCreate.tokens +
    total.output.tokens +
    total.reasoning.tokens;
  const costIncomplete = total.hasUnknownCosts === true;
  const cost = getTotalCost(total);
  // The sum counts unpriced usage as $0, so a session with nothing priced has no cost to show
  // (only its tokens), rather than a misleading "$0.00".
  return { cost: costIncomplete && cost === 0 ? undefined : cost, costIncomplete, tokens };
}

/**
 * What the collapsed right sidebar shows instead of a bare rail (Codex desktop style): a small
 * card over the chat's top-right corner with the gist of each sidebar tab (stats, goal, changes,
 * outputs, side chats, running work, heartbeat); each row reopens the sidebar on its tab. Only
 * data is shown, no explanatory copy, and sections without data are left out, so the card
 * stays as small as the workspace allows.
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
  const sideChatLabels = sideChats.map((chat) =>
    chat.title != null && chat.title.length > 0 ? chat.title : SIDE_CHAT_INITIAL_TITLE
  );
  const sideChatOrdinals = getSideChatOrdinals(sideChatLabels);
  const showSideChats = sideChats.length > 0 || props.onNewSideChat != null;
  // The first side chat past the cap once the user listed them all, else null (capped list).
  const [revealedSideChatId, setRevealedSideChatId] = React.useState<string | null>(null);
  const workflowRuns = sidebarState?.activeWorkflowRunCount ?? 0;
  const terminals = sidebarState?.terminalSessionCount ?? 0;
  const heartbeat = metadata?.heartbeat?.enabled === true ? metadata.heartbeat : null;
  // A heartbeat without its own interval follows the global default, as the scheduler does.
  const defaultHeartbeatIntervalMs = useAppConfig((config) => config.heartbeatDefaultIntervalMs);
  const heartbeatIntervalMs =
    heartbeat?.intervalMs ?? defaultHeartbeatIntervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS;
  const showActivity = workflowRuns > 0 || terminals > 0 || heartbeat != null;

  return (
    <div className="divide-border-light flex flex-col divide-y px-3 pb-1.5 text-xs">
      {/* Stats lead the card (the Stats tab's session totals) and share a row with Expand. */}
      <div className="flex items-center gap-2 py-1.5">
        <OverviewStats workspaceId={props.workspaceId} onOpen={() => props.onOpenTab("costs")} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={props.onExpand}
              className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md focus-visible:ring-1"
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
            Icon={TAB_ICONS.goal}
            label={goal.objective}
            detail={<span className={goalStatus.className}>{goalStatus.label}</span>}
            sub={getGoalLimits(goal)}
            onClick={() => props.onOpenTab("goal")}
          />
        </OverviewSection>
      )}

      {hasRepository && (
        <OverviewSection title={branch ?? "Changes"}>
          <OverviewRow
            Icon={TAB_ICONS.review}
            label="Changes"
            detail={
              (gitStatus != null || props.unreadAssisted > 0) && (
                <span className="counter-nums flex items-center gap-1.5">
                  {gitStatus != null && (
                    <>
                      <span className="text-success-light">
                        +{gitStatus.outgoingAdditions.toLocaleString()}
                      </span>
                      <span className="text-danger-light">
                        -{gitStatus.outgoingDeletions.toLocaleString()}
                      </span>
                    </>
                  )}
                  {/* Reported apart from git status, so it shows even before that loads. */}
                  {props.unreadAssisted > 0 && (
                    <span
                      className="text-review-accent inline-flex items-center gap-0.5"
                      aria-label={`${props.unreadAssisted} unread agent-flagged hunk${props.unreadAssisted === 1 ? "" : "s"}`}
                    >
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      {props.unreadAssisted}
                    </span>
                  )}
                </span>
              )
            }
            onClick={() => props.onOpenTab("review")}
          />
        </OverviewSection>
      )}

      {props.artifactsEnabled && (
        <OverviewOutputs workspaceId={props.workspaceId} onOpenTab={props.onOpenTab} />
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
          {(revealedSideChatId != null
            ? sideChats
            : sideChats.slice(0, OVERVIEW_MAX_LIST_ROWS)
          ).map((sideChat, index) => (
            <OverviewRow
              key={sideChat.id}
              Icon={MessageCircle}
              label={sideChatLabels[index]}
              sub={sideChatOrdinals[index]}
              focusOnMount={sideChat.id === revealedSideChatId}
              onClick={() => props.onOpenTab(makeSideChatTabType(sideChat.id))}
            />
          ))}
          {revealedSideChatId == null && (
            // Closed side chats have no tab to reopen, so "more" lists them here instead
            // (the card scrolls past its height cap) and moves focus to the first one shown.
            <MoreRow
              count={sideChats.length - OVERVIEW_MAX_LIST_ROWS}
              onClick={() => setRevealedSideChatId(sideChats[OVERVIEW_MAX_LIST_ROWS]?.id ?? null)}
            />
          )}
        </OverviewSection>
      )}

      {showActivity && (
        // Each row names itself, so this group needs no visible heading.
        <OverviewSection title="Activity" showTitle={false}>
          {workflowRuns > 0 && (
            <OverviewRow
              Icon={TAB_ICONS.workflows}
              label="Workflows"
              detail={<span className="counter-nums">{workflowRuns}</span>}
              onClick={() => props.onOpenTab("workflows")}
            />
          )}
          {terminals > 0 && (
            <OverviewRow
              Icon={SquareTerminal}
              label="Terminals"
              detail={<span className="counter-nums">{terminals}</span>}
              onClick={props.onOpenTerminals}
            />
          )}
          {heartbeat != null && (
            <OverviewRow
              Icon={HeartPulse}
              label="Heartbeat"
              detail={`Every ${formatHeartbeatIntervalShort(heartbeatIntervalMs)}`}
            />
          )}
        </OverviewSection>
      )}
    </div>
  );
};

/**
 * The stats row. It owns the usage subscription, so live stream telemetry rerenders only this
 * row, not the whole card.
 */
const OverviewStats: React.FC<{ workspaceId: string; onOpen: () => void }> = (props) => {
  const stats = useSessionStats(props.workspaceId);
  if (stats == null) return <span className="flex-1" />;
  return (
    <OverviewRow
      Icon={TAB_ICONS.costs}
      numeric
      label={
        stats.cost != null
          ? formatCostWithDollar(stats.cost)
          : `${formatTokens(stats.tokens)} tokens`
      }
      labelAdornment={
        stats.cost != null &&
        stats.costIncomplete && (
          // Same cue as the Stats tab: an unpriced model makes the total a lower bound.
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-warning" aria-label="Cost may be incomplete">
                ?
              </span>
            </TooltipTrigger>
            <TooltipContent align="center">
              Cost may be incomplete — some models in this session have unknown pricing
            </TooltipContent>
          </Tooltip>
        )
      }
      detail={stats.cost != null && `${formatTokens(stats.tokens)} tokens`}
      onClick={props.onOpen}
    />
  );
};

/**
 * The Artifacts tab's newest files and app views. Listed once when the card shows, then again
 * after the agent's file edits; the card is a glance, so it skips the tab's polling.
 */
const OverviewOutputs: React.FC<{
  workspaceId: string;
  onOpenTab: (tab: TabType) => void;
}> = (props) => {
  const api = useOptionalAPI()?.api ?? null;
  const appViews = useMcpAppViews(props.workspaceId);
  const [files, setFiles] = React.useState<readonly ArtifactEntry[]>([]);
  // The backend capped its walk (entry limit, depth, unreadable folders): more files exist than
  // `files` holds, so the "more" row cannot give an exact count.
  const [filesTruncated, setFilesTruncated] = React.useState(false);
  const [refreshTick, setRefreshTick] = React.useState(0);

  React.useEffect(() => {
    if (api == null) return;
    const controller = new AbortController();
    api.artifacts
      .list({ workspaceId: props.workspaceId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        // A failed listing hides the section; the Artifacts tab reports the error.
        const listing = result.success && result.data.available ? result.data : null;
        setFiles(listing?.entries ?? []);
        setFilesTruncated(listing?.truncated === true);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setFiles([]);
        setFilesTruncated(false);
      });
    return () => controller.abort();
  }, [api, props.workspaceId, refreshTick]);

  React.useEffect(
    () =>
      workspaceStore.subscribeFileModifyingTool(
        () => setRefreshTick((tick) => tick + 1),
        props.workspaceId
      ),
    [props.workspaceId]
  );

  // Several calls of one MCP app tool share a label, so each row carries the call's detail
  // (outcome, arguments, and `#n` for repeats) to tell them apart.
  const details = appViewDetails(appViews);
  // Both lists come newest first, but app views carry no time to merge them by. So that a new
  // app result is never pushed out by files, each kind keeps at least one of the capped rows
  // when it has any. A file opens in the Artifacts tab; an app view in its own app tab (Artifacts
  // lists only files). Either tab gets focus (the activated row unmounts as the sidebar expands).
  const appRows =
    appViews.length === 0
      ? 0
      : Math.min(appViews.length, Math.max(1, OVERVIEW_MAX_LIST_ROWS - files.length));
  const fileRows = Math.min(files.length, OVERVIEW_MAX_LIST_ROWS - appRows);
  const shown: Array<{
    key: string;
    Icon: LucideIcon;
    label: string;
    sub?: string | null;
    open: () => void;
  }> = [
    ...files.slice(0, fileRows).map((file) => {
      const slash = file.path.lastIndexOf("/");
      return {
        key: `file:${file.path}`,
        Icon: FileText,
        label: file.path.slice(slash + 1),
        // The folder tells apart files of the same name (reports/summary.md, drafts/summary.md).
        sub: slash > 0 ? file.path.slice(0, slash) : null,
        open: () => {
          openArtifact({ workspaceId: props.workspaceId, path: file.path });
          props.onOpenTab("artifacts");
        },
      };
    }),
    ...appViews.slice(0, appRows).map((view, index) => ({
      key: `app:${view.toolCallId}`,
      Icon: TAB_ICONS.artifacts,
      label: view.label,
      sub: details[index] || null,
      open: () => props.onOpenTab(appViewTabFor(view.toolCallId)),
    })),
  ];
  // A truncated walk can end before reaching any file (only a too-deep or unreadable folder), yet
  // outputs still exist: keep the section for its "More" row.
  if (shown.length === 0 && !filesTruncated) return null;

  return (
    <OverviewSection title="Outputs">
      {shown.map((output) => (
        <OverviewRow
          key={output.key}
          Icon={output.Icon}
          label={output.label}
          sub={output.sub}
          onClick={output.open}
        />
      ))}
      <MoreRow
        count={files.length + appViews.length - shown.length}
        atLeast={filesTruncated}
        onClick={() => props.onOpenTab("artifacts")}
      />
    </OverviewSection>
  );
};

const OverviewSection: React.FC<{
  title: string;
  /** False when the rows name themselves; the title then only labels the region. */
  showTitle?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = (props) => (
  <section aria-label={props.title} className="flex flex-col gap-0.5 py-2">
    {props.showTitle !== false && (
      <div className="flex min-w-0 items-center justify-between gap-2 px-1.5 pb-0.5">
        <h3 className="text-muted truncate text-[11px] font-medium">{props.title}</h3>
        {props.action}
      </div>
    )}
    {props.children}
  </section>
);

/** The rows a capped list leaves out, as one row that leads to the full list. */
const MoreRow: React.FC<{
  count: number;
  /** Only a lower bound is known (a truncated listing): "3+ more", or "More" when none counted. */
  atLeast?: boolean;
  onClick: () => void;
}> = (props) => {
  if (props.count <= 0 && props.atLeast !== true) return null;
  const label =
    props.atLeast === true
      ? props.count > 0
        ? `${props.count}+ more`
        : "More"
      : `${props.count} more`;
  // A live count (new outputs and side chats arrive while the card shows).
  return <OverviewRow label={label} muted numeric onClick={props.onClick} />;
};

/** One line of the card: a button when it leads somewhere, plain text otherwise. */
const OverviewRow: React.FC<{
  Icon?: LucideIcon;
  label: string;
  /** Inline after the label, outside its truncation. */
  labelAdornment?: React.ReactNode;
  detail?: React.ReactNode;
  /** A second, muted line under the label. */
  sub?: string | null;
  muted?: boolean;
  /** The label is a live number (cost, tokens): tabular digits keep it from jittering. */
  numeric?: boolean;
  /** Take keyboard focus when it mounts (the row replaces the control that revealed it). */
  focusOnMount?: boolean;
  onClick?: () => void;
}> = (props) => {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const focusOnMount = props.focusOnMount === true;
  // Moving DOM focus is a side effect on the committed row, so it runs after mount.
  React.useEffect(() => {
    if (focusOnMount) buttonRef.current?.focus();
  }, [focusOnMount]);

  const content = (
    <>
      {props.Icon != null && (
        <props.Icon className="text-muted h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          <span
            className={cn(
              "truncate",
              props.muted ? "text-muted" : "text-foreground",
              props.numeric === true && "counter-nums"
            )}
          >
            {props.label}
          </span>
          {props.labelAdornment}
        </span>
        {props.sub != null && (
          <span className="text-muted counter-nums truncate text-[11px]">{props.sub}</span>
        )}
      </span>
      {props.detail != null && props.detail !== false && (
        <span className="text-muted counter-nums shrink-0">{props.detail}</span>
      )}
    </>
  );
  const className = "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left";
  if (props.onClick == null) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      ref={buttonRef}
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
