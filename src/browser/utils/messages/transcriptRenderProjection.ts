import {
  TRANSCRIPT_REVEAL_NOMINAL_ROW_CHARS,
  TRANSCRIPT_REVEAL_STEP_CHARS,
} from "@/common/constants/ui";
import type { DisplayedMessage } from "@/common/types/message";
import { isPlainObject } from "@/common/utils/isPlainObject";

export type OperationalBundleMemberMessage = DisplayedMessage & { type: "reasoning" | "tool" };

export interface OperationalBundleSummary {
  title: string;
  details: string;
  activeTitle?: string;
  tone?: "danger" | "interrupted";
}

export interface OperationalBundleEntry {
  message: OperationalBundleMemberMessage;
  originalIndex: number;
}

export interface OperationalBundleInfo {
  key: string;
  position: "head" | "member";
  /** Render slot where the bundle header is placed; leading entries can appear earlier. */
  headIndex: number;
  entries: readonly OperationalBundleEntry[];
  summary: OperationalBundleSummary;
  state: "active" | "settled";
  defaultExpanded: boolean;
}

export interface WorkBundleEntry {
  message: DisplayedMessage;
  originalIndex: number;
}

export interface WorkBundleInfo {
  key: string;
  position: "head" | "member" | "final";
  /** Render slot where the work-bundle header is placed. */
  headIndex: number;
  entries: readonly WorkBundleEntry[];
  startedAtMs?: number;
  durationMs?: number;
  state: "active" | "settled";
  defaultExpanded: boolean;
}

interface ComputeBundleInfosOptions {
  isTurnActive: boolean;
  /**
   * "all" (hyper density): every run of reasoning and tool rows becomes a bundle.
   * "routine" (normal density): only runs of two or more routine tool calls (reads, searches,
   * shell commands, code execution, task polls) collapse into one summary row, the way Claude
   * Code, Codex and Cursor fold exploration into "Explored · 3 reads" lines. Rows the user must
   * see (edits, questions, plans, todos, attachments) stay standalone.
   */
  scope?: "all" | "routine";
}

type OperationalBundleCategory =
  | "code"
  | "edit"
  | "fetch"
  | "question"
  | "read"
  | "reasoning"
  | "search"
  | "shell"
  | "skill"
  | "task"
  | "tool";

const FILE_READ_TOOL_NAMES = new Set<string>(["file_read"]);

// Keep legacy edit tool names categorized as edits for old transcripts, without
// reintroducing the removed file-tool coalescing render path.
const FILE_EDIT_TOOL_NAMES = new Set<string>([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
]);

/**
 * Summary-row copy, phrased like Claude Code / Codex / Cursor ("Explored 3 files, 2 queries",
 * "Ran 2 commands, read 1 file") rather than tallying "operations". `explores` marks read-only
 * lookups: a run made only of those reads as "Explored ...".
 */
const OPERATIONAL_BUNDLE_CATEGORY_COPY: Record<
  Exclude<OperationalBundleCategory, "reasoning">,
  { verb: string; noun: string; nounPlural: string; explores: boolean }
> = {
  read: { verb: "Read", noun: "file", nounPlural: "files", explores: true },
  search: { verb: "Searched", noun: "query", nounPlural: "queries", explores: true },
  fetch: { verb: "Fetched", noun: "page", nounPlural: "pages", explores: true },
  skill: { verb: "Read", noun: "skill", nounPlural: "skills", explores: true },
  edit: { verb: "Edited", noun: "file", nounPlural: "files", explores: false },
  shell: { verb: "Ran", noun: "command", nounPlural: "commands", explores: false },
  code: { verb: "Ran", noun: "script", nounPlural: "scripts", explores: false },
  question: { verb: "Asked", noun: "question", nounPlural: "questions", explores: false },
  task: { verb: "Ran", noun: "agent task", nounPlural: "agent tasks", explores: false },
  tool: { verb: "Used", noun: "tool", nounPlural: "tools", explores: false },
};

/** Nesting walked when charging a tool payload: provider/MCP results wrap content a few levels deep. */
const TOOL_PAYLOAD_WALK_DEPTH = 4;

/**
 * Characters of string payload a tool card can render when expanded: every string reachable
 * within a few levels (file contents, command output, a plan body, `{ type: "json", value }`
 * result wrappers whose value an expanded card serializes in full). Nothing is serialized —
 * expansion is per workspace/tool and not visible to this projection, so this errs toward
 * charging the visible payload. The walk is bounded in depth and in work: the caller only
 * needs to know whether a row exceeds one reveal step, so it stops once that ceiling is
 * reached (a very wide result must not itself become a long task).
 */
function estimateToolPayloadChars(value: unknown, depth = TOOL_PAYLOAD_WALK_DEPTH): number {
  if (typeof value === "string") return value.length;
  if (value === null || typeof value !== "object" || depth === 0) return 0;
  let chars = 0;
  const fields = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const field of fields) {
    if (chars >= TRANSCRIPT_REVEAL_STEP_CHARS) break;
    chars += estimateToolPayloadChars(field, depth - 1);
  }
  return chars;
}

/**
 * Relative render + layout cost of a transcript row for the tail-first reveal: the text body
 * length for rows that render one (markdown, code blocks); for tool cards a nominal constant
 * plus their string payload (args and result), since expanded cards — sticky per tool, and
 * default for some tools — render it in full; a nominal constant for markers. A heuristic in
 * characters, deliberately cheap — never serializes a message.
 */
export function estimateTranscriptRowWeight(message: DisplayedMessage): number {
  switch (message.type) {
    case "user":
    case "assistant":
    case "reasoning":
    case "plan-display":
      return message.content.length;
    case "tool":
      return (
        TRANSCRIPT_REVEAL_NOMINAL_ROW_CHARS +
        estimateToolPayloadChars(message.args) +
        estimateToolPayloadChars(message.result)
      );
    case "stream-error":
      // Rendered in full; distinct verbose provider failures are not merged, so a run of them
      // must count as the text it mounts, not as markers.
      return TRANSCRIPT_REVEAL_NOMINAL_ROW_CHARS + message.error.length;
    default:
      return TRANSCRIPT_REVEAL_NOMINAL_ROW_CHARS;
  }
}

export function computeWorkBundleInfos(
  messages: DisplayedMessage[]
): Array<WorkBundleInfo | undefined> {
  const infos = new Array<WorkBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    const span = findWorkBundleSpan(messages, index);
    if (span === undefined) {
      index += 1;
      continue;
    }

    const entries: WorkBundleEntry[] = [];
    for (let entryIndex = span.firstEntryIndex; entryIndex <= span.finalIndex; entryIndex++) {
      entries.push({ message: messages[entryIndex], originalIndex: entryIndex });
    }

    const finalMessage = messages[span.finalIndex];
    if (span.state === "settled" && finalMessage?.type !== "assistant") {
      index = span.finalIndex + 1;
      continue;
    }

    const frozenEntries = Object.freeze(entries);
    const firstAgentMessage = frozenEntries.find((entry) =>
      isWorkBundleAgentMessage(entry.message)
    );
    if (firstAgentMessage === undefined) {
      index = span.finalIndex + 1;
      continue;
    }

    const info: WorkBundleInfo = {
      key: `work:${firstAgentMessage.message.id}`,
      position: "head",
      headIndex: span.headIndex,
      entries: frozenEntries,
      startedAtMs: getMessageTimestamp(frozenEntries[0].message),
      durationMs:
        span.state === "active"
          ? undefined
          : computeWorkBundleDurationMs(frozenEntries, finalMessage),
      state: span.state,
      defaultExpanded: span.state === "active",
    };

    infos[span.headIndex] = info;
    for (const entry of entries) {
      infos[entry.originalIndex] = {
        ...info,
        position:
          entry.originalIndex === span.headIndex
            ? "head"
            : span.state === "settled" && entry.originalIndex === span.finalIndex
              ? "final"
              : "member",
      };
    }
    index = span.finalIndex + 1;
  }

  return infos;
}

export function computeOperationalBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeBundleInfosOptions
): Array<OperationalBundleInfo | undefined> {
  if (options.scope === "routine") {
    return computeRoutineRunBundleInfos(messages, options);
  }

  const infos = new Array<OperationalBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    const leadingReasoningStart = index;
    const leadingReasoningEntries: OperationalBundleEntry[] = [];
    while (true) {
      const message = messages[index];
      if (message?.type !== "reasoning") break;
      leadingReasoningEntries.push({ message, originalIndex: index });
      index += 1;
    }

    if (leadingReasoningEntries.length > 0 && messages[index]?.type === "assistant") {
      index += 1;
    } else if (leadingReasoningEntries.length > 0) {
      leadingReasoningEntries.length = 0;
      index = leadingReasoningStart;
    }

    const firstMessage = messages[index];
    if (!isOperationalBundleMemberMessage(firstMessage)) {
      index += 1;
      continue;
    }

    const headIndex = index;
    const entries: OperationalBundleEntry[] = [...leadingReasoningEntries];
    while (index < messages.length) {
      const candidate = messages[index];
      if (!isOperationalBundleMemberMessage(candidate)) {
        break;
      }
      entries.push({ message: candidate, originalIndex: index });
      index += 1;
    }

    const frozenEntries = Object.freeze(entries);
    const messagesInBundle = frozenEntries.map((entry) => entry.message);
    const allTaskAwaits = messagesInBundle.every(isTaskAwaitMessage);
    const state = getBundleState(frozenEntries);
    const needsAttention = hasTaskAwaitTerminalIssue(messagesInBundle);
    assignBundleInfo(infos, {
      key: `bundle:${entries[0].message.id}`,
      position: "head",
      headIndex,
      entries: frozenEntries,
      summary: summarizeOperationalBundle(messagesInBundle),
      state,
      defaultExpanded: needsAttention || (state === "active" && !allTaskAwaits),
    });
  }

  return infos;
}

/**
 * Tools whose collapsed card carries no information the user must act on or review, so a run of
 * them can fold into one summary row. Deliberately an allowlist: an unknown or new tool keeps its
 * own card until someone decides it is routine.
 */
const ROUTINE_TOOL_NAMES = new Set<string>([
  "agent_skill_list",
  "agent_skill_read",
  "agent_skill_read_file",
  "bash",
  "bash_background_list",
  "bash_output",
  "code_execution",
  "file_read",
  "get_goal",
  "models_list",
  "review_pane_get",
  "server:GOOGLE_SEARCH_WEB",
  "session_history",
  "task_await",
  "tool_catalog_search",
  "tool_search",
  "web_fetch",
  "web_search",
]);

/** Fewest routine tool calls that fold into a summary row; one call is already one row. */
const MIN_ROUTINE_RUN_TOOLS = 2;

function isRoutineToolMessage(
  message: DisplayedMessage | undefined
): message is DisplayedMessage & { type: "tool" } {
  if (message?.type !== "tool" || !ROUTINE_TOOL_NAMES.has(message.toolName)) {
    return false;
  }
  if (message.toolName !== "code_execution") {
    return true;
  }
  // A code execution is only as routine as what it ran: one that edited a file or asked a
  // question keeps its card visible. Attachments (screenshots, files) ride on its result.
  const nestedCalls = Array.isArray(message.nestedCalls) ? message.nestedCalls : [];
  if (nestedCalls.some((call) => !ROUTINE_TOOL_NAMES.has(call.toolName))) {
    return false;
  }
  const result = unwrapJsonResult(message.result);
  return !(
    isPlainObject(result) &&
    Array.isArray(result.attachments) &&
    result.attachments.length > 0
  );
}

function computeRoutineRunBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeBundleInfosOptions
): Array<OperationalBundleInfo | undefined> {
  const infos = new Array<OperationalBundleInfo | undefined>(messages.length);
  // Found once per projection (not per run) so live-tail detection stays linear in the transcript.
  let lastNonReasoningIndex = messages.length - 1;
  while (lastNonReasoningIndex >= 0 && messages[lastNonReasoningIndex].type === "reasoning") {
    lastNonReasoningIndex -= 1;
  }
  let index = 0;

  while (index < messages.length) {
    if (!isRoutineToolMessage(messages[index])) {
      index += 1;
      continue;
    }

    // Reasoning between routine calls stays inside the run (it is part of the same exploration),
    // but reasoning after the last call is left out so the thought that leads into the next
    // visible row (an answer, an edit) stays next to it.
    const headIndex = index;
    let lastToolIndex = index;
    let toolCount = 0;
    for (let cursor = index; cursor < messages.length; cursor++) {
      const candidate = messages[cursor];
      if (isRoutineToolMessage(candidate)) {
        lastToolIndex = cursor;
        toolCount += 1;
        continue;
      }
      if (candidate.type === "reasoning" && isOperationalBundleMemberMessage(candidate)) {
        continue;
      }
      break;
    }
    index = lastToolIndex + 1;

    if (toolCount < MIN_ROUTINE_RUN_TOOLS) {
      continue;
    }

    const entries: OperationalBundleEntry[] = [];
    for (let entryIndex = headIndex; entryIndex <= lastToolIndex; entryIndex++) {
      const message = messages[entryIndex];
      if (isOperationalBundleMemberMessage(message)) {
        entries.push({ message, originalIndex: entryIndex });
      }
    }

    const frozenEntries = Object.freeze(entries);
    const messagesInBundle = frozenEntries.map((entry) => entry.message);
    const allTaskAwaits = messagesInBundle.every(isTaskAwaitMessage);
    // The run the agent is still working in stays open so progress is visible, and it folds once
    // the agent moves on (writes text, makes an edit) or the turn ends. Keying this on the tail
    // rather than on per-row status keeps the run from collapsing and reopening between calls.
    const isLiveTail = options.isTurnActive && lastToolIndex === lastNonReasoningIndex;
    assignBundleInfo(infos, {
      key: `routine:${entries[0].message.id}`,
      position: "head",
      headIndex,
      entries: frozenEntries,
      summary: summarizeOperationalBundle(messagesInBundle),
      state: getBundleState(frozenEntries),
      defaultExpanded:
        hasTaskAwaitTerminalIssue(messagesInBundle) || (isLiveTail && !allTaskAwaits),
    });
  }

  return infos;
}

function getBundleState(
  entries: readonly OperationalBundleEntry[]
): OperationalBundleInfo["state"] {
  return entries.some((entry) => isActiveOperationalMessage(entry.message)) ? "active" : "settled";
}

function assignBundleInfo(
  infos: Array<OperationalBundleInfo | undefined>,
  info: OperationalBundleInfo
): void {
  for (const entry of info.entries) {
    infos[entry.originalIndex] = {
      ...info,
      position: entry.originalIndex === info.headIndex ? "head" : "member",
    };
  }
}

interface WorkBundleSpan {
  headIndex: number;
  firstEntryIndex: number;
  finalIndex: number;
  state: "active" | "settled";
}

function findWorkBundleSpan(
  messages: DisplayedMessage[],
  index: number
): WorkBundleSpan | undefined {
  const message = messages[index];
  const firstEntryIndex = message?.type === "user" ? index + 1 : index;
  const firstEntry = messages[firstEntryIndex];
  if (getWorkBundleAgentHistoryId(firstEntry) === undefined) {
    return undefined;
  }

  const finalIndex = findWorkBundleFinalIndex(messages, firstEntryIndex);
  if (finalIndex === undefined) {
    return undefined;
  }

  return {
    headIndex: message?.type === "user" ? index : firstEntryIndex,
    firstEntryIndex,
    ...finalIndex,
  };
}

function findWorkBundleFinalIndex(
  messages: DisplayedMessage[],
  startIndex: number
): Pick<WorkBundleSpan, "finalIndex" | "state"> | undefined {
  const firstHistoryId = getWorkBundleAgentHistoryId(messages[startIndex]);
  if (firstHistoryId === undefined) {
    return undefined;
  }

  const historyIds = new Set<string>([firstHistoryId]);
  let canCrossVisibleConversation = false;
  let sawVisibleConversationSinceLastAgent = false;
  let sawAnyOperationalMessage = false;
  let sawOperationalMessage = false;
  let sawActiveMessage = false;
  let lastAgentIndex = startIndex;
  let finalIndex: number | undefined;

  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index];
    if (!isWorkBundleTimelineMessage(message)) {
      break;
    }

    if (isWorkBundleVisibleConversationMessage(message)) {
      if (finalIndex !== undefined) {
        break;
      }
      if (!canCrossVisibleConversation) {
        break;
      }
      if (!hasFutureWorkBundleAgentMessage(messages, index + 1)) {
        break;
      }
      sawVisibleConversationSinceLastAgent = true;
      sawOperationalMessage = false;
      sawActiveMessage = false;
      canCrossVisibleConversation = false;
      continue;
    }

    const messageHistoryId = getWorkBundleAgentHistoryId(message);
    if (messageHistoryId === undefined) {
      break;
    }
    if (!historyIds.has(messageHistoryId)) {
      if (!sawVisibleConversationSinceLastAgent) {
        break;
      }
      historyIds.add(messageHistoryId);
    }
    sawVisibleConversationSinceLastAgent = false;
    lastAgentIndex = index;
    if (isActiveWorkBundleMessage(message)) {
      sawActiveMessage = true;
    }

    if (isWorkBundleOperationalMessage(message)) {
      sawAnyOperationalMessage = true;
      sawOperationalMessage = true;
    }
    canCrossVisibleConversation = canContinueWorkBundleAcrossConversation(message);

    if (message.type !== "assistant" || message.isPartial || !sawOperationalMessage) {
      continue;
    }

    finalIndex = index;
    canCrossVisibleConversation = false;
  }

  if (!sawAnyOperationalMessage) {
    return undefined;
  }
  if (finalIndex !== undefined && finalIndex >= startIndex) {
    return { finalIndex, state: "settled" };
  }
  if (sawActiveMessage && lastAgentIndex >= startIndex) {
    return { finalIndex: lastAgentIndex, state: "active" };
  }

  return undefined;
}

function hasFutureWorkBundleAgentMessage(
  messages: DisplayedMessage[],
  startIndex: number
): boolean {
  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index];
    if (!isWorkBundleTimelineMessage(message)) {
      return false;
    }
    if (isWorkBundleVisibleConversationMessage(message)) {
      continue;
    }

    return getWorkBundleAgentHistoryId(message) !== undefined;
  }

  return false;
}

function canContinueWorkBundleAcrossConversation(message: DisplayedMessage): boolean {
  // Only partial tool rows prove the agent was still doing operational work when
  // the user spoke. Partial reasoning/text alone can also be an interrupted turn;
  // do not anchor the next prompt under that old turn's work bundle.
  return (
    message.type === "tool" &&
    message.isPartial === true &&
    (message.status === "pending" ||
      message.status === "executing" ||
      message.toolName === "ask_user_question")
  );
}

function getWorkBundleAgentHistoryId(message: DisplayedMessage | undefined): string | undefined {
  if (!isWorkBundleAgentMessage(message) || isWorkBundleVisibleConversationMessage(message)) {
    return undefined;
  }
  return message.historyId;
}

function isWorkBundleTimelineMessage(
  message: DisplayedMessage | undefined
): message is DisplayedMessage & { type: "assistant" | "reasoning" | "tool" | "user" } {
  return (
    message?.type === "assistant" ||
    message?.type === "reasoning" ||
    message?.type === "tool" ||
    message?.type === "user"
  );
}

function isWorkBundleAgentMessage(
  message: DisplayedMessage | undefined
): message is DisplayedMessage & { type: "assistant" | "reasoning" | "tool" } {
  return message?.type === "assistant" || message?.type === "reasoning" || message?.type === "tool";
}

function isWorkBundleVisibleConversationMessage(message: DisplayedMessage | undefined): boolean {
  return message?.type === "user";
}

function isWorkBundleOperationalMessage(message: DisplayedMessage | undefined): boolean {
  return message?.type === "reasoning" || message?.type === "tool";
}

function isActiveWorkBundleMessage(message: DisplayedMessage): boolean {
  if (message.type === "assistant" || message.type === "reasoning") {
    return message.isStreaming;
  }
  return (
    message.type === "tool" && (message.status === "pending" || message.status === "executing")
  );
}

function getMessageTimestamp(message: DisplayedMessage): number | undefined {
  return "timestamp" in message && typeof message.timestamp === "number"
    ? message.timestamp
    : undefined;
}

function computeWorkBundleDurationMs(
  entries: readonly WorkBundleEntry[],
  finalMessage: DisplayedMessage
): number | undefined {
  const startTimestamp = getMessageTimestamp(entries[0].message);
  const endTimestamp =
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
    getMessageTimestamp(finalMessage) ?? getMessageTimestamp(entries.at(-1)!.message);
  if (
    startTimestamp === undefined ||
    endTimestamp === undefined ||
    endTimestamp <= startTimestamp
  ) {
    return undefined;
  }
  return endTimestamp - startTimestamp;
}

export function summarizeOperationalBundle(
  messages: OperationalBundleMemberMessage[]
): OperationalBundleSummary {
  if (messages.length === 0) {
    throw new Error("Cannot summarize an empty operational bundle");
  }

  const allTaskAwaits = messages.every(isTaskAwaitMessage);
  if (allTaskAwaits) {
    const pollCount = messages.length;
    const hasFailure =
      messages.some(hasTaskAwaitCallFailure) || messages.some(hasTaskAwaitResultFailure);
    const hasInterruption =
      messages.some(hasTaskAwaitCallInterruption) || messages.some(hasTaskAwaitResultInterruption);
    if (hasFailure || hasInterruption) {
      return {
        title: hasFailure ? "Task wait needs attention" : "Task wait interrupted",
        activeTitle: hasFailure ? "Task wait needs attention" : "Task wait interrupted",
        details: pollCount === 1 ? "" : `${pollCount} checks`,
        tone: hasFailure ? "danger" : "interrupted",
      };
    }
    return {
      title: pollCount === 1 ? "Checked task status" : `Checked task status ${pollCount} times`,
      activeTitle:
        pollCount === 1 ? "Waiting for tasks" : `Waiting for tasks · ${pollCount} checks`,
      details: "",
    };
  }

  const allSearchMisses = messages.every(isEmptyCompletedWebSearch);
  if (allSearchMisses) {
    return {
      title: `${formatTitle(messages)}, no results`,
      details: formatFailures(messages),
    };
  }

  return {
    title: formatTitle(messages),
    details: formatFailures(messages),
  };
}

function isTaskAwaitMessage(message: OperationalBundleMemberMessage): boolean {
  return message.type === "tool" && message.toolName === "task_await";
}

function getTaskAwaitResultEntries(message: OperationalBundleMemberMessage): object[] {
  if (message.type !== "tool" || message.toolName !== "task_await") return [];

  const result = unwrapJsonResult(message.result);
  if (!isPlainObject(result) || !Array.isArray(result.results)) return [];

  return result.results.filter(isPlainObject);
}

// eslint-disable-next-line local/no-object-parameters -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
function isInterruptedTaskAwaitEntry(entry: object): boolean {
  if (!("status" in entry) || typeof entry.status !== "string") return false;
  if (entry.status === "interrupted") return true;
  return (
    entry.status === "error" &&
    "error" in entry &&
    typeof entry.error === "string" &&
    entry.error.trim().toLowerCase() === "interrupted"
  );
}

function hasTaskAwaitResultInterruption(message: OperationalBundleMemberMessage): boolean {
  return getTaskAwaitResultEntries(message).some(isInterruptedTaskAwaitEntry);
}

function hasTaskAwaitResultFailure(message: OperationalBundleMemberMessage): boolean {
  return getTaskAwaitResultEntries(message).some((entry) => {
    if (isInterruptedTaskAwaitEntry(entry)) return false;
    if (!("status" in entry) || typeof entry.status !== "string") return false;
    return (
      entry.status === "error" || entry.status === "invalid_scope" || entry.status === "not_found"
    );
  });
}

function hasTaskAwaitCallFailure(message: OperationalBundleMemberMessage): boolean {
  if (message.type !== "tool" || message.toolName !== "task_await") return false;
  if (message.status === "failed") return true;

  const result = unwrapJsonResult(message.result);
  return isPlainObject(result) && result.success === false;
}

function hasTaskAwaitCallInterruption(message: OperationalBundleMemberMessage): boolean {
  return (
    message.type === "tool" && message.toolName === "task_await" && message.status === "interrupted"
  );
}

function hasTaskAwaitTerminalIssue(messages: readonly OperationalBundleMemberMessage[]): boolean {
  return messages.some(
    (message) =>
      hasTaskAwaitCallFailure(message) ||
      hasTaskAwaitCallInterruption(message) ||
      hasTaskAwaitResultFailure(message) ||
      hasTaskAwaitResultInterruption(message)
  );
}

function isEmptyCompletedWebSearch(message: OperationalBundleMemberMessage): boolean {
  return (
    message.type === "tool" &&
    message.toolName === "web_search" &&
    message.status === "completed" &&
    getWebSearchResultCount(message.result) === 0
  );
}

function getWebSearchResultCount(result: unknown): number | undefined {
  const unwrapped = unwrapJsonResult(result);
  if (Array.isArray(unwrapped)) {
    return unwrapped.length;
  }
  if (isPlainObject(unwrapped) && Array.isArray(unwrapped.sources)) {
    return unwrapped.sources.length;
  }
  return undefined;
}

function unwrapJsonResult(result: unknown): unknown {
  if (isPlainObject(result) && result.type === "json" && "value" in result) {
    return result.value;
  }
  return result;
}

function isOperationalBundleMemberMessage(
  message: DisplayedMessage | undefined
): message is OperationalBundleMemberMessage {
  if (message?.type === "reasoning") {
    return message.isOnlyMessageContent !== true;
  }
  if (message?.type === "tool") {
    return true;
  }
  return false;
}

function isActiveOperationalMessage(message: OperationalBundleMemberMessage): boolean {
  if (message.type === "reasoning") {
    return message.isStreaming;
  }
  return message.status === "pending" || message.status === "executing";
}

/**
 * One sentence for the whole run, in order of first appearance: "Explored 3 files, 2 queries" when
 * every call was a read-only lookup of more than one kind, else verb clauses ("Ran 2 commands, read 1 file"). Reasoning
 * rows are folded in silently; a reasoning-only bundle reads "Thought".
 */
function formatTitle(messages: OperationalBundleMemberMessage[]): string {
  const counts = new Map<Exclude<OperationalBundleCategory, "reasoning">, number>();
  for (const message of messages) {
    const category = getOperationalBundleCategory(message);
    if (category === "reasoning") continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return "Thought";
  }

  const phrase = (category: Exclude<OperationalBundleCategory, "reasoning">, count: number) => {
    const copy = OPERATIONAL_BUNDLE_CATEGORY_COPY[category];
    return `${count.toLocaleString()} ${count === 1 ? copy.noun : copy.nounPlural}`;
  };
  const entries = Array.from(counts.entries());
  if (
    entries.length > 1 &&
    entries.every(([category]) => OPERATIONAL_BUNDLE_CATEGORY_COPY[category].explores)
  ) {
    return `Explored ${entries.map(([category, count]) => phrase(category, count)).join(", ")}`;
  }

  // Merge categories that share a verb ("Ran 2 commands and 1 script") so the line stays short.
  const clauses = new Map<string, string[]>();
  for (const [category, count] of entries) {
    const verb = OPERATIONAL_BUNDLE_CATEGORY_COPY[category].verb;
    clauses.set(verb, [...(clauses.get(verb) ?? []), phrase(category, count)]);
  }
  return Array.from(clauses.entries())
    .map(
      ([verb, phrases], index) =>
        `${index === 0 ? verb : verb.toLowerCase()} ${phrases.join(" and ")}`
    )
    .join(", ");
}

/** A collapsed bundle hides each card's status, so failures surface in the summary itself. */
function formatFailures(messages: OperationalBundleMemberMessage[]): string {
  const failedCount = messages.filter(
    (message) => message.type === "tool" && message.status === "failed"
  ).length;
  return failedCount > 0 ? `${failedCount.toLocaleString()} failed` : "";
}

function getOperationalBundleCategory(
  message: OperationalBundleMemberMessage
): OperationalBundleCategory {
  if (message.type === "reasoning") {
    return "reasoning";
  }

  if (FILE_READ_TOOL_NAMES.has(message.toolName)) {
    return "read";
  }
  if (FILE_EDIT_TOOL_NAMES.has(message.toolName)) {
    return "edit";
  }
  if (message.toolName === "bash") {
    return "shell";
  }
  // server:GOOGLE_SEARCH_WEB is Google's native search grounding (Gemini 3+); one call can
  // carry several queries, but it is still one search operation for bundle copy purposes.
  if (message.toolName === "web_search" || message.toolName === "server:GOOGLE_SEARCH_WEB") {
    return "search";
  }
  if (message.toolName === "web_fetch") {
    return "fetch";
  }
  if (message.toolName === "agent_skill_read" || message.toolName === "agent_skill_read_file") {
    return "skill";
  }
  if (message.toolName === "ask_user_question") {
    return "question";
  }
  if (message.toolName === "task" || message.toolName === "task_await") {
    return "task";
  }
  if (message.toolName === "code_execution") {
    return "code";
  }

  return "tool";
}
