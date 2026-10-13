/**
 * Fit a compaction request's input into the compaction model's context window.
 *
 * A compaction request skips the request-time context check (turnRequestBuilder
 * tokenBudgetEnabled) and summarizes the whole history from the latest boundary. Since #6268
 * the request replays long tool results in full, so it can exceed the window, and only
 * GPT-class and Anthropic-1M models had a retry. This trims a request-only copy instead:
 *
 * 1. Drop reasoning parts. Anthropic binds thinking signatures to the prefix, so any change
 *    below would make later thinking blocks invalid; the summary does not need them.
 * 2. Replace the oldest tool results with size placeholders. The call and a result stay, so
 *    every tool_use / function_call still has its result (Anthropic and OpenAI need the pair).
 * 3. Drop the oldest whole turns. A turn starts at a user row after a non-user row, so a cut
 *    never splits an assistant row from its tool results or a snapshot cluster from its turn.
 * 4. Replace tool results of the newest turn, as a last resort.
 *
 * Rows before the first turn (a previous summary), the newest turn and the compaction-request
 * row (the last user row) are never dropped. A history under the budget comes back as the same
 * array, so a normal compaction request stays byte-identical. The result can still be over the
 * budget (for example a huge user message): the caller sends it, and the context_exceeded retry
 * runs with half the budget.
 */
import type { MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import {
  estimateCompactionRowTokens,
  type CountCompactionRowTokens,
} from "@/common/utils/messages/compactionRowSizing";

export interface CompactionInputTrim {
  messages: MuxMessage[];
  omittedToolResults: number;
  omittedTurns: number;
}

type Part = MuxMessage["parts"][number];

/** The size trimCompactionInput fits to a budget, for a whole history. */
export async function estimateCompactionInputTokens(
  messages: MuxMessage[],
  countRow: CountCompactionRowTokens = estimateCompactionRowTokens
): Promise<number> {
  const counts = await Promise.all(messages.map(async (message) => countRow(message)));
  return counts.reduce((sum, count) => sum + count, 0);
}

function omittedToolResultText(tokens: number): string {
  return `[Tool result omitted to fit the compaction request: about ${tokens} tokens]`;
}

/**
 * Step start indices after removing the parts where `kept` is false. Each step starts at its
 * first kept part, a step with none left disappears, and the first kept part is always 0, so
 * the list stays strictly ascending from 0 (insertStepStartPartsForSdk trusts only that shape).
 * A list of other values is corrupted history: returned as is, and the SDK helper ignores it.
 */
function rebaseStepStarts(starts: unknown, kept: boolean[]): unknown {
  const isIndexList = Array.isArray(starts) && starts.every((start) => Number.isSafeInteger(start));
  return isIndexList ? rebaseIndexList(starts as number[], kept) : starts;
}

function rebaseIndexList(starts: number[], kept: boolean[]): number[] {
  // newIndex[i]: how many kept parts come before part i.
  const newIndex: number[] = [];
  let count = 0;
  for (const keep of kept) {
    newIndex.push(count);
    if (keep) count += 1;
  }
  const rebased: number[] = [];
  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : kept.length;
    const first = kept.findIndex((keep, index) => keep && index >= start && index < end);
    if (first !== -1) rebased.push(newIndex[first]);
  });
  return rebased;
}

function withoutReasoning(messages: MuxMessage[]): MuxMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !message.parts.some((p) => p.type === "reasoning")) {
      return [message];
    }
    const kept = message.parts.map((part) => part.type !== "reasoning");
    const parts = message.parts.filter((_part, index) => kept[index]);
    // A row with nothing left stays (empty) until the end, so turn boundaries are the ones of
    // the original rows: removing it would join the user rows around it into one turn that is
    // never dropped. trimOverBudget leaves empty rows out of the result.
    if (parts.length === 0) return [{ ...message, parts }];
    const starts = message.metadata?.stepStartPartIndices;
    // The persisted step boundaries index into parts: rebase them onto the parts that remain,
    // or the SDK would split the replayed steps at the wrong places.
    const metadata =
      starts === undefined || message.metadata == null
        ? message.metadata
        : {
            ...message.metadata,
            stepStartPartIndices: rebaseStepStarts(starts, kept) as number[],
          };
    return [{ ...message, parts, metadata }];
  });
}

function isOutputPart(part: Part): boolean {
  return part.type === "dynamic-tool" && part.state === "output-available";
}

/** The row with the tool result at `partIndex` replaced by a size placeholder. */
async function withPlaceholderOutput(
  message: MuxMessage,
  partIndex: number,
  countRow: CountCompactionRowTokens
): Promise<MuxMessage> {
  const part = message.parts[partIndex];
  assert(part.type === "dynamic-tool" && part.state === "output-available", "not a tool result");
  const tokens = await countRow({ ...message, parts: [part] });
  // nestedCalls never reach the provider (convertToModelMessages reads input/output only),
  // but they count in the estimate, so drop them with the output.
  const placeholder: Part = {
    ...part,
    output: omittedToolResultText(tokens),
    nestedCalls: undefined,
  };
  const parts = message.parts.map((existing, index) =>
    index === partIndex ? placeholder : existing
  );
  return { ...message, parts };
}

/** Start indices of the turns before `end`: user rows that follow a non-user row. */
function turnStarts(messages: MuxMessage[], end: number): number[] {
  const starts: number[] = [];
  for (let index = 0; index < end; index++) {
    if (messages[index].role === "user" && messages[index - 1]?.role !== "user") {
      starts.push(index);
    }
  }
  return starts;
}

class TrimState {
  readonly rows: MuxMessage[];
  /** Each row's count; a row the trim changes is counted again (replaceOutput). */
  readonly tokens: number[];
  total: number;
  /** Tool results replaced per row; rows of dropped turns do not count in the note. */
  readonly replaced: number[];

  private constructor(
    rows: MuxMessage[],
    tokens: number[],
    private readonly countRow: CountCompactionRowTokens
  ) {
    this.rows = rows;
    this.tokens = tokens;
    this.total = tokens.reduce((sum, value) => sum + value, 0);
    this.replaced = rows.map(() => 0);
  }

  static async create(rows: MuxMessage[], countRow: CountCompactionRowTokens) {
    const tokens = await Promise.all(rows.map(async (row) => countRow(row)));
    return new TrimState([...rows], tokens, countRow);
  }

  /**
   * Replace tool results in rows [from, to), oldest first and one result at a time, until the
   * total fits: a row with several results keeps the ones the budget has room for.
   */
  async placeholderOutputs(from: number, to: number, budget: number): Promise<void> {
    for (let index = from; index < to && this.total > budget; index++) {
      for (let part = 0; part < this.rows[index].parts.length && this.total > budget; part++) {
        if (isOutputPart(this.rows[index].parts[part])) await this.replaceOutput(index, part);
      }
    }
  }

  /**
   * Replace one result, and count its row again: a count derived from the old row would
   * misjudge what remains (a dense text next to a large sparse result). A placeholder that is
   * not smaller than its result (`true`, "ok") is not applied: it would grow the request.
   */
  private async replaceOutput(index: number, part: number): Promise<void> {
    const message = await withPlaceholderOutput(this.rows[index], part, this.countRow);
    const tokens = await this.countRow(message);
    if (tokens >= this.tokens[index]) return;
    this.total += tokens - this.tokens[index];
    this.rows[index] = message;
    this.tokens[index] = tokens;
    this.replaced[index] += 1;
  }

  /** Count the oldest turns (of `starts`, never the newest) to leave out until the total fits. */
  dropOldestTurns(starts: number[], budget: number): number {
    let dropped = 0;
    while (this.total > budget && dropped < starts.length - 1) {
      for (let index = starts[dropped]; index < starts[dropped + 1]; index++) {
        this.total -= this.tokens[index];
      }
      dropped += 1;
    }
    return dropped;
  }
}

/** An assistant row with nothing left would reach the provider as an empty message. */
function isSendableRow(row: MuxMessage): boolean {
  return row.role !== "assistant" || row.parts.length > 0;
}

function appendOmissionNote(request: MuxMessage, trim: Omit<CompactionInputTrim, "messages">) {
  const note =
    `[Compaction input trimmed to fit the context window: ${trim.omittedTurns} oldest turns ` +
    `were left out and ${trim.omittedToolResults} tool results were replaced by size ` +
    "placeholders. Summarize what remains, and say in the summary that earlier history was " +
    "left out.]";
  // Append inside the last text part: mergeConsecutiveUserMessages keeps one text part per
  // message, so a separate note part could be dropped (see tagUserRowsWithHistoryItemIds).
  const lastText = request.parts.findLastIndex((part) => part.type === "text");
  const parts: Part[] =
    lastText === -1
      ? [...request.parts, { type: "text", text: note }]
      : request.parts.map((part, index) =>
          index === lastText && part.type === "text"
            ? { ...part, text: `${part.text}\n\n${note}` }
            : part
        );
  return { ...request, parts };
}

/**
 * `countRow` sizes one row (compactionRowSizing.ts). The node caller counts with the model's
 * tokenizer; the default counts chars/4. Each row is counted once, then again only when the
 * trim changes it.
 */
export async function trimCompactionInput(
  messages: MuxMessage[],
  budgetTokens: number,
  countRow: CountCompactionRowTokens = estimateCompactionRowTokens
): Promise<CompactionInputTrim> {
  assert(Number.isFinite(budgetTokens) && budgetTokens > 0, "budgetTokens must be positive");
  const requestIndex = messages.findLastIndex((message) => message.role === "user");
  if (requestIndex <= 0) return { messages, omittedToolResults: 0, omittedTurns: 0 };
  // Rows reasoning removal leaves as they are reuse their first count.
  const counted = new Map<MuxMessage, number>();
  const countOnce = async (row: MuxMessage) => {
    const cached = counted.get(row);
    if (cached != null) return cached;
    const tokens = await countRow(row);
    counted.set(row, tokens);
    return tokens;
  };
  if ((await estimateCompactionInputTokens(messages, countOnce)) <= budgetTokens) {
    return { messages, omittedToolResults: 0, omittedTurns: 0 };
  }
  return trimOverBudget(
    await TrimState.create(withoutReasoning(messages), countOnce),
    budgetTokens
  );
}

/** Phases 2-4 on a history already over the budget and without reasoning. */
async function trimOverBudget(
  state: TrimState,
  budgetTokens: number
): Promise<CompactionInputTrim> {
  // Reasoning removal keeps every row (emptied ones too), so these are the original indices.
  const request = state.rows.findLastIndex((message) => message.role === "user");
  const starts = turnStarts(state.rows, request);
  const firstTurn = starts[0] ?? request;
  const newestTurn = starts.at(-1) ?? request;
  await state.placeholderOutputs(0, newestTurn, budgetTokens);
  const omittedTurns = state.dropOldestTurns(starts, budgetTokens);
  await state.placeholderOutputs(newestTurn, request, budgetTokens);

  const keptFrom = starts[omittedTurns] ?? request;
  const isKept = (index: number) => index < firstTurn || index >= keptFrom;
  const omittedToolResults = state.replaced.reduce(
    (sum, count, index) => (isKept(index) ? sum + count : sum),
    0
  );
  const omitted = { omittedToolResults, omittedTurns };
  // Reasoning removal alone changes nothing the summary needs to know about.
  const changed = omittedTurns > 0 || omittedToolResults > 0;
  const kept = [
    ...state.rows.slice(0, firstTurn),
    ...state.rows.slice(keptFrom, request),
    changed ? appendOmissionNote(state.rows[request], omitted) : state.rows[request],
    ...state.rows.slice(request + 1),
  ];
  return { messages: kept.filter(isSendableRow), ...omitted };
}
