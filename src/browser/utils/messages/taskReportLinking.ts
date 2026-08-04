import type { DisplayedMessage } from "@/common/types/message";
import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";

export interface LinkedTaskReport {
  taskId: string;
  reportMarkdown: string;
  title?: string;
  // Report-time AI settings: fresher than the spawn result when a plan child
  // handed off to exec after launch.
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface BashTaskSpawnInfo {
  script: string;
  modelIntent?: string;
}

export interface TaskReportLinking {
  /**
   * Completed task reports indexed by taskId.
   *
   * If the same taskId appears multiple times (multiple task_await calls), the last one
   * in the message history wins.
   */
  reportByTaskId: Map<string, LinkedTaskReport>;

  /**
   * Task IDs whose completed report should be rendered under the original `task` tool call,
   * instead of being duplicated under the corresponding `task_await` result.
   */
  suppressReportInAwaitTaskIds: Set<string>;

  /**
   * Titles from the original `task` tool call input (`args.title`), indexed by taskId.
   *
   * This is a best-effort fallback for task_await rows when the completed result omitted a title
   * (e.g. older agent_report payloads).
   */
  spawnTitleByTaskId: Map<string, string>;

  /**
   * Agent types from the original `task` tool call input (`args.agentId` / `args.subagent_type`),
   * indexed by taskId.
   */
  spawnAgentTypeByTaskId: Map<string, string>;

  /**
   * Spawn args of background `bash` tool calls, indexed by taskId. Lets task_await rows
   * surface the spawning command's model_intent, which task_await results do not carry.
   */
  bashSpawnByTaskId: Map<string, BashTaskSpawnInfo>;
}

/**
 * Every field this module reads comes from persisted tool args/results typed as `unknown`, so each
 * read repeated the same "is a string, is not blank, use the trimmed form" coercion. Centralizing it
 * keeps the call sites from drifting on whether they trim before or after the blank check.
 *
 * Deliberately NOT used by the `task_await` result reader below: those sites validate that a field is
 * non-blank but go on to store the raw, untrimmed value, so routing them through here would change
 * what gets persisted.
 */
function coerceNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getTaskIdsFromToolResult(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];

  const taskIds = new Set<string>();

  const taskId = coerceNonBlankString((result as { taskId?: unknown }).taskId);
  if (taskId !== undefined) {
    taskIds.add(taskId);
  }

  const pluralTaskIds = (result as { taskIds?: unknown }).taskIds;
  if (Array.isArray(pluralTaskIds)) {
    for (const rawCandidate of pluralTaskIds) {
      const candidate = coerceNonBlankString(rawCandidate);
      if (candidate !== undefined) {
        taskIds.add(candidate);
      }
    }
  }

  const tasks = (result as { tasks?: unknown }).tasks;
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (typeof task !== "object" || task === null) continue;
      const candidate = coerceNonBlankString((task as { taskId?: unknown }).taskId);
      if (candidate !== undefined) {
        taskIds.add(candidate);
      }
    }
  }

  return Array.from(taskIds);
}

function getTitleFromTaskToolArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  if (!("title" in args)) return null;

  return coerceNonBlankString((args as { title?: unknown }).title) ?? null;
}

function getAgentTypeFromTaskToolArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;

  const candidates = [
    (args as { agentId?: unknown }).agentId,
    (args as { subagent_type?: unknown }).subagent_type,
  ];
  for (const candidate of candidates) {
    const agentType = coerceNonBlankString(candidate);
    if (agentType !== undefined) {
      return agentType;
    }
  }
  return null;
}

// Only background bash spawn results carry a taskId, so its presence identifies them.
function getBashSpawnTaskId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;

  return coerceNonBlankString((result as { taskId?: unknown }).taskId) ?? null;
}

function getBashSpawnInfoFromArgs(args: unknown): BashTaskSpawnInfo | null {
  if (typeof args !== "object" || args === null) return null;

  const { script, model_intent } = args as {
    script?: unknown;
    model_intent?: unknown;
  };
  const modelIntent = coerceNonBlankString(model_intent);
  if (modelIntent === undefined) return null;

  return {
    script: typeof script === "string" ? script : "",
    modelIntent,
  };
}

/**
 * Render-time helper that links completed task reports (from `task_await`) back to the
 * original `task` tool call that spawned the background work.
 *
 * This is intentionally UI-only: it does not mutate persisted history/tool output; it just
 * helps the renderer place the final report in a more intuitive location.
 */
export function computeTaskReportLinking(messages: DisplayedMessage[]): TaskReportLinking {
  // First pass: record which taskIds have a visible `task` tool call (and capture spawn titles).
  const taskToolCallTaskIds = new Set<string>();
  const spawnTitleByTaskId = new Map<string, string>();
  const spawnAgentTypeByTaskId = new Map<string, string>();
  const bashSpawnByTaskId = new Map<string, BashTaskSpawnInfo>();
  for (const msg of messages) {
    if (msg.type !== "tool") continue;

    if (msg.toolName === "bash") {
      const taskId = getBashSpawnTaskId(msg.result);
      const spawnInfo = taskId ? getBashSpawnInfoFromArgs(msg.args) : null;
      if (taskId && spawnInfo) {
        bashSpawnByTaskId.set(taskId, spawnInfo);
      }
      continue;
    }

    if (msg.toolName !== "task") continue;

    const taskIds = getTaskIdsFromToolResult(msg.result);
    if (taskIds.length === 0) continue;

    const title = getTitleFromTaskToolArgs(msg.args);
    const agentType = getAgentTypeFromTaskToolArgs(msg.args);
    for (const taskId of taskIds) {
      taskToolCallTaskIds.add(taskId);
      if (title) {
        spawnTitleByTaskId.set(taskId, title);
      }
      if (agentType) {
        spawnAgentTypeByTaskId.set(taskId, agentType);
      }
    }
  }

  // Second pass: collect completed reports from `task_await` results.
  const reportByTaskId = new Map<string, LinkedTaskReport>();
  for (const msg of messages) {
    if (msg.type !== "tool" || msg.toolName !== "task_await") continue;

    const rawResult = msg.result;
    if (typeof rawResult !== "object" || rawResult === null) continue;
    if (!("results" in rawResult)) continue;

    const results = (rawResult as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;

    for (const r of results) {
      if (typeof r !== "object" || r === null) continue;

      const status = (r as { status?: unknown }).status;
      if (status !== "completed") continue;

      const taskId = (r as { taskId?: unknown }).taskId;
      if (typeof taskId !== "string" || taskId.trim().length === 0) continue;

      const reportMarkdown = (r as { reportMarkdown?: unknown }).reportMarkdown;
      if (typeof reportMarkdown !== "string") continue;

      const title = (r as { title?: unknown }).title;
      const modelString = (r as { modelString?: unknown }).modelString;
      const thinkingLevel = (r as { thinkingLevel?: unknown }).thinkingLevel;

      // Last-wins (history order)
      reportByTaskId.set(taskId, {
        taskId,
        reportMarkdown,
        title: typeof title === "string" ? title : undefined,
        modelString:
          typeof modelString === "string" && modelString.trim().length > 0
            ? modelString
            : undefined,
        thinkingLevel:
          typeof thinkingLevel === "string" &&
          (THINKING_LEVELS as readonly string[]).includes(thinkingLevel)
            ? (thinkingLevel as ThinkingLevel)
            : undefined,
      });
    }
  }

  // If a task has both a visible spawn card and a non-empty report, suppress the report
  // duplication under `task_await`.
  const suppressReportInAwaitTaskIds = new Set<string>();
  for (const [taskId, completed] of reportByTaskId) {
    if (!taskToolCallTaskIds.has(taskId)) continue;
    if (completed.reportMarkdown.trim().length === 0) continue;

    suppressReportInAwaitTaskIds.add(taskId);
  }

  return {
    reportByTaskId,
    suppressReportInAwaitTaskIds,
    spawnTitleByTaskId,
    spawnAgentTypeByTaskId,
    bashSpawnByTaskId,
  };
}
