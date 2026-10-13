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
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";

export interface CompactionInputTrim {
  messages: MuxMessage[];
  omittedToolResults: number;
  omittedTurns: number;
}

type Part = MuxMessage["parts"][number];

function omittedToolResultText(tokens: number): string {
  return `[Tool result omitted to fit the compaction request: about ${tokens} tokens]`;
}

function withoutReasoning(messages: MuxMessage[]): MuxMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !message.parts.some((p) => p.type === "reasoning")) {
      return [message];
    }
    const parts = message.parts.filter((part) => part.type !== "reasoning");
    // An assistant row with nothing left would reach the provider as an empty message.
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

function isOutputPart(part: Part): boolean {
  return part.type === "dynamic-tool" && part.state === "output-available";
}

/** The row with every tool result replaced by a placeholder; the same row when it has none. */
function withPlaceholderOutputs(message: MuxMessage): { message: MuxMessage; replaced: number } {
  let replaced = 0;
  const parts = message.parts.map((part): Part => {
    if (part.type !== "dynamic-tool" || part.state !== "output-available") return part;
    replaced += 1;
    const tokens = estimateMuxMessageTokens({ ...message, parts: [part] });
    // nestedCalls never reach the provider (convertToModelMessages reads input/output only),
    // but they count in the estimate, so drop them with the output.
    return { ...part, output: omittedToolResultText(tokens), nestedCalls: undefined };
  });
  return replaced === 0 ? { message, replaced } : { message: { ...message, parts }, replaced };
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
  readonly tokens: number[];
  total: number;
  /** Tool results replaced per row; rows of dropped turns do not count in the note. */
  readonly replaced: number[];

  constructor(rows: MuxMessage[]) {
    this.rows = [...rows];
    this.tokens = this.rows.map(estimateMuxMessageTokens);
    this.total = this.tokens.reduce((sum, value) => sum + value, 0);
    this.replaced = this.rows.map(() => 0);
  }

  /** Replace tool results in rows [from, to), oldest first, until the total fits. */
  placeholderOutputs(from: number, to: number, budget: number): void {
    for (let index = from; index < to && this.total > budget; index++) {
      if (!this.rows[index].parts.some(isOutputPart)) continue;
      const { message, replaced } = withPlaceholderOutputs(this.rows[index]);
      const tokens = estimateMuxMessageTokens(message);
      this.total += tokens - this.tokens[index];
      this.rows[index] = message;
      this.tokens[index] = tokens;
      this.replaced[index] = replaced;
    }
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

export function trimCompactionInput(
  messages: MuxMessage[],
  budgetTokens: number
): CompactionInputTrim {
  assert(Number.isFinite(budgetTokens) && budgetTokens > 0, "budgetTokens must be positive");
  const unchanged = { messages, omittedToolResults: 0, omittedTurns: 0 };
  const requestIndex = messages.findLastIndex((message) => message.role === "user");
  if (requestIndex <= 0) return unchanged;
  const total = messages.reduce((sum, message) => sum + estimateMuxMessageTokens(message), 0);
  if (total <= budgetTokens) return unchanged;

  // Reasoning removal can drop rows, so find the request and the turns again afterwards.
  const state = new TrimState(withoutReasoning(messages));
  const request = state.rows.findLastIndex((message) => message.role === "user");
  const starts = turnStarts(state.rows, request);
  const newestTurn = starts.at(-1) ?? request;
  state.placeholderOutputs(0, newestTurn, budgetTokens);
  const omittedTurns = state.dropOldestTurns(starts, budgetTokens);
  state.placeholderOutputs(newestTurn, request, budgetTokens);

  const keptFrom = starts[omittedTurns] ?? request;
  const omittedToolResults = state.replaced.reduce(
    (sum, count, index) =>
      index < (starts[0] ?? request) || index >= keptFrom ? sum + count : sum,
    0
  );
  const omitted = { omittedToolResults, omittedTurns };
  // Reasoning removal alone changes nothing the summary needs to know about.
  const changed = omittedTurns > 0 || omitted.omittedToolResults > 0;
  const kept = [
    ...state.rows.slice(0, starts[0] ?? request),
    ...state.rows.slice(keptFrom, request),
    changed ? appendOmissionNote(state.rows[request], omitted) : state.rows[request],
    ...state.rows.slice(request + 1),
  ];
  return { messages: kept, ...omitted };
}
