import {
  TRANSCRIPT_REVEAL_NOMINAL_ROW_CHARS,
  TRANSCRIPT_REVEAL_STEP_CHARS,
} from "@/common/constants/ui";
import type { DisplayedMessage } from "@/common/types/message";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { sanitizeDisplayableModelIntent } from "@/browser/features/Tools/bashCollapsedSummary";
import { isMachineRow } from "./machineRows";
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
  /**
   * A work row that shows through the fold because the user must act on it: a call that waits
   * for their approval, or the row an interrupted turn stopped on.
   */
  visibleWhenFolded: boolean;
  state: "live" | "settled";
  /**
   * What a live stretch is doing right now ("Running the unit tests"). Its line says so in
   * place, so no row has to mount under the line and unmount when the next step starts.
   */
  liveStep?: string;
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

interface ComputeWorkBundleInfosOptions extends ComputeBundleInfosOptions {
  /**
   * Tool calls (a row's own, or one nested in a script) that wait for the user's approval. The
   * approval lives in the store, not in the row, so the host passes it in. Their rows show
   * through the fold: the approval card and its shortcuts are in the row.
   */
  approvalToolCallIds?: ReadonlySet<string>;
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

/** A row a work line can fold: a step of the agent, or a prompt the machine wrote mid-work. */
function isFoldableRow(message: DisplayedMessage | undefined): message is DisplayedMessage {
  return isWorkBundleRow(message) || isMachineRow(message);
}

function isRunningRow(message: DisplayedMessage): boolean {
  if (message.type === "tool") {
    return message.status === "pending" || message.status === "executing";
  }
  return "isStreaming" in message && message.isStreaming;
}

/**
 * Whether a run of routine calls must stay open for this row (the "show earlier calls" cut of a
 * script applies the same rule, see selectVisibleNestedCalls): a call that has not finished,
 * which may be waiting for an approval whose card and shortcuts live in the row, and the row the
 * transcript ends on when its turn was interrupted, which carries the control that continues the
 * turn. An interrupted row further up needs nobody: the conversation went on.
 *
 * The work line is stricter about running calls (see showsThroughFold): it names the running
 * step itself, and is told which calls wait for an approval.
 */
function needsUser(message: DisplayedMessage, isTranscriptTail: boolean): boolean {
  if (message.type === "tool" && (message.status === "pending" || message.status === "executing")) {
    return true;
  }
  return isTranscriptTail && shouldShowInterruptedBarrier(message);
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
function collectEditedFiles(editedFiles: Set<string>, message: DisplayedMessage): void {
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
 * Compact density. The agent's rows between two things the user reads (their prompt, a question
 * or plan that stops for them, an app view, an error) are one stretch of work: its last
 * narration is the reply and stays in view, and every other row folds behind one line.
 *
 * A stretch is not one assistant message. A turn that was interrupted and continued, that hit
 * an error and retried, or that was woken by a finished sub-agent is several messages, with
 * prompts the machine wrote between them (see isMachineRow), and it is still one piece of work
 * with one line. Only a reply ends a stretch early: the agent answered, and what follows (a
 * wake-up and the work it starts) is new work with its own line and its own reply.
 *
 * The last narration shows even when the stretch went back to work after it (it was
 * interrupted, or it failed): that is the last thing the agent said, and hiding it could hide an
 * answer that a trailing call happened to follow.
 *
 * A call that left a background process running folds like any other step, although the routine
 * fold below keeps its row (see isRoutineToolCall). That is deliberate. The row cannot tell
 * whether the process still runs, and showing every spawn through the fold would return the log
 * this density removes. The composer's activity line (BackgroundProcessesBanner) lists the
 * processes that are running, with their output and terminate controls, whatever is folded here.
 *
 * A live stretch names its latest step on its line ("Working for 42s · Running the unit tests")
 * and mounts no row for it. Showing each step as a row under the line made the transcript flash:
 * every call rendered in, and was gone when the next one started. Only a row the user must act
 * on shows through the fold (see showsThroughFold).
 */
export function computeWorkBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeWorkBundleInfosOptions
): Array<WorkBundleInfo | undefined> {
  const infos = new Array<WorkBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    if (!isFoldableRow(messages[index])) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < messages.length && isFoldableRow(messages[index])) {
      index += 1;
    }
    const runEnd = index - 1;
    const isLiveTail = options.isTurnActive && runEnd === messages.length - 1;
    const starts = findStretchStarts(messages, runStart, runEnd, isLiveTail);
    starts.forEach((start, position) => {
      const end = (starts[position + 1] ?? runEnd + 1) - 1;
      assignWorkBundle(infos, messages, start, end, options);
    });
  }

  return infos;
}

/** Narration, or a call that did real work: what makes a message more than bookkeeping. */
function isSubstantiveRow(message: DisplayedMessage): boolean {
  return message.type === "assistant" || isWorkAfterNarration(message);
}

/** Last row of the unit that starts at `start`: one assistant message, or one machine prompt. */
function findUnitEnd(messages: DisplayedMessage[], start: number, runEnd: number): number {
  const first = messages[start];
  if (!isWorkBundleRow(first)) {
    return start;
  }
  let end = start;
  while (end < runEnd) {
    const next = messages[end + 1];
    if (!isWorkBundleRow(next) || next.historyId !== first.historyId) {
      break;
    }
    end += 1;
  }
  return end;
}

function findLastSubstantiveRow(
  messages: DisplayedMessage[],
  start: number,
  end: number
): DisplayedMessage | undefined {
  for (let index = end; index >= start; index--) {
    if (isSubstantiveRow(messages[index])) {
      return messages[index];
    }
  }
  return undefined;
}

/**
 * Where the stretches of a run of foldable rows start. The run is one stretch, cut after each
 * reply that more work follows: the new stretch starts right after the reply, so it takes the
 * machine prompts that woke the agent with it.
 *
 * Rows after the last reply that hold no narration and no real work (a nudge and the todo
 * update it asked for) stay with that reply's stretch, as bookkeeping behind its line. While
 * the turn runs they open a stretch instead: the agent is about to act on them, and its line
 * should not appear to restart the work above.
 */
function findStretchStarts(
  messages: DisplayedMessage[],
  runStart: number,
  runEnd: number,
  isLiveTail: boolean
): number[] {
  const starts = [runStart];
  // First row after the reply that closed the stretch being built; undefined while it is open.
  let afterReply: number | undefined;
  for (let unitStart = runStart; unitStart <= runEnd; ) {
    const unitEnd = findUnitEnd(messages, unitStart, runEnd);
    const last = findLastSubstantiveRow(messages, unitStart, unitEnd);
    if (last !== undefined) {
      if (afterReply !== undefined) {
        starts.push(afterReply);
      }
      afterReply = last.type === "assistant" ? unitEnd + 1 : undefined;
    }
    unitStart = unitEnd + 1;
  }
  if (afterReply !== undefined && afterReply <= runEnd && isLiveTail) {
    starts.push(afterReply);
  }
  return starts;
}

/** What one pass over a stretch finds: where its work and its narration end, and whether it runs. */
interface StretchScan {
  /**
   * Last row that is not narration (reasoning, a tool call, a machine prompt). -1 when the
   * stretch holds no step of the agent's: narration alone needs no line, and neither does a
   * machine prompt the agent has not acted on.
   */
  lastWorkIndex: number;
  /** Last narration row; -1 when the stretch has none. */
  lastTextIndex: number;
  /**
   * The agent is still in this stretch: it is the transcript's tail, and the turn is running. A
   * row that is itself still running also counts, for hosts that do not report the turn (and so
   * a stale partial call does not look finished).
   */
  isLive: boolean;
}

function scanStretch(
  messages: DisplayedMessage[],
  start: number,
  end: number,
  isTurnActive: boolean
): StretchScan {
  let lastWorkIndex = -1;
  let lastTextIndex = -1;
  let hasAgentStep = false;
  let hasRunningRow = false;
  for (let index = start; index <= end; index++) {
    const message = messages[index];
    if (message.type === "assistant") {
      lastTextIndex = index;
    } else {
      lastWorkIndex = index;
      hasAgentStep ||= message.type !== "user";
    }
    hasRunningRow ||= isRunningRow(message);
  }
  const isLive = end === messages.length - 1 && (isTurnActive || hasRunningRow);
  return { lastWorkIndex: hasAgentStep ? lastWorkIndex : -1, lastTextIndex, isLive };
}

/**
 * When a stretch started and how long it took. It starts at the prompt before it, or else at its
 * first row with a timestamp. It ends at the latest timestamp of the agent's own rows, not at
 * its last row's: a row without its own carries its message's start. A machine prompt does not
 * end it: a sub-agent's report is shown where the agent was when the sub-agent finished, which
 * can be before rows that are older than the report.
 */
function measureStretch(
  messages: DisplayedMessage[],
  start: number,
  end: number
): { startedAtMs: number | undefined; durationMs: number | undefined } {
  const prompt = messages[start - 1];
  let startedAtMs = prompt?.type === "user" ? getMessageTimestamp(prompt) : undefined;
  let endedAtMs = Number.NEGATIVE_INFINITY;
  for (let index = start; index <= end; index++) {
    const timestamp = getMessageTimestamp(messages[index]);
    if (timestamp === undefined) {
      continue;
    }
    startedAtMs ??= timestamp;
    if (messages[index].type !== "user") {
      endedAtMs = Math.max(endedAtMs, timestamp);
    }
  }
  // No start, or no row with a timestamp after it (endedAtMs is still -Infinity): no duration.
  const elapsedMs = startedAtMs === undefined ? 0 : endedAtMs - startedAtMs;
  return { startedAtMs, durationMs: elapsedMs > 0 ? elapsedMs : undefined };
}

/** Rows `first` to `last`; empty when `first` is above `last`. */
interface RowRange {
  first: number;
  last: number;
}

const isInRange = (range: RowRange, index: number) => index >= range.first && index <= range.last;

/**
 * The reply of a stretch: its last narration, with any narration directly before it. Bookkeeping
 * that follows it (a todo update, a notification) folds like the rest, so it never hides a reply.
 * The range is empty when the stretch has no narration.
 */
function findAnswerRange(
  messages: DisplayedMessage[],
  start: number,
  lastTextIndex: number
): RowRange {
  if (lastTextIndex === -1) {
    return { first: 0, last: -1 };
  }
  let first = lastTextIndex;
  while (first > start && messages[first - 1].type === "assistant") {
    first -= 1;
  }
  return { first, last: lastTextIndex };
}

/** What the work line says about the rows it folds: whether they only reasoned, and their edits. */
function summarizeFoldedRows(
  messages: DisplayedMessage[],
  start: number,
  end: number,
  answer: RowRange
): { onlyReasoned: boolean; editedFileCount: number } {
  let reasoningRows = 0;
  let otherRows = 0;
  const editedFiles = new Set<string>();
  for (let index = start; index <= end; index++) {
    if (isInRange(answer, index)) {
      continue;
    }
    const message = messages[index];
    if (message.type === "reasoning") {
      reasoningRows += 1;
    } else {
      otherRows += 1;
    }
    collectEditedFiles(editedFiles, message);
  }
  return {
    onlyReasoned: reasoningRows > 0 && otherRows === 0,
    editedFileCount: editedFiles.size,
  };
}

/** Whether a call, or a call nested in it, waits for the user's approval. */
function awaitsApproval(
  message: DisplayedMessage,
  approvalToolCallIds: ReadonlySet<string> | undefined
): boolean {
  if (message.type !== "tool" || approvalToolCallIds === undefined) {
    return false;
  }
  if (approvalToolCallIds.has(message.toolCallId)) {
    return true;
  }
  const nestedCalls = Array.isArray(message.nestedCalls) ? message.nestedCalls : [];
  return nestedCalls.some((call) => approvalToolCallIds.has(call.toolCallId));
}

/**
 * Whether a folded work row still shows under its closed work line: only when the user must act
 * on it. That is a call that waits for their approval (the card and its shortcuts are in the
 * row), and the row the transcript ends on when its turn was interrupted (it carries the control
 * that continues the turn). A call that is merely running does not show: the line names it.
 */
function showsThroughFold(
  messages: DisplayedMessage[],
  index: number,
  approvalToolCallIds: ReadonlySet<string> | undefined
): boolean {
  const message = messages[index];
  return (
    awaitsApproval(message, approvalToolCallIds) ||
    (index === messages.length - 1 && shouldShowInterruptedBarrier(message))
  );
}

function assignWorkBundle(
  infos: Array<WorkBundleInfo | undefined>,
  messages: DisplayedMessage[],
  start: number,
  end: number,
  options: ComputeWorkBundleInfosOptions
): void {
  const scan = scanStretch(messages, start, end, options.isTurnActive);
  // A reply with no work behind it needs no work line.
  if (scan.lastWorkIndex === -1) {
    return;
  }

  const answer = findAnswerRange(messages, start, scan.lastTextIndex);
  const base = describeStretch(messages, start, end, scan, answer);
  for (let index = start; index <= end; index++) {
    infos[index] = isInRange(answer, index)
      ? { ...base, role: "answer", visibleWhenFolded: true }
      : {
          ...base,
          role: "work",
          visibleWhenFolded: showsThroughFold(messages, index, options.approvalToolCallIds),
        };
  }
}

type LiveStepDescriber = (toolName: string, args: Record<string, unknown>) => string;

/** "Reading session.ts": the file a read or an edit names, without its directories. */
function describeFileStep(verb: string, fallback: string): LiveStepDescriber {
  return (_toolName, args) => {
    if (typeof args.path !== "string") {
      return fallback;
    }
    const fileName = args.path.slice(
      Math.max(args.path.lastIndexOf("/"), args.path.lastIndexOf("\\")) + 1
    );
    return `${verb} ${fileName.length > 0 ? fileName : args.path}`;
  };
}

/** What a live turn's line says a call of each kind is doing. */
const LIVE_STEP_DESCRIBERS: Record<ToolBundleCategory, LiveStepDescriber> = {
  read: describeFileStep("Reading", "Reading a file"),
  edit: describeFileStep("Editing", "Editing a file"),
  // The model states what a command is for ("Running the unit tests"): that reads better than
  // the command, which the opened line shows.
  shell: (_toolName, args) =>
    sanitizeDisplayableModelIntent(
      args.model_intent,
      typeof args.script === "string" ? args.script : ""
    ) ?? "Running a command",
  search: () => "Searching the web",
  fetch: () => "Reading a web page",
  skill: () => "Reading a skill",
  code: () => "Running a script",
  question: () => "Asking a question",
  task: () => "Starting a sub-agent",
  wait: () => "Waiting for sub-agents",
  tool: (toolName) => `Using ${toolName}`,
};

function describeCall(toolName: string, args: unknown): string {
  const category = getToolCategory(toolName);
  return LIVE_STEP_DESCRIBERS[category](toolName, isPlainObject(args) ? args : {});
}

/**
 * What the latest step of a live stretch is doing, for its line. A script is described by the
 * call it is making. Undefined when the agent has moved on to writing, and for a machine prompt
 * the agent has not acted on yet: the line then says "Working" alone.
 */
function describeLiveStep(messages: DisplayedMessage[], scan: StretchScan): string | undefined {
  if (scan.lastWorkIndex <= scan.lastTextIndex) {
    return undefined;
  }
  const message = messages[scan.lastWorkIndex];
  if (message.type === "reasoning") {
    return "Thinking";
  }
  if (message.type !== "tool") {
    return undefined;
  }
  const nestedCalls = Array.isArray(message.nestedCalls) ? message.nestedCalls : [];
  const latestNested = nestedCalls[nestedCalls.length - 1];
  return latestNested === undefined
    ? describeCall(message.toolName, message.args)
    : describeCall(latestNested.toolName, latestNested.input);
}

/** What every row of a stretch shares: the facts its work line states. */
function describeStretch(
  messages: DisplayedMessage[],
  start: number,
  end: number,
  scan: StretchScan,
  answer: RowRange
): Omit<WorkBundleInfo, "role" | "visibleWhenFolded"> {
  const folded = summarizeFoldedRows(messages, start, end, answer);
  const timing = measureStretch(messages, start, end);
  return {
    key: `work:${messages[start].id}`,
    headIndex: start,
    state: scan.isLive ? "live" : "settled",
    kind: folded.onlyReasoned ? "thought" : "work",
    // A stretch that only reasoned already reads "Thinking for 4s".
    liveStep: scan.isLive && !folded.onlyReasoned ? describeLiveStep(messages, scan) : undefined,
    editedFileCount: folded.editedFileCount,
    startedAtMs: timing.startedAtMs,
    // A live stretch has no duration yet: its line runs a clock from startedAtMs.
    durationMs: scan.isLive ? undefined : timing.durationMs,
  };
}

/**
 * The rows the transcript's mount window counts, as indices into the transcript, or undefined
 * when that is every row (detailed density).
 *
 * The window (useBoundedTranscriptReveal) budgets rows: how many mount first, how many per
 * step, where it pauses and where it caps. A row folded behind a closed work line mounts
 * nothing, so counting it made each budget many times too small in compact density: the first
 * paint of a long session was its last turn alone, with the turns above popping in over the
 * next frames, and "Load older messages" came after two or three long turns.
 *
 * The window tracks its edges by row id, so the rows it is given must be stable there:
 *  - The first row of a stretch always counts (the work line renders at it, and it is the only
 *    place the window may cut), and so does the last (the newest row of the transcript is
 *    always one, and the window restarts when the newest row it knew disappears).
 *  - Every row of a live stretch counts. Its last row changes with every step, and a newest
 *    row that stops counting would read as a replaced tail.
 * A line the user opened mounts its steps without counting them: they come on request only.
 */
export function computeWindowRowIndices(
  workBundleInfos: ReadonlyArray<WorkBundleInfo | undefined> | undefined
): number[] | undefined {
  if (workBundleInfos === undefined) return undefined;
  const indices: number[] = [];
  for (let index = 0; index < workBundleInfos.length; index++) {
    if (countsInWindow(workBundleInfos, index)) indices.push(index);
  }
  return indices.length === workBundleInfos.length ? undefined : indices;
}

/** Whether the mount window counts the row at `index` (the rules of computeWindowRowIndices). */
function countsInWindow(
  workBundleInfos: ReadonlyArray<WorkBundleInfo | undefined>,
  index: number
): boolean {
  const info = workBundleInfos[index];
  if (info === undefined || info.state === "live") return true;
  const showsWhenFolded = info.role === "answer" || info.visibleWhenFolded;
  const isFirstOfStretch = info.headIndex === index;
  const isLastOfStretch = workBundleInfos[index + 1]?.key !== info.key;
  return showsWhenFolded || isFirstOfStretch || isLastOfStretch;
}

/** The rows a mount window counts, with its indices translated to and from the transcript's. */
export interface TranscriptWindowRows<Row> {
  rows: readonly Row[];
  /** Transcript index of the window row at `windowIndex`; the transcript's length past the end. */
  toTranscriptIndex: (windowIndex: number) => number;
  /** The last window row at or before the transcript row at `transcriptIndex`. */
  toWindowIndex: (transcriptIndex: number) => number;
}

/**
 * `messages` narrowed to `windowRowIndices` (see computeWindowRowIndices; undefined keeps every
 * row). A range of window rows [from, to) is the transcript range between the same two rows, so
 * it takes the uncounted rows between them with it: they sit inside stretches, and the window
 * only cuts at the first row of one.
 */
export function selectTranscriptWindowRows<Row>(
  messages: readonly Row[],
  windowRowIndices: readonly number[] | undefined
): TranscriptWindowRows<Row> {
  if (windowRowIndices === undefined) {
    return { rows: messages, toTranscriptIndex: (index) => index, toWindowIndex: (index) => index };
  }
  return {
    rows: windowRowIndices.map((index) => messages[index]),
    toTranscriptIndex: (windowIndex) =>
      windowIndex < windowRowIndices.length ? windowRowIndices[windowIndex] : messages.length,
    toWindowIndex: (transcriptIndex) => {
      // Binary search for the last counted row at or before the target.
      let low = 0;
      let high = windowRowIndices.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (windowRowIndices[middle] <= transcriptIndex) low = middle;
        else high = middle - 1;
      }
      return low;
    },
  };
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
  return !carriesAttachments(message.result);
}

/** Whether a tool result carries attachments (screenshots, files) for the user to see. */
function carriesAttachments(rawResult: unknown): boolean {
  const result = unwrapJsonResult(rawResult);
  return (
    isPlainObject(result) && Array.isArray(result.attachments) && result.attachments.length > 0
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
  const transcriptTail = messages[messages.length - 1];
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
        (!allTaskAwaits &&
          messagesInBundle.some((message) => needsUser(message, message === transcriptTail))),
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
  const entries = countToolCategories(messages);
  if (entries.length === 0) {
    return "Thought";
  }

  if (
    entries.length > 1 &&
    entries.every(([category]) => OPERATIONAL_BUNDLE_CATEGORY_COPY[category].explores)
  ) {
    return `Explored ${entries.map(([category, count]) => formatCategoryCount(category, count)).join(", ")}`;
  }

  // Merge categories that share a verb ("Ran 2 commands and 1 script") so the line stays short.
  const clauses = new Map<string, string[]>();
  for (const [category, count] of entries) {
    const verb = OPERATIONAL_BUNDLE_CATEGORY_COPY[category].verb;
    clauses.set(verb, [...(clauses.get(verb) ?? []), formatCategoryCount(category, count)]);
  }
  return Array.from(clauses.entries())
    .map(
      ([verb, phrases], index) =>
        `${index === 0 ? verb : verb.toLowerCase()} ${phrases.join(" and ")}`
    )
    .join(", ");
}

type ToolBundleCategory = Exclude<OperationalBundleCategory, "reasoning">;

/** How many calls of each kind a run made, in order of first appearance. Reasoning is not counted. */
function countToolCategories(
  messages: OperationalBundleMemberMessage[]
): Array<[ToolBundleCategory, number]> {
  const counts = new Map<ToolBundleCategory, number>();
  for (const message of messages) {
    const category = getOperationalBundleCategory(message);
    if (category === "reasoning") continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return Array.from(counts.entries());
}

/** "3 files", "1 command". */
function formatCategoryCount(category: ToolBundleCategory, count: number): string {
  const copy = OPERATIONAL_BUNDLE_CATEGORY_COPY[category];
  return `${count.toLocaleString()} ${count === 1 ? copy.noun : copy.nounPlural}`;
}

/** A collapsed bundle hides each card's status, so failures surface in the summary itself. */
function formatFailures(messages: OperationalBundleMemberMessage[]): string {
  const failedCount = messages.filter(
    (message) => message.type === "tool" && message.status === "failed"
  ).length;
  return failedCount > 0 ? `${failedCount.toLocaleString()} failed` : "";
}

/**
 * The summary category of each tool that is known by name. Tools not listed (and not a file
 * read or edit) count as a plain "tool".
 */
const TOOL_CATEGORY_BY_NAME = new Map<string, ToolBundleCategory>([
  ["bash", "shell"],
  ["web_search", "search"],
  // server:GOOGLE_SEARCH_WEB is Google's native search grounding (Gemini 3+); one call can
  // carry several queries, but it is still one search operation for bundle copy purposes.
  ["server:GOOGLE_SEARCH_WEB", "search"],
  ["web_fetch", "fetch"],
  ["agent_skill_read", "skill"],
  ["agent_skill_read_file", "skill"],
  ["ask_user_question", "question"],
  ["task", "task"],
  ["task_await", "wait"],
  ["code_execution", "code"],
]);

function getToolCategory(toolName: string): ToolBundleCategory {
  if (FILE_READ_TOOL_NAMES.has(toolName)) {
    return "read";
  }
  if (FILE_EDIT_TOOL_NAMES.has(toolName)) {
    return "edit";
  }
  return TOOL_CATEGORY_BY_NAME.get(toolName) ?? "tool";
}

function getOperationalBundleCategory(
  message: OperationalBundleMemberMessage
): OperationalBundleCategory {
  return message.type === "reasoning" ? "reasoning" : getToolCategory(message.toolName);
}
