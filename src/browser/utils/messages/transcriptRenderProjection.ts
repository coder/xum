import {
  TRANSCRIPT_REVEAL_NOMINAL_ROW_CHARS,
  TRANSCRIPT_REVEAL_STEP_CHARS,
} from "@/common/constants/ui";
import type { DisplayedMessage } from "@/common/types/message";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { shouldShowInterruptedBarrier } from "./messageUtils";

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

/**
 * One stretch of agent work between two things the user reads: their prompt, a question or plan
 * that stops for them, and the reply. Compact density shows the stretch as one line ("Worked for
 * 2m 14s") above the reply, the way Codex folds a finished turn.
 */
export interface WorkBundleInfo {
  /** Derived from the stretch's first row, so it holds while a live turn grows. */
  key: string;
  /** First row of the stretch; the work line renders above it. */
  headIndex: number;
  /** "work" rows fold behind the work line. "answer" rows are the reply and always show. */
  role: "work" | "answer";
  /** A work row that shows through the fold: a call still running, or a live turn's latest step. */
  visibleWhenFolded: boolean;
  state: "live" | "settled";
  /** A stretch that only reasoned reads "Thought for 4s" rather than "Worked for 4s". */
  kind: "work" | "thought";
  /**
   * Files the folded work changed with the edit tools. The line says so ("edited 2 files"),
   * because a change to the user's files is the one thing a fold must not keep quiet about.
   */
  editedFileCount: number;
  startedAtMs?: number;
  durationMs?: number;
}

interface ComputeBundleInfosOptions {
  isTurnActive: boolean;
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
  | "tool"
  | "wait";

const FILE_READ_TOOL_NAMES = new Set<string>(["file_read"]);

// Keep legacy edit tool names categorized as edits for old transcripts, without
// reintroducing the removed file-tool coalescing render path.
const FILE_EDIT_TOOL_NAMES = new Set<string>([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
]);

/**
 * Summary-row copy, phrased like Claude Code / Codex / Cursor ("Explored 3 files, 2 searches",
 * "Ran 2 commands, read 1 file") rather than tallying "operations". `explores` marks read-only
 * lookups: a run made only of those reads as "Explored ...".
 */
const OPERATIONAL_BUNDLE_CATEGORY_COPY: Record<
  Exclude<OperationalBundleCategory, "reasoning">,
  { verb: string; noun: string; nounPlural: string; explores: boolean }
> = {
  read: { verb: "Read", noun: "file", nounPlural: "files", explores: true },
  search: { verb: "Ran", noun: "search", nounPlural: "searches", explores: true },
  fetch: { verb: "Fetched", noun: "page", nounPlural: "pages", explores: true },
  skill: { verb: "Read", noun: "skill", nounPlural: "skills", explores: true },
  edit: { verb: "Edited", noun: "file", nounPlural: "files", explores: false },
  shell: { verb: "Ran", noun: "command", nounPlural: "commands", explores: false },
  code: { verb: "Ran", noun: "script", nounPlural: "scripts", explores: false },
  question: { verb: "Asked", noun: "question", nounPlural: "questions", explores: false },
  task: { verb: "Ran", noun: "agent task", nounPlural: "agent tasks", explores: false },
  // A task_await inside a mixed run, worded like the all-wait row ("Checked task status 2 times").
  wait: { verb: "Checked task status", noun: "time", nounPlural: "times", explores: false },
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

/**
 * Tool rows that stop for the user: a question to answer, a plan to approve. They are part of
 * the conversation, so no work line hides them and they end the stretch of work before them.
 */
const STOP_TOOL_NAMES = new Set<string>(["ask_user_question", "propose_plan"]);

/**
 * Whether a tool row carries an MCP App view (its own call, or a call nested under a script).
 * A view is something the user works in, so like a question or a plan it stays in the
 * conversation: no work line hides it.
 */
function showsAppView(message: DisplayedMessage & { type: "tool" }): boolean {
  if (message.mcpServer?.app != null) {
    return true;
  }
  const nestedCalls = Array.isArray(message.nestedCalls) ? message.nestedCalls : [];
  return nestedCalls.some((call) => call.mcpServer?.app != null);
}

type WorkBundleRow = DisplayedMessage & {
  type: "assistant" | "reasoning" | "tool";
};

function isWorkBundleRow(message: DisplayedMessage | undefined): message is WorkBundleRow {
  switch (message?.type) {
    case "reasoning":
      return true;
    case "tool":
      return !STOP_TOOL_NAMES.has(message.toolName) && !showsAppView(message);
    case "assistant":
      // Compaction summaries and peer messages are not this turn's narration: they stay put.
      return !message.isCompacted && message.agentPeerMessage === undefined;
    default:
      return false;
  }
}

function isRunningWorkBundleRow(message: WorkBundleRow): boolean {
  if (message.type === "tool") {
    return message.status === "pending" || message.status === "executing";
  }
  return message.isStreaming;
}

/**
 * The one rule every fold in the transcript obeys (a work line, a run of routine calls, and the
 * "show earlier calls" cut of a script, see selectVisibleNestedCalls): a row that still needs
 * the user is never folded. That is a call that has not finished, which may be waiting for an
 * approval whose card and shortcuts live in the row, and the row a stopped turn ended on, which
 * carries the interrupted divider and its "continue" control.
 */
function needsUser(message: DisplayedMessage): boolean {
  return (
    (message.type === "tool" && (message.status === "pending" || message.status === "executing")) ||
    shouldShowInterruptedBarrier(message)
  );
}

function getMessageTimestamp(message: DisplayedMessage | undefined): number | undefined {
  return message !== undefined && "timestamp" in message && typeof message.timestamp === "number"
    ? message.timestamp
    : undefined;
}

/**
 * Calls that record progress and do no work. They often follow the reply (the agent ticks off
 * its todo list last), and the narration before them is still the reply.
 */
const BOOKKEEPING_TOOL_NAMES = new Set<string>(["notify", "timeline_event", "todo_write"]);

/** Whether a row after some narration means the agent went back to work after writing it. */
function isWorkAfterNarration(message: DisplayedMessage): boolean {
  return message.type === "tool" && !BOOKKEEPING_TOOL_NAMES.has(message.toolName);
}

/** Records the file a successful edit call changed. A call with no readable path counts alone. */
function collectEditedFile(
  editedFiles: Set<string>,
  call: { id: string; toolName: string; args: unknown; result: unknown; failed: boolean }
): void {
  if (!FILE_EDIT_TOOL_NAMES.has(call.toolName) || call.failed) {
    return;
  }
  const result = unwrapJsonResult(call.result);
  if (isPlainObject(result) && result.success === false) {
    return;
  }
  const path = isPlainObject(call.args) ? call.args.path : undefined;
  editedFiles.add(typeof path === "string" ? path : `call:${call.id}`);
}

/** Records the files a work row edited: its own edit, or the edits of a script's nested calls. */
function collectEditedFiles(editedFiles: Set<string>, message: WorkBundleRow): void {
  if (message.type !== "tool") {
    return;
  }
  collectEditedFile(editedFiles, {
    id: message.id,
    toolName: message.toolName,
    args: message.args,
    result: message.result,
    failed: message.status !== "completed",
  });
  for (const call of Array.isArray(message.nestedCalls) ? message.nestedCalls : []) {
    collectEditedFile(editedFiles, {
      id: call.toolCallId,
      toolName: call.toolName,
      args: call.input,
      result: call.output,
      failed: call.failed === true || call.state !== "output-available",
    });
  }
}

/**
 * Compact density. Each stretch of consecutive agent rows of one message (narration, reasoning,
 * tool calls) becomes a work bundle: the last narration is the reply and stays in view, and every
 * other row folds behind one line. Rows of another kind (a prompt, a question, a plan, an app
 * view, an error) end the stretch and are never folded.
 *
 * A finished stretch that went back to work after its last narration (it was interrupted, or
 * failed) has no reply: that narration announced work, it did not report on it. The work after
 * it gets a line of its own below it, so the narration does not read as the turn's answer.
 *
 * A call that left a background process running folds like any other step, although the routine
 * fold below keeps its row (see isRoutineToolCall). That is deliberate. The row cannot tell
 * whether the process still runs, and showing every spawn through the fold would return the log
 * this density removes. The composer's activity line (BackgroundProcessesBanner) lists the
 * processes that are running, with their output and terminate controls, whatever is folded here.
 *
 * A live stretch shows two more things through the fold so the user can see what the agent is
 * doing without the whole log: calls that are still running, and its latest step.
 */
export function computeWorkBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeBundleInfosOptions
): Array<WorkBundleInfo | undefined> {
  const infos = new Array<WorkBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    const first = messages[index];
    if (!isWorkBundleRow(first)) {
      index += 1;
      continue;
    }

    // One assistant message is one stream. A second message that follows with no prompt in
    // between (a wake-up, a continuation) is its own stretch with its own reply.
    const start = index;
    while (index < messages.length) {
      const candidate = messages[index];
      if (!isWorkBundleRow(candidate) || candidate.historyId !== first.historyId) {
        break;
      }
      index += 1;
    }
    assignWorkBundle(infos, messages, start, index - 1, options.isTurnActive);
  }

  return infos;
}

function assignWorkBundle(
  infos: Array<WorkBundleInfo | undefined>,
  messages: DisplayedMessage[],
  start: number,
  end: number,
  isTurnActive: boolean
): void {
  let lastWorkIndex = -1;
  let lastTextIndex = -1;
  let hasRunningRow = false;
  let startedAtMs =
    messages[start - 1]?.type === "user" ? getMessageTimestamp(messages[start - 1]) : undefined;
  let endedAtMs: number | undefined;
  for (let index = start; index <= end; index++) {
    const message = messages[index];
    if (!isWorkBundleRow(message)) {
      continue;
    }
    if (message.type === "assistant") {
      lastTextIndex = index;
    } else {
      lastWorkIndex = index;
    }
    hasRunningRow ||= isRunningWorkBundleRow(message);
    const timestamp = getMessageTimestamp(message);
    startedAtMs ??= timestamp;
    // The latest timestamp, not the last row's: a row without its own carries its message's start.
    if (timestamp !== undefined && (endedAtMs === undefined || timestamp > endedAtMs)) {
      endedAtMs = timestamp;
    }
  }
  // A reply with no work behind it needs no work line.
  if (lastWorkIndex === -1) {
    return;
  }

  // Live means the agent is still in this stretch: it is the transcript's tail, and the turn is
  // running. A row that is itself still running also counts, for hosts that do not report the
  // turn (and so a stale partial call does not look finished).
  const isLive = end === messages.length - 1 && (isTurnActive || hasRunningRow);

  // A finished stretch that worked on after its last narration is two stretches: the one that
  // narration closes, and the work after it. Each half is assigned on its own (the first now ends
  // on its narration and the second has none, so neither splits again).
  if (!isLive && lastTextIndex !== -1 && lastTextIndex < end) {
    let workedOn = false;
    for (let index = lastTextIndex + 1; index <= end && !workedOn; index++) {
      workedOn = isWorkAfterNarration(messages[index]);
    }
    if (workedOn) {
      assignWorkBundle(infos, messages, start, lastTextIndex, isTurnActive);
      assignWorkBundle(infos, messages, lastTextIndex + 1, end, isTurnActive);
      return;
    }
  }

  // The reply is the last narration, with any narration directly before it. Bookkeeping that
  // follows it (a todo update, a notification) folds like the rest, so it never hides a reply.
  let answerStart = lastTextIndex;
  while (answerStart > start && messages[answerStart - 1].type === "assistant") {
    answerStart -= 1;
  }
  const isAnswer = (index: number) =>
    lastTextIndex !== -1 && index >= answerStart && index <= lastTextIndex;

  let onlyReasoned = true;
  const editedFiles = new Set<string>();
  for (let index = start; index <= end; index++) {
    const message = messages[index];
    if (isAnswer(index) || !isWorkBundleRow(message)) {
      continue;
    }
    onlyReasoned &&= message.type === "reasoning";
    collectEditedFiles(editedFiles, message);
  }

  const base = {
    key: `work:${messages[start].id}`,
    headIndex: start,
    state: isLive ? "live" : "settled",
    kind: onlyReasoned ? "thought" : "work",
    editedFileCount: editedFiles.size,
    startedAtMs,
    durationMs:
      !isLive && startedAtMs !== undefined && endedAtMs !== undefined && endedAtMs > startedAtMs
        ? endedAtMs - startedAtMs
        : undefined,
  } satisfies Partial<WorkBundleInfo>;

  for (let index = start; index <= end; index++) {
    const message = messages[index];
    if (!isWorkBundleRow(message)) {
      continue;
    }
    if (isAnswer(index)) {
      infos[index] = { ...base, role: "answer", visibleWhenFolded: true };
      continue;
    }
    infos[index] = {
      ...base,
      role: "work",
      visibleWhenFolded:
        // A running call (an approval, or the thing the user is waiting on), or the row an
        // interrupted turn stopped on.
        needsUser(message) ||
        // The latest step, unless the agent has since moved on to writing.
        (isLive && index === lastWorkIndex && index > lastTextIndex),
    };
  }
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
  // bash_output is deliberately absent: consecutive polls of one process have their own
  // first/last collapse ("Show N more output checks"), which a generic fold would hide.
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

/**
 * Whether a call (a transcript row, or a call nested under a script) is routine enough to fold out
 * of sight. It depends on the payload as well as the tool name.
 */
export function isRoutineToolCall(toolName: string, args: unknown, result: unknown): boolean {
  if (!ROUTINE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  // A bash call that left a process running is not routine: the process outlives the call, has
  // its own controls (view output, terminate), and later task_await rows refer back to it.
  // That is a spawn asked for up front (`run_in_background`) or a foreground command sent to
  // the background while it ran, which only its result records (`backgroundProcessId`).
  if (toolName === "bash") {
    if (isPlainObject(args) && args.run_in_background === true) {
      return false;
    }
    const unwrapped = unwrapJsonResult(result);
    return !(isPlainObject(unwrapped) && typeof unwrapped.backgroundProcessId === "string");
  }
  return true;
}

/** Fewest routine tool calls that fold into a summary row; one call is already one row. */
const MIN_ROUTINE_RUN_TOOLS = 2;

function isRoutineToolMessage(
  message: DisplayedMessage | undefined
): message is DisplayedMessage & { type: "tool" } {
  if (
    message?.type !== "tool" ||
    !isRoutineToolCall(message.toolName, message.args, message.result)
  ) {
    return false;
  }
  if (message.toolName !== "code_execution") {
    return true;
  }
  // A code execution is only as routine as what it ran: one that edited a file, asked a
  // question or left a process running keeps its card visible. The same payload-aware test
  // applies to each nested call. Attachments (screenshots, files) ride on its result.
  const nestedCalls = Array.isArray(message.nestedCalls) ? message.nestedCalls : [];
  if (nestedCalls.some((call) => !isRoutineToolCall(call.toolName, call.input, call.output))) {
    return false;
  }
  const result = unwrapJsonResult(message.result);
  return !(
    isPlainObject(result) &&
    Array.isArray(result.attachments) &&
    result.attachments.length > 0
  );
}

/**
 * Runs of two or more routine tool calls (reads, searches, shell commands, code execution, task
 * polls) collapse into one summary row, the way Claude Code, Codex and Cursor fold exploration
 * into "Explored 3 files" lines. Rows the user must see (edits, questions, plans, todos,
 * attachments) stay standalone. This is the grouping inside a turn at either density.
 */
export function computeOperationalBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeBundleInfosOptions & {
    /**
     * Compact density's work bundles, indexed like `messages`. A run stops where the work line
     * changes: each line opens on its own, so a run that spanned two of them would leave its
     * summary row behind one line and its members, with no way to open them, behind the other.
     */
    workBundleInfos?: ReadonlyArray<WorkBundleInfo | undefined>;
  }
): Array<OperationalBundleInfo | undefined> {
  const workBundleInfos = options.workBundleInfos;
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
      if (workBundleInfos?.[cursor]?.key !== workBundleInfos?.[headIndex]?.key) {
        break;
      }
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
        hasTaskAwaitTerminalIssue(messagesInBundle) ||
        (isLiveTail && !allTaskAwaits) ||
        // The run is no longer the tail (a parallel sibling such as an edit came after it), but
        // one of its calls still needs the user. A run of task polls keeps its own quiet row:
        // a poll that is waiting needs nobody.
        (!allTaskAwaits && messagesInBundle.some(needsUser)),
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
        title: hasFailure ? "Task wait failed" : "Task wait interrupted",
        activeTitle: hasFailure ? "Task wait failed" : "Task wait interrupted",
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
 * One sentence for the whole run, in order of first appearance: "Explored 3 files, 2 searches" when
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
  if (message.toolName === "task") {
    return "task";
  }
  if (message.toolName === "task_await") {
    return "wait";
  }
  if (message.toolName === "code_execution") {
    return "code";
  }

  return "tool";
}
