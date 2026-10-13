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
   * in the message history wins. Pages of one long report (task_await offset_chars) are
   * joined back into the full report by their offsets.
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

function getTaskIdsFromToolResult(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];

  const taskIds = new Set<string>();

  const taskId = (result as { taskId?: unknown }).taskId;
  if (typeof taskId === "string" && taskId.trim().length > 0) {
    taskIds.add(taskId.trim());
  }

  const pluralTaskIds = (result as { taskIds?: unknown }).taskIds;
  if (Array.isArray(pluralTaskIds)) {
    for (const candidate of pluralTaskIds) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        taskIds.add(candidate.trim());
      }
    }
  }

  const tasks = (result as { tasks?: unknown }).tasks;
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (typeof task !== "object" || task === null) continue;
      const candidate = (task as { taskId?: unknown }).taskId;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        taskIds.add(candidate.trim());
      }
    }
  }

  return Array.from(taskIds);
}

/** The task_await call's offset_chars: where every completed report page it returned starts. */
function getAwaitPageOffset(args: unknown): number {
  if (typeof args !== "object" || args === null) return 0;
  const offset = (args as { offset_chars?: unknown }).offset_chars;
  return typeof offset === "number" && Number.isInteger(offset) && offset > 0 ? offset : 0;
}

/**
 * Join a report page onto the report read so far. A page at offset 0 starts the report over;
 * a page at or before the end replaces the text from its offset on (a page read twice). A page
 * past the end leaves a gap: null, and the caller keeps the await rows visible instead.
 */
function joinReportPage(previous: string | undefined, page: string, offset: number) {
  if (offset === 0) return page;
  if (previous == null || offset > previous.length) return null;
  return previous.slice(0, offset) + page;
}

function getTitleFromTaskToolArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  if (!("title" in args)) return null;

  const title = (args as { title?: unknown }).title;
  return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
}

function getAgentTypeFromTaskToolArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;

  const candidates = [
    (args as { agentId?: unknown }).agentId,
    (args as { subagent_type?: unknown }).subagent_type,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

// Only background bash spawn results carry a taskId, so its presence identifies them.
function getBashSpawnTaskId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;

  const taskId = (result as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId.trim().length > 0 ? taskId.trim() : null;
}

function getBashSpawnInfoFromArgs(args: unknown): BashTaskSpawnInfo | null {
  if (typeof args !== "object" || args === null) return null;

  const { script, model_intent } = args as {
    script?: unknown;
    model_intent?: unknown;
  };
  const modelIntent =
    typeof model_intent === "string" && model_intent.trim().length > 0
      ? model_intent.trim()
      : undefined;
  if (modelIntent === undefined) return null;

  return {
    script: typeof script === "string" ? script : "",
    modelIntent,
  };
}

/** One completed report (page) from a task_await result entry; null for anything else. */
function readCompletedAwaitReport(r: unknown): LinkedTaskReport | null {
  if (typeof r !== "object" || r === null) return null;
  if ((r as { status?: unknown }).status !== "completed") return null;

  const taskId = (r as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string" || taskId.trim().length === 0) return null;

  const reportMarkdown = (r as { reportMarkdown?: unknown }).reportMarkdown;
  if (typeof reportMarkdown !== "string") return null;

  const title = (r as { title?: unknown }).title;
  return {
    taskId,
    reportMarkdown,
    title: typeof title === "string" ? title : undefined,
    ...readReportAiSettings(r),
  };
}

/** Report-time AI settings of a completed task_await result entry, when valid. */
function readReportAiSettings(r: {
  modelString?: unknown;
  thinkingLevel?: unknown;
}): Pick<LinkedTaskReport, "modelString" | "thinkingLevel"> {
  const { modelString, thinkingLevel } = r;
  return {
    modelString:
      typeof modelString === "string" && modelString.trim().length > 0 ? modelString : undefined,
    thinkingLevel:
      typeof thinkingLevel === "string" &&
      (THINKING_LEVELS as readonly string[]).includes(thinkingLevel)
        ? (thinkingLevel as ThinkingLevel)
        : undefined,
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
  // Tasks whose pages left a gap: their await rows keep showing each page.
  const incompleteReportTaskIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type !== "tool" || msg.toolName !== "task_await") continue;
    const pageOffset = getAwaitPageOffset(msg.args);

    const rawResult = msg.result;
    if (typeof rawResult !== "object" || rawResult === null) continue;
    if (!("results" in rawResult)) continue;

    const results = (rawResult as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;

    for (const r of results) {
      const page = readCompletedAwaitReport(r);
      if (page == null) continue;
      const joined = joinReportPage(
        reportByTaskId.get(page.taskId)?.reportMarkdown,
        page.reportMarkdown,
        pageOffset
      );
      if (joined == null) {
        incompleteReportTaskIds.add(page.taskId);
        continue;
      }
      if (pageOffset === 0) incompleteReportTaskIds.delete(page.taskId);
      // Last-wins (history order)
      reportByTaskId.set(page.taskId, { ...page, reportMarkdown: joined });
    }
  }

  // If a task has both a visible spawn card and a non-empty report, suppress the report
  // duplication under `task_await`.
  const suppressReportInAwaitTaskIds = new Set<string>();
  for (const [taskId, completed] of reportByTaskId) {
    if (!taskToolCallTaskIds.has(taskId)) continue;
    if (completed.reportMarkdown.trim().length === 0) continue;
    if (incompleteReportTaskIds.has(taskId)) continue;

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
