import type { ProvidersConfigMap } from "@/common/orpc/types";
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
function readRecord(message: MuxMessage): VolatileSystemTailRecord | undefined {
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
    // The tail starts with its own "\n\n" separator; an empty tail means every section is gone.
    parts: [
      { type: "text", text: ROW_HEADER + (tail === "" ? "\n\nNone are present now." : tail) },
    ],
  };
}

export interface VolatileSystemTailPlan {
  /** The tail to send at the end of the system prompt. */
  systemTail: string;
  /** The history with the segment's recorded rows put back before their assistant rows. */
  messages: MuxMessage[];
  /** The row to append after the newest user message, if the tail changed. */
  appendedRow?: MuxMessage;
  /** What this turn's assistant row must record; undefined records nothing. */
  record?: VolatileSystemTailRecord;
}

/**
 * Where this request sends `liveTail`. `messages` are the rows the request sends (after the
 * boundary slice and the empty-row filter), so a dropped assistant row also drops its row.
 * Unsupported routes keep the old placement and ignore the records.
 */
export function planVolatileSystemTail(
  messages: MuxMessage[],
  liveTail: string,
  rowsSupported: boolean
): VolatileSystemTailPlan {
  if (!rowsSupported) return { systemTail: liveTail, messages };
  const segmentStart = findLatestContextBoundaryIndex(messages) + 1;
  let frozen: string | undefined;
  let lastSent: string | undefined;
  const withRows: MuxMessage[] = [];
  messages.forEach((message, index) => {
    const record =
      index >= segmentStart && message.role === "assistant" ? readRecord(message) : undefined;
    if (record?.placement === "system") frozen = record.text;
    // Anthropic rejects a system row after an assistant message: skip one that no longer
    // follows a user row (self-healing), rather than send a request that fails.
    if (record?.placement === "row" && withRows.at(-1)?.role === "user") {
      withRows.push(systemRow(`${message.id}-volatile-tail`, record.text));
    }
    if (record != null) lastSent = record.text;
    withRows.push(message);
  });

  // Segment start (or a history from before this rule): send as before and freeze here.
  if (frozen === undefined) {
    return {
      systemTail: liveTail,
      messages: withRows,
      record: { text: liveTail, placement: "system" },
    };
  }
  if (liveTail === lastSent) return { systemTail: frozen, messages: withRows };
  // A row must follow a user message. Otherwise (a resume after an assistant row) send the new
  // tail as before, which re-freezes the segment at it.
  if (messages.at(-1)?.role !== "user") {
    return {
      systemTail: liveTail,
      messages: withRows,
      record: { text: liveTail, placement: "system" },
    };
  }
  return {
    systemTail: frozen,
    messages: withRows,
    appendedRow: systemRow("volatile-tail-pending", liveTail),
    record: { text: liveTail, placement: "row" },
  };
}
