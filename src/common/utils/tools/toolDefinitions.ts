/**
 * Tool definitions module - Frontend-safe
 *
 * Single source of truth for all tool definitions.
 * Zod schemas are defined here and JSON schemas are auto-generated.
 *
 * ## Schema convention: `.nullish()` for optional tool parameters
 *
 * All optional fields in **tool input schemas** (i.e. parameters the model
 * provides) MUST use `.nullish()` instead of `.optional()`.
 *
 * Why: OpenAI's Responses API normalizes tool schemas into strict mode, which
 * forces every field into `required` and expects optional fields to accept
 * `null` (via `"type": ["string", "null"]`).  Using `.optional()` alone
 * produces a schema without a null type, so the model is forced to hallucinate
 * values for fields it would normally skip.  `.nullish()` (= `.optional().nullable()`)
 * emits both `null` in the type union AND keeps the field out of `required`,
 * which satisfies strict-mode providers (OpenAI) while remaining compatible
 * with non-strict providers (Anthropic, Google).
 *
 * Implementation handlers that consume these values should use `!= null`
 * (loose equality) instead of `!== undefined` to correctly treat both
 * `null` and `undefined` as "not provided".
 *
 * This does NOT apply to tool **output/result** schemas — those are constructed
 * by our own backend code and always use `undefined` for absent fields.
 */

import {
  SUBAGENT_REUSABLE_BENCH_EXCLUSIVE_LIMIT,
  SUBAGENT_REUSABLE_BENCH_TARGET,
} from "@/common/constants/subagentLifecycle";
import { isGrokFrontierModel } from "@/common/types/thinking";
import { z } from "zod";
import {
  AgentIdSchema,
  AgentSkillPackageSchema,
  BestOfGroupSchema,
  SkillNameSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusSchema,
  WorkflowStepStatusSchema,
  WorkspaceHeartbeatSettingsSchema,
} from "@/common/orpc/schemas";
import {
  RUNTIME_MODE,
  runtimeModeSupportsSharedTaskWorkspace,
  type RuntimeMode,
} from "@/common/types/runtime";
import {
  BASH_HARD_MAX_LINES,
  BASH_MAX_LINE_BYTES,
  BASH_MAX_TOTAL_BYTES,
  WEB_FETCH_MAX_OUTPUT_BYTES,
} from "@/common/constants/toolLimits";
import { ADVISOR_TOOL_DESCRIPTION } from "@/common/constants/advisor";
import {
  ConfigMutationPathSchema,
  ConfigOperationsSchema,
} from "@/common/config/schemas/configOperations";
import { TOOL_EDIT_WARNING } from "@/common/types/tools";
import { THINKING_LEVELS } from "@/common/types/thinking";

import { zodToJsonSchema } from "zod-to-json-schema";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";
import { WorkspaceTurnFinalMessageRefSchema } from "@/common/types/workspaceTurn";

import {
  HEARTBEAT_CONTEXT_MODE_VALUES,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_TRIGGER_VALUES,
  HEARTBEAT_WHEN_BUSY_VALUES,
} from "@/constants/heartbeat";
import { TASK_FAMILY_MESSAGE_MAX_CHARS } from "@/constants/taskMessages";

// -----------------------------------------------------------------------------
// ask_user_question (plan-mode interactive questions)
// -----------------------------------------------------------------------------

export const AskUserQuestionOptionSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const AskUserQuestionQuestionSchema = z
  .object({
    question: z.string().min(1),
    header: z.string().min(1).max(32).describe("Short label shown in the UI (keep it concise)"),
    options: z.array(AskUserQuestionOptionSchema).min(2).max(4),
    multiSelect: z.boolean(),
  })
  .strict()
  .superRefine((question, ctx) => {
    const labels = question.options.map((o) => o.label);
    const labelSet = new Set(labels);
    if (labelSet.size !== labels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Option labels must be unique within a question",
        path: ["options"],
      });
    }

    // Claude Code provides "Other" automatically; do not include it explicitly.
    if (labels.some((label) => label.trim().toLowerCase() === "other")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Do not include an 'Other' option; it is provided automatically",
        path: ["options"],
      });
    }
  });

const AskUserQuestionUiOnlySchema = z.object({
  questions: z.array(AskUserQuestionQuestionSchema),
  answers: z.record(z.string(), z.string()),
});

const ToolOutputUiOnlySchema = z.object({
  ask_user_question: AskUserQuestionUiOnlySchema.optional(),
  file_edit: z
    .object({
      diff: z.string(),
    })
    .optional(),
  notify: z
    .object({
      notifiedVia: z.enum(["electron", "browser"]),
      workspaceId: z.string().optional(),
    })
    .optional(),
});

const ToolOutputUiOnlyFieldSchema = {
  ui_only: ToolOutputUiOnlySchema.optional(),
};

export const AskUserQuestionToolArgsSchema = z
  .object({
    questions: z.array(AskUserQuestionQuestionSchema).min(1).max(4),
    // Optional prefilled answers (Claude Code supports this, though Xum typically won't use it)
    answers: z.record(z.string(), z.string()).nullish(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const questionTexts = args.questions.map((q) => q.question);
    const questionTextSet = new Set(questionTexts);
    if (questionTextSet.size !== questionTexts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question text must be unique across questions",
        path: ["questions"],
      });
    }
  });

const AskUserQuestionToolSummarySchema = z
  .object({
    summary: z.string(),
  })
  .extend(ToolOutputUiOnlyFieldSchema);

const AskUserQuestionToolLegacySchema = z
  .object({
    questions: z.array(AskUserQuestionQuestionSchema),
    answers: z.record(z.string(), z.string()),
  })
  .strict();

export const AskUserQuestionToolResultSchema = z.union([
  AskUserQuestionToolSummarySchema,
  AskUserQuestionToolLegacySchema,
]);

// -----------------------------------------------------------------------------
// heartbeat (workspace idle check-in schedule)
// -----------------------------------------------------------------------------

export const HeartbeatToolActionSchema = z.enum(["get", "set", "unset"]);
export const HeartbeatToolArgsSchema = z
  .object({
    action: HeartbeatToolActionSchema.describe(
      'Operation to perform: "get" reads the current heartbeat, "set" enables or configures it, and "unset" removes this workspace\'s heartbeat settings.'
    ),
    enabled: z
      .boolean()
      .nullish()
      .describe(
        'set: whether scheduled heartbeats are enabled. Omit to preserve the current value; when creating new settings, omitted means "enabled".'
      ),
    intervalMs: z
      .number()
      .int()
      .min(HEARTBEAT_MIN_INTERVAL_MS)
      .max(HEARTBEAT_MAX_INTERVAL_MS)
      .nullish()
      .describe(
        `set: heartbeat interval in milliseconds (${HEARTBEAT_MIN_INTERVAL_MS}–${HEARTBEAT_MAX_INTERVAL_MS}). Omit to preserve the current interval or use the global default for new settings.`
      ),
    message: z
      .string()
      .nullish()
      .describe(
        "set: optional custom instruction body appended after the fixed idle-workspace lead-in. Pass an empty string to clear the custom message."
      ),
    contextMode: z
      .enum(HEARTBEAT_CONTEXT_MODE_VALUES)
      .nullish()
      .describe(
        'set: context preparation for heartbeat turns: "normal" uses current context, "compact" compacts first, and "reset" appends a reset boundary first. Omit to preserve the current mode.'
      ),
    trigger: z
      .enum(HEARTBEAT_TRIGGER_VALUES)
      .nullish()
      .describe(
        'set: countdown anchoring: "idle" resets on workspace activity (fires only after a full quiet interval), "interval" fires on a fixed wall-clock cadence regardless of activity. Omit to preserve the current value; unset resolves to "idle" at read time.'
      ),
    whenBusy: z
      .enum(HEARTBEAT_WHEN_BUSY_VALUES)
      .nullish()
      .describe(
        'set: behavior when a heartbeat fires while the workspace is busy: "skip" misses the slot, "tool-end" queues the heartbeat into the current turn at the next tool boundary, "turn-end" queues it as its own turn after the current one. Omit to preserve the current value; unset resolves at read time to "skip" for trigger "idle" and "turn-end" for trigger "interval".'
      ),
  })
  .strict();

// -----------------------------------------------------------------------------
// advisor (nested strategic guidance)
// -----------------------------------------------------------------------------

export const AdvisorToolInputSchema = z
  .object({
    // Advisor prompts often need tradeoff context; keep bounded while allowing a compact brief.
    question: z.string().min(1).max(2000).nullish(),
  })
  .strict();

// -----------------------------------------------------------------------------
// task (sub-workspaces as subagents)
// -----------------------------------------------------------------------------

const SubagentTypeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  AgentIdSchema
);

const TaskAgentIdSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  AgentIdSchema
);

const TaskToolBestOfCountSchema = z.number().int().min(1).max(20);

// Model/thinking overrides for the spawned sub-agent. Accepted as free-form strings
// so they can be parsed with the SAME logic as the UI (alias resolution for model;
// named levels OR numeric indices for thinking). A numeric thinking value may arrive
// as a JSON number, so coerce it to a string before parsing in the handler.
const TaskToolModelSchema = z.string().trim().min(1);
const TaskToolThinkingSchema = z.preprocess(
  (value) => (typeof value === "number" ? String(value) : value),
  z.string().trim().min(1)
);

/** Sub-agent workspace isolation modes. `fork` matches the historical default. */
export const TASK_ISOLATION_VALUES = ["fork", "none"] as const;
export type TaskIsolation = (typeof TASK_ISOLATION_VALUES)[number];
const TaskIsolationSchema = z.enum(TASK_ISOLATION_VALUES);

const TASK_ISOLATION_PARAM_DESCRIPTION =
  'Workspace isolation for the sub-agent. "fork" (the default) runs it in an isolated copy of this ' +
  'workspace created from committed state. "none" runs it directly in this workspace\'s checkout, ' +
  "sharing the working tree (including uncommitted changes) and skipping the fork + init overhead. " +
  'Use "none" only for read-only analysis (e.g. the explore agent) or when you instruct the sub-agent ' +
  "to avoid editing shared files, since it can otherwise modify the same files concurrently. Omit to fork.";

function getTaskRuntimeVisibilityGuidance(runtimeMode: RuntimeMode | undefined): string {
  switch (runtimeMode) {
    case RUNTIME_MODE.LOCAL:
      return (
        "In local runtime, sub-agents share the same working directory as the parent, so they can see uncommitted changes. " +
        "Be careful: they can also modify the same files concurrently."
      );
    case RUNTIME_MODE.WORKTREE:
      return (
        "In worktree runtime, sub-agents start from a forked workspace based on committed state. " +
        "Uncommitted changes from the parent are not available. Commit any changes you want the sub-agent to consider before spawning a task."
      );
    case RUNTIME_MODE.DOCKER:
      return (
        "In Docker runtime, sub-agents start from a new workspace created from the repository's committed state. " +
        "Uncommitted changes from the parent are not available. Commit any changes you want the sub-agent to consider before spawning a task."
      );
    case RUNTIME_MODE.DEVCONTAINER:
      return (
        "In devcontainer runtime, sub-agents start from a forked workspace based on committed state. " +
        "Uncommitted changes from the parent are not available. Commit any changes you want the sub-agent to consider before spawning a task."
      );
    case RUNTIME_MODE.SSH:
      return (
        "In SSH runtime, sub-agents usually start from committed state. Some fallback fork paths may copy the working tree, but do not rely on that ambiguity. " +
        "If the child must see your latest changes, commit them before spawning the task."
      );
    default:
      return "Sub-agent visibility depends on runtime. If the child must see your latest work, commit it before spawning the task unless your runtime explicitly shares the working copy.";
  }
}

export function buildTaskToolDescription(runtimeMode: RuntimeMode | undefined): string {
  const isolationGuidance = runtimeModeSupportsSharedTaskWorkspace(runtimeMode)
    ? "\n\nWorkspace isolation: by default each sub-agent runs in a forked copy of this workspace. " +
      'On this runtime you may pass isolation: "none" to run the sub-agent directly in this workspace\'s ' +
      "checkout (shared working tree, including uncommitted changes), skipping the fork + init overhead. " +
      'Reserve isolation: "none" for read-only analysis (e.g. the explore agent) or when you instruct the ' +
      "sub-agent to avoid editing shared files, since concurrent edits to the same files are possible. "
    : "";
  return (
    "Spawn a sub-agent task (child workspace). " +
    "\n\nIMPORTANT: Whether a sub-agent can see uncommitted changes depends on the runtime. " +
    `${getTaskRuntimeVisibilityGuidance(runtimeMode)} ` +
    "\n\nProvide agentId (preferred) or subagent_type, prompt, title, run_in_background, and optional n. For sub-agents, use title as a short, friendly reusable role name (for example, Reviewer or Simplicity Auditor), not a task summary. For kind=workspace, use a normal work-specific chat title. " +
    "Use n only when you want several agents to try the same prompt independently. Omit it for a single task, and prefer non-interfering sub-agents for grouped runs (for example read-only agents like explore). " +
    `\n\nA terminal report makes the child inactive but leaves its workspace persistent. Keep each parent's direct standalone bench small and role-based: aim for at most ${SUBAGENT_REUSABLE_BENCH_TARGET} and keep it below ${SUBAGENT_REUSABLE_BENCH_EXCLUSIVE_LIMIT}; deliberate grouped n runs are temporary exceptions. Before spawning standalone work, prefer reawakening a known inactive child when its context or expertise fits, and retitle it if its reusable responsibility changes. At the target, add a role only for a genuinely distinct responsibility and prune an inactive overlapping or least-useful role before reaching the limit. Reawakening preserves the child's checkout, so for repository-dependent work, reuse it only when that snapshot is appropriate or instruct the child to verify and synchronize before acting; otherwise spawn a new child. Stop active work with task_stop; use irreversible task_remove for consumed grouped candidates, bench consolidation, explicit user requests, or clearly obsolete context—not routine end-of-turn cleanup. ` +
    "\n\nWhen the user explicitly asks for best-of-n work, the parent should begin with light preliminary analysis to extract shared context, constraints, or evaluation criteria that would otherwise be duplicated across children. " +
    "Keep that pre-work lightweight: frame the task and provide useful starting points, but do not pre-solve the problem or over-constrain how the children reason about it. Then delegate the substantive analysis to the spawned sub-agents. " +
    "Do not also do a full parallel analysis in the parent. Call task_await when you are ready to act on child output; do not await reflexively just because tasks are running. " +
    "task_await returns as soon as the first awaited task completes by default (min_completed), so you can start dependent work on each result as it lands instead of blocking on the whole batch; for best-of-N synthesis that must compare every candidate, pass min_completed equal to the batch size (or use a foreground grouped spawn, below). " +
    "\n\nWhen delegating, include a compact task brief (Task / Background / Scope / Starting points / Acceptance / Deliverables / Constraints). " +
    "For now, persisted sub-agent goals are not supported; pass sub-agent objectives, success criteria, and deliverables directly in the prompt. " +
    "Sub-agents observe the same system instructions as the parent (project/global AGENTS.md and custom instructions), so do not restate that shared context in the prompt; spend the prompt on task-specific information the sub-agent cannot infer from those instructions. " +
    "Caveat: instruction files are read from the child's checkout, so uncommitted AGENTS.md edits in the parent follow the same runtime visibility rules above — commit them first or pass the relevant guidance in the prompt. " +
    "Avoid telling the sub-agent to read your plan file; child workspaces do not automatically have access to it. " +
    "\n\nIf run_in_background is false, waits for the sub-agent to finish and returns the completed report. When grouped sibling tasks are requested via n, the completed result includes one report per spawned task. " +
    "If the foreground wait times out, returns queued/starting/running task metadata with a note (the task continues running); use task_await to monitor progress. " +
    "If run_in_background is true, returns immediately with queued/starting/running task metadata and arranges a one-shot terminal wake when the task settles. Foreground waits that are later detached use the same terminal-wake path. " +
    "Prefer run_in_background: false when spawning a single task — it is equivalent to spawning background + immediately awaiting, but saves a round-trip. " +
    "Use run_in_background: true when launching multiple tasks in parallel so you can act on each as it completes via task_await (which returns on the first completion by default); a foreground grouped spawn (run_in_background: false) instead blocks until every sibling finishes and returns all reports at once. " +
    "Do not call task_await in the same parallel tool-call batch; wait for the returned task metadata first. " +
    "Use task_send_message for later guidance whether the child is active or inactive; inactive children reawaken under the same stable identity. " +
    isolationGuidance +
    "Use the bash tool to run shell commands."
  );
}

const WorkspaceTaskKindSchema = z.enum(["subagent", "workspace"]);
const WorkspaceTaskModeSchema = z.enum(["new", "fork", "existing"]);
const WorkspaceTaskTargetSchema = z
  .object({
    mode: WorkspaceTaskModeSchema.nullish(),
    workspaceId: z.string().trim().min(1).nullish(),
    branchName: z.string().trim().min(1).nullish(),
    trunkBranch: z.string().trim().min(1).nullish(),
    queueDispatchMode: z
      .enum(["tool-end", "turn-end"])
      .nullish()
      .describe(
        'For kind="workspace" + workspace.mode="existing", choose when a follow-up queued while the workspace is busy should dispatch: "tool-end" after the next tool call, or "turn-end" after the current turn.'
      ),
    disposable: z.boolean().nullish(),
  })
  .strict();

/** Shared validation across both task-arg schema variants (with/without `isolation`). */
function refineTaskToolAgentArgs(
  args: {
    kind?: "subagent" | "workspace" | null;
    agentId?: string | null;
    subagent_type?: string | null;
    prompt: string;
    n?: number | null;
    workspace?: { mode?: "new" | "fork" | "existing" | null; workspaceId?: string | null } | null;
  },
  ctx: z.RefinementCtx
): void {
  const kind = args.kind ?? "subagent";
  const hasAgentId = typeof args.agentId === "string" && args.agentId.length > 0;
  const hasSubagentType = typeof args.subagent_type === "string" && args.subagent_type.length > 0;

  if (kind === "workspace") {
    if (hasAgentId || hasSubagentType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Workspace tasks do not accept agentId or subagent_type",
        path: ["agentId"],
      });
    }
    if (args.n != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Workspace tasks do not support n yet",
        path: ["n"],
      });
    }
    if ((args.workspace?.mode ?? "new") === "fork") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspace.mode="fork" is not supported for workspace tasks yet',
        path: ["workspace", "mode"],
      });
    }
    if ((args.workspace?.mode ?? "new") === "existing" && args.workspace?.workspaceId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspace.workspaceId is required when workspace.mode is existing",
        path: ["workspace", "workspaceId"],
      });
    }
    return;
  }

  if (!hasAgentId && !hasSubagentType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide agentId (preferred) or subagent_type",
      path: ["agentId"],
    });
    return;
  }

  // GPT models often send both fields with identical values — allow that.
  // Only reject when they conflict, since the handler silently prefers agentId.
  if (hasAgentId && hasSubagentType && args.agentId !== args.subagent_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "agentId and subagent_type must match when both are provided",
      path: ["agentId"],
    });
    return;
  }
}

const taskToolBaseShape = {
  kind: WorkspaceTaskKindSchema.nullish().describe(
    'Task kind. Omit or use "subagent" for the existing child-workspace sub-agent flow; use "workspace" to start a normal full workspace turn.'
  ),
  // Prefer agentId. subagent_type is a deprecated alias for backwards compatibility.
  agentId: TaskAgentIdSchema.nullish(),
  subagent_type: SubagentTypeSchema.nullish(),
  prompt: z.string().min(1),
  // Persistent children appear alongside normal chats, so a short role label stays friendly and
  // reusable across follow-up assignments instead of reading like another task-specific chat title.
  title: z
    .string()
    .min(1)
    .describe(
      'Parent-chosen title. For a persistent sub-agent, use a short, friendly reusable role name such as "Reviewer" or "Simplicity Auditor", not the current assignment. For kind="workspace", use a normal work-specific chat title.'
    ),
  run_in_background: z.boolean().default(false),
  n: TaskToolBestOfCountSchema.nullish().describe(
    "Optional best-of count. Use n when several agents should try the same prompt independently; omit it for a single task. Only use grouped runs for sub-agents without interfering side effects, such as read-only agents like explore."
  ),
  workspace: WorkspaceTaskTargetSchema.nullish().describe(
    'Workspace target for kind="workspace". Omit for a new full workspace; use mode="existing" with workspaceId only for a workspace previously created by this caller.'
  ),
  model: TaskToolModelSchema.nullish().describe(
    "Optional model override for the sub-agent, parsed with the same alias logic as the UI (an alias or a full 'provider:model' string). Omit this unless the user explicitly instructed a specific model — by default the sub-agent inherits the parent's model. Do not assume any particular model is available."
  ),
  thinking: TaskToolThinkingSchema.nullish().describe(
    "Optional thinking/reasoning-level override for the sub-agent. Accepts a level name (off, low, medium, high, xhigh, max) or a numeric index (resolved against the chosen model). Omit this unless the user explicitly instructed a specific thinking level — by default the sub-agent inherits the parent's thinking level."
  ),
};

// Canonical schema (always includes `isolation`) — used for the execute() re-parse and token
// counting so `isolation` is accepted regardless of the runtime the args were produced on.
export const TaskToolArgsSchema = z
  .object({
    ...taskToolBaseShape,
    isolation: TaskIsolationSchema.nullish().describe(TASK_ISOLATION_PARAM_DESCRIPTION),
  })
  .strict()
  .superRefine(refineTaskToolAgentArgs);

// Variant WITHOUT `isolation`, advertised on runtimes that cannot share the parent checkout (e.g.
// local). `.strict()` makes it reject the field outright, so it never enters LLM context there.
const TaskToolArgsSchemaWithoutIsolation = z
  .object(taskToolBaseShape)
  .strict()
  .superRefine(refineTaskToolAgentArgs);

/**
 * Pick the task tool input schema for a runtime. `isolation` is only advertised on runtimes that
 * support sharing the parent checkout (see {@link runtimeModeSupportsSharedTaskWorkspace}); on
 * local runtimes the parameter is omitted from the schema entirely so it never enters LLM context.
 */
export function buildTaskToolAgentArgsSchema(options: {
  includeIsolation: boolean;
}): typeof TaskToolArgsSchema | typeof TaskToolArgsSchemaWithoutIsolation {
  return options.includeIsolation ? TaskToolArgsSchema : TaskToolArgsSchemaWithoutIsolation;
}

const TaskHandleKindSchema = z.enum(["agent_task", "workspace_turn"]);
const TaskThinkingLevelSchema = z.enum(THINKING_LEVELS);
const TaskToolSpawnedTaskSchema = z
  .object({
    taskId: z.string(),
    status: z.enum(["queued", "starting", "running", "completed", "interrupted"]),
    handleKind: TaskHandleKindSchema.optional(),
    workspaceId: z.string().optional(),
    modelString: z.string().optional(),
    thinkingLevel: TaskThinkingLevelSchema.optional(),
  })
  .strict();

const TaskToolCompletedReportSchema = z
  .object({
    taskId: z.string(),
    reportMarkdown: z.string(),
    title: z.string().optional(),
    structuredOutput: z.unknown().optional(),
    planFilePath: z.string().optional(),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    handleKind: TaskHandleKindSchema.optional(),
    workspaceId: z.string().optional(),
    messageId: z.string().optional(),
    finalMessageRef: WorkspaceTurnFinalMessageRefSchema.optional(),
    modelString: z.string().optional(),
    thinkingLevel: TaskThinkingLevelSchema.optional(),
  })
  .strict();

export const TaskToolQueuedResultSchema = z
  .object({
    status: z.enum(["queued", "starting", "running"]),
    taskId: z.string().optional(),
    taskIds: z.array(z.string()).min(1).optional(),
    handleKind: TaskHandleKindSchema.optional(),
    workspaceId: z.string().optional(),
    tasks: z.array(TaskToolSpawnedTaskSchema).min(1).optional(),
    reports: z.array(TaskToolCompletedReportSchema).min(1).optional(),
    modelString: z.string().optional(),
    thinkingLevel: TaskThinkingLevelSchema.optional(),
    note: z
      .string()
      .min(1)
      .describe("Additional guidance for the caller (e.g., use task_await to monitor progress)."),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasSingleTaskId = typeof value.taskId === "string" && value.taskId.trim().length > 0;
    const hasTaskIds = Array.isArray(value.taskIds) && value.taskIds.length > 0;
    const hasTasks = Array.isArray(value.tasks) && value.tasks.length > 0;

    if (!hasSingleTaskId && !hasTaskIds && !hasTasks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide taskId for single-task results or taskIds/tasks for grouped task results",
        path: ["taskId"],
      });
    }
  });

export const TaskToolCompletedResultSchema = z
  .object({
    status: z.literal("completed"),
    taskId: z.string().optional(),
    taskIds: z.array(z.string()).min(1).optional(),
    reportMarkdown: z.string().optional(),
    title: z.string().optional(),
    structuredOutput: z.unknown().optional(),
    planFilePath: z.string().optional(),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    handleKind: TaskHandleKindSchema.optional(),
    workspaceId: z.string().optional(),
    messageId: z.string().optional(),
    finalMessageRef: WorkspaceTurnFinalMessageRefSchema.optional(),
    reports: z.array(TaskToolCompletedReportSchema).min(1).optional(),
    modelString: z.string().optional(),
    thinkingLevel: TaskThinkingLevelSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasSingleTaskId = typeof value.taskId === "string" && value.taskId.trim().length > 0;
    const hasSingleReport = typeof value.reportMarkdown === "string";
    const hasReports = Array.isArray(value.reports) && value.reports.length > 0;

    if (hasSingleTaskId !== hasSingleReport) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Single-task completed results must include both taskId and reportMarkdown",
        path: hasSingleTaskId ? ["reportMarkdown"] : ["taskId"],
      });
    }

    if (!hasSingleTaskId && !hasReports) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide taskId/reportMarkdown for single-task results or reports for grouped task results",
        path: ["reports"],
      });
    }

    const reports = value.reports;
    if (hasReports && Array.isArray(reports)) {
      const taskIds = value.taskIds;
      if (Array.isArray(taskIds) && taskIds.length !== reports.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "taskIds length must match reports length when both are provided",
          path: ["taskIds"],
        });
      }
    }
  });

export const TaskToolResultSchema = z.discriminatedUnion("status", [
  TaskToolQueuedResultSchema,
  TaskToolCompletedResultSchema,
]);

// -----------------------------------------------------------------------------
// task_await (await one or more sub-agent tasks)
// -----------------------------------------------------------------------------

export const TaskAwaitToolArgsSchema = z
  .object({
    task_ids: z
      .array(z.string().min(1))
      .nullish()
      .describe(
        "List of task IDs or workflow run IDs to await — use only real IDs returned by prior task, bash, or workflow_run results; never fabricate an ID. " +
          "task_list can rediscover sub-agent/background bash IDs, but top-level workflow run rediscovery is done by omitting task_ids. " +
          "When omitted, waits for active descendant tasks and top-level workflow runs of the current workspace, excluding workflow-owned sub-agents/background bash tasks because those results are consumed through parent workflow runs."
      ),
    filter: z
      .string()
      .nullish()
      .describe(
        "Optional regex to filter bash task output lines. By default, only matching lines are returned. " +
          "When filter_exclude is true, matching lines are excluded instead. " +
          "Non-matching lines are discarded and cannot be retrieved later."
      ),
    filter_exclude: z
      .boolean()
      .nullish()
      .describe(
        "When true, lines matching 'filter' are excluded instead of kept. " +
          "Requires 'filter' to be set."
      ),
    timeout_secs: z
      .number()
      .min(0)
      .nullish()
      .default(600)
      .describe(
        "Maximum time to wait in seconds for each task. " +
          "For bash tasks, this waits for NEW output (or process exit). " +
          "If exceeded, the result returns status=queued|starting|running|awaiting_report (task is still active). " +
          "Defaults to 600 seconds (10 minutes) if not specified. " +
          "Set to 0 for a non-blocking status check."
      ),
    min_completed: z
      .number()
      .int()
      .min(1)
      .nullish()
      .describe(
        "Number of awaited tasks that must complete before this call returns. " +
          "Defaults to 1, so by default task_await returns as soon as the FIRST awaited task completes, " +
          "letting you act on it while the rest keep running. " +
          "The result still includes every task complete at that moment plus current status (running/queued) for the rest. " +
          "Tasks that have not yet completed keep running and remain re-awaitable on a later task_await call. " +
          "Raise this (e.g. set it to the total number of awaited tasks) when you genuinely need more before proceeding — " +
          "for example best-of-N synthesis that must compare every candidate. " +
          "Clamped to the number of awaited tasks; values above that behave like 'wait for all'."
      ),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.filter_exclude && !args.filter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "filter_exclude requires filter to be set",
        path: ["filter_exclude"],
      });
    }
  });

export const SubagentGitPatchArtifactStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "skipped",
]);

export const SubagentGitProjectPatchArtifactSchema = z
  .object({
    projectPath: z.string(),
    projectName: z.string(),
    storageKey: z.string(),
    status: SubagentGitPatchArtifactStatusSchema,
    baseCommitSha: z.string().optional(),
    headCommitSha: z.string().optional(),
    commitCount: z.number().int().nonnegative().optional(),
    mboxPath: z.string().optional(),
    error: z.string().optional(),
    appliedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const SubagentGitPatchArtifactSchema = z
  .object({
    childTaskId: z.string(),
    parentWorkspaceId: z.string(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative().optional(),
    status: SubagentGitPatchArtifactStatusSchema,
    projectArtifacts: z.array(SubagentGitProjectPatchArtifactSchema),
    readyProjectCount: z.number().int().nonnegative(),
    failedProjectCount: z.number().int().nonnegative(),
    skippedProjectCount: z.number().int().nonnegative(),
    totalCommitCount: z.number().int().nonnegative(),
  })
  .strict();

export type SubagentGitProjectPatchArtifact = z.infer<typeof SubagentGitProjectPatchArtifactSchema>;
export type SubagentGitPatchArtifact = z.infer<typeof SubagentGitPatchArtifactSchema>;

const TaskAwaitToolArtifactsSchema = z
  .object({
    gitFormatPatch: SubagentGitPatchArtifactSchema.optional(),
  })
  .strict();

/**
 * Appended to completed task/workflow results so the model knows the report is durable
 * and can be re-fetched by ID after context compaction instead of re-running the work.
 */
export const COMPLETED_REPORT_REFETCH_NOTE =
  'Report persisted on disk; re-fetch anytime (even after context compaction) with task_await(task_ids: ["<id>"], timeout_secs: 0).';

export const TaskAwaitToolCompletedResultSchema = z
  .object({
    status: z.literal("completed"),
    taskId: z.string(),
    reportMarkdown: z.string(),
    handleKind: TaskHandleKindSchema.optional(),
    workspaceId: z.string().optional(),
    messageId: z.string().optional(),
    finalMessageRef: WorkspaceTurnFinalMessageRefSchema.optional(),
    structuredOutput: z.unknown().optional(),
    title: z.string().optional(),
    modelString: z.string().optional(),
    thinkingLevel: TaskThinkingLevelSchema.optional(),
    output: z.string().optional(),
    elapsed_ms: z.number().optional(),
    exitCode: z.number().optional(),
    note: z.string().optional(),
    artifacts: TaskAwaitToolArtifactsSchema.optional(),
  })
  .strict();

export const WorkflowProgressPhaseSummarySchema = z
  .object({
    name: z.string().min(1),
    at: z.string(),
  })
  .strict();

export const WorkflowProgressStepCountsSchema = z
  .object({
    started: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    interrupted: z.number().int().nonnegative(),
  })
  .strict();

export const WorkflowProgressSummarySchema = z
  .object({
    name: z.string().min(1),
    latestPhase: WorkflowProgressPhaseSummarySchema.optional(),
    lastProgressAt: z.string().optional(),
    stepCounts: WorkflowProgressStepCountsSchema,
  })
  .strict();

export const TaskAwaitToolActiveResultSchema = z
  .object({
    status: z.enum([
      "queued",
      "starting",
      "running",
      "backgrounded",
      "awaiting_report",
      "interrupted",
    ]),
    taskId: z.string(),
    handleKind: TaskHandleKindSchema.optional(),
    workspaceId: z.string().optional(),
    output: z.string().optional(),
    elapsed_ms: z.number().optional(),
    note: z.string().optional(),
    workflowProgress: WorkflowProgressSummarySchema.optional(),
  })
  .strict();

export const TaskAwaitToolNotFoundResultSchema = z
  .object({
    status: z.literal("not_found"),
    taskId: z.string(),
    activeTaskIds: z.array(z.string()).optional(),
  })
  .strict();

export const TaskAwaitToolInvalidScopeResultSchema = z
  .object({
    status: z.literal("invalid_scope"),
    taskId: z.string(),
    activeTaskIds: z.array(z.string()).optional(),
  })
  .strict();

// Failure is the one case where workflow state must reach the model: it has to decide between
// workflow_resume (retry_from_checkpoint) and a fresh workflow_run. Surface per-step outcomes
// compactly — never the full run record (script source / event log).
export const TaskAwaitWorkflowFailureStateSchema = z
  .object({
    name: z.string().min(1),
    steps: z.array(
      z
        .object({
          stepId: z.string().min(1),
          status: WorkflowStepStatusSchema,
          taskId: z.string().optional(),
          error: z.string().optional(),
        })
        .strict()
    ),
  })
  .strict();

export const TaskAwaitToolErrorResultSchema = z
  .object({
    status: z.literal("error"),
    taskId: z.string(),
    error: z.string(),
    elapsed_ms: z.number().optional(),
    workflow: TaskAwaitWorkflowFailureStateSchema.optional(),
  })
  .strict();

export const TaskAwaitToolResultSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion("status", [
        TaskAwaitToolCompletedResultSchema,
        TaskAwaitToolActiveResultSchema,
        TaskAwaitToolNotFoundResultSchema,
        TaskAwaitToolInvalidScopeResultSchema,
        TaskAwaitToolErrorResultSchema,
      ])
    ),
  })
  .strict();

// -----------------------------------------------------------------------------
// task_apply_git_patch (apply git-format-patch artifact via git am)
// -----------------------------------------------------------------------------

export const TaskApplyGitPatchToolArgsSchema = z
  .object({
    task_id: z.string().min(1).describe("Child task ID whose patch artifact should be applied"),
    project_path: z
      .string()
      .nullish()
      .describe("When provided, apply only the patch artifact for this project path."),
    dry_run: z
      .boolean()
      .nullish()
      .describe(
        "When true, attempt to apply the patch in a temporary git worktree and then discard it (does not modify the current workspace)."
      ),
    expected_head_sha: z
      .string()
      .min(1)
      .nullish()
      .describe(
        "When provided, refuse to apply unless the target repository HEAD matches this SHA."
      ),
    three_way: z.boolean().nullish().default(true).describe("When true, run git am with --3way"),
    force: z
      .boolean()
      .nullish()
      .describe("When true, allow apply even if the patch was previously applied."),
  })
  .strict();

const TaskApplyGitPatchAppliedCommitSchema = z
  .object({
    // Commit subject line (always stable, even across dry-run vs real apply)
    subject: z.string().min(1),
    // Optional SHA (omitted for dry-run because the commit IDs may differ when applied for real)
    sha: z.string().min(1).optional(),
  })
  .strict();

const TaskApplyGitPatchProjectResultStatusSchema = z.enum(["applied", "failed", "skipped"]);

export const TaskApplyGitPatchProjectResultSchema = z
  .object({
    projectPath: z.string(),
    projectName: z.string(),
    status: TaskApplyGitPatchProjectResultStatusSchema,
    appliedCommits: z.array(TaskApplyGitPatchAppliedCommitSchema).optional(),
    headCommitSha: z.string().optional(),
    error: z.string().optional(),
    failedPatchSubject: z.string().optional(),
    conflictPaths: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict();

export const TaskApplyGitPatchToolResultSchema = z.union([
  z
    .object({
      success: z.literal(true),
      taskId: z.string(),
      projectResults: z.array(TaskApplyGitPatchProjectResultSchema),
      appliedCommits: z.array(TaskApplyGitPatchAppliedCommitSchema).optional(),
      headCommitSha: z.string().optional(),
      dryRun: z.boolean().optional(),
      note: z.string().optional(),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      taskId: z.string(),
      error: z.string(),
      projectResults: z.array(TaskApplyGitPatchProjectResultSchema).optional(),
      dryRun: z.boolean().optional(),
      appliedCommits: z.array(TaskApplyGitPatchAppliedCommitSchema).optional(),
      headCommitSha: z.string().optional(),
      conflictPaths: z.array(z.string()).optional(),
      failedPatchSubject: z.string().optional(),
      note: z.string().optional(),
    })
    .strict(),
]);

// -----------------------------------------------------------------------------
// task_send_message (send updated guidance to a running sub-agent)
// -----------------------------------------------------------------------------

export const TaskSendMessageToolArgsSchema = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe("Descendant sub-agent task ID returned by task or task_list."),
    message: z.string().trim().min(1).describe("Updated guidance to send to the sub-agent."),
    queue_dispatch_mode: z
      .enum(["tool-end", "turn-end"])
      .nullish()
      .describe(
        'When the child is busy, dispatch the guidance at "tool-end" after its next tool call (default) or at "turn-end" after its current turn.'
      ),
  })
  .strict();

const TaskSendMessageToolAcceptedResultSchema = z
  .object({
    status: z.literal("accepted"),
    taskId: z.string(),
  })
  .strict();

const TaskSendMessageToolQueuedResultSchema = z
  .object({
    status: z.literal("queued"),
    taskId: z.string(),
    queueDispatchMode: z.enum(["tool-end", "turn-end"]).optional(),
  })
  .strict();

const TaskSendMessageToolReactivatedResultSchema = z
  .object({
    status: z.literal("reactivated"),
    taskId: z.string(),
  })
  .strict();

const TaskSendMessageToolNotFoundResultSchema = z
  .object({
    status: z.literal("not_found"),
    taskId: z.string(),
  })
  .strict();

const TaskSendMessageToolInvalidScopeResultSchema = z
  .object({
    status: z.literal("invalid_scope"),
    taskId: z.string(),
  })
  .strict();

const TaskSendMessageToolNotActiveResultSchema = z
  .object({
    status: z.literal("not_active"),
    taskId: z.string(),
    taskStatus: z.enum([
      "queued",
      "starting",
      "running",
      "awaiting_report",
      "interrupted",
      "reported",
      "unknown",
    ]),
    error: z.string(),
  })
  .strict();

const TaskSendMessageToolErrorResultSchema = z
  .object({
    status: z.literal("error"),
    taskId: z.string(),
    error: z.string(),
  })
  .strict();

export const TaskSendMessageToolResultSchema = z.discriminatedUnion("status", [
  TaskSendMessageToolAcceptedResultSchema,
  TaskSendMessageToolQueuedResultSchema,
  TaskSendMessageToolReactivatedResultSchema,
  TaskSendMessageToolNotFoundResultSchema,
  TaskSendMessageToolInvalidScopeResultSchema,
  TaskSendMessageToolNotActiveResultSchema,
  TaskSendMessageToolErrorResultSchema,
]);

// -----------------------------------------------------------------------------
// task_message_parent / task_message_sibling (RLM family messaging)
// -----------------------------------------------------------------------------

export const TaskMessageParentToolArgsSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1)
      // Bounded: a kernel guest can synthesize huge strings cheaply; family
      // messages land in another workspace's transcript and provider requests.
      .max(TASK_FAMILY_MESSAGE_MAX_CHARS)
      .describe("Message to queue for your parent workspace."),
  })
  .strict();

export const TaskMessageParentToolResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("sent"), parentWorkspaceId: z.string() }).strict(),
  z.object({ status: z.literal("invalid_scope"), error: z.string() }).strict(),
  z.object({ status: z.literal("error"), error: z.string() }).strict(),
]);

export const TaskMessageSiblingToolArgsSchema = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe("Sibling task ID; it must share your direct parent workspace."),
    message: z
      .string()
      .trim()
      .min(1)
      // Same bound as task_message_parent (see that schema's rationale).
      .max(TASK_FAMILY_MESSAGE_MAX_CHARS)
      .describe("Message to deliver to the sibling task."),
  })
  .strict();

// Sibling delivery reuses the task_send_message machinery, so the result surface is identical.
export const TaskMessageSiblingToolResultSchema = TaskSendMessageToolResultSchema;

// -----------------------------------------------------------------------------
// task_retitle (rename a persistent descendant sub-agent)
// -----------------------------------------------------------------------------
export const TaskRetitleToolArgsSchema = z
  .object({
    task_id: z.string().min(1).describe("Stable descendant sub-agent task ID."),
    title: z
      .string()
      .trim()
      .min(1)
      .describe('New short, friendly reusable role name, such as "Reviewer".'),
  })
  .strict();

const TaskRetitleToolBaseResultSchema = z.object({
  taskId: z.string(),
});

export const TaskRetitleToolResultSchema = z.discriminatedUnion("status", [
  TaskRetitleToolBaseResultSchema.extend({
    status: z.literal("retitled"),
    title: z.string(),
  }).strict(),
  TaskRetitleToolBaseResultSchema.extend({ status: z.literal("not_found") }).strict(),
  TaskRetitleToolBaseResultSchema.extend({ status: z.literal("invalid_scope") }).strict(),
  TaskRetitleToolBaseResultSchema.extend({
    status: z.literal("error"),
    error: z.string(),
  }).strict(),
]);

// -----------------------------------------------------------------------------
// task_stop (non-destructively stop tasks/processes)
// -----------------------------------------------------------------------------
export const TaskStopToolArgsSchema = z
  .object({
    task_ids: z.array(z.string().min(1)).min(1).describe("Task IDs to stop."),
  })
  .strict();

const TaskStopToolStoppedResultSchema = z
  .object({
    status: z.literal("stopped"),
    taskId: z.string(),
    stoppedTaskIds: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict();

const TaskStopToolAlreadyInactiveResultSchema = z
  .object({
    status: z.literal("already_inactive"),
    taskId: z.string(),
  })
  .strict();

const TaskStopToolNotFoundResultSchema = z
  .object({ status: z.literal("not_found"), taskId: z.string() })
  .strict();
const TaskStopToolInvalidScopeResultSchema = z
  .object({ status: z.literal("invalid_scope"), taskId: z.string() })
  .strict();
const TaskStopToolErrorResultSchema = z
  .object({ status: z.literal("error"), taskId: z.string(), error: z.string() })
  .strict();

export const TaskStopToolResultSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion("status", [
        TaskStopToolStoppedResultSchema,
        TaskStopToolAlreadyInactiveResultSchema,
        TaskStopToolNotFoundResultSchema,
        TaskStopToolInvalidScopeResultSchema,
        TaskStopToolErrorResultSchema,
      ])
    ),
  })
  .strict();

// -----------------------------------------------------------------------------
// task_remove (irreversibly remove inactive child workspaces)
// -----------------------------------------------------------------------------
export const TaskRemoveToolArgsSchema = z
  .object({
    task_ids: z.array(z.string().min(1)).min(1).describe("Inactive child task IDs to remove."),
  })
  .strict();

const TaskRemoveToolBaseResultSchema = z.object({
  taskId: z.string(),
  workspaceId: z.string().optional(),
  descendantTaskIds: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export const TaskRemoveToolResultSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion("status", [
        TaskRemoveToolBaseResultSchema.extend({ status: z.literal("removed") }).strict(),
        TaskRemoveToolBaseResultSchema.extend({ status: z.literal("already_removed") }).strict(),
        TaskRemoveToolBaseResultSchema.extend({ status: z.literal("active") }).strict(),
        TaskRemoveToolBaseResultSchema.extend({ status: z.literal("not_found") }).strict(),
        TaskRemoveToolBaseResultSchema.extend({ status: z.literal("invalid_scope") }).strict(),
        TaskRemoveToolBaseResultSchema.extend({ status: z.literal("error") }).strict(),
      ])
    ),
  })
  .strict();

// -----------------------------------------------------------------------------
// task_terminate (terminate sub-agent/bash tasks, interrupt workflow runs)
// -----------------------------------------------------------------------------
export const TaskTerminateToolArgsSchema = z
  .object({
    task_ids: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "List of task IDs to terminate. Sub-agent task IDs and bash task IDs must belong to descendants of the current workspace; " +
          "workflow run IDs (wfr_...) must belong to the current workspace and are interrupted (resumable) rather than destroyed."
      ),
  })
  .strict();

export const TaskTerminateToolTerminatedResultSchema = z
  .object({
    status: z.literal("terminated"),
    taskId: z.string(),
    terminatedTaskIds: z
      .array(z.string())
      .describe("All terminated task IDs (includes descendants)"),
  })
  .strict();

// Workflow runs are durable: interrupting preserves the event log so the run can be resumed
// later via workflow_resume. This is intentionally distinct from "terminated" (work discarded).
export const TaskTerminateToolInterruptedResultSchema = z
  .object({
    status: z.literal("interrupted"),
    taskId: z.string(),
    note: z.string(),
  })
  .strict();

export const TaskTerminateToolNotFoundResultSchema = z
  .object({
    status: z.literal("not_found"),
    taskId: z.string(),
    activeTaskIds: z.array(z.string()).optional(),
  })
  .strict();

export const TaskTerminateToolInvalidScopeResultSchema = z
  .object({
    status: z.literal("invalid_scope"),
    taskId: z.string(),
    activeTaskIds: z.array(z.string()).optional(),
  })
  .strict();

export const TaskTerminateToolErrorResultSchema = z
  .object({
    status: z.literal("error"),
    taskId: z.string(),
    error: z.string(),
  })
  .strict();

export const TaskTerminateToolResultSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion("status", [
        TaskTerminateToolTerminatedResultSchema,
        TaskTerminateToolInterruptedResultSchema,
        TaskTerminateToolNotFoundResultSchema,
        TaskTerminateToolInvalidScopeResultSchema,
        TaskTerminateToolErrorResultSchema,
      ])
    ),
  })
  .strict();

// -----------------------------------------------------------------------------
// task_workspace_lifecycle (parent-owned workspace cleanup)
// -----------------------------------------------------------------------------

export const TaskWorkspaceLifecycleActionSchema = z.enum([
  "archive",
  "unarchive",
  "delete_worktree",
  "remove",
]);

export const TaskWorkspaceLifecycleTargetSchema = z
  .object({
    taskId: z.string().min(1).nullish(),
    workspaceId: z.string().min(1).nullish(),
  })
  .strict()
  .superRefine((target, ctx) => {
    const hasTaskId = target.taskId != null && target.taskId.trim().length > 0;
    const hasWorkspaceId = target.workspaceId != null && target.workspaceId.trim().length > 0;
    if (hasTaskId === hasWorkspaceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of taskId or workspaceId",
        path: ["taskId"],
      });
    }
  });

export const TaskWorkspaceLifecycleToolArgsSchema = z
  .object({
    action: TaskWorkspaceLifecycleActionSchema.describe(
      'Lifecycle action to perform: "archive" hides and suspends without deleting state, "unarchive" restores visibility, "delete_worktree" reclaims disk after archive, and "remove" irreversibly deletes archived workspace metadata/session state.'
    ),
    targets: z
      .array(TaskWorkspaceLifecycleTargetSchema)
      .min(1)
      .describe(
        "Parent-owned sub-agent or workspace-turn targets. Provide exactly one of taskId or workspaceId for each target."
      ),
    interrupt_active: z
      .boolean()
      .nullish()
      .describe(
        "When true, interrupt active workspace turns for the target before performing an otherwise-eligible lifecycle action. Active sub-agents must be discarded with task_terminate instead. Defaults to false."
      ),
    force: z
      .boolean()
      .nullish()
      .describe(
        "Only applies to remove. Does not bypass ownership, active-turn, archive, or archive-confirmation safety checks."
      ),
    acknowledged_untracked_paths: z
      .record(z.string(), z.array(z.string()))
      .nullish()
      .describe(
        "Archive-only confirmations keyed by resolved workspaceId. Use only paths returned by a previous requires_confirmation result."
      ),
  })
  .strict();

const TaskWorkspaceLifecycleBaseResultSchema = z.object({
  action: TaskWorkspaceLifecycleActionSchema,
  taskId: z.string().optional(),
  workspaceId: z.string().optional(),
  displayName: z.string().optional(),
  paths: z.array(z.string()).optional(),
  activeTaskIds: z.array(z.string()).optional(),
  descendantTaskIds: z.array(z.string()).optional(),
  note: z.string().optional(),
  error: z.string().optional(),
});

export const TaskWorkspaceLifecycleToolTargetResultSchema = z.discriminatedUnion("status", [
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("archived") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("already_archived") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("unarchived") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({
    status: z.literal("already_unarchived"),
  }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("deleted_worktree") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({
    status: z.literal("already_transcript_only"),
  }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("removed") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("already_removed") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("requires_archive") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({
    status: z.literal("requires_confirmation"),
  }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("active") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("not_found") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("invalid_scope") }).strict(),
  TaskWorkspaceLifecycleBaseResultSchema.extend({ status: z.literal("error") }).strict(),
]);

export const TaskWorkspaceLifecycleToolResultSchema = z
  .object({
    results: z.array(TaskWorkspaceLifecycleToolTargetResultSchema),
  })
  .strict();

// -----------------------------------------------------------------------------
// task_list (list descendant sub-agent tasks)
// -----------------------------------------------------------------------------

// Agent tasks use queued/starting/running/awaiting_report/interrupted/reported; workflow runs
// additionally use pending/backgrounded/failed/completed. The vocabularies share "running" and
// "interrupted"; task IDs are self-describing (wfr_... = workflow run, bash:... = bash task).
const TaskListStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "awaiting_report",
  "interrupted",
  "reported",
  "pending",
  "backgrounded",
  "failed",
  "completed",
]);
export const TaskListToolArgsSchema = z
  .object({
    statuses: z
      .array(TaskListStatusSchema)
      .nullish()
      .describe(
        "Task statuses to include. Defaults to unfinished tasks and workflow runs: queued, starting, running, awaiting_report, pending, backgrounded. " +
          "Persistent completed sub-agents are terminal `reported` tasks and are intentionally omitted by default; include `reported` (and `interrupted` when relevant) to rediscover inactive child workspaces after compaction or restart. " +
          "Omitting statuses is the safe recovery default after an uncertain workflow_run because it includes unfinished workflow runs. " +
          "Pass ['interrupted', 'failed'] to discover workflow runs that may be resumable via workflow_resume, but do not use only terminal/resumable statuses when checking for a still-running workflow."
      ),
    includeArchived: z
      .boolean()
      .nullish()
      .describe(
        "Compatibility option for archived workspace-turn and bash records. Legacy archived sub-agents remain listable as inactive children regardless."
      ),
  })
  .strict();

export const TaskListToolTaskSchema = z
  .object({
    taskId: z.string(),
    status: TaskListStatusSchema,
    parentWorkspaceId: z.string(),
    agentType: z.string().optional(),
    workspaceName: z.string().optional(),
    title: z.string().optional(),
    createdAt: z.string().optional(),
    handleKind: TaskHandleKindSchema.optional(),
    workspaceId: z.string().optional(),
    modelString: z.string().optional(),
    thinkingLevel: TaskThinkingLevelSchema.optional(),
    bestOf: BestOfGroupSchema.optional(),
    workflowProgress: WorkflowProgressSummarySchema.optional(),
    depth: z.number().int().min(0),
  })
  .strict();

export const TaskListToolResultSchema = z
  .object({
    tasks: z.array(TaskListToolTaskSchema),
    note: z.string().optional(),
  })
  .strict();

// -----------------------------------------------------------------------------
// workflow_run (durable workflow orchestration)
// -----------------------------------------------------------------------------

export const WorkflowRunToolArgsSchema = z
  .object({
    script_path: z
      .string()
      .min(1)
      .nullish()
      .describe(
        'Explicit workflow script path, such as "skill://deep-research/workflow.js" or "./workflows/research.js". Use paths for reusable, reviewable, or skill-packaged workflows.'
      ),
    script_source: z
      .string()
      .min(1)
      .nullish()
      .describe(
        "Inline JavaScript workflow source for one-off conductors, including prose-described processes codified in place. The exact source is snapshotted into the durable run for replay/resume."
      ),
    args: z.unknown().nullish(),
    run_in_background: z
      .boolean()
      .nullish()
      .default(false)
      .describe(
        "Defaults to false. Prefer foreground mode for a single workflow; when the returned status is completed, the result is available directly. " +
          "Set true only when you will start another workflow/task or do independent work while it runs. If workflow_run returns status=running or status=backgrounded, await the returned runId with task_await before using the result."
      ),
  })
  .strict()
  .superRefine((args, ctx) => {
    const hasPath = args.script_path != null;
    const hasSource = args.script_source != null;
    if (hasPath === hasSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of script_path or script_source.",
        path: ["script_path"],
      });
    }
  });

export const WorkflowRunToolResultSchema = z
  .object({
    status: WorkflowRunStatusSchema,
    runId: z.string().min(1),
    result: z.unknown(),
    run: WorkflowRunRecordSchema.optional(),
    note: z.string().optional(),
  })
  .strict();

// Resuming replays the durable event log and continues from the last checkpoint; completed
// steps never re-execute. Checkpoint retry of a *failed* run re-executes whatever followed the
// last durable event (potentially side-effectful), so it must be requested explicitly via mode.
export const WorkflowResumeModeSchema = z.enum(["resume", "retry_from_checkpoint"]);

export const WorkflowResumeToolArgsSchema = z
  .object({
    run_id: z
      .string()
      .min(1)
      .describe("Workflow run ID (wfr_...) to resume. Must belong to the current workspace."),
    run_in_background: z
      .boolean()
      .nullish()
      .default(false)
      .describe(
        "Defaults to false (foreground): waits until the run reaches a terminal status and returns its result. " +
          "Set true to resume in the background and continue other work; await the runId with task_await when you need the result."
      ),
    mode: WorkflowResumeModeSchema.nullish().describe(
      "Defaults to 'resume', which continues interrupted or crash-orphaned runs from durable state and never re-executes completed steps. " +
        "Use 'retry_from_checkpoint' only for failed runs; it re-executes work after the last checkpoint and is rejected when unsafe."
    ),
  })
  .strict();

export const WorkflowResumeToolResultSchema = z
  .object({
    status: WorkflowRunStatusSchema,
    runId: z.string().min(1),
    result: z.unknown(),
    mode: WorkflowResumeModeSchema,
    note: z.string().optional(),
    run: WorkflowRunRecordSchema.optional(),
  })
  .strict();

// -----------------------------------------------------------------------------
// agent_report (explicit subagent -> parent report)
// -----------------------------------------------------------------------------

export const AgentReportInlineToolArgsSchema = z
  .object({
    reportMarkdown: z.string().min(1),
    title: z.string().nullish(),
  })
  .strict();

export const AgentReportToolArgsSchema = AgentReportInlineToolArgsSchema;

export const AgentReportSubmittedReportSchema = z
  .object({
    reportMarkdown: z.string().min(1),
    structuredOutput: z.unknown().optional(),
    title: z.string().min(1).optional(),
  })
  .strict();

export const AgentReportToolResultSchema = z.discriminatedUnion("success", [
  z
    .object({
      success: z.literal(true),
      message: z.string().min(1).optional(),
      report: AgentReportSubmittedReportSchema.optional(),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      message: z.string().min(1),
      errors: z.array(z.object({ path: z.string().min(1), message: z.string().min(1) })).min(1),
    })
    .strict(),
]);
const FILE_TOOL_PATH = z
  .string()
  .describe("Path to the file to edit (absolute or relative to the current workspace)");

/**
 * Zod preprocessor: normalizes legacy `file_path` / `filePath` keys to canonical `path`.
 * Signature is `unknown → unknown` because `z.preprocess` requires it.
 */
function normalizeFilePath(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

  const obj = value as Record<string, unknown>;

  // Canonical `path` already present — let schema validation handle it.
  if ("path" in obj) return value;

  const resolved = extractToolFilePath(value);
  if (resolved == null) return value;

  const { file_path: _, filePath: __, ...rest } = obj;
  return { ...rest, path: resolved };
}

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

// -----------------------------------------------------------------------------
// propose_name (workspace name generation)
// -----------------------------------------------------------------------------

export const ProposeNameToolArgsSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(20)
    .describe(
      "Codebase area (1-2 words, max 15 chars): lowercase, hyphens only, e.g. 'sidebar', 'auth', 'config'"
    ),
  title: z
    .string()
    .min(5)
    .max(60)
    .describe("Human-readable title (2-5 words): verb-noun format like 'Fix plan mode'"),
});

// -----------------------------------------------------------------------------
// propose_status (sidebar agent status generation)
// -----------------------------------------------------------------------------

export const ProposeStatusToolArgsSchema = z.object({
  emoji: z
    .string()
    .min(1)
    .max(8)
    .describe(
      "A single emoji that represents the agent's current activity (e.g. '🔍', '🛠️', '🧪', '📝')"
    ),
  message: z
    .string()
    .min(2)
    .max(60)
    .describe(
      "A short verb-led phrase (2-6 words) describing what the agent is currently working on, in sentence case, no punctuation, no quotes (e.g. 'Investigating crash', 'Implementing sidebar status')"
    ),
});

const XumConfigFileSchema = z.enum(["providers", "config"]);

/**
 * Rename a string-typed alias field to its canonical name on a plain object,
 * dropping the alias to keep downstream tool args canonical. No-op if the
 * canonical field is already a string or the alias is missing/non-string.
 *
 * Used by the bash tool's `preprocess` to normalize quirky model emissions
 * (e.g. `command` → `script`, `description` → `display_name`) without
 * duplicating the same destructure/spread shape per alias.
 */
function renameAliasField(
  obj: Record<string, unknown>,
  alias: string,
  canonical: string
): Record<string, unknown> {
  if (typeof obj[canonical] === "string") return obj;
  if (typeof obj[alias] !== "string") return obj;
  const { [alias]: aliasValue, ...rest } = obj;
  return { ...rest, [canonical]: aliasValue };
}

const BashMonitorSchema = z
  .object({
    filter: z.string().min(1).describe("Regex applied to each complete output line."),
    filter_exclude: z
      .boolean()
      .nullish()
      .describe("When true, wake for complete lines that do not match filter."),
    cooldown_ms: z
      .number()
      .int()
      .min(0)
      .nullish()
      .describe("Milliseconds to coalesce matching lines before one wake. Defaults to 1000."),
    max_events: z
      .number()
      .int()
      .positive()
      .nullish()
      .describe("Stop monitoring after this many matching lines; the process keeps running."),
  })
  .strict();

/**
 * Tool definitions: single source of truth
 * Key = tool name, Value = { description, schema }
 */
export const TOOL_DEFINITIONS = {
  bash: {
    description:
      "Execute a bash command with a configurable timeout. " +
      `Output is strictly limited to ${BASH_HARD_MAX_LINES} lines, ${BASH_MAX_LINE_BYTES} bytes per line, and ${BASH_MAX_TOTAL_BYTES} bytes total. ` +
      "Commands that exceed these limits will FAIL with an error (no partial output returned). " +
      "Be conservative: use 'head', 'tail', 'grep', or other filters to limit output before running commands. " +
      "Large outputs may be automatically filtered; when this happens, the result includes a note explaining what was kept and (if available) where the full output was saved.\n" +
      "On Windows this runs in Git Bash; to discard output use `>/dev/null` (not `>nul`). " +
      "Background commands can include a monitor block with a regex filter; matching complete output lines wake this workspace, including after the current response, so no polling is required. Terminate monitors that are no longer relevant before finishing.",
    schema: z.preprocess(
      (value) => {
        // Compatibility shims for models that emit alias fields:
        // - some models emit `command` instead of `script`
        // - DeepSeek v4 emits `description` instead of `display_name`
        // Normalize both so downstream code (tool runner + UI) sees canonical args.
        // Aliases are intentionally undocumented in the public schema; we don't
        // want to invite other models to use the wrong field.
        if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

        let obj = value as Record<string, unknown>;
        obj = renameAliasField(obj, "command", "script");
        obj = renameAliasField(obj, "description", "display_name");
        return obj;
      },
      z
        .object({
          script: z.string().describe("The bash script/command to execute"),
          model_intent: z
            .string()
            .nullish()
            .describe(
              "Optional. Short user-facing purpose for this command, shown next to the command in collapsed chat. " +
                "Use a present-participle phrase in plain English, under 100 characters. " +
                "Do not repeat the command or include duration, because Xum appends those. " +
                "Examples: 'Running the unit tests', 'Checking repository state', 'Inspecting build output'."
            ),
          timeout_secs: z
            .number()
            .positive()
            .describe(
              "Timeout in seconds. For foreground: max execution time before kill. " +
                "For background: max lifetime before auto-termination. " +
                "Start small and increase on retry; avoid large initial values to keep UX responsive"
            ),
          run_in_background: z
            .boolean()
            .default(false)
            .describe(
              "Run this command in the background without blocking. " +
                "Use for processes running >5s (dev servers, builds, file watchers). " +
                "Do NOT use for quick commands (<5s), interactive processes (no stdin support), " +
                "or processes requiring real-time output (use foreground with larger timeout instead). " +
                "Returns immediately with a taskId (bash:<processId>) and backgroundProcessId. " +
                "Read output with task_await (returns only new output since last check). " +
                "Stop with task_stop using the taskId. " +
                "List active tasks with task_list. " +
                "Process persists until timeout_secs expires, terminated, or workspace is removed." +
                "\\n\\nFor long-running tasks like builds or compilations, prefer background mode to continue productive work in parallel. " +
                "Without a monitor, raw background bash does not automatically wake the parent workspace when it prints output or exits. " +
                "With monitor, matching complete output lines wake this workspace, including after your current response; use task_await only if you need surrounding/full output. " +
                "Before finishing, terminate monitored tasks that are no longer relevant so stale output cannot trigger a follow-up turn. " +
                "Do not call task_await in the same parallel tool-call batch; wait for the returned taskId first. " +
                "When you actually need the output, read it with task_await; do not poll task_await just because the process is still running."
            ),
          monitor: BashMonitorSchema.nullish().describe(
            "Wake-on-match monitor. Valid only with run_in_background=true. Matching complete output lines wake this workspace without polling, even after the current response; terminate it before finishing if future wakes are no longer useful."
          ),
          display_name: z
            .string()
            .describe(
              "Human-readable name for the process (e.g., 'Dev Server', 'TypeCheck Watch'). " +
                "Required for all bash invocations since any process can be sent to background."
            ),
        })
        .refine((args) => args.monitor == null || args.run_in_background === true, {
          path: ["monitor"],
          message: "monitor requires run_in_background=true",
        })
    ),
  },
  file_read: {
    description:
      "Read the contents of a file from the file system. Read as little as possible to complete the task. " +
      "Content is returned with line numbers prepended in the format '<line_number>\\t<content>'. " +
      "These line numbers are NOT part of the actual file content and must not be included when editing files.",
    schema: z.preprocess(
      normalizeFilePath,
      z.object({
        path: z.string().describe("The path to the file to read (absolute or relative)"),
        offset: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe("1-based starting line number (optional, defaults to 1)"),
        limit: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe(
            "Number of lines to return from offset (optional, returns all if not specified)"
          ),
      })
    ),
  },
  memory: {
    description:
      "Manage your persistent memory directory (experiment). " +
      "MEMORY PROTOCOL: check relevant memories before acting on a task; record durable facts, preferences, and lessons as you learn them; update or delete memories that turn out to be wrong or stale.\n" +
      "Scopes (all paths are virtual):\n" +
      "- /memories/global/... — personal, permanent, shared across all projects\n" +
      "- /memories/project/... — private notes about this project; host-local, never committed, survives workspaces\n" +
      "- /memories/workspace/... — scratch state for this workspace; deleted with the workspace\n" +
      "Commands:\n" +
      "- view: list a directory (up to 2 levels, dotfiles excluded) or show a file with line numbers (offset/limit supported)\n" +
      "- create: create a new file; ERRORS if the file already exists (to overwrite: delete first, then create)\n" +
      "- str_replace: replace a unique occurrence of old_str with new_str (errors with matching line numbers when ambiguous)\n" +
      "- insert: insert insert_text after line insert_line (0 = top of file)\n" +
      "- delete: delete a file or directory (recursive)\n" +
      "- rename: move old_path to new_path within the same scope\n" +
      "Files are Markdown; optional YAML frontmatter with a one-line `description:` is surfaced in your memory index.",
    schema: z.preprocess(
      (value) => {
        // Compatibility shims (same mechanism as bash command->script): models
        // trained on our file tools may emit file tool field names.
        const normalized = normalizeFilePath(value); // file_path/filePath -> path
        if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
          return normalized;
        }
        let obj = normalized as Record<string, unknown>;
        obj = renameAliasField(obj, "content", "file_text");
        obj = renameAliasField(obj, "old_string", "old_str");
        obj = renameAliasField(obj, "new_string", "new_str");
        return obj;
      },
      z.object({
        command: z
          .enum(["view", "create", "str_replace", "insert", "delete", "rename"])
          .describe("The memory operation to perform."),
        path: z
          .string()
          .nullish()
          .describe(
            "Virtual memory path (e.g. /memories/global/notes.md). Required for every command except rename."
          ),
        file_text: z.string().nullish().describe("create: full contents of the new file."),
        old_str: z
          .string()
          .nullish()
          .describe("str_replace: exact text to replace (must be unique in the file)."),
        new_str: z.string().nullish().describe("str_replace: replacement text."),
        insert_line: z
          .number()
          .int()
          .nonnegative()
          .nullish()
          .describe("insert: line number to insert after (0 = top of file)."),
        insert_text: z.string().nullish().describe("insert: text to insert."),
        old_path: z.string().nullish().describe("rename: current virtual path."),
        new_path: z.string().nullish().describe("rename: new virtual path (same scope)."),
        offset: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe("view on a file: 1-based starting line number (optional)."),
        limit: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe("view on a file: number of lines to return from offset (optional)."),
      })
    ),
  },
  attach_file: {
    description:
      "Attach a file from the filesystem so later model steps receive it as a real attachment instead of a huge base64 JSON blob. " +
      "Accepts absolute or relative paths, including files outside the workspace. Accepts any file type. " +
      "Raster images, SVG, and PDF are sent to the model as real attachments. Every other file type (text, source, diffs, logs, video, audio, archives, etc.) is shown to the user in chat for preview/download, but its contents are NOT sent to the model — you only receive a notice. Use file_read when you need to read a text file's contents yourself.",
    schema: z.preprocess(
      normalizeFilePath,
      z
        .object({
          path: z.string().describe("The path to the file to attach (absolute or relative)"),
          mediaType: z
            .string()
            .nullish()
            .describe("Optional media type override when the filename/extension is ambiguous."),
          filename: z
            .string()
            .nullish()
            .describe("Optional filename override to present to the model."),
        })
        .strict()
    ),
  },
  desktop_screenshot: {
    description:
      "Capture a screenshot of the desktop. " +
      "Optionally accepts scaledWidth and scaledHeight hints for downstream consumers while still capturing at the desktop's actual resolution.",
    schema: z
      .object({
        scaledWidth: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe("Optional scaled width hint in pixels for downstream consumers."),
        scaledHeight: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe("Optional scaled height hint in pixels for downstream consumers."),
      })
      .strict(),
  },
  desktop_move_mouse: {
    description: "Move the desktop mouse cursor to the provided screen coordinates.",
    schema: z
      .object({
        x: z.number().int().describe("Target X coordinate in screen pixels."),
        y: z.number().int().describe("Target Y coordinate in screen pixels."),
      })
      .strict(),
  },
  desktop_click: {
    description:
      "Click on the desktop at the provided screen coordinates. Defaults to the left mouse button when button is omitted.",
    schema: z
      .object({
        x: z.number().int().describe("Target X coordinate in screen pixels."),
        y: z.number().int().describe("Target Y coordinate in screen pixels."),
        button: z
          .enum(["left", "right"])
          .nullish()
          .describe("Optional mouse button to click. Defaults to left."),
      })
      .strict(),
  },
  desktop_double_click: {
    description:
      "Double-click on the desktop at the provided screen coordinates. Defaults to the left mouse button when button is omitted.",
    schema: z
      .object({
        x: z.number().int().describe("Target X coordinate in screen pixels."),
        y: z.number().int().describe("Target Y coordinate in screen pixels."),
        button: z
          .enum(["left"])
          .nullish()
          .describe("Optional mouse button to double-click. Defaults to left."),
      })
      .strict(),
  },
  desktop_drag: {
    description: "Drag on the desktop from one screen position to another.",
    schema: z
      .object({
        startX: z.number().int().describe("Starting X coordinate in screen pixels."),
        startY: z.number().int().describe("Starting Y coordinate in screen pixels."),
        endX: z.number().int().describe("Ending X coordinate in screen pixels."),
        endY: z.number().int().describe("Ending Y coordinate in screen pixels."),
      })
      .strict(),
  },
  desktop_scroll: {
    description: "Scroll on the desktop at the provided screen coordinates.",
    schema: z
      .object({
        x: z.number().int().describe("Target X coordinate in screen pixels."),
        y: z.number().int().describe("Target Y coordinate in screen pixels."),
        deltaX: z.number().int().nullish().describe("Optional horizontal scroll delta in pixels."),
        deltaY: z.number().int().describe("Vertical scroll delta in pixels."),
      })
      .strict(),
  },
  desktop_type: {
    description: "Type text into the active desktop input target.",
    schema: z
      .object({
        text: z.string().describe("Text to type into the active desktop target."),
      })
      .strict(),
  },
  desktop_key_press: {
    description:
      'Press a desktop key or key combination such as "ctrl+c", "Return", or "cmd+shift+p".',
    schema: z
      .object({
        key: z.string().describe("Key or key combination to press on the desktop."),
      })
      .strict(),
  },
  mux_agents_read: {
    description:
      "Read the AGENTS.md instructions file. In a project workspace, reads the project's AGENTS.md. " +
      "In the system workspace, reads the global ~/.xum/AGENTS.md.",
    schema: z.object({}).strict(),
  },
  mux_agents_write: {
    description:
      "Write the AGENTS.md instructions file. In a project workspace, writes the project's AGENTS.md. " +
      "In the system workspace, writes the global ~/.xum/AGENTS.md. " +
      "Requires explicit confirmation via confirm: true.",
    schema: z
      .object({
        newContent: z.string().describe("The full new contents of the AGENTS.md file"),
        confirm: z
          .boolean()
          .describe(
            "Must be true to apply the write. The agent should ask the user for confirmation first."
          ),
      })
      .strict(),
  },
  mux_config_read: {
    description:
      "Read the Xum configuration file. Returns the current configuration with secrets redacted. " +
      "Use 'providers' for ~/.xum/providers.jsonc (API provider settings) or 'config' for ~/.xum/config.json (app settings).",
    schema: z
      .object({
        file: XumConfigFileSchema.describe("Which configuration file to read"),
        path: ConfigMutationPathSchema.nullish().describe(
          "Optional path segments to read a specific nested value. If omitted, returns the full config."
        ),
      })
      .strict(),
  },
  mux_config_write: {
    description:
      "Write to the Xum configuration file. Applies one or more set/delete operations and validates the full document before writing. " +
      "Use 'providers' for ~/.xum/providers.jsonc or 'config' for ~/.xum/config.json. " +
      "Requires explicit confirmation via confirm: true.",
    schema: z
      .object({
        file: XumConfigFileSchema.describe("Which configuration file to write"),
        operations: ConfigOperationsSchema.describe("Operations to apply to the config document"),
        confirm: z
          .boolean()
          .describe("Must be true to apply the write. Ask the user for confirmation first."),
      })
      .strict(),
  },
  agent_skill_read: {
    description:
      "Load an Agent Skill's SKILL.md (YAML frontmatter + markdown body) by name. " +
      "Skills are discovered from <projectRoot>/.xum/skills/<name>/SKILL.md, <projectRoot>/.agents/skills/<name>/SKILL.md, ~/.xum/skills/<name>/SKILL.md, and ~/.agents/skills/<name>/SKILL.md.",
    schema: z
      .object({
        name: SkillNameSchema.describe("Skill name (directory name under the skills root)"),
      })
      .strict(),
  },
  agent_skill_read_file: {
    description:
      "Read a file within an Agent Skill directory. " +
      "filePath must be relative to the skill directory (no absolute paths, no ~, no .. traversal). " +
      "Supports offset/limit like file_read.",
    schema: z
      .object({
        name: SkillNameSchema.describe("Skill name (directory name under the skills root)"),
        filePath: z
          .string()
          .min(1)
          .describe("Path to the file within the skill directory (relative)"),
        offset: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe("1-based starting line number (optional, defaults to 1)"),
        limit: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe(
            "Number of lines to return from offset (optional, returns all if not specified)"
          ),
      })
      .strict(),
  },
  agent_skill_list: {
    description:
      "List available skills. In a project workspace, lists project skills from .xum/skills/ and legacy/universal .agents/skills/, plus global skills from ~/.xum/skills/ and legacy/universal ~/.agents/skills/, each tagged with its scope. In the system workspace, lists global skills only.",
    schema: z
      .object({
        includeUnadvertised: z
          .boolean()
          .nullish()
          .describe(
            "When true, includes skills hidden from the index (advertise: false or disable-model-invocation: true)"
          ),
      })
      .strict(),
  },
  agent_skill_write: {
    description:
      "Create or update a file within the contextual skills directory. In a project workspace, writes under .xum/skills/<name>/. In the system workspace, writes under ~/.xum/skills/<name>/. " +
      "When writing SKILL.md, content is validated as a skill definition and frontmatter.name is aligned to the skill name argument.",
    schema: z
      .object({
        name: SkillNameSchema.describe("Skill name (directory name under the global skills root)"),
        filePath: z
          .string()
          .min(1)
          .nullish()
          .describe("Relative path within skill directory. Defaults to SKILL.md"),
        content: z.string().min(1).describe("File content to write"),
      })
      .strict(),
  },
  agent_skill_delete: {
    description:
      "Delete either a file within the contextual skills directory or the entire skill directory. In a project workspace, deletes from .xum/skills/. In the system workspace, deletes from ~/.xum/skills/. " +
      "Requires confirm: true.",
    schema: z
      .object({
        name: SkillNameSchema.describe("Skill name to delete"),
        target: z
          .enum(["file", "skill"])
          .nullish()
          .describe(
            "Deletion target: 'file' to delete a specific file, 'skill' to remove the entire skill directory (defaults to file)"
          ),
        filePath: z
          .string()
          .min(1)
          .nullish()
          .describe(
            "Relative file path within the skill directory to delete. Required when target is 'file'"
          ),
        confirm: z.boolean().describe("Must be true to confirm deletion"),
      })
      .strict(),
  },

  skills_catalog_search: {
    description:
      "Search the skills.sh community catalog for agent skills. " +
      "Returns a list of matching skills with their IDs, names, source repos, and install counts. " +
      "Use skills_catalog_read to preview a skill's full content before installing.",
    schema: z
      .object({
        query: z.string().describe("Search query to find skills in the catalog"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .nullish()
          .describe("Maximum number of results to return (default: 10)"),
      })
      .strict(),
  },

  skills_catalog_read: {
    description:
      "Read the full SKILL.md content for a skill from the skills.sh community catalog. " +
      "Use this to preview a skill's documentation before installing it with agent_skill_write. " +
      "The owner and repo come from skills_catalog_search results.",
    schema: z
      .object({
        owner: z.string().describe("GitHub owner from the search result (e.g. 'vercel-labs')"),
        repo: z
          .string()
          .describe("GitHub repository name from the search result (e.g. 'agent-skills')"),
        skillId: SkillNameSchema.describe("Skill ID from the search result"),
      })
      .strict(),
  },

  file_edit_replace_string: {
    description:
      "⚠️ CRITICAL: Always check tool results - edits WILL fail if old_string is not found or unique. Do not proceed with dependent operations (commits, pushes, builds) until confirming success.\n\n" +
      "Apply one or more edits to a file by replacing exact text matches. All edits are applied sequentially. Each old_string must be unique in the file unless replace_count > 1 or replace_count is -1.",
    schema: z.preprocess(
      normalizeFilePath,
      z.object({
        path: FILE_TOOL_PATH,
        old_string: z
          .string()
          .describe(
            "The exact text to replace (must be unique in file if replace_count is 1). Include enough context (indentation, surrounding lines) to make it unique."
          ),
        new_string: z.string().describe("The replacement text"),
        replace_count: z
          .number()
          .int()
          .nullish()
          .describe(
            "Number of occurrences to replace (default: 1). Use -1 to replace all occurrences. If 1, old_string must be unique in the file."
          ),
      })
    ),
  },
  file_edit_replace_lines: {
    description:
      "⚠️ CRITICAL: Always check tool results - edits WILL fail if line numbers are invalid or file content has changed. Do not proceed with dependent operations (commits, pushes, builds) until confirming success.\n\n" +
      "Replace a range of lines in a file. Use this for line-based edits when you know the exact line numbers to modify.",
    schema: z.preprocess(
      normalizeFilePath,
      z.object({
        path: FILE_TOOL_PATH,
        start_line: z.number().int().min(1).describe("1-indexed start line (inclusive) to replace"),
        end_line: z.number().int().min(1).describe("1-indexed end line (inclusive) to replace"),
        new_lines: z
          .array(z.string())
          .describe("Replacement lines. Provide an empty array to delete the specified range."),
        expected_lines: z
          .array(z.string())
          .nullish()
          .describe(
            "Optional safety check. When provided, the current lines in the specified range must match exactly."
          ),
      })
    ),
  },
  file_edit_insert: {
    description:
      "Insert content into a file using substring guards. " +
      "Provide exactly one of insert_before or insert_after to anchor the operation when editing an existing file. " +
      "When the file does not exist or is empty, it is populated automatically without guards. " +
      "Optional before/after substrings must uniquely match surrounding content. " +
      "Avoid short guards like `}` or `}\\n` that match multiple locations — " +
      `use longer patterns like full function signatures or unique comments. ${TOOL_EDIT_WARNING}`,
    schema: z.preprocess(
      normalizeFilePath,
      z
        .object({
          path: FILE_TOOL_PATH,
          insert_before: z
            .string()
            .min(1)
            .nullish()
            .describe(
              "Anchor text to insert before. Content will be placed immediately before this substring."
            ),
          insert_after: z
            .string()
            .min(1)
            .nullish()
            .describe(
              "Anchor text to insert after. Content will be placed immediately after this substring."
            ),
          content: z.string().describe("The content to insert"),
        })
        .refine((data) => !(data.insert_before != null && data.insert_after != null), {
          message: "Provide only one of insert_before or insert_after (not both).",
          path: ["insert_before"],
        })
    ),
  },
  advisor: {
    description: ADVISOR_TOOL_DESCRIPTION,
    schema: AdvisorToolInputSchema,
  },
  ask_user_question: {
    description:
      "Ask 1–4 multiple-choice questions (with optional multi-select) and wait for the user's answers. " +
      "This tool is intended for plan mode. " +
      "Use it ONLY for genuinely balanced decisions that hinge on user-specific context, preference, or information not present in the conversation or repo. " +
      "Do NOT use it when you already have a reasonable recommendation: if one option is clearly best, proceed with it (stating the assumption) instead of asking — surfacing a question you can answer yourself defeats the purpose. " +
      "When you do ask, keep the options genuinely open; do not steer toward a single 'recommended' choice. " +
      "Do not output a list of open questions; ask them via this tool instead. " +
      "Each question must include 2–4 options; an 'Other' choice is provided automatically.",
    schema: AskUserQuestionToolArgsSchema,
  },
  // `internal` tools are excluded from user-facing tool docs (hooks/tools.mdx
  // env-var tables) because users can't write hooks for them — they run via
  // bespoke streamText paths in their own services, not the standard tool
  // execution pipeline. See gen_docs.ts.
  propose_name: {
    description:
      "Propose a workspace name and title. You MUST call this tool exactly once with your chosen name and title. " +
      "Do not emit a text response; call this tool immediately.",
    schema: ProposeNameToolArgsSchema,
    internal: true,
  },
  propose_status: {
    description:
      "Propose a short sidebar status (emoji + 2-6 word verb-led phrase) summarizing what the agent is currently doing. " +
      "You MUST call this tool exactly once. Do not emit a text response; call this tool immediately.",
    schema: ProposeStatusToolArgsSchema,
    internal: true,
  },
  propose_plan: {
    description:
      "Signal that your plan is complete and ready for user approval. " +
      "This tool reads the plan from the plan file you wrote. " +
      "You must write your plan to the plan file before calling this tool. " +
      "After calling this tool, do not paste the plan contents or mention the plan file path; the UI already shows the full plan.",
    schema: z.object({}),
  },
  task: {
    description: buildTaskToolDescription(undefined),
    schema: TaskToolArgsSchema,
  },
  task_apply_git_patch: {
    description:
      "Apply a completed sub-agent task's git-format-patch artifact to the current workspace using `git am`. " +
      "This is an explicit integration step: Xum will not auto-apply patches.",
    schema: TaskApplyGitPatchToolArgsSchema,
  },
  task_await: {
    description:
      "Wait for one or more tasks or workflow runs to produce output. " +
      "\n\nWHEN TO USE: only call task_await when the current user request depends on a task's output, or when synthesis/integration of a previously-spawned task is the next logical step. " +
      "Do not call task_await solely because active tasks exist; for unrelated user messages, respond directly and let tasks continue in the background. " +
      "If a synthetic/system follow-up explicitly says active background tasks or workflow runs block your turn, treat that as a dependency and await the listed IDs. " +
      "When a terminal wake-up says a sub-agent report or failure is already injected into context, integrate it directly — do NOT call task_await for it. When a wake-up asks you to retrieve a workspace turn's terminal output, call task_await with the listed IDs and timeout_secs: 0 (a one-shot retrieval, not a wait). " +
      "\n\nIMPORTANT: Do not call task_await in the same parallel tool-call batch as task, bash, or workflow_run — " +
      "the taskId/runId is not available until the spawning tool returns. " +
      "Always wait for the task/bash/workflow_run tool result first, then call task_await in a subsequent step. " +
      "When omitting task_ids to await active tasks/workflows, ensure at least one background task or workflow was already spawned in a prior step. Omitted task_ids discover top-level workflow runs only and exclude workflow-owned sub-agents/background bash tasks because those results are consumed through parent workflow runs. " +
      "\n\nAgent tasks and workflow runs return reports when completed. " +
      "Completed reports are persisted on disk and survive context compaction: calling task_await on an already-completed task/workflow run ID (timeout_secs: 0 for non-blocking) re-fetches the full report instead of re-running the work. " +
      "Bash tasks return incremental output while running and a final reportMarkdown when they exit. " +
      "For bash tasks, you may optionally pass filter/filter_exclude to include/exclude output lines by regex. " +
      "WARNING: when using filter, non-matching lines are permanently discarded. " +
      "Use this tool to WAIT; do not poll task_list in a loop to wait for task completion (that is misuse and wastes tool calls). " +
      "\n\nBy default (min_completed=1) this returns as soon as the FIRST awaited task completes, so you can begin dependent work on that result while the rest keep running — then call task_await again for the remainder. " +
      "This is ideal for independent tasks or any case where per-result work exists. " +
      "Set min_completed higher (up to the number of awaited tasks) when you genuinely need more before proceeding — e.g. best-of-N synthesis that must compare every candidate should pass min_completed equal to the batch size. " +
      "The result always includes every task complete at the moment it returns, plus current status for the rest; not-yet-completed tasks keep running and stay re-awaitable on a later call. " +
      "Active workflow-run results may include compact `workflowProgress` (latest phase, last progress timestamp, and step counts); use that to see that phased progress is still happening instead of treating elapsed time alone as a hang. " +
      "You always get per-task results (like Promise.allSettled), just possibly before every task has finished. " +
      "Possible statuses: completed, queued, starting, running, backgrounded, awaiting_report, interrupted, not_found, invalid_scope, error. " +
      "Bash task outputs may be automatically filtered; when this happens, check each result's note for details and (if available) where the full output was saved.",
    schema: TaskAwaitToolArgsSchema,
  },
  task_send_message: {
    description:
      "Send guidance to a descendant sub-agent. Queued/running work is interrupted or queued at the requested boundary so the child can incorporate the update. An inactive child is reawakened in the same persistent workspace under a fresh internal execution. " +
      "The stable sub-agent task ID and durable role title remain unchanged, and the child's checkout is not refreshed automatically. Prefer reawakening an inactive child over spawning a replacement when its prior context or expertise is relevant. For repository-dependent work, reuse it only when the retained snapshot is appropriate or tell the child to verify and synchronize its checkout before acting; otherwise spawn a new child. If the new assignment changes the child's reusable responsibility, call task_retitle as well; do not retitle it for ordinary one-off assignments. Best-of children retain candidate metadata, so reawaken them only to continue that same candidate; use a standalone specialist for unrelated work. This tool does not target bash tasks, workflow runs, or workspace-turn handles.",
    schema: TaskSendMessageToolArgsSchema,
  },
  task_message_parent: {
    description:
      "Send a message up to your parent workspace (RLM family messaging). It is appended to the parent's queue as a clearly-labeled child message and coalesces behind a busy parent turn, dispatching at the parent's next tool boundary. " +
      "The parent has no obligation to reply and no delivery receipt is produced. Keep using agent_report for progress updates and your final report.",
    schema: TaskMessageParentToolArgsSchema,
  },
  task_message_sibling: {
    description:
      "Send a message to a sibling sub-agent that shares your DIRECT parent (nuclear-family scoping: exactly one hop up plus one hop down). Any other target — grandparent, grandchild, uncle, or unrelated task — is refused with invalid_scope. " +
      "The message arrives in the sibling's queue as a clearly-labeled message; a busy sibling picks it up at its next tool boundary.",
    schema: TaskMessageSiblingToolArgsSchema,
  },
  task_retitle: {
    description:
      "Change the short, friendly role name of a persistent descendant sub-agent without changing its stable task identity or workspace. Active and inactive user-owned children can be retitled; workflow-owned internal workers cannot.",
    schema: TaskRetitleToolArgsSchema,
  },
  task_stop: {
    description:
      "Stop one or more tasks without removing persistent child workspaces. Sub-agent trees are stopped leaf-first and unfinished children become interrupted; workspace turns and workflow runs are interrupted; bash processes are terminated. Use this to cancel or abandon work, not to mark useful progress as completed—ask a child to finalize with task_send_message and await its report instead. Stopping an already-inactive task is idempotent.",
    schema: TaskStopToolArgsSchema,
  },
  task_remove: {
    description:
      "Irreversibly remove inactive child task workspaces owned by the current workspace. Use it to prune completed grouped candidates after their results and artifacts are consumed, consolidate substantially overlapping standalone roles, restore the bounded reusable bench, honor an explicit user request, or discard clearly obsolete context. Do not use it for a blanket end-of-turn cleanup: retain a small bench of distinct useful roles. Removed sub-agents cannot be restored or reawakened. Active targets are rejected; descendants must be removed first, so nested batches are processed deepest-first.",
    schema: TaskRemoveToolArgsSchema,
  },
  task_list: {
    description:
      "List descendant tasks for the current workspace, including status + metadata. " +
      "This includes sub-agent tasks, background bash tasks, and top-level workflow runs, but omits workflow-owned sub-agents/background bash tasks whose reports are consumed through parent workflow runs. " +
      "Use this after compaction, interruptions, workflow_run errors/aborts, or an app restart to rediscover active tasks, inactive persistent sub-agents, and resumable workflow runs. Sub-agent rows from grouped runs include `bestOf` metadata so they can be distinguished from the standalone reusable bench. The default statuses find unfinished work; request `reported` explicitly for completed persistent sub-agents. " +
      "When recovering an uncertain workflow_run, omit statuses first or include pending/running/backgrounded as well as interrupted/failed/completed; terminal-only filters can hide unfinished workflow runs. Pending runs may need workflow_resume because no runner may be active yet. " +
      "Workflow rows may include compact `workflowProgress` so callers can see the latest phase before deciding whether to await, resume, or leave the run alone. " +
      "The legacy includeArchived option only affects archived workspace-turn and bash records; sub-agents remain one inactive/active task identity. " +
      "This is a discovery tool, NOT a waiting mechanism. If the current request actually depends on a task's output, call task_await with the specific task IDs you need; do not await all active tasks just because they appear here.",
    schema: TaskListToolArgsSchema,
  },
  workflow_run: {
    // Prefer foreground workflows so callers do not waste a turn polling when no other work can proceed.
    description:
      "Start a durable workflow run from exactly one launch source: script_path for a JavaScript file/skill workflow, or script_source for compact one-off inline workflow source. Workflows coordinate delegated agent tasks and preserve run state for replay/resume. " +
      "Prefer script_path for reusable, reviewable, shared, slash/CLI-invokable, or skill-packaged workflows; use script_source for one-off conductors whose exact source should be snapshotted into the durable run. " +
      "When a skill, instruction block, or plan describes a multi-phase, looping, or multi-agent process in prose and ships no packaged workflow script, prefer codifying that process as a one-off script_source workflow over executing every phase in-context: " +
      "the conductor follows the documented phases more faithfully and gains durable checkpoints, resume, and fresh delegated context per phase. " +
      "Use agent_skill_read / agent_skill_read_file to discover and inspect skill-packaged workflows; non-skill workflow files must be addressed by an explicit known path and can be inspected with normal file tools. " +
      "Prefer the default foreground mode (`run_in_background` omitted or false) so completed workflows return their result without an extra task_await round-trip. " +
      "If workflow_run returns status=running or status=backgrounded, await the returned runId with task_await before using or reporting the workflow output. " +
      "After a previous workflow_run error, abort, timeout, or uncertain result, do not start a fresh run until you rediscover existing workflow runs: either omit task_list statuses first, or query pending/running/backgrounded/interrupted/failed/completed together. " +
      "Use task_await for running/backgrounded runs, workflow_resume for pending/interrupted runs, workflow_resume({ mode: 'retry_from_checkpoint' }) only for eligible failed runs, and inspect/refetch completed results instead of rerunning. " +
      "Use background mode only when you intend to start another workflow/task or do independent work while the workflow runs; a background run is non-blocking and Xum wakes this workspace with the terminal workflow result, so call task_await only when the current request depends on the output before you can answer.",
    schema: WorkflowRunToolArgsSchema,
  },
  workflow_resume: {
    description:
      "Resume an existing durable workflow run by run ID (wfr_...). Use this for runs that were interrupted (by the user, task_stop, or an app crash/restart) — " +
      "resume replays the durable event log and continues from the last checkpoint without re-executing completed steps. " +
      "Discover resumable runs with task_list (statuses pending/interrupted/failed). Pending runs left by post-create aborts and interrupted runs can be resumed in default mode; running/backgrounded workflows do not need resume, await them with task_await. " +
      "For failed runs, pass mode='retry_from_checkpoint' explicitly; it re-executes work after the last checkpoint, so only use it when that is acceptable, and start a fresh workflow_run when it is rejected as unsafe. " +
      "Calling this on a completed run returns its existing result without re-running anything. " +
      "Prefer foreground mode (run_in_background omitted or false) to get the final result directly; " +
      "if the returned status is running or backgrounded, await the runId with task_await before using the result.",
    schema: WorkflowResumeToolArgsSchema,
  },
  agent_report: {
    description:
      "Send an incremental update from a sub-agent to its parent workspace and wake the parent. " +
      "Call this whenever the parent should see important progress or a finding before the task is complete; it may be called multiple times. " +
      "Do not use it for the final result—the final assistant message completes the sub-agent task.",
    schema: AgentReportToolArgsSchema,
  },
  timeline_event: {
    description:
      "Record one notable step on the durable workspace timeline, which is a birds-eye record of the work rather than a tool log. " +
      "Call it when: a notable implementation step landed; work was committed, pushed, or opened as a PR; " +
      "external input was picked up, such as a review comment, CI failure, or issue; " +
      "the approach changed, including why; a blocker was hit or resolved; work was handed off. " +
      "Describe what happened in one plain sentence. " +
      "Prompts, goals, heartbeats, sub-agents, and workflows are already recorded automatically, so do not restate them or narrate routine tool use.",
    schema: z
      .object({
        description: z.string().min(1).max(300).describe("One sentence describing what happened."),
        category: z
          .enum(["picked_up", "milestone", "decision", "blocker", "handoff"])
          .nullish()
          .describe("Optional event category."),
      })
      .strict(),
  },
  set_goal: {
    description:
      "Create or replace a durable goal for this current parent workspace when the user explicitly asks for multi-turn, verifiable work. " +
      "Do not use this for one-shot questions. Objectives must be concrete, measurable, and verifiable. " +
      "Omitted or null budget/turn fields use the effective workspace goal defaults; model-created goals must resolve to at least one budget or turn bound. " +
      "Do not replace an active, paused, or budget-limited goal unless the user explicitly asked to replace it; when replacing, first call get_goal and pass replaceExistingGoal=true with the current expectedGoalId. " +
      "After setting a goal during your own turn, let subsequent automatic continuation turns do the substantial goal work, then call complete_goal only after verification.",
    schema: z
      .object({
        objective: z
          .string()
          .trim()
          .min(1)
          .describe("Concrete, measurable objective to pursue over automatic goal continuations."),
        budgetCents: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe(
            "Optional positive budget in cents. Omit/null to apply the effective workspace goal default."
          ),
        turnCap: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe(
            "Optional positive maximum automatic continuation turns. Omit/null to apply the effective workspace goal default."
          ),
        replaceExistingGoal: z
          .boolean()
          .nullish()
          .describe("Set true only when the user explicitly asked to replace the current goal."),
        expectedGoalId: z
          .string()
          .uuid()
          .nullish()
          .describe(
            "Optimistic-concurrency token required when replacing an active, paused, or budget-limited goal. Use the goalId from get_goal."
          ),
      })
      .strict(),
  },
  get_goal: {
    description:
      "Read the current workspace goal. Returns null when no goal is available in this turn.",
    schema: z.object({}).strict(),
  },
  complete_goal: {
    description:
      "Mark the current workspace goal complete with a concise 1-2 sentence summary of why the goal is done. " +
      "This tool only completes goals; it cannot pause, resume, replace, or change goal budgets. " +
      "Pass the `goalId` returned by `get_goal` so the completion is rejected with a typed conflict " +
      "error if the user clears or replaces the goal mid-stream rather than throwing a confusing " +
      "validation error.",
    schema: z
      .object({
        summary: z
          .string()
          .trim()
          .min(1)
          .describe("Required 1-2 sentence justification for completing the current goal."),
        goalId: z
          .string()
          .nullish()
          .describe(
            "Optional optimistic-concurrency token. Pass the `goalId` returned by `get_goal` to " +
              "ensure the completion is rejected with a typed conflict error if the user clears " +
              "or replaces the goal mid-stream."
          ),
      })
      .strict(),
  },

  heartbeat: {
    description:
      "Read or change this workspace's scheduled heartbeat. " +
      "The tool only affects the current workspace; it does not accept a workspaceId. " +
      "Use action='set' to enable or configure the heartbeat interval, custom message, context mode, trigger, when-busy behavior, or enabled flag. " +
      "trigger chooses the countdown anchor: 'idle' (default) fires only after the workspace has been quiet for a full interval; 'interval' fires on a fixed wall-clock cadence. " +
      "whenBusy chooses what happens when a heartbeat fires while the workspace is busy: 'skip' misses the slot, 'tool-end'/'turn-end' queue the heartbeat for the matching boundary. " +
      "Unset whenBusy defaults to 'skip' for trigger 'idle' and 'turn-end' for trigger 'interval'. " +
      "Use action='unset' to remove this workspace's heartbeat settings entirely. " +
      "Use action='get' before changing settings when you need to preserve existing values.",
    schema: HeartbeatToolArgsSchema,
  },
  todo_write: {
    description:
      "Create or update the todo list for tracking multi-step tasks (limit: 7 items). " +
      "The TODO list is displayed to the user at all times. " +
      "Replace the entire list on each call - the AI tracks which tasks are completed.\n" +
      "\n" +
      "Mark tasks as in_progress when actively being worked on (multiple allowed for parallel work). " +
      "Order tasks as: completed first, then in_progress, then pending last. " +
      "Use appropriate tense in content: past tense for completed (e.g., 'Added tests'), " +
      "present progressive for in_progress (e.g., 'Adding tests'), " +
      "and imperative/infinitive for pending (e.g., 'Add tests').\n" +
      "\n" +
      "If you hit the 7-item limit, summarize older completed items into one line " +
      "(e.g., 'Completed initial setup (3 tasks)').\n" +
      "\n" +
      "Update the list as work progresses. If work fails or the approach changes, update " +
      "the list to reflect reality - only mark tasks complete when they actually succeed.",
    schema: z.object({
      todos: z.array(
        z.object({
          content: z
            .string()
            .describe(
              "Task description with tense matching status: past for completed, present progressive for in_progress, imperative for pending"
            ),
          status: z.enum(["pending", "in_progress", "completed"]).describe("Task status"),
        })
      ),
    }),
  },
  todo_read: {
    description: "Read the current todo list",
    schema: z.object({}),
  },
  review_pane_update: {
    description:
      "Flag specific code regions in the Review pane for the user to review next. " +
      "Use this to draw the user's attention to critical changes you want reviewed first. " +
      "Each hunk references a project-relative file path with an optional inclusive line " +
      'range using familiar syntax: "src/foo.ts" (whole file), "src/foo.ts:42" (single line), ' +
      'or "src/foo.ts:42-58" (range, new-file line numbers). Project-relative paths are ' +
      "preferred; use './' or '../' for paths that must resolve from the current tool cwd. " +
      "Attach a short comment to each " +
      "hunk explaining what to look at and why.\n\n" +
      "operation:\n" +
      "  - 'replace' (default): overwrite the current assisted set\n" +
      "  - 'add': append to the existing set, deduplicating exact path:range matches\n\n" +
      "Flagged hunks appear pinned at the top of the Review pane; the user can toggle " +
      "'Assisted' to hide everything else. Pass an empty hunks array with operation='replace' " +
      "to clear the set when review is no longer needed.",
    schema: z
      .object({
        operation: z
          .enum(["add", "replace"])
          .describe("'replace' overwrites the assisted set; 'add' appends to it."),
        hunks: z
          .array(
            z
              .object({
                path: z
                  .string()
                  .min(1)
                  .describe(
                    'Filter in `path[:range]` form, e.g. "src/foo.ts" or "src/foo.ts:42-58". ' +
                      "Path is project-relative; use './' or '../' when the path must resolve from the current tool working directory. Range uses new-file line numbers (inclusive)."
                  ),
                comment: z
                  .string()
                  .nullish()
                  .describe("Short note (~1 sentence) telling the user what to look at and why."),
              })
              .strict()
          )
          .describe("List of hunks to flag for review."),
      })
      .strict(),
  },
  review_pane_get: {
    description:
      "Return the current set of agent-flagged hunks in the Review pane, in declared order. " +
      "Use this to inspect what you've already pinned before adding more.",
    schema: z.object({}).strict(),
  },
  bash_output: {
    description:
      'DEPRECATED: use task_await instead (pass bash-prefixed taskId like "bash:<processId>"). ' +
      "Retrieve output from a running or completed background bash process. " +
      "Returns only NEW output since the last check (incremental). " +
      "Returns stdout and stderr output along with process status. " +
      "Supports optional regex filtering to show only lines matching a pattern. " +
      "WARNING: When using filter, non-matching lines are permanently discarded. " +
      "Use timeout to wait for output instead of polling repeatedly. " +
      "Large outputs may be automatically filtered; when this happens, the result includes a note explaining what was kept and (if available) where the full output was saved.",
    schema: z.object({
      process_id: z.string().describe("The ID of the background process to retrieve output from"),
      filter: z
        .string()
        .nullish()
        .describe(
          "Optional regex to filter output lines. By default, only matching lines are returned. " +
            "When filter_exclude is true, matching lines are excluded instead. " +
            "Non-matching lines are permanently discarded and cannot be retrieved later."
        ),
      filter_exclude: z
        .boolean()
        .nullish()
        .describe(
          "When true, lines matching 'filter' are excluded instead of kept. " +
            "Key behavior: excluded lines do NOT cause early return from timeout - " +
            "waiting continues until non-excluded output arrives or process exits. " +
            "Use to avoid busy polling on progress spam (e.g., filter='⏳|waiting|\\.\\.\\.' with filter_exclude=true " +
            "lets you set a long timeout and only wake on meaningful output). " +
            "Requires 'filter' to be set."
        ),
      timeout_secs: z
        .number()
        .min(0)
        .describe(
          "Seconds to wait for new output. " +
            "If no output is immediately available and process is still running, " +
            "blocks up to this duration. Returns early when output arrives or process exits. " +
            "Only use long timeouts (>15s) when no other useful work can be done in parallel."
        ),
    }),
  },
  bash_background_list: {
    description:
      "DEPRECATED: use task_list instead. " +
      "List all background processes started with bash(run_in_background=true). " +
      "Returns process_id, status, script for each process. " +
      "Use to find process_id for termination or check output with bash_output.",
    schema: z.object({}),
  },
  bash_background_terminate: {
    description:
      "DEPRECATED: use task_stop instead. " +
      "Terminate a background process started with bash(run_in_background=true). " +
      "Use process_id from the original bash response or from bash_background_list. " +
      "Sends SIGTERM, waits briefly, then SIGKILL if needed. " +
      "Output remains available via bash_output after termination.",
    schema: z.object({
      process_id: z.string().describe("Background process ID to terminate"),
    }),
  },
  analytics_query: {
    description: `Execute a DuckDB SQL query against Xum analytics tables and optionally provide visualization hints.
Use read-only SELECT queries over analytics data.

DuckDB SQL guidelines:
- Use SELECT queries only; do not write, alter, or drop tables.
- Prefer explicit column lists and aliases so result sets are easy to understand.
- Use ORDER BY and LIMIT for exploratory queries over large datasets.
- Use DuckDB date/time helpers (for example date_trunc, CAST(... AS DATE), and interval arithmetic) for time series.

Available tables:

CREATE TABLE IF NOT EXISTS events (
  workspace_id VARCHAR NOT NULL,
  project_path VARCHAR,
  project_name VARCHAR,
  workspace_name VARCHAR,
  parent_workspace_id VARCHAR,
  agent_id VARCHAR,
  timestamp BIGINT,
  date DATE,
  model VARCHAR,
  thinking_level VARCHAR,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cache_create_tokens INTEGER DEFAULT 0,
  input_cost_usd DOUBLE DEFAULT 0,
  output_cost_usd DOUBLE DEFAULT 0,
  reasoning_cost_usd DOUBLE DEFAULT 0,
  cached_cost_usd DOUBLE DEFAULT 0,
  total_cost_usd DOUBLE DEFAULT 0,
  duration_ms DOUBLE,
  ttft_ms DOUBLE,
  streaming_ms DOUBLE,
  tool_execution_ms DOUBLE,
  output_tps DOUBLE,
  response_index INTEGER,
  is_sub_agent BOOLEAN DEFAULT false
)

CREATE TABLE IF NOT EXISTS delegation_rollups (
  parent_workspace_id VARCHAR NOT NULL,
  child_workspace_id VARCHAR NOT NULL,
  project_path VARCHAR,
  project_name VARCHAR,
  agent_type VARCHAR,
  model VARCHAR,
  total_tokens INTEGER DEFAULT 0,
  context_tokens INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cache_create_tokens INTEGER DEFAULT 0,
  report_token_estimate INTEGER DEFAULT 0,
  total_cost_usd DOUBLE DEFAULT 0,
  rolled_up_at_ms BIGINT,
  date DATE,
  PRIMARY KEY (parent_workspace_id, child_workspace_id)
)`,
    schema: z.object({
      sql: z.string().min(1).describe("DuckDB SQL query to execute"),
      visualization: z
        .enum(["table", "bar", "line", "pie", "area", "stacked_bar"])
        .nullish()
        .describe("Optional visualization type for rendering the query result"),
      title: z.string().nullish().describe("Optional chart title"),
      x_axis: z.string().nullish().describe("Optional column name for the visualization X axis"),
      y_axis: z
        .array(z.string())
        .nullish()
        .describe("Optional column name(s) for the visualization Y axis"),
    }),
  },
  web_fetch: {
    description:
      `Fetch a web page and extract its main content as clean markdown. ` +
      `Uses the workspace's network context (requests originate from the workspace, not Xum host). ` +
      `Requires curl to be installed in the workspace. ` +
      `Output is truncated to ${Math.floor(WEB_FETCH_MAX_OUTPUT_BYTES / 1024)}KB.`,
    schema: z.object({
      url: z.string().url().describe("The URL to fetch (http or https)"),
    }),
  },
  code_execution: {
    description:
      "Execute JavaScript code in a sandboxed environment with access to Xum tools. " +
      "Available for multi-tool workflows when PTC experiment is enabled.",
    schema: z.object({
      code: z.string().min(1).describe("JavaScript code to execute in the PTC sandbox"),
    }),
  },
  refinement_rollback: {
    description:
      "Roll back a journaled harness self-modification (a memory or skill edit) by its refinement row id, " +
      "restoring the exact prior file contents recorded in the session's refinement journal. " +
      "The rollback is journaled as a refinement row of its own, so it can be rolled back again. " +
      "Refuses rows that were already rolled back and rows whose files changed since (divergence). " +
      "Available only in RLM mode.",
    schema: z
      .object({
        id: z.string().min(1).describe("Refinement row id (envelope id) to roll back"),
        reason: z
          .string()
          .min(1)
          .describe("Why this refinement is being rolled back (recorded in the journal)"),
      })
      .strict(),
  },
  // #region NOTIFY_DOCS
  notify: {
    description:
      "Send a system notification to the user. Use this to alert the user about important events that require their attention, such as long-running task completion, errors requiring intervention, or questions. " +
      "Notifications appear as OS-native notifications (macOS Notification Center, Windows Toast, Linux). " +
      "Infer whether to send notifications from user instructions. If no instructions provided, reserve notifications for major wins or blocking issues. Do not use for routine progress updates — keep the todo list current instead.",
    schema: z
      .object({
        title: z
          .string()
          .min(1)
          .max(64)
          .describe("Short notification title (max 64 chars). Should be concise and actionable."),
        message: z
          .string()
          .max(200)
          .nullish()
          .describe(
            "Optional notification body with more details (max 200 chars). " +
              "Keep it brief - users may only see a preview."
          ),
      })
      .strict(),
  },
  // #endregion NOTIFY_DOCS
  tool_catalog_search: {
    description:
      "Search the catalog of deferred tools. Some tools (provided by MCP servers) are deferred: " +
      "they exist but are not currently visible in your tool list. " +
      "Call tool_catalog_search with task/capability keywords to discover them; matched tools become available on the next step. " +
      "Returns matched tool names and descriptions plus the total number of deferred tools (there may be more undiscovered — refine the query to find them).",
    schema: z
      .object({
        query: z
          .string()
          .min(1)
          .describe(
            "Task or capability keywords to search for (matched against tool names, descriptions, and parameter names)"
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .nullish()
          .describe("Maximum number of matches to return (default 10, max 25)"),
      })
      .strict(),
  },
  mcp_prompt_get: {
    description:
      "Fetch a prompt template from a connected MCP server, expanded with the given arguments. " +
      "MCP prompts are reusable instructions or workflows the user has made available through MCP servers. " +
      "The result contains the prompt text; follow it as task guidance in the current conversation. " +
      "Available prompts are listed in this description when connected servers advertise them.",
    schema: z
      .object({
        name: z
          .string()
          .min(1)
          .describe('Prompt name from the available list, e.g. "mcp__server__prompt"'),
        arguments: z
          .record(z.string(), z.string())
          .nullish()
          .describe(
            "Prompt argument values by argument name. Arguments marked with ? are optional; all others are required."
          ),
        list_offset: z
          .number()
          .int()
          .min(0)
          .nullish()
          .describe(
            "When an unknown-name error truncates the prompt listing, repeat the call with the suggested list_offset to page through the remaining prompt names."
          ),
      })
      .strict(),
  },
} as const;

// -----------------------------------------------------------------------------
// Result Schemas for Bridgeable Tools (PTC Type Generation)
// -----------------------------------------------------------------------------
// These Zod schemas define the result types for tools exposed in the PTC sandbox.
// They serve as single source of truth for both:
// 1. TypeScript types in tools.ts (via z.infer<>)
// 2. Runtime type generation for PTC (via Zod → JSON Schema → TypeScript string)

/**
 * Truncation info returned when output exceeds limits.
 */
const TruncatedInfoSchema = z.object({
  reason: z.string(),
  totalLines: z.number(),
});

/**
 * Bash tool result - success, background spawn, or failure.
 */
const BashToolSuccessSchema = z
  .object({
    success: z.literal(true),
    output: z.string(),
    exitCode: z.literal(0),
    wall_duration_ms: z.number(),
    note: z.string().optional(),
    truncated: TruncatedInfoSchema.optional(),
  })
  .extend(ToolOutputUiOnlyFieldSchema);

const BashToolMonitorResultSchema = z
  .object({
    filter: z.string(),
    filter_exclude: z.boolean(),
    cooldown_ms: z.number(),
    max_events: z.number().optional(),
  })
  .strict();

const BashToolBackgroundSchema = z
  .object({
    success: z.literal(true),
    output: z.string(),
    exitCode: z.literal(0),
    wall_duration_ms: z.number(),
    monitor: BashToolMonitorResultSchema.optional(),
    taskId: z.string(),
    backgroundProcessId: z.string(),
  })
  .extend(ToolOutputUiOnlyFieldSchema);

const BashToolFailureSchema = z
  .object({
    success: z.literal(false),
    output: z.string().optional(),
    exitCode: z.number(),
    error: z.string(),
    wall_duration_ms: z.number(),
    note: z.string().optional(),
    truncated: TruncatedInfoSchema.optional(),
  })
  .extend(ToolOutputUiOnlyFieldSchema);

export const BashToolResultSchema = z.union([
  // Foreground success
  BashToolSuccessSchema,
  // Background spawn success
  BashToolBackgroundSchema,
  // Failure
  BashToolFailureSchema,
]);

/**
 * Bash output tool result - process status and incremental output.
 */
export const BashOutputToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    status: z.enum(["running", "exited", "killed", "failed", "interrupted"]),
    output: z.string(),
    exitCode: z.number().optional(),
    note: z.string().optional(),
    elapsed_ms: z.number(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * Bash background list tool result - all background processes.
 */
export const BashBackgroundListResultSchema = z.union([
  z.object({
    success: z.literal(true),
    processes: z.array(
      z.object({
        process_id: z.string(),
        status: z.enum(["running", "exited", "killed", "failed"]),
        script: z.string(),
        uptime_ms: z.number(),
        exitCode: z.number().optional(),
        display_name: z.string().optional(),
      })
    ),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * Bash background terminate tool result.
 */
export const BashBackgroundTerminateResultSchema = z.union([
  z.object({
    success: z.literal(true),
    message: z.string(),
    display_name: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * xum_agents_read tool result.
 */
export const XumAgentsReadToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    content: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * xum_agents_write tool result.
 */
export const XumAgentsWriteToolResultSchema = z.union([
  z
    .object({
      success: z.literal(true),
      diff: z.string(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
]);

/**
 * xum_config_read tool result.
 */
export const XumConfigReadToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    file: z.string(),
    data: z.unknown(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

const XumConfigWriteValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

/**
 * xum_config_write tool result.
 */
export const XumConfigWriteToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    file: z.string(),
    appliedOps: z.number(),
    summary: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    validationIssues: z.array(XumConfigWriteValidationIssueSchema).optional(),
  }),
]);

/**
 * File read tool result - content or error.
 */
export const FileReadToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    file_size: z.number(),
    modifiedTime: z.string(),
    lines_read: z.number(),
    content: z
      .string()
      .describe(
        "File content with line numbers prepended as '<line_number>\\t<content>'. " +
          "Line numbers are not part of the actual file content."
      ),
    warning: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

const AttachFileToolTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const AttachFileToolMediaPartSchema = z
  .object({
    type: z.literal("media"),
    data: z.string(),
    mediaType: z.string(),
    filename: z.string().optional(),
  })
  .strict();

const AttachFileToolDisplayFilePartSchema = z
  .object({
    type: z.literal("display_file"),
    data: z.string(),
    mediaType: z.string(),
    filename: z.string().optional(),
    providerOptions: z
      .object({
        mux: z
          .object({
            displayOnly: z.literal(true),
            size: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const AttachFileToolSuccessResultSchema = z
  .object({
    type: z.literal("content"),
    value: z.union([
      z.tuple([AttachFileToolTextPartSchema, AttachFileToolMediaPartSchema]),
      z.tuple([AttachFileToolTextPartSchema, AttachFileToolDisplayFilePartSchema]),
    ]),
  })
  .strict();

export const AttachFileToolResultSchema = z.union([
  AttachFileToolSuccessResultSchema,
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .strict(),
]);

/**
 * Agent Skill read tool result - full SKILL.md package or error.
 */
export const AgentSkillReadToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    skill: AgentSkillPackageSchema,
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * Agent Skill read_file tool result.
 * Uses the same shape/limits as file_read.
 */
export const AgentSkillReadFileToolResultSchema = FileReadToolResultSchema;

/**
 * MCP prompt get tool result - flattened prompt text or error.
 */
export const MCPPromptGetToolResultSchema = z.union([
  z
    .object({
      success: z.literal(true),
      text: z.string(),
      description: z.string().optional(),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .strict(),
]);

/**
 * File edit insert tool result - diff or error.
 */
export const FileEditInsertToolResultSchema = z.union([
  z
    .object({
      success: z.literal(true),
      diff: z.string(),
      warning: z.string().optional(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
      note: z.string().optional(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
]);

/**
 * File edit replace string tool result - diff with edit count or error.
 */
export const FileEditReplaceStringToolResultSchema = z.union([
  z
    .object({
      success: z.literal(true),
      diff: z.string(),
      edits_applied: z.number(),
      warning: z.string().optional(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
      note: z.string().optional(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
]);

/**
 * Web fetch tool result - parsed content or error.
 */
export const WebFetchToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    title: z.string(),
    content: z.string(),
    url: z.string(),
    byline: z.string().optional(),
    length: z.number(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    content: z.string().optional(),
  }),
]);

export const HeartbeatToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    action: HeartbeatToolActionSchema,
    configured: z.boolean(),
    settings: WorkspaceHeartbeatSettingsSchema.nullable(),
    summary: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

// `recorded: false` means TimelineService throttled the note (duplicate description or too
// many agent events in a short window) and nothing was added to the timeline.
export const TimelineEventToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    recorded: z.boolean(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

export const MemoryToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    output: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * Names of tools that are bridgeable to PTC sandbox.
 * If adding a new tool here, you must also add its result schema below.
 */
export type BridgeableToolName =
  | "bash"
  | "bash_output"
  | "bash_background_list"
  | "bash_background_terminate"
  | "file_read"
  | "attach_file"
  | "agent_skill_read"
  | "agent_skill_read_file"
  | "file_edit_insert"
  | "file_edit_replace_string"
  // Note: for Anthropic models, web_fetch is replaced by a provider-native tool
  // (webFetch_20250910) that has no execute(). ToolBridge's hasExecute filter will drop it
  // from the PTC sandbox for those sessions. That silent absence is intentional and accepted.
  | "web_fetch"
  | "task"
  | "task_await"
  | "task_apply_git_patch"
  | "task_list"
  | "task_send_message"
  // Family messaging tools are bridged when the RLM experiment enables them;
  // registering their result schemas keeps generateXumTypes from declaring
  // them as returning unknown inside the kernel.
  | "task_message_parent"
  | "task_message_sibling"
  | "task_retitle"
  | "task_stop"
  | "task_remove"
  | "heartbeat"
  | "memory"
  | "mcp_prompt_get";

/**
 * Lookup map for result schemas by tool name.
 * Used by PTC type generator to get result types for bridgeable tools.
 *
 * Type-level enforcement ensures all BridgeableToolName entries have schemas.
 */
export const RESULT_SCHEMAS: Record<BridgeableToolName, z.ZodType> = {
  bash: BashToolResultSchema,
  bash_output: BashOutputToolResultSchema,
  bash_background_list: BashBackgroundListResultSchema,
  bash_background_terminate: BashBackgroundTerminateResultSchema,
  file_read: FileReadToolResultSchema,
  attach_file: AttachFileToolResultSchema,
  agent_skill_read: AgentSkillReadToolResultSchema,
  agent_skill_read_file: AgentSkillReadFileToolResultSchema,
  file_edit_insert: FileEditInsertToolResultSchema,
  file_edit_replace_string: FileEditReplaceStringToolResultSchema,
  web_fetch: WebFetchToolResultSchema,
  task: TaskToolResultSchema,
  task_await: TaskAwaitToolResultSchema,
  task_apply_git_patch: TaskApplyGitPatchToolResultSchema,
  task_list: TaskListToolResultSchema,
  task_send_message: TaskSendMessageToolResultSchema,
  task_message_parent: TaskMessageParentToolResultSchema,
  task_message_sibling: TaskMessageSiblingToolResultSchema,
  task_retitle: TaskRetitleToolResultSchema,
  task_stop: TaskStopToolResultSchema,
  task_remove: TaskRemoveToolResultSchema,
  heartbeat: HeartbeatToolResultSchema,
  memory: MemoryToolResultSchema,
  mcp_prompt_get: MCPPromptGetToolResultSchema,
};

/**
 * Get tool definition schemas for token counting
 * JSON schemas are auto-generated from zod schemas
 *
 * @returns Record of tool name to schema
 */
export function getToolSchemas(): Record<string, ToolSchema> {
  return Object.fromEntries(
    Object.entries(TOOL_DEFINITIONS).map(([name, def]) => [
      name,
      {
        name,
        description: def.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        inputSchema: zodToJsonSchema(def.schema as any) as ToolSchema["inputSchema"],
      },
    ])
  );
}

/**
 * Google's mixed built-in + function tool path is currently supported for Gemini 3.
 * Keep native Google tools gated here so the prompt allowlist matches the actual toolset.
 */
export function supportsGoogleNativeToolsWithFunctionTools(modelId: string): boolean {
  const bareModelId = modelId.split("/").pop() ?? modelId;
  const match = /^gemini-(\d+)(?:[.-]|$)/.exec(bareModelId);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  // The installed @ai-sdk/google mixed native/function serialization path is Gemini 3-only.
  return major === 3;
}

/**
 * Get which tools are available for a given model
 * @param modelString The model string (e.g., "anthropic:claude-opus-4-1")
 * @returns Array of tool names available for the model
 */
export function getAvailableTools(
  modelString: string,
  options?: {
    enableAgentReport?: boolean;
    /**
     * Whether the RLM family messaging tools (task_message_parent /
     * task_message_sibling) are available. Only true for sub-agent sessions
     * whose task record was stamped with the rlm experiment at spawn.
     */
    enableFamilyMessaging?: boolean;
    enableAnalyticsQuery?: boolean;
    enableAdvisor?: boolean;
    enableDynamicWorkflows?: boolean;
    /** Whether the agent memory tool is available (memory experiment enabled). */
    enableMemory?: boolean;
    enableTimelineEvent?: boolean;
    /** Whether tool_catalog_search is available (tool-search experiment + deferred MCP tools present). */
    enableToolSearch?: boolean;
    /** Whether mcp_prompt_get is available (connected MCP servers advertise prompts). */
    enableMcpPromptGet?: boolean;
    /**
     * Whether the Review pane tools (review_pane_update/review_pane_get) are
     * available. The Review pane belongs to the user-facing parent workspace,
     * so sub-agents (child task workspaces) pass false to keep them from
     * pinning code to a pane the user never sees. Defaults to true.
     */
    enableReviewPane?: boolean;
    /** @deprecated Xum global tools are always included. */
    enableMuxGlobalAgentsTools?: boolean;
  }
): string[] {
  const [provider, modelId = ""] = modelString.split(":");
  const enableAgentReport = options?.enableAgentReport ?? true;
  const enableFamilyMessaging = options?.enableFamilyMessaging ?? false;
  const enableAnalyticsQuery = options?.enableAnalyticsQuery ?? true;
  const enableAdvisor = options?.enableAdvisor ?? false;
  const enableDynamicWorkflows = options?.enableDynamicWorkflows ?? false;
  const enableMemory = options?.enableMemory ?? false;
  const enableTimelineEvent = options?.enableTimelineEvent ?? false;
  const enableToolSearch = options?.enableToolSearch ?? false;
  const enableMcpPromptGet = options?.enableMcpPromptGet ?? false;
  const enableReviewPane = options?.enableReviewPane ?? true;

  // Base tools available for all models
  // Note: Tool availability is controlled by agent tool policy (allowlist), not mode checks here.
  const baseTools = [
    "mux_agents_read",
    "mux_agents_write",
    "agent_skill_list",
    "agent_skill_write",
    "agent_skill_delete",
    "skills_catalog_search",
    "skills_catalog_read",
    "mux_config_read",
    "mux_config_write",
    "file_read",
    "attach_file",
    "desktop_screenshot",
    "desktop_move_mouse",
    "desktop_click",
    "desktop_double_click",
    "desktop_drag",
    "desktop_scroll",
    "desktop_type",
    "desktop_key_press",
    "agent_skill_read",
    "agent_skill_read_file",
    "file_edit_replace_string",
    // "file_edit_replace_lines", // DISABLED: causes models to break repo state
    "file_edit_insert",
    ...(enableMemory ? ["memory"] : []),
    ...(enableTimelineEvent ? ["timeline_event"] : []),
    ...(enableAdvisor ? ["advisor"] : []),
    ...(enableToolSearch ? ["tool_catalog_search"] : []),
    ...(enableMcpPromptGet ? ["mcp_prompt_get"] : []),
    "ask_user_question",
    "propose_plan",
    "bash",
    "task",
    "task_await",
    "task_apply_git_patch",
    "task_send_message",
    "task_retitle",
    "task_stop",
    "task_remove",
    "task_list",
    ...(enableDynamicWorkflows ? ["workflow_run", "workflow_resume"] : []),
    ...(enableAgentReport ? ["agent_report"] : []),
    ...(enableFamilyMessaging ? ["task_message_parent", "task_message_sibling"] : []),
    "set_goal",
    "get_goal",
    "complete_goal",
    "heartbeat",
    "todo_write",
    "todo_read",
    ...(enableReviewPane ? ["review_pane_update", "review_pane_get"] : []),
    "notify",
    ...(enableAnalyticsQuery ? ["analytics_query"] : []),
    "web_fetch",
  ];

  // Add provider-specific tools
  switch (provider) {
    case "anthropic":
      return [...baseTools, "web_search"];
    case "openai":
      // Only some OpenAI models support web search
      if (modelString.includes("gpt-4") || modelString.includes("gpt-5")) {
        return [...baseTools, "web_search"];
      }
      return baseTools;
    case "xai":
      return isGrokFrontierModel(modelString)
        ? [...baseTools, "web_search", "x_search"]
        : baseTools;
    case "google":
      if (supportsGoogleNativeToolsWithFunctionTools(modelId)) {
        return [...baseTools, "google_search", "url_context"];
      }
      return baseTools;
    default:
      return baseTools;
  }
}
