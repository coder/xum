import assert from "node:assert/strict";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { normalizeAgentId } from "@/common/utils/agentIds";
import {
  isActiveWorkspaceTurnTaskStatus,
  isWorkspaceTurnTaskId,
} from "@/node/services/taskHandleStore";
import type {
  AgentTaskStatus,
  ResolvedWorkspaceAiSettings,
} from "@/node/services/taskWorkspaceSeam";

/**
 * Pure agent-task tree predicates shared by TaskService and the WorkspaceTurnManager test host.
 * They live outside TaskService so the test host reuses the production rules (queued tasks,
 * archived streams, the streaming fallback) instead of re-implementing and drifting from them.
 */

type ProjectsConfig = ReturnType<Config["loadConfigOrDefault"]>;

export type AgentTaskWorkspaceEntry = WorkspaceConfigEntry & { projectPath: string };

export interface AgentTaskIndex {
  byId: Map<string, AgentTaskWorkspaceEntry>;
  childrenByParent: Map<string, string[]>;
  parentById: Map<string, string>;
}

export const ACTIVE_AGENT_TASK_STATUSES: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>([
  "queued",
  "starting",
  "running",
  "awaiting_report",
]);

export function listAgentTaskWorkspaces(config: ProjectsConfig): AgentTaskWorkspaceEntry[] {
  const tasks: AgentTaskWorkspaceEntry[] = [];
  for (const [projectPath, project] of config.projects) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      if (!workspace.parentWorkspaceId) continue;
      tasks.push({ ...workspace, projectPath });
    }
  }
  return tasks;
}

export function buildAgentTaskIndex(config: ProjectsConfig): AgentTaskIndex {
  const byId = new Map<string, AgentTaskWorkspaceEntry>();
  const childrenByParent = new Map<string, string[]>();
  const parentById = new Map<string, string>();

  for (const task of listAgentTaskWorkspaces(config)) {
    const taskId = task.id!;
    byId.set(taskId, task);

    const parent = task.parentWorkspaceId;
    if (!parent) continue;

    parentById.set(taskId, parent);
    const list = childrenByParent.get(parent) ?? [];
    list.push(taskId);
    childrenByParent.set(parent, list);
  }

  return { byId, childrenByParent, parentById };
}

export function isDescendantAgentTaskUsingParentById(
  parentById: Map<string, string>,
  ancestorWorkspaceId: string,
  taskId: string
): boolean {
  let current = taskId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) return false;
    if (parent === ancestorWorkspaceId) return true;
    current = parent;
  }

  throw new Error(
    `isDescendantAgentTaskUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
  );
}

export function isActiveAgentTaskEntry(
  task: WorkspaceConfigEntry,
  isStreaming: (workspaceId: string) => boolean
): boolean {
  if (isActiveWorkspaceTurnTaskStatus(task.taskExecutionStatus)) {
    return true;
  }
  const status: AgentTaskStatus = task.taskStatus ?? "running";
  if (!ACTIVE_AGENT_TASK_STATUSES.has(status)) {
    return false;
  }

  // Archiving a task stops its stream but intentionally leaves taskStatus untouched in
  // persisted config. Treat archived, non-streaming tasks as inactive so stale status cannot
  // keep ancestors/workspace-turn handles blocked forever.
  if (isWorkspaceArchived(task.archivedAt, task.unarchivedAt)) {
    return task.id != null && isStreaming(task.id);
  }

  return true;
}

export function countActiveAgentTasks(
  tasks: readonly WorkspaceConfigEntry[],
  runtime: {
    isStreaming: (workspaceId: string) => boolean;
    isForegroundAwaiting: (workspaceId: string) => boolean;
  }
): number {
  let activeCount = 0;
  for (const task of tasks) {
    const status: AgentTaskStatus = task.taskStatus ?? "running";
    // A reawakened persistent child is represented by its private workspace-turn handle in the
    // workspace-turn count. Charging its mirrored execution status here would count one task twice.
    if (
      isWorkspaceTurnTaskId(task.taskExecutionId) &&
      isActiveWorkspaceTurnTaskStatus(task.taskExecutionStatus)
    ) {
      continue;
    }
    // If this task workspace is blocked in a foreground wait, do not count it towards parallelism.
    // This prevents deadlocks where a task spawns a nested task in the foreground while
    // maxParallelAgentTasks is low (e.g. 1).
    // Note: StreamManager can still report isStreaming() while a tool call is executing, so
    // isStreaming is not a reliable signal for "actively doing work" here.
    if (status === "running" && task.id && runtime.isForegroundAwaiting(task.id)) {
      continue;
    }
    if (status !== "queued" && isActiveAgentTaskEntry(task, runtime.isStreaming)) {
      activeCount += 1;
      continue;
    }

    // Defensive: task status and runtime stream state can be briefly out of sync during
    // termination/cleanup boundaries. Count streaming tasks as active so we never exceed
    // the configured parallel limit.
    if (task.id && runtime.isStreaming(task.id)) {
      activeCount += 1;
    }
  }

  return activeCount;
}

export function hasActiveDescendantAgentTasksUsingIndex(
  index: AgentTaskIndex,
  workspaceId: string,
  isStreaming: (workspaceId: string) => boolean
): boolean {
  assert(
    workspaceId.length > 0,
    "hasActiveDescendantAgentTasksUsingIndex: workspaceId must be non-empty"
  );

  const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const entry = index.byId.get(next);
    if (entry != null && isActiveAgentTaskEntry(entry, isStreaming)) {
      return true;
    }
    const children = index.childrenByParent.get(next);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }

  return false;
}

// Prefer per-agent settings so tasks inherit the correct agent defaults;
// fall back to legacy workspace settings for older configs.
export function resolveWorkspaceAISettings(
  workspace: {
    aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
    aiSettings?: ResolvedWorkspaceAiSettings;
  },
  agentId: string | undefined
): ResolvedWorkspaceAiSettings | undefined {
  const normalizedAgentId =
    typeof agentId === "string" && agentId.trim().length > 0
      ? normalizeAgentId(agentId, "")
      : undefined;
  return (
    (normalizedAgentId ? workspace.aiSettingsByAgent?.[normalizedAgentId] : undefined) ??
    workspace.aiSettings
  );
}
