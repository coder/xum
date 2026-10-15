import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import type { MuxMessage, VolatileSystemTailRecord } from "@/common/types/message";
import { anthropicBindsThinkingToPrefix } from "@/common/types/thinking";
import { findLatestContextBoundaryIndex } from "@/common/utils/messages/compactionBoundary";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";

/**
 * Prompt-cache mechanism 10: the volatile system tail (hot memories, MCP warning, context-window
 * ids) ends the system prompt, and Anthropic puts the system prompt before the messages. So a
 * tail change rewrote the whole cached history, and its replayed thinking (bound to the prefix)
 * could 400.
 *
 * Rule: inside one context segment the system tail stays frozen at the value the segment first
 * sent. A later change goes into one `role: "system"` row right after the newest user message,
 * and the turn's assistant row records it (MuxMetadata.volatileSystemTail), so every rebuild
 * puts the row back at the same place and the next request extends the previous one.
 *
 * Old data and downgrades: a history without records behaves as before (the first turn sends
 * the live tail in the system prompt and records it). Nothing else is persisted, so an older
 * build loads the same chat.jsonl: it ignores the field, sends the live tail in the system
 * prompt and no rows (one cache rewrite, then the old behavior). Back on this build, the turns
 * the older build wrote carry no record, so the last record from before still decides: the
 * system tail returns to its frozen value and the rows return (one more rewrite). Thinking
 * produced under the older build's prefix can then cost one signature 400 and the usual strip
 * repair. Nothing bricks.
 */

/**
 * Routes and models that accept a mid-conversation system row after a user message. Anthropic
 * rejects one after an assistant message (live, Opus 5.5). Only direct Anthropic and the Coder
 * gateway send the Messages API body Xum builds; mux-gateway and OpenRouter convert it on
 * their side. The model list is the one that binds thinking to the prefix (a tail change also
 * breaks its thinking replay). Live through the Coder gateway (2026-10-15), Opus 5.5, Sonnet
 * 5.5, Haiku 5.5 and Fable 5.1 accepted the row after a user message, then with an assistant
 * row after it, and read the whole earlier request from the cache.
 */
export function acceptsVolatileSystemTailRow(
  modelString: string,
  routeProvider: string | undefined,
  providersConfig: ProvidersConfigMap | null | undefined
): boolean {
  if (routeProvider !== "anthropic" && routeProvider !== "coder") return false;
  return anthropicBindsThinkingToPrefix(
    resolveModelForMetadata(modelString, providersConfig ?? null)
  );
}

/** The record, or undefined when absent or corrupt (self-healing: a bad record is ignored). */
export function readVolatileSystemTailRecord(
  message: MuxMessage
): VolatileSystemTailRecord | undefined {
  const record: unknown = message.metadata?.volatileSystemTail;
  if (record == null || typeof record !== "object") return undefined;
  const { text, placement } = record as Record<string, unknown>;
  if (typeof text !== "string" || (placement !== "system" && placement !== "row")) return undefined;
  return { text, placement };
}

const ROW_HEADER =
  "Update: these volatile system sections replace the earlier ones (hot memories, MCP warning, context window).";

function systemRow(id: string, tail: string): MuxMessage {
  return {
    id,
    role: "system",
    // The tail starts with its own "\n\n" separator (never empty: see planVolatileSystemTail).
    parts: [{ type: "text", text: ROW_HEADER + tail }],
  };
}

export interface VolatileSystemTailPlan {
  /** The tail to send at the end of the system prompt. */
  systemTail: string;
  /** The history with the segment's recorded rows put back before their assistant rows. */
  messages: MuxMessage[];
  /** The row to append after the newest user message, if the tail changed. */
  appendedRow?: MuxMessage;
  /**
   * The text of every tail row the request sends (put back and appended). They exist only in
   * the request, so callers that size the history from its rows add them to the system size.
   */
  rowsText: string;
  /** What this turn's assistant row must record; undefined records nothing. */
  record?: VolatileSystemTailRecord;
}

/** The segment's recorded assistant rows (after the latest context boundary), in order. */
function readSegmentRecords(messages: MuxMessage[]): Array<[MuxMessage, VolatileSystemTailRecord]> {
  const records: Array<[MuxMessage, VolatileSystemTailRecord]> = [];
  for (const message of messages.slice(findLatestContextBoundaryIndex(messages) + 1)) {
    const record = message.role === "assistant" ? readVolatileSystemTailRecord(message) : undefined;
    if (record != null) records.push([message, record]);
  }
  return records;
}

/**
 * `messages` with each recorded row put back right before its assistant row. `lastTail` is
 * the tail of the last row put back (undefined when none was).
 */
function withRecordedRows(
  messages: MuxMessage[],
  records: Map<MuxMessage, VolatileSystemTailRecord>
): { messages: MuxMessage[]; rowsText: string; lastTail?: string } {
  let rowsText = "";
  let lastTail: string | undefined;
  const withRows = messages.flatMap((message, index) => {
    const record = records.get(message);
    // Anthropic rejects a system row after an assistant message: skip one that no longer
    // follows a user row (self-healing), rather than send a request that fails.
    if (record?.placement !== "row" || messages[index - 1]?.role !== "user") return [message];
    const row = systemRow(`${message.id}-volatile-tail`, record.text);
    rowsText += rowText(row);
    lastTail = record.text;
    return [row, message];
  });
  return { messages: withRows, rowsText, lastTail };
}

function rowText(row: MuxMessage): string {
  return row.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * The segment's frozen system tail and the rows recorded after it put back, or undefined
 * before a freeze (see planVolatileSystemTail). `appliedTail` is the tail the model already reads: the last row put back, else the frozen
 * one. Not the last record's: withRecordedRows can skip that row, and then the model never
 * reads it (a reasoning-only partial the empty-row filter dropped when the row was recorded
 * can come back between the user row and the row's assistant row on a thinking-on rebuild).
 */
function restoreFrozenSegment(
  messages: MuxMessage[]
): (Omit<VolatileSystemTailPlan, "appendedRow" | "record"> & { appliedTail: string }) | undefined {
  const records = readSegmentRecords(messages);
  const freeze = records.findLastIndex(([, record]) => record.placement === "system");
  if (freeze < 0) return undefined;
  const systemTail = records[freeze][1].text;
  const restored = withRecordedRows(messages, new Map(records.slice(freeze + 1)));
  return {
    systemTail,
    messages: restored.messages,
    rowsText: restored.rowsText,
    appliedTail: restored.lastTail ?? systemTail,
  };
}

/**
 * Replay only: the turn envelope records the system tail the request SENT (the frozen one), so
 * the live tail comes from the planner's own rules. A recorded change names it, and without a
 * record it equals the tail the request already applied (or the sent tail itself, before any
 * freeze).
 */
function replayedLiveTail(
  appliedTail: string | undefined,
  sentTail: string,
  turnRecord: VolatileSystemTailRecord | undefined
): string {
  return turnRecord?.text ?? appliedTail ?? sentTail;
}

/**
 * Where this request sends `liveTail`. `messages` are the rows the request sends (after the
 * boundary slice and the empty-row filter), so a dropped assistant row also drops its row.
 * Unsupported routes keep the old placement and ignore the records. Callers pass
 * rowsSupported=false for an empty or unsplittable tail, so `liveTail` is never empty here.
 *
 * The latest "system" record freezes the segment, and only rows recorded after it apply: each
 * says it replaces the earlier sections, so a row from before a re-freeze would override the
 * newer system tail. A re-freeze already rewrites the history (the system prompt changed), so
 * dropping those rows costs nothing more.
 */
export function planVolatileSystemTail(
  messages: MuxMessage[],
  requestTail: string,
  rowsSupported: boolean,
  /** Replay only: `requestTail` is the tail the turn sent, and this is the turn's record. */
  replayedTurn?: { record?: VolatileSystemTailRecord }
): VolatileSystemTailPlan {
  if (!rowsSupported) return { systemTail: requestTail, messages, rowsText: "" };
  assert(requestTail !== "", "a volatile-tail row needs a non-empty tail");
  const restored = restoreFrozenSegment(messages);
  const liveTail = replayedTurn
    ? replayedLiveTail(restored?.appliedTail, requestTail, replayedTurn.record)
    : requestTail;
  // Segment start (or a history from before this rule), or a re-freeze below: send as before,
  // with no earlier rows, and freeze here.
  const asBefore: VolatileSystemTailPlan = {
    systemTail: liveTail,
    messages,
    rowsText: "",
    record: { text: liveTail, placement: "system" },
  };
  if (restored == null) return asBefore;
  const { appliedTail, ...withRows } = restored;
  if (liveTail === appliedTail) return withRows;
  // A row must follow a user message. Otherwise (a resume after an assistant row) send the new
  // tail as before, which re-freezes the segment at it.
  if (messages.at(-1)?.role !== "user") return asBefore;
  const appendedRow = systemRow("volatile-tail-pending", liveTail);
  return {
    ...withRows,
    rowsText: withRows.rowsText + rowText(appendedRow),
    appendedRow,
    record: { text: liveTail, placement: "row" },
  };
}
