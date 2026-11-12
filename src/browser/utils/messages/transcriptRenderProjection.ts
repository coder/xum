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
 * One stretch of the agent's steps between two things the user reads: their prompt, something
 * the agent wrote, a question or plan that stops for them. Compact density shows the stretch as
 * one line that says what it did ("Read 3 files, ran 2 commands").
 */
export interface WorkBundleInfo {
  /** Derived from the stretch's first row, so it holds while a live stretch grows. */
  key: string;
  /** First row of the stretch; the work line renders above it. */
  headIndex: number;
  /**
   * A row that shows under the closed line because the user must act on it: a call that waits
   * for their approval, or the row an interrupted turn stopped on.
   */
  visibleWhenFolded: boolean;
  state: "live" | "settled";
  /**
   * The line's text. Settled, what the steps did ("Read 3 files, ran 2 commands · 1 failed").
   * Live, what the latest step is doing ("Running the unit tests"): the text changes in place,
   * so no row has to mount under the line and unmount when the next step starts.
   */
  summary: string;
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
  | "todo"
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
  // The agent ticks its list off after most replies, so this is often a line of its own.
  todo: { verb: "Updated", noun: "the todo list", nounPlural: "the todo list", explores: false },
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

/**
 * A step of the agent's work, which compact density folds: reasoning, a tool call, or a prompt
 * the machine wrote mid-work (see isMachineRow). What the agent writes is never a step: it
 * stays in view. Neither is a question, a plan or an app view, which are there for the user.
 */
function isStepRow(message: DisplayedMessage | undefined): message is DisplayedMessage {
  switch (message?.type) {
    case "reasoning":
      return true;
    case "tool":
      return !STOP_TOOL_NAMES.has(message.toolName) && !showsAppView(message);
    default:
      return isMachineRow(message);
  }
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

/**
 * Compact density. Everything the agent writes stays in view as regular text, the way Claude
 * Code and Codex show a turn: its status updates while it works, then its reply. The steps
 * between two things the user reads (their prompt, an update, a question or plan, an app view,
 * an error) are one stretch, folded behind one line that says what they did.
 *
 * An earlier design folded a whole turn behind one line ("Worked for 2m 14s") and showed only
 * its last narration. Closed, that said too little about a long turn. Opened, it put the whole
 * log on the page, and the line that closes it was a long scroll away. The stretch between two
 * updates is short, so it opens and closes in place.
 *
 * Prompts the machine writes mid-work (a sub-agent's report, a wake-up, a nudge) fold with the
 * steps around them. A stretch that holds only such prompts gets no line: the agent has not
 * acted on them, and they stay rows.
 *
 * A call that left a background process running folds like any other step, although the routine
 * fold below keeps its row (see isRoutineToolCall). That is deliberate. The row cannot tell
 * whether the process still runs, and showing every spawn through the fold would return the log
 * this density removes. The composer's activity line (BackgroundProcessesBanner) lists the
 * processes that are running, with their output and terminate controls, whatever is folded here.
 *
 * A live stretch names its latest step on its line ("Running the unit tests") and mounts no row
 * for it. Showing each step as a row under the line made the transcript flash: every call
 * rendered in, and was gone when the next one started. Only a row the user must act on shows
 * through the fold (see showsThroughFold).
 */
export function computeWorkBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeWorkBundleInfosOptions
): Array<WorkBundleInfo | undefined> {
  const infos = new Array<WorkBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    if (!isStepRow(messages[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < messages.length && isStepRow(messages[index])) {
      index += 1;
    }
    assignWorkBundle(infos, messages, start, index - 1, options);
  }

  return infos;
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
 * Whether a folded step still shows under its closed work line: only when the user must act
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
  const steps: OperationalBundleMemberMessage[] = [];
  for (let index = start; index <= end; index++) {
    const message = messages[index];
    if (message.type === "reasoning" || message.type === "tool") {
      steps.push(message);
    }
  }
  // Machine prompts the agent has not acted on: nothing was done, so there is nothing to fold.
  if (steps.length === 0) {
    return;
  }

  // The agent is still in this stretch: it is the transcript's tail, and the turn is running. A
  // step that is itself still running also counts, for hosts that do not report the turn (and
  // so a stale partial call does not look finished).
  const isLive = end === messages.length - 1 && (options.isTurnActive || steps.some(isRunningRow));
  const base = {
    key: `work:${messages[start].id}`,
    headIndex: start,
    state: isLive ? "live" : "settled",
    summary: isLive ? describeLiveStep(messages[end]) : describeSteps(steps),
  } as const;
  for (let index = start; index <= end; index++) {
    infos[index] = {
      ...base,
      visibleWhenFolded: showsThroughFold(messages, index, options.approvalToolCallIds),
    };
  }
}

/** What a finished stretch did, in the words a run of routine calls uses in detailed density. */
function describeSteps(steps: OperationalBundleMemberMessage[]): string {
  const summary = summarizeOperationalBundle(steps);
  return summary.details === "" ? summary.title : `${summary.title} · ${summary.details}`;
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

/** What a live stretch's line says a call of each kind is doing. */
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
  todo: () => "Updating the todo list",
  tool: (toolName) => `Using ${toolName}`,
};

function describeCall(toolName: string, args: unknown): string {
  const category = getToolCategory(toolName);
  return LIVE_STEP_DESCRIBERS[category](toolName, isPlainObject(args) ? args : {});
}

/**
 * What the latest step of a live stretch is doing, for its line. A script is described by the
 * call it is making. A machine prompt the agent has just been handed says "Working" alone.
 */
function describeLiveStep(message: DisplayedMessage): string {
  if (message.type === "reasoning") {
    return "Thinking";
  }
  if (message.type !== "tool") {
    return "Working";
  }
  const nestedCalls = Array.isArray(message.nestedCalls) ? message.nestedCalls : [];
  const latestNested = nestedCalls[nestedCalls.length - 1];
  return latestNested === undefined
    ? describeCall(message.toolName, message.args)
    : describeCall(latestNested.toolName, latestNested.input);
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
  const isFirstOfStretch = info.headIndex === index;
  const isLastOfStretch = workBundleInfos[index + 1]?.key !== info.key;
  return info.visibleWhenFolded || isFirstOfStretch || isLastOfStretch;
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
 * attachments) stay standalone. This is detailed density's grouping. Compact density folds every
 * step between two things the agent wrote (see computeWorkBundleInfos), so it has no use for it.
 */
export function computeOperationalBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeBundleInfosOptions
): Array<OperationalBundleInfo | undefined> {
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
  // Every update rewrites the one list: how many there were says nothing.
  if (category === "todo") {
    return copy.noun;
  }
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
  ["todo_write", "todo"],
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
