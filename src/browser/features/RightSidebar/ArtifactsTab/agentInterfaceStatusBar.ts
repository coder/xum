import type { HeldInput } from "@/common/orpc/types";
import type { DisplayedMessage, DisplayedUserMessage, QueuedMessage } from "@/common/types/message";

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
  /** The backend's startup breadcrumb (runtime readiness, tool loading), as StreamingBarrier shows it. */
  runtimeDetail?: string | null;
}

/**
 * What the agent is doing right now. While a turn streams, the current turn's rows (after the
 * last user row) decide: a running tool call beats streaming reasoning, which beats reply text,
 * so a turn that runs parallel tools keeps naming a tool while one still runs.
 */
export function deriveStatusActivity(
  messages: readonly DisplayedMessage[],
  flags: StatusActivityFlags
): StatusActivity {
  if (flags.isStreamStarting) {
    return { kind: "starting", label: flags.runtimeDetail ?? "Starting…" };
  }
  if (flags.isCompacting) return { kind: "compacting", label: "Compacting context…" };
  if (flags.awaitingUserQuestion) return { kind: "question", label: "Waiting for your answer" };
  if (!flags.canInterrupt) {
    return messages.at(-1)?.type === "stream-error"
      ? { kind: "error", label: "Stopped with an error" }
      : { kind: "idle", label: "Idle" };
  }

  let thinking = false;
  let writing = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === "user") break;
    if (
      message.type === "tool" &&
      (message.status === "pending" || message.status === "executing")
    ) {
      return {
        kind: "tool",
        label: `Running ${message.toolName}`,
        detail: toolCallDetail(message.args),
      };
    }
    if (message.type === "reasoning" && message.isStreaming) thinking = true;
    if (message.type === "assistant" && message.isStreaming) writing = true;
  }
  if (thinking) return { kind: "thinking", label: "Thinking…" };
  if (writing) return { kind: "writing", label: "Writing a reply…" };
  return { kind: "working", label: "Working…" };
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
}

function previewOrPlaceholder(text: string): string {
  return oneLine(text) || "(no text)";
}

/**
 * Where the user's latest message is. A queued or held message is always newer than every
 * transcript row (neither is in history yet), so it wins over the newest human row.
 */
export function deriveLastMessageReceipt(
  messages: readonly DisplayedMessage[],
  queuedMessage: QueuedMessage | null,
  heldInputs: readonly HeldInput[]
): LastMessageReceipt | null {
  if (queuedMessage != null) {
    return { state: "queued", preview: previewOrPlaceholder(queuedMessage.content) };
  }
  const held = heldInputs.at(-1);
  if (held != null) return { state: "held", preview: previewOrPlaceholder(held.displayText) };
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

function transcriptRow(message: DisplayedMessage): RecentTranscriptRow | null {
  switch (message.type) {
    case "user":
      return {
        id: message.id,
        kind: "user",
        // Machine-authored user rows (wakes, continuations) are Xum's, not the user's.
        label: isHumanUserMessage(message) ? "You" : "Xum",
        preview: oneLine(message.content),
      };
    case "assistant":
      return {
        id: message.id,
        kind: "assistant",
        label: "Agent",
        preview: oneLine(message.content),
      };
    case "tool":
      return {
        id: message.id,
        kind: "tool",
        label: `${message.toolName} (${message.status})`,
        preview: toolCallDetail(message.args) ?? "",
      };
    case "reasoning":
      return {
        id: message.id,
        kind: "reasoning",
        label: "Thinking",
        preview: oneLine(message.content),
      };
    case "stream-error":
      return { id: message.id, kind: "error", label: "Error", preview: oneLine(message.error) };
    case "plan-display":
      return { id: message.id, kind: "plan", label: "Plan", preview: oneLine(message.content) };
    case "compaction-boundary":
      return { id: message.id, kind: "boundary", label: "Context reset", preview: "" };
    case "history-hidden":
    case "workspace-init":
      return null;
  }
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
