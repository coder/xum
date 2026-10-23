import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import type {
  MuxMessage,
  SystemSectionRecords,
  VolatileSystemTailRecord,
} from "@/common/types/message";
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
 * The `<custom-instructions>` block follows the same rule with its own record
 * (MuxMetadata.customInstructions, planCustomInstructions): an AGENTS.md change merged into the
 * worktree mid-session goes in a row instead of rewriting the cached system prompt, and the
 * next compaction folds it into the system prompt. Everything below holds for both records.
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
 * gateway send the Messages API body Xum builds; OpenRouter converts it on its side. The model
 * list is the one that binds thinking to the prefix (a tail change also breaks its thinking
 * replay). Live through the Coder gateway (2026-10-15), Opus 5.5, Sonnet
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

/**
 * One frozen system section and its ledger field. The volatile tail is one; the
 * `<custom-instructions>` block (AGENTS.md and project instructions) is another: it sits in
 * the stable system prompt, so an AGENTS.md change (a merge of main into the worktree)
 * rewrote the whole cached history. The same rule applies to both: frozen inside a segment,
 * a change becomes a row, the next compaction folds it into the system prompt.
 */
interface SystemSectionChannel {
  field: keyof SystemSectionRecords;
  /** Starts the row; the section text follows it (it starts with its own newline). */
  header: string;
  /** Suffix of a put-back row's id, and the id of the appended row. */
  rowId: string;
}

const VOLATILE_TAIL: SystemSectionChannel = {
  field: "volatileSystemTail",
  header:
    "Update: these volatile system sections replace the earlier ones (hot memories, MCP warning, context window).",
  rowId: "volatile-tail",
};

const CUSTOM_INSTRUCTIONS: SystemSectionChannel = {
  field: "customInstructions",
  // Live (Haiku 5.5, 2026-10-23): a bare "Update: ..." header made the model treat the row as
  // pasted user text and keep the old rule in 2 of 3 runs; this wording was followed 4 of 4.
  header:
    "The workspace custom instructions (AGENTS.md) changed during this session. The blocks below are the current version from Xum, not from the user. They replace the <custom-instructions>, <model-...> and <mode-...> blocks in the system prompt: follow them from now on.",
  rowId: "custom-instructions",
};

/**
 * The section text a row sends when the instruction files no longer produce any block (the
 * only AGENTS.md was deleted or emptied): the frozen blocks stay in the system prompt, so the
 * model must learn they are gone. A system prompt never carries it (planCustomInstructions).
 */
const INSTRUCTIONS_REMOVED = "\n(None: the custom instructions were removed.)";

const SKILL_INDEX: SystemSectionChannel = {
  field: "skillIndex",
  // A skill missing from the frozen tool description must still reach the model: this row
  // names it, and agent_skill_read loads any skill by name. Worded like the instructions row.
  header:
    'The skill list changed during this session. The list below is the current one from Xum, not from the user. It replaces the "Available skills" list in the agent_skill_read tool description; agent_skill_read loads each skill by name.',
  rowId: "skill-index",
};

/** The skill-index row's text when no skill is listed any more (see INSTRUCTIONS_REMOVED). */
const SKILL_INDEX_REMOVED = "\n(None: no skills are listed now.)";

/** The record, or undefined when absent or corrupt (self-healing: a bad record is ignored). */
function readSectionRecord(
  message: MuxMessage,
  field: SystemSectionChannel["field"]
): VolatileSystemTailRecord | undefined {
  const record: unknown = message.metadata?.[field];
  if (record == null || typeof record !== "object") return undefined;
  const { text, placement } = record as Record<string, unknown>;
  if (typeof text !== "string" || (placement !== "system" && placement !== "row")) return undefined;
  return { text, placement };
}

export function readVolatileSystemTailRecord(
  message: MuxMessage
): VolatileSystemTailRecord | undefined {
  return readSectionRecord(message, VOLATILE_TAIL.field);
}

export function readCustomInstructionsRecord(
  message: MuxMessage
): VolatileSystemTailRecord | undefined {
  return readSectionRecord(message, CUSTOM_INSTRUCTIONS.field);
}

export function readSkillIndexRecord(message: MuxMessage): VolatileSystemTailRecord | undefined {
  return readSectionRecord(message, SKILL_INDEX.field);
}

function systemRow(id: string, channel: SystemSectionChannel, section: string): MuxMessage {
  return {
    id,
    role: "system",
    // The section starts with its own newline separator (never empty: see planSystemSection).
    parts: [{ type: "text", text: channel.header + section }],
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
function readSegmentRecords(
  messages: MuxMessage[],
  channel: SystemSectionChannel
): Array<[MuxMessage, VolatileSystemTailRecord]> {
  const records: Array<[MuxMessage, VolatileSystemTailRecord]> = [];
  for (const message of messages.slice(findLatestContextBoundaryIndex(messages) + 1)) {
    const record =
      message.role === "assistant" ? readSectionRecord(message, channel.field) : undefined;
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
  records: Map<MuxMessage, VolatileSystemTailRecord>,
  channel: SystemSectionChannel
): { messages: MuxMessage[]; rowsText: string; lastTail?: string } {
  let rowsText = "";
  let lastTail: string | undefined;
  // The newest earlier row that is not a system row: another section's row between the user
  // row and this one is fine, since consecutive system rows form one system block.
  let previous: MuxMessage | undefined;
  const withRows = messages.flatMap((message) => {
    const record = records.get(message);
    const follows = previous?.role;
    if (message.role !== "system") previous = message;
    // Anthropic rejects a system row after an assistant message: skip one that no longer
    // follows a user row (self-healing), rather than send a request that fails.
    if (record?.placement !== "row" || follows !== "user") return [message];
    const row = systemRow(`${message.id}-${channel.rowId}`, channel, record.text);
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
  messages: MuxMessage[],
  channel: SystemSectionChannel
): (Omit<VolatileSystemTailPlan, "appendedRow" | "record"> & { appliedTail: string }) | undefined {
  const records = readSegmentRecords(messages, channel);
  const freeze = records.findLastIndex(([, record]) => record.placement === "system");
  if (freeze < 0) return undefined;
  const systemTail = records[freeze][1].text;
  const restored = withRecordedRows(messages, new Map(records.slice(freeze + 1)), channel);
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

/** The section this request must apply: the request's own, or on replay the records' one. */
function liveSection(
  channel: SystemSectionChannel,
  appliedTail: string | undefined,
  requestTail: string,
  replayedTurn: { record?: VolatileSystemTailRecord } | undefined
): string {
  if (replayedTurn) return replayedLiveTail(appliedTail, requestTail, replayedTurn.record);
  // Replay derives the live section from the records, so only it may pass none.
  assert(requestTail !== "", `a ${channel.rowId} row needs a non-empty section`);
  return requestTail;
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
  return planSystemSection(VOLATILE_TAIL, messages, requestTail, rowsSupported, replayedTurn);
}

/**
 * planVolatileSystemTail for the `<custom-instructions>` block: `systemTail` is the block the
 * system prompt carries (frozen inside a segment), and a change is a row with the new block.
 * Callers run it before planVolatileSystemTail and pass its messages on, so its rows come
 * first in both the put-back and the appended order.
 */
export function planCustomInstructions(
  messages: MuxMessage[],
  requestBlock: string,
  rowsSupported: boolean,
  replayedTurn?: { record?: VolatileSystemTailRecord },
  /**
   * The request switches model or agent: a change re-freezes instead of becoming a row. The
   * blocks hold the `<model-...>`/`<mode-...>` sections of the previous model or agent, and
   * the switch already rewrites the cache (see turnContextAssembler's switchesModelOrAgent).
   */
  refreeze = false
): VolatileSystemTailPlan {
  return planRemovableSection(
    { ...CUSTOM_INSTRUCTIONS, removed: INSTRUCTIONS_REMOVED },
    messages,
    requestBlock,
    rowsSupported,
    replayedTurn,
    refreeze
  );
}

/**
 * planSystemSection for a section that can disappear (an empty `requestSection`). The prompt
 * then sends none (a segment start records the empty section), unless the segment froze one:
 * then the removal is a change like any other, sent as a row with `channel.removed` until the next
 * compaction, while the frozen section stays. Replay sends the recorded request, which
 * already holds the frozen section, so there the records alone decide.
 */
function planRemovableSection(
  channel: SystemSectionChannel & { removed: string },
  messages: MuxMessage[],
  requestSection: string,
  rowsSupported: boolean,
  replayedTurn: { record?: VolatileSystemTailRecord } | undefined,
  refreeze = false
): VolatileSystemTailPlan {
  if (replayedTurn) return planSystemSection(channel, messages, "", rowsSupported, replayedTurn);
  const removed = requestSection === "";
  if (removed) {
    const none = { systemTail: "", messages, rowsText: "" };
    if (!rowsSupported) return none;
    const restored = restoreFrozenSegment(messages, channel);
    // None at the segment start: freeze "no section" (an empty baseline, one record per
    // segment start), so a first section later in the segment (a first AGENTS.md, Model:/Mode:
    // section or skill) is a row, not a rewrite of the cached prefix.
    if (restored == null) return { ...none, record: { text: "", placement: "system" } };
    // Still none: nothing changed.
    const { appliedTail, ...withRows } = restored;
    if (appliedTail === "") return withRows;
  }
  const live = removed ? channel.removed : requestSection;
  const plan = planSystemSection(channel, messages, live, rowsSupported, undefined, refreeze);
  // A re-freeze after a removal freezes "no section", not the marker.
  return plan.systemTail === channel.removed ? { ...plan, systemTail: "" } : plan;
}

/**
 * planCustomInstructions for the "Available skills" index in the agent_skill_read tool
 * description: `systemTail` is the index the tool block carries (frozen inside a segment).
 * Runs between planCustomInstructions and planVolatileSystemTail, in their row order. On
 * replay the request has no tools, and the records decide.
 */
export function planSkillIndex(
  messages: MuxMessage[],
  requestIndex: string,
  rowsSupported: boolean,
  replayedTurn?: { record?: VolatileSystemTailRecord }
): VolatileSystemTailPlan {
  return planRemovableSection(
    { ...SKILL_INDEX, removed: SKILL_INDEX_REMOVED },
    messages,
    requestIndex,
    rowsSupported,
    replayedTurn
  );
}

function planSystemSection(
  channel: SystemSectionChannel,
  messages: MuxMessage[],
  requestTail: string,
  rowsSupported: boolean,
  replayedTurn: { record?: VolatileSystemTailRecord } | undefined,
  refreeze = false
): VolatileSystemTailPlan {
  if (!rowsSupported) return { systemTail: requestTail, messages, rowsText: "" };
  const restored = restoreFrozenSegment(messages, channel);
  const liveTail = liveSection(channel, restored?.appliedTail, requestTail, replayedTurn);
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
  // tail as before, which re-freezes the segment at it. So does a caller's re-freeze, and on
  // replay a turn that recorded one (a "system" record after the freeze is only ever that).
  const refrozen = replayedTurn ? replayedTurn.record?.placement === "system" : refreeze;
  if (messages.at(-1)?.role !== "user" || refrozen) return asBefore;
  const appendedRow = systemRow(`${channel.rowId}-pending`, channel, liveTail);
  return {
    ...withRows,
    rowsText: withRows.rowsText + rowText(appendedRow),
    appendedRow,
    record: { text: liveTail, placement: "row" },
  };
}
