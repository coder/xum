import {
  Bot,
  CheckCircle2,
  CircleSlash2,
  CircleX,
  Clock3,
  LoaderCircle,
  Workflow,
} from "lucide-react";

import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { shortenWorkflowRunId } from "@/browser/components/ProjectSidebar/sidebarTaskGroups";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useRouter } from "@/browser/contexts/RouterContext";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { getSubAgentTasksExpandedKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { isActionableTaskExecutionStatus } from "@/browser/utils/ui/workspaceFiltering";
import { cn } from "@/common/lib/utils";

interface DescendantSubAgent {
  workspace: FrontendWorkspaceMetadata;
  depth: number;
}

const ACTIVE_SUBAGENT_STATUSES = new Set<FrontendWorkspaceMetadata["taskStatus"]>([
  "queued",
  "starting",
  "running",
  "awaiting_report",
]);

export function isSubAgentActive(workspace: FrontendWorkspaceMetadata): boolean {
  return (
    isActionableTaskExecutionStatus(workspace.taskExecutionStatus) ||
    ACTIVE_SUBAGENT_STATUSES.has(workspace.taskStatus)
  );
}

/** Live workers of one workflow run, in traversal order (parents before children). */
export interface WorkflowAgentGroup {
  runId: string;
  /** Display name stamped at spawn time; absent on runs from before the field existed. */
  workflowName?: string;
  workers: DescendantSubAgent[];
}

export interface DescendantAgents {
  /** User-owned descendant tasks in stable workspace order. */
  subAgents: DescendantSubAgent[];
  /** Workflow-owned descendants grouped per run, in first-encounter order. */
  workflowGroups: WorkflowAgentGroup[];
}

/**
 * Split the parent's descendants into user-owned sub-agents and workflow
 * workers. Workflow workers stay transient implementation details the parent
 * never manages individually, but they ARE the workflow's current state, so the
 * tray lists them grouped per run instead of leaving the run invisible.
 * User-owned tasks spawned by a worker stay inside that run's group.
 */
export function collectDescendantAgents(
  workspaces: Iterable<FrontendWorkspaceMetadata>,
  parentWorkspaceId: string
): DescendantAgents {
  const childrenByParentId = new Map<string, FrontendWorkspaceMetadata[]>();
  for (const workspace of workspaces) {
    if (
      workspace.parentWorkspaceId == null ||
      isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
    ) {
      continue;
    }
    const children = childrenByParentId.get(workspace.parentWorkspaceId) ?? [];
    children.push(workspace);
    childrenByParentId.set(workspace.parentWorkspaceId, children);
  }

  const subAgents: DescendantSubAgent[] = [];
  const workflowGroups: WorkflowAgentGroup[] = [];
  const groupsByRunId = new Map<string, WorkflowAgentGroup>();
  const visited = new Set<string>([parentWorkspaceId]);
  const stack = (childrenByParentId.get(parentWorkspaceId) ?? [])
    .map((workspace) => ({ workspace, depth: 1, runId: workspace.workflowTask?.runId ?? null }))
    .reverse();

  while (stack.length > 0) {
    const next = stack.pop();
    if (next == null || visited.has(next.workspace.id)) {
      continue;
    }
    visited.add(next.workspace.id);

    if (next.runId == null) {
      subAgents.push({ workspace: next.workspace, depth: next.depth });
    } else {
      let group = groupsByRunId.get(next.runId);
      if (group == null) {
        group = { runId: next.runId, workers: [] };
        groupsByRunId.set(next.runId, group);
        workflowGroups.push(group);
      }
      group.workflowName ??= next.workspace.workflowTask?.workflowName;
      group.workers.push({ workspace: next.workspace, depth: next.depth });
    }

    const children = childrenByParentId.get(next.workspace.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({
        workspace: child,
        depth: next.depth + 1,
        // A nested workflow's workers regroup under their own run; user-owned
        // tasks spawned by a worker inherit the worker's run.
        runId: child.workflowTask?.runId ?? next.runId,
      });
    }
  }

  return { subAgents, workflowGroups };
}

export function getSubAgentStatusPresentation(workspace: FrontendWorkspaceMetadata): {
  label: string;
  icon: typeof Clock3;
  iconClassName: string;
} {
  // No execution status (never-reawakened sub-agent) falls through to taskStatus.
  if (workspace.taskExecutionStatus !== undefined) {
    switch (workspace.taskExecutionStatus) {
      case "queued":
        return { label: "Queued", icon: Clock3, iconClassName: "text-muted" };
      case "starting":
      case "running":
        return {
          label: "Running",
          icon: LoaderCircle,
          iconClassName: "text-success animate-spin",
        };
      case "completed":
        return { label: "Completed", icon: CheckCircle2, iconClassName: "text-success" };
      case "interrupted":
        return { label: "Interrupted", icon: CircleSlash2, iconClassName: "text-muted" };
      case "error":
        return { label: "Failed", icon: CircleX, iconClassName: "text-danger" };
    }
  }
  switch (workspace.taskStatus) {
    case "queued":
      return { label: "Queued", icon: Clock3, iconClassName: "text-muted" };
    case "starting":
      return { label: "Starting", icon: LoaderCircle, iconClassName: "text-warning animate-spin" };
    case "running":
      return { label: "Running", icon: LoaderCircle, iconClassName: "text-success animate-spin" };
    case "awaiting_report":
      return { label: "Finishing", icon: LoaderCircle, iconClassName: "text-warning animate-spin" };
    case "reported":
      return { label: "Completed", icon: CheckCircle2, iconClassName: "text-success" };
    case "interrupted":
      return { label: "Interrupted", icon: CircleSlash2, iconClassName: "text-muted" };
    default:
      return { label: "Inactive", icon: CheckCircle2, iconClassName: "text-muted" };
  }
}

function AgentRow(props: {
  workspace: FrontendWorkspaceMetadata;
  indentLevel: number;
  onNavigate: (workspaceId: string) => void;
}) {
  const status = getSubAgentStatusPresentation(props.workspace);
  const StatusIcon = status.icon;
  return (
    <button
      type="button"
      onClick={() => props.onNavigate(props.workspace.id)}
      className="hover:bg-hover flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors"
      style={{ paddingLeft: `${Math.min(props.indentLevel, 4) * 12 + 8}px` }}
    >
      <StatusIcon className={cn("size-3.5 shrink-0", status.iconClassName)} />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">
        {props.workspace.title ?? props.workspace.name}
      </span>
      <span className="text-muted shrink-0 text-[10px]">{status.label}</span>
    </button>
  );
}

function formatWorkflowSummary(workflowGroups: readonly WorkflowAgentGroup[]): string {
  const workerCount = workflowGroups.reduce((count, group) => count + group.workers.length, 0);
  const activeWorkerCount = workflowGroups.reduce(
    (count, group) =>
      count + group.workers.filter(({ workspace }) => isSubAgentActive(workspace)).length,
    0
  );
  const label =
    workflowGroups.length === 1
      ? `Workflow${workflowGroups[0].workflowName != null ? ` ${workflowGroups[0].workflowName}` : ""}`
      : `${workflowGroups.length} workflows`;
  // Workers vanish once they report, so a lingering all-inactive group (e.g. an
  // interrupted run) must not read as running.
  const workers =
    activeWorkerCount > 0
      ? `${activeWorkerCount} active`
      : `${workerCount} agent${workerCount === 1 ? "" : "s"}`;
  return `${label} · ${workers}`;
}

export function SubAgentTasksDecoration(props: { workspaceId: string }) {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const { navigateToWorkspace } = useRouter();
  const [expanded, setExpanded] = usePersistedState(
    getSubAgentTasksExpandedKey(props.workspaceId),
    false
  );
  const { subAgents, workflowGroups } = collectDescendantAgents(
    workspaceMetadata.values(),
    props.workspaceId
  );

  if (subAgents.length === 0 && workflowGroups.length === 0) {
    return null;
  }

  const activeCount = subAgents.filter(({ workspace }) => isSubAgentActive(workspace)).length;
  const SummaryIcon = subAgents.length === 0 ? Workflow : Bot;

  return (
    <ChatInputDecoration
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      dataComponent="SubAgentTasksDecoration"
      contentClassName="max-h-52 space-y-1 overflow-y-auto py-2"
      summary={
        <>
          <SummaryIcon className="text-muted group-hover:text-secondary size-3.5 shrink-0 transition-colors" />
          <span className="text-muted group-hover:text-secondary min-w-0 truncate transition-colors">
            {subAgents.length > 0 && (
              <>
                <span className="font-medium">{subAgents.length}</span> sub-agent
                {subAgents.length === 1 ? "" : "s"}
                {activeCount > 0 ? ` · ${activeCount} active` : " · inactive"}
              </>
            )}
            {subAgents.length > 0 && workflowGroups.length > 0 && " · "}
            {workflowGroups.length > 0 && formatWorkflowSummary(workflowGroups)}
          </span>
        </>
      }
      renderExpanded={() => (
        <>
          {subAgents.map(({ workspace, depth }) => (
            <AgentRow
              key={workspace.id}
              workspace={workspace}
              indentLevel={depth - 1}
              onNavigate={navigateToWorkspace}
            />
          ))}
          {workflowGroups.map((group) => (
            <div key={group.runId} className="space-y-1">
              <div className="text-muted flex min-w-0 items-center gap-2 px-2 pt-1.5 pb-0.5 text-[10px]">
                <Workflow className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate font-medium">
                  Workflow · {group.workflowName ?? shortenWorkflowRunId(group.runId)}
                </span>
              </div>
              {group.workers.map(({ workspace, depth }) => (
                <AgentRow
                  key={workspace.id}
                  workspace={workspace}
                  // Nest workers one level under their run header; nested runs keep
                  // their relative depth without inheriting the outer tree's offset.
                  indentLevel={Math.max(0, depth - group.workers[0].depth) + 1}
                  onNavigate={navigateToWorkspace}
                />
              ))}
            </div>
          ))}
        </>
      )}
    />
  );
}
