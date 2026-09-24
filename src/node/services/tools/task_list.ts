import assert from "node:assert/strict";
import * as path from "node:path";

import { tool } from "ai";

import {
  SUBAGENT_REUSABLE_BENCH_EXCLUSIVE_LIMIT,
  SUBAGENT_REUSABLE_BENCH_TARGET,
} from "@/common/constants/subagentLifecycle";
import type { TaskListToolSuccessResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import { TaskListToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { isWorkspaceArchived } from "@/common/utils/archive";

import { isNestedWorkflowRun } from "@/common/types/workflow";
import type { TaskService } from "@/node/services/taskService";
import type { AgentTaskStatus } from "@/node/services/taskWorkspaceSeam";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Config } from "@/node/config";
import { log } from "@/node/services/log";
import {
  isActiveWorkspaceTurnTaskStatus,
  type WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";

import { buildWorkflowProgressSummary } from "./workflowProgress";
import { toBashTaskId } from "./taskId";
import {
  parseToolResult,
  requireTaskService,
  requireWorkspaceId,
  requireWorkspaceTurnManager,
} from "./toolUtils";

// "pending" and "backgrounded" are workflow-run statuses; agent/bash tasks never carry them.
const DEFAULT_STATUSES = [
  "queued",
  "starting",
  "running",
  "awaiting_report",
  "pending",
  "backgrounded",
] as const;

// Statuses agent tasks can actually carry; the wider tool enum additionally accepts
// workflow-run statuses, which must not reach taskService.listDescendantAgentTasks.
const AGENT_TASK_STATUSES: readonly AgentTaskStatus[] = [
  "queued",
  "starting",
  "running",
  "awaiting_report",
  "interrupted",
  "reported",
];

function isAgentTaskStatus(status: string): status is AgentTaskStatus {
  return (AGENT_TASK_STATUSES as readonly string[]).includes(status);
}

type TaskListStatus = TaskListToolSuccessResult["tasks"][number]["status"];

function taskListStatusFromExecution(status: WorkspaceTurnTaskStatus): TaskListStatus {
  switch (status) {
    case "queued":
    case "starting":
    case "running":
    case "interrupted":
      return status;
    case "completed":
      return "reported";
    case "error":
      return "failed";
  }
}

// Discovery should keep a useful reusable bench without letting inactive children accumulate
// indefinitely or turning every task boundary into a blanket cleanup.
const INACTIVE_CHILD_RETENTION_NOTE = `Inactive persistent children remain available under stable task IDs. Rows with bestOf metadata are temporary grouped candidates rather than standalone bench members; after their results and artifacts are consumed and no same-candidate follow-up is expected, remove them with task_remove. Keep each parent's direct standalone bench role-based: aim for at most ${SUBAGENT_REUSABLE_BENCH_TARGET} and keep it below ${SUBAGENT_REUSABLE_BENCH_EXCLUSIVE_LIMIT}. Prefer reawakening relevant context and use task_retitle when responsibility changes; prune substantially overlapping, obsolete, or least-useful inactive roles with task_remove when the bench exceeds those bounds. Do not sweep a small bench merely because a turn, task, or PR ended. A reawakened child keeps its checkout, so for repository-dependent work verify the retained snapshot or tell it to synchronize. Interrupted children were stopped before a terminal report; reawaken and ask them to finalize if their work should count as completed.`;

const TREE_SCOPE_NOTE =
  'Rows (including the root "workspace" row) are addressable via task_send_message, except your own "self" row, best-of candidate rows (`bestOf` metadata, refused to preserve candidate independence), and non-descendant rows in terminal states like reported/interrupted (peers cannot reactivate a task — only its parent can); ' +
  "the relationship field is computed relative to this workspace.";

const TREE_SCOPE_RESTRICTED_NOTE =
  "This workspace cannot send or receive peer messages (best-of candidates stay independent; workflow-owned tasks communicate through the workflow journal), so only self/descendant rows are listed; descendants remain addressable via task_send_message guidance.";

const INSTANCE_SCOPE_NOTE =
  "Rows are local/worktree root workspaces in this Xum instance and an availability snapshot. Unrelated roots must have consented (newly created roots are opted in by default; others enable it in their workspace settings); absent or revoked consent hides them, including from searches and counts. Non-local or unresolved runtimes, archived, user-stopped, stopping, and delegated-turn roots are omitted, and a listed target can still refuse if its state changes (including consent, runtime, or a delegated turn starting on it). " +
  'Message them with task_send_message — "unrelated" rows receive your text as an untrusted agent message, queued to turn-end while they are busy, under their own agent/model settings; discovery grants no additional control. Your own "self" row is not addressable.';

// The tree note promises self/descendant rows, which would be false here: a restricted caller
// gets no instance rows at all.
const INSTANCE_SCOPE_RESTRICTED_NOTE =
  "Instance discovery is unavailable from this workspace. Unrelated discovery and messaging require local/worktree runtimes and exclude best-of candidates and workflow-owned tasks. Existing same-tree messaging rules are unchanged; no instance rows are listed.";

const INSTANCE_SCOPE_TRUNCATED_NOTE =
  " More rows match; pass `nextOffset` as `offset` to continue. Paging is best-effort while workspaces are created, removed, or archived, so restart from offset 0 or deduplicate by ID when completeness matters.";

const MAX_ARCHIVE_ANCESTOR_DEPTH = 32;

interface WorkspaceArchiveLookup {
  isArchivedInScope(workspaceId: string): boolean;
}

function inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir: string): string | undefined {
  assert(
    workspaceSessionDir.length > 0,
    "inferMuxRootFromWorkspaceSessionDir: workspaceSessionDir must be non-empty"
  );

  const sessionsDir = path.dirname(workspaceSessionDir);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }

  return path.dirname(sessionsDir);
}

function resolveMuxRootDir(config: ToolConfiguration): string | undefined {
  const scopedMuxHome = config.xumScope?.xumHome;
  if (scopedMuxHome && scopedMuxHome.length > 0) {
    return scopedMuxHome;
  }

  const workspaceSessionDir = config.workspaceSessionDir;
  if (workspaceSessionDir && workspaceSessionDir.length > 0) {
    return inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir);
  }

  return undefined;
}

function createWorkspaceArchiveLookup(
  config: ToolConfiguration,
  rootWorkspaceId: string
): WorkspaceArchiveLookup | null {
  const muxRootDir = resolveMuxRootDir(config);
  if (!muxRootDir) {
    return null;
  }

  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = new Config(muxRootDir).loadConfigOrDefault();
  } catch (error) {
    log.debug("task_list: failed to load mux config for archive filtering", {
      workspaceId: rootWorkspaceId,
      muxRootDir,
      error,
    });
    return null;
  }

  const workspaceById = new Map<string, WorkspaceConfigEntry>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      if (workspace.id && workspace.id.length > 0) {
        workspaceById.set(workspace.id, workspace);
      }
    }
  }

  return {
    isArchivedInScope(workspaceId: string): boolean {
      if (workspaceId.length === 0) {
        return false;
      }

      const visited = new Set<string>();
      let currentWorkspaceId = workspaceId;
      for (let depth = 0; depth < MAX_ARCHIVE_ANCESTOR_DEPTH; depth += 1) {
        // Invoking task_list from an archived root should not hide that root's descendants.
        if (currentWorkspaceId === rootWorkspaceId) {
          return false;
        }

        if (visited.has(currentWorkspaceId)) {
          log.debug("task_list: parentWorkspaceId cycle during archive filtering", {
            rootWorkspaceId,
            workspaceId,
            currentWorkspaceId,
          });
          return false;
        }
        visited.add(currentWorkspaceId);

        const workspace = workspaceById.get(currentWorkspaceId);
        if (!workspace) {
          return false;
        }

        if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
          return true;
        }

        if (!workspace.parentWorkspaceId) {
          return false;
        }
        currentWorkspaceId = workspace.parentWorkspaceId;
      }

      log.debug("task_list: archive filtering hit parent traversal limit", {
        rootWorkspaceId,
        workspaceId,
      });
      return false;
    },
  };
}

function shouldHideArchivedBackgroundProcess(
  proc: { status: "running" | "exited" | "killed" | "failed"; workspaceId: string },
  archiveLookup: WorkspaceArchiveLookup | null
): boolean {
  return (
    archiveLookup != null &&
    proc.status !== "running" &&
    archiveLookup.isArchivedInScope(proc.workspaceId)
  );
}

function shouldHideArchivedWorkspaceTurn(
  turn: { status: WorkspaceTurnTaskStatus; workspaceId: string },
  archiveLookup: WorkspaceArchiveLookup | null
): boolean {
  return (
    archiveLookup != null &&
    !isActiveWorkspaceTurnTaskStatus(turn.status) &&
    archiveLookup.isArchivedInScope(turn.workspaceId)
  );
}

/**
 * scope:"tree" — peer-discovery view: every agent workspace in the caller's task tree plus the
 * root workspace row. Workflow runs, workspace turns, and bash processes stay descendants-only.
 */
async function executeTreeScope(
  taskService: TaskService,
  workspaceId: string,
  requestedStatuses: readonly TaskListStatus[] | null
): Promise<unknown> {
  const tree = taskService.listTaskTreeAgents(workspaceId);
  const explicit = requestedStatuses != null && requestedStatuses.length > 0;
  const statusFilter = new Set<TaskListStatus>(
    explicit ? requestedStatuses : [...DEFAULT_STATUSES, "workspace"]
  );

  const tasks: TaskListToolSuccessResult["tasks"] = [];
  // The root is a plain workspace with no task lifecycle: included by default, filtered like any
  // other row (status "workspace") when explicit statuses were passed. An ARCHIVED root is
  // omitted entirely — sendAgentPeerMessage refuses archived targets, so advertising the row
  // would break the note's addressability claim. A MISSING root (parent chain ending at a
  // removed/corrupted workspace) is omitted for the same reason: sends to it return not_found.
  // A RESTRICTED caller (best-of candidate / workflow-owned) cannot message the root at all.
  if (
    statusFilter.has("workspace") &&
    tree.rootArchived !== true &&
    tree.rootMissing !== true &&
    tree.callerPeerMessagingRestricted !== true
  ) {
    tasks.push({
      taskId: tree.rootWorkspaceId,
      status: "workspace",
      ...(tree.rootTitle != null ? { title: tree.rootTitle } : {}),
      relationship: tree.rootRelationship,
      depth: 0,
    });
  }

  const resolveAgentExecution =
    taskService.getDescendantAgentTaskExecutionSnapshot?.bind(taskService);
  for (const task of tree.tasks) {
    let status: TaskListStatus = task.status;
    let executionStatus = task.executionStatus;
    // The live execution overlay is ancestor-scoped; non-descendant rows fall back to the
    // persisted execution status, which is close enough for peer discovery.
    if (
      task.executionTaskId != null &&
      task.relationship === "descendant" &&
      resolveAgentExecution != null
    ) {
      const resolvedExecution = await resolveAgentExecution(workspaceId, task.taskId);
      executionStatus = resolvedExecution?.record?.status ?? executionStatus;
    }
    // Peer admission accepts only a RUNNING execution mirror: overlaying a queued/starting
    // reawakening onto a sibling/ancestor row would advertise a target task_send_message always
    // refuses. Those rows keep their stable terminal status, which the note already marks
    // unaddressable. Descendant/self rows keep the full overlay (guidance may target any state).
    const hideUnadmittedReawakening =
      (task.relationship === "sibling" || task.relationship === "ancestor") &&
      (executionStatus === "queued" || executionStatus === "starting");
    if (executionStatus != null && !hideUnadmittedReawakening) {
      status = taskListStatusFromExecution(executionStatus);
    }
    // Initially queued/starting peers (waiting for launch capacity — no execution overlay, the
    // STABLE status is nonterminal) are also unaddressable: sendAgentPeerMessage refuses those
    // statuses outright because only the parent may edit a queued launch prompt. Hide the row
    // so the note's "nonterminal ⇒ addressable" claim stays true; descendant/self rows keep
    // every state (guidance may target them).
    if (
      (task.relationship === "sibling" || task.relationship === "ancestor") &&
      (status === "queued" || status === "starting")
    ) {
      continue;
    }
    if (!statusFilter.has(status)) {
      continue;
    }
    const {
      executionTaskId: _executionTaskId,
      executionStatus: _executionStatus,
      ...publicTask
    } = task;
    tasks.push({ ...publicTask, status });
  }

  return parseToolResult(
    TaskListToolResultSchema,
    {
      tasks,
      note:
        tree.callerPeerMessagingRestricted === true ? TREE_SCOPE_RESTRICTED_NOTE : TREE_SCOPE_NOTE,
    },
    "task_list"
  );
}

/**
 * scope:"instance" — the on-demand address book: root workspaces across every project in this
 * instance, paged. Eligibility, query filtering, ordering, and paging live in the service; the
 * tool only applies the status filter (before paging, so an excluded "workspace" status cannot
 * advertise a cursor for rows that will never be shown) and maps rows onto the tool schema.
 */
function executeInstanceScope(
  taskService: TaskService,
  workspaceId: string,
  args: {
    statuses?: readonly TaskListStatus[] | null;
    query?: string | null;
    limit?: number | null;
    offset?: number | null;
  }
): unknown {
  // Instance rows are plain workspaces (status "workspace", same rule as the tree root row).
  const explicitStatuses = args.statuses ?? [];
  if (explicitStatuses.length > 0 && !explicitStatuses.includes("workspace")) {
    return parseToolResult(
      TaskListToolResultSchema,
      { tasks: [], note: INSTANCE_SCOPE_NOTE },
      "task_list"
    );
  }

  const options = {
    query: args.query ?? undefined,
    limit: args.limit ?? undefined,
    offset: args.offset ?? undefined,
  };
  const page = taskService.listInstanceWorkspaces(workspaceId, options);
  if (page.callerPeerMessagingRestricted === true) {
    assert(
      page.rows.length === 0 && page.nextOffset == null,
      "task_list: a restricted caller must receive no instance rows"
    );
  }
  if (options.limit != null) {
    assert(page.rows.length <= options.limit, "task_list: instance page exceeds the limit");
  }
  const nextOffset = page.nextOffset;
  if (nextOffset != null) {
    assert(
      nextOffset > (options.offset ?? 0),
      "task_list: instance nextOffset must advance past the requested offset"
    );
  }

  const tasks: TaskListToolSuccessResult["tasks"] = page.rows.map((row) => ({
    taskId: row.workspaceId,
    status: "workspace" as const,
    ...(row.name != null ? { workspaceName: row.name } : {}),
    ...(row.title != null ? { title: row.title } : {}),
    ...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
    projectPath: row.projectPath,
    activity: row.busy ? ("busy" as const) : ("idle" as const),
    relationship: row.relationship,
    depth: 0,
  }));

  const note =
    page.callerPeerMessagingRestricted === true
      ? INSTANCE_SCOPE_RESTRICTED_NOTE
      : nextOffset != null
        ? `${INSTANCE_SCOPE_NOTE}${INSTANCE_SCOPE_TRUNCATED_NOTE}`
        : INSTANCE_SCOPE_NOTE;

  return parseToolResult(
    TaskListToolResultSchema,
    { tasks, note, ...(nextOffset != null ? { nextOffset } : {}) },
    "task_list"
  );
}

export const createTaskListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_list.description,
    inputSchema: TOOL_DEFINITIONS.task_list.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_list");
      const taskService = requireTaskService(config, "task_list");
      const workspaceTurnManager = requireWorkspaceTurnManager(config, "task_list");

      const scope = args.scope ?? "descendants";
      if (scope !== "instance") {
        // Paging inputs are instance-only. Silently ignoring them would let a model believe a
        // tree/descendants listing was filtered or paged when it was not; null counts as absent
        // (strict-mode providers send null for omitted optional fields).
        for (const field of ["query", "limit", "offset"] as const) {
          if (args[field] != null) {
            throw new Error(
              `task_list: \`${field}\` is only valid with scope:"instance" (got scope:"${scope}")`
            );
          }
        }
      }

      if (scope === "instance") {
        return executeInstanceScope(taskService, workspaceId, args);
      }
      if (scope === "tree") {
        return executeTreeScope(taskService, workspaceId, args.statuses ?? null);
      }

      const statuses =
        args.statuses && args.statuses.length > 0 ? args.statuses : [...DEFAULT_STATUSES];
      const requestedStatusSet = new Set<TaskListStatus>(statuses);
      const includeArchived = args.includeArchived ?? false;
      const archiveLookup = includeArchived
        ? null
        : createWorkspaceArchiveLookup(config, workspaceId);
      const workspaceTurnStatuses = statuses.filter(
        (
          status
        ): status is "queued" | "starting" | "running" | "interrupted" | "completed" | "failed" =>
          status === "queued" ||
          status === "starting" ||
          status === "running" ||
          status === "interrupted" ||
          status === "completed" ||
          status === "failed"
      );
      const isDescendantAgentWorkspace = async (candidateWorkspaceId: string): Promise<boolean> => {
        const checker = taskService.isDescendantAgentTask?.bind(taskService);
        return checker != null ? await checker(workspaceId, candidateWorkspaceId) : false;
      };
      const agentStatuses = statuses.filter(isAgentTaskStatus);

      const allAgentTasks =
        agentStatuses.length > 0 || requestedStatusSet.has("failed")
          ? taskService.listDescendantAgentTasks(workspaceId, {
              excludeWorkflowTasks: true,
            })
          : [];
      // Legacy archived sub-agents are still part of the public inactive state and remain listable.
      // Reactivated executions use internal workspace-turn handles, but the public row keeps the
      // stable child task ID and overlays the current execution status.
      const resolveAgentExecution =
        taskService.getDescendantAgentTaskExecutionSnapshot?.bind(taskService);
      const internalExecutionIds = new Set<string>();
      let listedInactiveChild = false;
      const tasks: TaskListToolSuccessResult["tasks"] = [];
      for (const task of allAgentTasks) {
        let status: TaskListStatus = task.status;
        let executionStatus = task.executionStatus;
        if (task.executionTaskId != null) {
          internalExecutionIds.add(task.executionTaskId);
          const resolvedExecution =
            resolveAgentExecution != null
              ? await resolveAgentExecution(workspaceId, task.taskId)
              : null;
          const execution =
            resolvedExecution?.record ??
            (resolveAgentExecution == null
              ? await workspaceTurnManager.getWorkspaceTurnSnapshot(
                  workspaceId,
                  task.executionTaskId
                )
              : null);
          executionStatus = execution?.status ?? executionStatus;
        }
        if (executionStatus != null) {
          status = taskListStatusFromExecution(executionStatus);
        }
        if (!requestedStatusSet.has(status)) {
          continue;
        }
        if (status === "reported" || status === "interrupted" || status === "failed") {
          listedInactiveChild = true;
        }
        const {
          executionTaskId: _executionTaskId,
          executionStatus: _executionStatus,
          ...publicTask
        } = task;
        tasks.push({ ...publicTask, status });
      }

      // Workflow runs are workspace-scoped (not parent/child workspaces), so they surface as
      // depth-1 entries. interrupted/failed runs stay listable here because they are the
      // resumable ones (workflow_resume).
      if (config.workflowService?.listRuns != null) {
        const runs = await config.workflowService.listRuns({ workspaceId });
        for (const rawRun of runs) {
          const parsed = WorkflowRunRecordSchema.safeParse(rawRun);
          if (
            !parsed.success ||
            !statuses.includes(parsed.data.status) ||
            isNestedWorkflowRun(parsed.data)
          ) {
            continue;
          }
          const workflowProgress = buildWorkflowProgressSummary(parsed.data);
          tasks.push({
            taskId: parsed.data.id,
            status: parsed.data.status,
            parentWorkspaceId: workspaceId,
            title: parsed.data.workflow.name,
            createdAt: parsed.data.createdAt,
            ...(workflowProgress != null ? { workflowProgress } : {}),
            depth: 1,
          });
        }
      }

      if (workspaceTurnStatuses.length > 0 && workspaceTurnManager.listWorkspaceTurnTasks != null) {
        const storeStatuses = workspaceTurnStatuses.map((status) =>
          status === "failed" ? "error" : status
        );
        const workspaceTurns = await workspaceTurnManager.listWorkspaceTurnTasks(workspaceId, {
          statuses: storeStatuses,
        });
        for (const turn of workspaceTurns) {
          if (
            internalExecutionIds.has(turn.handleId) ||
            (await isDescendantAgentWorkspace(turn.workspaceId))
          ) {
            continue;
          }
          if (shouldHideArchivedWorkspaceTurn(turn, archiveLookup)) {
            continue;
          }
          tasks.push({
            taskId: turn.handleId,
            status: turn.status === "error" ? "failed" : turn.status,
            parentWorkspaceId: workspaceId,
            handleKind: "workspace_turn",
            workspaceId: turn.workspaceId,
            title: turn.title,
            createdAt: turn.createdAt,
            depth: 1,
          });
        }
      }

      if (config.backgroundProcessManager) {
        const depthByWorkspaceId = new Map<string, number>();
        depthByWorkspaceId.set(workspaceId, 0);
        for (const t of allAgentTasks) {
          depthByWorkspaceId.set(t.taskId, t.depth);
        }

        const processes = await config.backgroundProcessManager.list();
        for (const proc of processes) {
          const inScope =
            proc.workspaceId === workspaceId ||
            (await taskService.isDescendantAgentTask(workspaceId, proc.workspaceId));
          if (!inScope) continue;

          if (
            proc.workspaceId !== workspaceId &&
            (await taskService.isWorkflowOwnedDescendantAgentTask(workspaceId, proc.workspaceId))
          ) {
            continue;
          }

          if (shouldHideArchivedBackgroundProcess(proc, archiveLookup)) {
            continue;
          }
          const status = proc.status === "running" ? "running" : "reported";
          if (!statuses.includes(status)) continue;

          const parentDepth = depthByWorkspaceId.get(proc.workspaceId) ?? 0;
          tasks.push({
            taskId: toBashTaskId(proc.id),
            status,
            parentWorkspaceId: proc.workspaceId,
            title: proc.displayName ?? proc.id,
            createdAt: new Date(proc.startTime).toISOString(),
            depth: parentDepth + 1,
          });
        }
      }

      return parseToolResult(
        TaskListToolResultSchema,
        {
          tasks,
          ...(listedInactiveChild ? { note: INACTIVE_CHILD_RETENTION_NOTE } : {}),
        },
        "task_list"
      );
    },
  });
};
