import type { HeldInput } from "@/common/orpc/types";
import type { DisplayedMessage, DisplayedUserMessage, QueuedMessage } from "@/common/types/message";
import type { RuntimeStatusEvent } from "@/common/types/stream";
import { parseAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";

/** The longest preview kept per line; the bar truncates visually well before this. */
const PREVIEW_MAX_CHARS = 160;

/** Tool argument fields that name what a call works on, in order of preference. */
const TOOL_DETAIL_KEYS = ["display_name", "title", "path", "file_path"] as const;

/** Collapses a text to one plain line, cut at PREVIEW_MAX_CHARS. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_MAX_CHARS ? `${line.slice(0, PREVIEW_MAX_CHARS - 1)}…` : line;
}

/** A short plain-text name for what a tool call works on (bash display_name, file path, task title). */
export function toolCallDetail(args: unknown): string | undefined {
  if (args == null || typeof args !== "object") return undefined;
  for (const key of TOOL_DETAIL_KEYS) {
    const value: unknown = Reflect.get(args, key);
    if (typeof value === "string" && value.trim() !== "") return oneLine(value);
  }
  return undefined;
}

export type StatusActivityKind =
  | "starting"
  | "compacting"
  | "question"
  | "tool"
  | "thinking"
  | "writing"
  | "working"
  | "monitor"
  | "idle"
  | "error";

export interface StatusActivity {
  kind: StatusActivityKind;
  label: string;
  detail?: string;
}

export interface StatusActivityFlags {
  canInterrupt: boolean;
  isStreamStarting: boolean;
  isCompacting: boolean;
  awaitingUserQuestion: boolean;
  /** Armed background bash monitors, which wake the agent on matching output after its turn. */
  activeBashMonitorCount: number;
  /** The backend's startup breadcrumb (runtime readiness, tool loading), as StreamingBarrier shows it. */
  runtimeStatus?: Pick<RuntimeStatusEvent, "phase" | "detail"> | null;
}

type DisplayedTool = Extract<DisplayedMessage, { type: "tool" }>;

function isRunningTool(message: DisplayedMessage): message is DisplayedTool {
  return (
    message.type === "tool" && (message.status === "pending" || message.status === "executing")
  );
}

function isStreamingRow(message: DisplayedMessage, type: "reasoning" | "assistant"): boolean {
  return message.type === type && message.isStreaming;
}

/**
 * The streaming turn's rows (after the last user row) decide: a running tool call beats
 * streaming reasoning, which beats reply text, so a turn that runs parallel tools keeps naming a
 * tool while one still runs.
 */
function streamingActivity(messages: readonly DisplayedMessage[]): StatusActivity {
  // mutation-equivalent: the user row itself is neither a tool nor a streaming row
  const turn = messages.slice(messages.findLastIndex((message) => message.type === "user") + 1);
  const running = turn.filter(isRunningTool);
  // The backend runs parallel calls one at a time, and the queued ones show as executing too:
  // only the call whose execute() began has executionStartedAt. Provider-executed tools never get
  // one, so without a started call the newest running call stands.
  const tool = running.findLast((call) => call.executionStartedAt != null) ?? running.at(-1);
  if (tool != null) {
    return { kind: "tool", label: `Running ${tool.toolName}`, detail: toolCallDetail(tool.args) };
  }
  if (turn.some((message) => isStreamingRow(message, "reasoning"))) {
    return { kind: "thinking", label: "Thinking…" };
  }
  if (turn.some((message) => isStreamingRow(message, "assistant"))) {
    return { kind: "writing", label: "Writing a reply…" };
  }
  return { kind: "working", label: "Working…" };
}

/**
 * The runtime's startup breadcrumb while it starts or waits, as StreamingBarrier shows it. A blank
 * detail (which the backend may send) reads as none, so the line never shows a bare spinner.
 */
function startingLabel(runtimeStatus: StatusActivityFlags["runtimeStatus"]): string {
  const phase = runtimeStatus?.phase;
  const detail = phase === "starting" || phase === "waiting" ? runtimeStatus?.detail?.trim() : "";
  return detail != null && detail !== "" ? detail : "Starting…";
}

/** After the turn: an armed monitor wakes the agent on matching output, so it is not idle. */
function settledActivity(
  messages: readonly DisplayedMessage[],
  activeBashMonitorCount: number
): StatusActivity {
  if (activeBashMonitorCount > 0) {
    const monitors =
      activeBashMonitorCount === 1
        ? "a background monitor"
        : `${activeBashMonitorCount} background monitors`;
    return { kind: "monitor", label: `Waiting on ${monitors}` };
  }
  return messages.at(-1)?.type === "stream-error"
    ? { kind: "error", label: "Stopped with an error" }
    : { kind: "idle", label: "Idle" };
}

/** What the agent is doing right now. */
export function deriveStatusActivity(
  messages: readonly DisplayedMessage[],
  flags: StatusActivityFlags
): StatusActivity {
  if (flags.isStreamStarting) return { kind: "starting", label: startingLabel(flags.runtimeStatus) };
  if (flags.isCompacting) return { kind: "compacting", label: "Compacting context…" };
  if (flags.awaitingUserQuestion) return { kind: "question", label: "Waiting for your answer" };
  if (flags.canInterrupt) return streamingActivity(messages);
  return settledActivity(messages, flags.activeBashMonitorCount);
}

/** Activities with no turn running: the agent is idle, stopped, or waits for a monitor's match. */
const SETTLED_KINDS: ReadonlySet<StatusActivityKind> = new Set(["idle", "error", "monitor"]);

/** Whether a turn is still running. */
export function isTurnActive(activity: StatusActivity): boolean {
  return !SETTLED_KINDS.has(activity.kind);
}

/** A user row the human typed, not a machine turn (wakes, continuations, peer triggers, warnings). */
export function isHumanUserMessage(message: DisplayedMessage): message is DisplayedUserMessage {
  return (
    message.type === "user" &&
    message.isSynthetic !== true &&
    message.isGoalContinuation !== true &&
    message.isBudgetLimitWrapup !== true &&
    message.bashMonitorWake == null &&
    message.agentPeerMessageTrigger == null &&
    message.contextBudgetWarning == null
  );
}

export type LastMessageReceiptState = "queued" | "held" | "sending" | "in-transcript";

export interface LastMessageReceipt {
  state: LastMessageReceiptState;
  preview: string;
  /** When the row landed in the transcript, for "in-transcript" rows that carry one. */
  timestamp?: number;
  /**
   * Held inputs the receipt does not show. They carry no time, so the bar cannot tell whether one
   * is newer than the message it shows, and counts them instead (the dock lists each one).
   */
  otherHeldCount: number;
}

function previewOrPlaceholder(text: string): string {
  return oneLine(text) || "(no text)";
}

/** The queued message (newer than every row: it is not in history yet), else the newest human row. */
function sentMessageReceipt(
  messages: readonly DisplayedMessage[],
  queuedMessage: QueuedMessage | null
): Omit<LastMessageReceipt, "otherHeldCount"> | null {
  if (queuedMessage != null) {
    return { state: "queued", preview: previewOrPlaceholder(queuedMessage.content) };
  }
  const latest = messages.findLast(isHumanUserMessage);
  if (latest == null) return null;
  if (latest.isPendingSend === true) {
    return { state: "sending", preview: previewOrPlaceholder(latest.content) };
  }
  return {
    state: "in-transcript",
    preview: previewOrPlaceholder(latest.content),
    timestamp: latest.timestamp,
  };
}

/**
 * Where the user's latest message is. Held inputs stay until the user resends or discards them,
 * so an old one must not stand in for a newer message that landed: the receipt shows a held input
 * only when there is nothing else to show, and counts the rest.
 */
export function deriveLastMessageReceipt(
  messages: readonly DisplayedMessage[],
  queuedMessage: QueuedMessage | null,
  heldInputs: readonly HeldInput[]
): LastMessageReceipt | null {
  const sent = sentMessageReceipt(messages, queuedMessage);
  if (sent != null) return { ...sent, otherHeldCount: heldInputs.length };
  const held = heldInputs.at(-1);
  if (held == null) return null;
  return {
    state: "held",
    preview: previewOrPlaceholder(held.displayText),
    otherHeldCount: heldInputs.length - 1,
  };
}

export type RecentTranscriptRowKind =
  | "user"
  | "assistant"
  | "tool"
  | "reasoning"
  | "error"
  | "plan"
  | "boundary";

export interface RecentTranscriptRow {
  id: string;
  kind: RecentTranscriptRowKind;
  label: string;
  preview: string;
}

type RowBuilders = {
  [Type in DisplayedMessage["type"]]: (
    message: Extract<DisplayedMessage, { type: Type }>
  ) => RecentTranscriptRow | null;
};

/** One line per row type; rows with nothing to read (hidden counts, init logs) get none. */
const ROW_BUILDERS: RowBuilders = {
  user: (message) => ({
    id: message.id,
    kind: "user",
    // Machine-authored user rows (wakes, continuations) are Xum's, not the user's.
    label: isHumanUserMessage(message) ? "You" : "Xum",
    preview: oneLine(message.content),
  }),
  assistant: (message) => {
    // Another agent's message: name its sender and show its text, as the transcript's card does,
    // not this agent and the model-facing envelope.
    const peer = message.agentPeerMessage;
    if (peer != null) {
      const envelope = parseAgentMessageEnvelope(message.content);
      return {
        id: message.id,
        kind: "assistant",
        label: `From ${peer.fromTitle ?? peer.fromWorkspaceId}`,
        preview: oneLine(envelope?.message ?? message.content),
      };
    }
    return { id: message.id, kind: "assistant", label: "Agent", preview: oneLine(message.content) };
  },
  tool: (message) => ({
    id: message.id,
    kind: "tool",
    label: `${message.toolName} (${message.status})`,
    preview: toolCallDetail(message.args) ?? "",
  }),
  reasoning: (message) => ({
    id: message.id,
    kind: "reasoning",
    label: "Thinking",
    preview: oneLine(message.content),
  }),
  "stream-error": (message) => ({
    id: message.id,
    kind: "error",
    label: "Error",
    preview: oneLine(message.error),
  }),
  "plan-display": (message) => ({
    id: message.id,
    kind: "plan",
    label: "Plan",
    preview: oneLine(message.content),
  }),
  "compaction-boundary": (message) => ({
    id: message.id,
    kind: "boundary",
    label: "Context reset",
    preview: "",
  }),
  "history-hidden": () => null,
  "workspace-init": () => null,
};

function transcriptRow(message: DisplayedMessage): RecentTranscriptRow | null {
  // TypeScript cannot pair a union-keyed builder with its own variant; the mapped type does.
  const build = ROW_BUILDERS[message.type] as (row: DisplayedMessage) => RecentTranscriptRow | null;
  return build(message);
}

/** The newest `limit` transcript rows worth a line in the peek, oldest first. */
export function recentTranscriptRows(
  messages: readonly DisplayedMessage[],
  limit: number
): RecentTranscriptRow[] {
  const rows: RecentTranscriptRow[] = [];
  for (let index = messages.length - 1; index >= 0 && rows.length < limit; index--) {
    const row = transcriptRow(messages[index]);
    if (row != null) rows.push(row);
  }
  return rows.reverse();
}

/**
 * The agent's last reply that Start Here can start from: the newest settled assistant row with
 * text in the active context, the same rows AssistantMessage offers Start Here on. Peer message
 * payloads are another agent's words, not this agent's reply.
 */
export function findStartHereSource(
  messages: readonly DisplayedMessage[]
): Extract<DisplayedMessage, { type: "assistant" }> | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type !== "assistant") continue;
    if (message.isStreaming || message.agentPeerMessage != null) continue;
    if (message.content.trim() === "") continue;
    // Rows only get older from here: a compacted or pre-boundary row means no eligible reply.
    if (message.isCompacted || message.isBeforeLatestContextBoundary === true) return null;
    return message;
  }
  return null;
}
