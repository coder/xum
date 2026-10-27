import assert from "@/common/utils/assert";
import {
  getContextBudgetHardCeiling,
  prepareAssembledRequestTokenCount,
  prepareBudgetTokenCount,
  prepareFreshRequestTokenCount,
  type AssembledRequestBudgetInput,
  type BudgetTokenCountInput,
  type ContextBudgetExceeded,
  type FreshRequestBudgetInput,
} from "@/common/utils/compaction/contextBudget";
import {
  BUDGET_TOKEN_COUNT_CHUNK_CHARS,
  BUDGET_TOKEN_CHUNK_SLACK,
  REQUEST_FRAMING_TOKENS,
} from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { isTrustedStepStartList } from "@/common/utils/messages/stepStartPartIndices";
import {
  getPromptTokens,
  readUsageTokens,
  type AiSdkUsageLike,
} from "@/common/utils/tokens/usageHelpers";
import { countToolReferences } from "@/common/utils/tools/toolCatalog";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import {
  CLAUDE_ENCODING_BUDGET_FACTOR,
  CLAUDE_TOOL_OVERHEAD_TOKENS,
  CLAUDE_TOOL_PREAMBLE_TOKENS,
} from "@/constants/tokenizerCorrection";

interface BudgetModel {
  model: string;
  metadataModel?: string;
}

/**
 * Real encoding, not exact vendor accounting: fallback families/media remain estimates.
 * Oversized strings use codepoint-safe chunks to bound long-run BPE work; short strings
 * take one direct count. Extra chunk framing and the old estimate guard against drift.
 */
async function countBudgetInput(
  input: BudgetTokenCountInput,
  model: BudgetModel,
  framing: number,
  ceiling?: number,
  toolCount = 0
): Promise<number> {
  const tokenizer = await getTokenizerForModel(model.model, model.metadataModel, {
    requireRealEncoding: true,
  });
  assert(tokenizer.encoding !== "approx-4", "A hard budget guard requires a real encoding");
  // The local `claude` encoding under-counts newer Claude tokenizers by up to ~1.55x (#5219), so
  // every claude-encoded count is scaled by one measured factor and pays Anthropic's tool-use
  // framing. Older Claude models are over-counted on purpose; see tokenizerCorrection.ts.
  const claude = tokenizer.encoding === "claude";
  const factor = claude ? CLAUDE_ENCODING_BUDGET_FACTOR : 1;
  const toolFraming =
    claude && toolCount > 0
      ? CLAUDE_TOOL_PREAMBLE_TOKENS + CLAUDE_TOOL_OVERHEAD_TOKENS * toolCount
      : 0;
  // The factor scales encoded text only: fixedTokens already charges one token per omitted byte.
  const textEstimate = (count: number) => Math.ceil(count * factor) + input.fixedTokens + framing;
  let encoded = 0;
  let chunks = 0;
  for (let start = 0; start < input.text.length; ) {
    let end = Math.min(input.text.length, start + BUDGET_TOKEN_COUNT_CHUNK_CHARS);
    const last = input.text.charCodeAt(end - 1);
    if (end < input.text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    const count = await tokenizer.countTokens(input.text.slice(start, end));
    assert(Number.isSafeInteger(count) && count >= 0, "Invalid encoded budget count");
    encoded += count + (chunks > 0 ? BUDGET_TOKEN_CHUNK_SLACK : 0);
    chunks += 1;
    // This early exit returns a lower bound, not an exact request size.
    if (ceiling != null && textEstimate(encoded) + toolFraming > ceiling) return ceiling + 1;
    start = end;
  }
  // Retain existing conservative ASCII estimates while correcting token-dense text.
  // Encoding failures propagate; never fall back silently to chars-per-token.
  // Tool framing is provider overhead neither text measure contains, so it is added after both.
  return Math.max(input.heuristicTokens, textEstimate(encoded)) + toolFraming;
}

export function estimateFreshRequestTokensForModel(
  input: FreshRequestBudgetInput,
  model: BudgetModel
): Promise<number> {
  return countBudgetInput(
    prepareFreshRequestTokenCount(input),
    model,
    REQUEST_FRAMING_TOKENS,
    input.modelContextLimit == null
      ? undefined
      : getContextBudgetHardCeiling(input.modelContextLimit)
  );
}

export function estimateToolResultTokensForModel(
  output: unknown,
  model: BudgetModel
): Promise<number> {
  return countBudgetInput(prepareBudgetTokenCount(output), model, REQUEST_FRAMING_TOKENS);
}

/**
 * The assembled-request estimate the per-step preflight enforces. Above the hard ceiling the
 * count stops early and returns a lower bound (ceiling + 1), not the exact request size.
 * Undefined when the model has no usable context limit.
 */
export async function estimateAssembledRequestTokensForModel(
  payload: AssembledRequestBudgetInput,
  options: BudgetModel & {
    modelContextLimit: number | null | undefined;
    activeTools?: readonly string[];
  }
): Promise<{ estimate: number; hardCeiling: number } | undefined> {
  const limit = options.modelContextLimit;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return undefined;
  const hardCeiling = getContextBudgetHardCeiling(limit);
  // activeTools scopes provider advertisement, not the executable tool registry.
  const tools =
    options.activeTools == null
      ? payload.tools
      : Object.fromEntries(
          options.activeTools.flatMap((name) =>
            payload.tools && name in payload.tools ? [[name, payload.tools[name]]] : []
          )
        );
  // Anthropic expands every tool_reference into the full definition, repeats included (#5413).
  // The loaded tool list holds each referenced tool once, so each further reference (or a
  // reference to a tool the list omits) pays its schema again, one single-tool record each.
  const repeats = [...countToolReferences(payload.messages)].flatMap(([name, count]) => {
    const tool = payload.tools && Object.hasOwn(payload.tools, name) ? payload.tools[name] : null;
    const charged = tools != null && Object.hasOwn(tools, name) ? 1 : 0;
    return tool == null ? [] : Array.from({ length: count - charged }, () => ({ [name]: tool }));
  });
  const parts = [
    prepareAssembledRequestTokenCount({ ...payload, tools }),
    ...repeats.map((repeat) => prepareAssembledRequestTokenCount({ messages: [], tools: repeat })),
  ];
  const toolCount = Object.keys(tools ?? {}).length + repeats.length;
  const framing = REQUEST_FRAMING_TOKENS * (1 + payload.messages.length + toolCount);
  const estimate = await countBudgetInput(
    {
      text: parts.map((part) => part.text).join("\n"),
      fixedTokens: parts.reduce((sum, part) => sum + part.fixedTokens, 0),
      heuristicTokens: parts.reduce((sum, part) => sum + part.heuristicTokens, 0),
    },
    options,
    framing,
    hardCeiling,
    toolCount
  );
  return { estimate, hardCeiling };
}

/** The request a step sent, as the request builder already holds it (no serialization). */
export interface ContextBudgetAnchorRequest extends BudgetModel {
  system: AssembledRequestBudgetInput["system"];
  tools: AssembledRequestBudgetInput["tools"];
  activeTools: readonly string[] | undefined;
  messages: readonly unknown[];
}

export interface ContextBudgetAnchor extends ContextBudgetAnchorRequest {
  /** Provider-counted input of that request (cache reads/writes included). */
  providerTokens: number;
}

/**
 * A turn-start request's anchor (#7662): the provider-counted input of the previous turn's last
 * step. That step's request is this request up to its last assistant message (the step's own
 * output), so no request object is kept: the delta is found in the messages at count time.
 */
export interface TurnBudgetAnchor extends BudgetModel {
  providerTokens: number;
}

/** Persisted usage is unchecked JSON: a negative count would shrink the anchor. */
function isTokenCount(count: unknown): count is number {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
}

/**
 * The provider's count of a step's request (cache reads and writes included) plus the step's
 * reasoning output: the next request replays that reasoning, and the local estimator skips its
 * encrypted form (signatures, redacted data, encrypted content). The visible reasoning text the
 * next request also carries is counted again by its estimate, a small overcount. Undefined (so
 * the caller uses the full estimate) without a positive integer input total, or when the step
 * emitted reasoning without a reported count.
 */
function replayedStepTokens(
  usage: AiSdkUsageLike,
  providerMetadata: Record<string, unknown> | undefined,
  emittedReasoning: boolean
): number | undefined {
  // Cache or reasoning details without an input total do not count the whole request.
  const input = usage.inputTokens;
  if (!isTokenCount(input) || input === 0) return undefined;
  // Provider-metadata-only reasoning counts are read too. Zero cannot tell "no reasoning" from
  // "not reported", so a step that emitted reasoning needs a count.
  const tokens = readUsageTokens(usage, providerMetadata);
  const counts = [tokens.input, tokens.cached, tokens.cacheCreate, tokens.reasoning];
  if (!counts.every(isTokenCount)) return undefined;
  if (emittedReasoning && tokens.reasoning === 0) return undefined;
  const total = getPromptTokens(tokens) + tokens.reasoning;
  return Number.isSafeInteger(total) ? total : undefined;
}

/**
 * Pairs a step's request with its provider count (replayedStepTokens). Undefined (so the caller
 * uses the full estimate) when the step has none.
 */
export function createContextBudgetAnchor(
  request: ContextBudgetAnchorRequest | undefined,
  step:
    | {
        usage: AiSdkUsageLike | undefined;
        providerMetadata?: Record<string, unknown>;
        reasoning?: readonly unknown[];
      }
    | undefined
): ContextBudgetAnchor | undefined {
  if (request == null || step?.usage == null) return undefined;
  const emittedReasoning = (step.reasoning?.length ?? 0) > 0;
  const providerTokens = replayedStepTokens(step.usage, step.providerMetadata, emittedReasoning);
  return providerTokens == null ? undefined : { ...request, providerTokens };
}

/** Both set and different: a row without the field does not count as a switch. */
function differs(before: string | undefined, now: string | undefined): boolean {
  return before != null && now != null && before !== now;
}

type ReplyMetadata = NonNullable<MuxMessage["metadata"]>;

/** A completed reply: not partial, synthetic, failed, a compaction summary or a boundary. */
function isCompletedReply(metadata: ReplyMetadata): boolean {
  // A compaction summary carries an estimated usage, and starts a new segment.
  const compacted = metadata.compacted != null && metadata.compacted !== false;
  return !(
    metadata.partial === true ||
    metadata.synthetic === true ||
    metadata.error != null ||
    metadata.errorType != null ||
    compacted ||
    metadata.compactionBoundary === true ||
    metadata.contextBoundaryKind != null
  );
}

type AnchorRequest = BudgetModel & { routeProvider?: string; agentId?: string };

/**
 * The model the provider counted with, and the route and agent switches that re-freeze the
 * system prompt.
 */
function sameRequestRoute(metadata: ReplyMetadata & { model: string }, request: AnchorRequest) {
  // Rows record the canonical model (Coder ids raw), so compare both sides canonicalized. A
  // providers.jsonc mapping keeps the model and changes the resolved model, which picks the
  // tokenizer and the request transforms, so a row from another one (or from a build that did
  // not record it) does not anchor.
  return (
    normalizeToCanonical(metadata.model) === normalizeToCanonical(request.model) &&
    metadata.metadataModel === request.metadataModel &&
    !differs(metadata.routeProvider, request.routeProvider) &&
    !differs(metadata.agentId, request.agentId)
  );
}

/** The newest reply's metadata when its saved usage can anchor this request, else undefined. */
function anchoringReply(metadata: ReplyMetadata | undefined, request: AnchorRequest) {
  const { contextUsage, model, systemMessageTokens } = metadata ?? {};
  if (contextUsage == null || model == null || systemMessageTokens == null) return undefined;
  const reply = { ...metadata, contextUsage, model, systemMessageTokens };
  return isCompletedReply(reply) && sameRequestRoute(reply, request) ? reply : undefined;
}

/** Whether the reply's last step (from its last trusted step start) emitted reasoning. */
function lastStepEmittedReasoning(reply: Pick<MuxMessage, "parts" | "metadata">): boolean {
  const starts: unknown = reply.metadata?.stepStartPartIndices;
  const first = isTrustedStepStartList(starts)
    ? (starts.findLast((index) => index < reply.parts.length) ?? 0)
    : 0;
  return reply.parts.slice(first).some((part) => part.type === "reasoning");
}

/**
 * The anchor for a turn-start request built from `rows`, its provider request rows (#7662).
 * The newest assistant row must be a completed reply from the same model, resolved model, route
 * and agent, with the provider's input total for its last step and its sent system token count.
 * Undefined (so the caller uses the full estimate) otherwise.
 *
 * Like the in-turn anchor, the last step's reasoning output is added (replayedStepTokens): the
 * request replays it after the anchored prefix, and a model that keeps earlier thinking (Claude
 * Opus 5.5 does) counts all of it, not the summary text the estimator sees. For a model that
 * drops it, this overcounts by that step's reasoning.
 *
 * Growth of `system`, the sent system text with its system rows, since that request (a live
 * system prompt changes between turns when the provider takes no system rows) is added, because
 * the provider count holds the old prompt. A row this request appends after the newest reply is
 * also in the delta, a small overcount.
 */
export async function createTurnBudgetAnchor(
  rows: readonly MuxMessage[],
  request: AnchorRequest & { system: string }
): Promise<TurnBudgetAnchor | undefined> {
  const row = rows.findLast((candidate) => candidate.role === "assistant");
  if (row == null) return undefined;
  const reply = anchoringReply(row.metadata, request);
  if (reply == null) return undefined;
  const replayed = replayedStepTokens(
    reply.contextUsage,
    reply.contextProviderMetadata,
    lastStepEmittedReasoning(row)
  );
  if (replayed == null) return undefined;
  // The row counted the same text (message and rows) with this tokenizer (measureSentSystem).
  // Claude-encoded growth is scaled like every other claude count (#5219).
  const tokenizer = await getTokenizerForModel(request.model, request.metadataModel);
  const growth = (await tokenizer.countTokens(request.system)) - reply.systemMessageTokens;
  const factor = tokenizer.encoding === "claude" ? CLAUDE_ENCODING_BUDGET_FACTOR : 1;
  const providerTokens = replayed + Math.ceil(Math.max(0, growth) * factor);
  return Number.isSafeInteger(providerTokens)
    ? { model: request.model, metadataModel: request.metadataModel, providerTokens }
    : undefined;
}

export function isExactAppend(
  payload: AssembledRequestBudgetInput,
  options: BudgetModel & { activeTools?: readonly string[] },
  anchor: ContextBudgetAnchor
): boolean {
  const tools = options.activeTools;
  return (
    anchor.model === options.model &&
    anchor.metadataModel === options.metadataModel &&
    anchor.system === payload.system &&
    anchor.tools === payload.tools &&
    anchor.activeTools?.length === tools?.length &&
    (anchor.activeTools ?? []).every((name, i) => tools?.[i] === name) &&
    payload.messages.length >= anchor.messages.length &&
    anchor.messages.every((message, i) => payload.messages[i] === message) &&
    // A repeated tool_reference leaves the loaded tools unchanged, yet the provider expands it
    // into the full definition the delta estimate never charges (#5413). Use the full estimate.
    countToolReferences(payload.messages.slice(anchor.messages.length)).size === 0
  );
}

/**
 * The messages the anchor's provider count does not hold, or undefined when the anchor does
 * not apply. A turn anchor's delta starts at the last assistant message: the previous turn's
 * last step output, which Xum's history rebuild sends as its own message (stepStartPartIndices).
 */
function anchoredDelta(
  payload: AssembledRequestBudgetInput,
  options: BudgetModel & { activeTools?: readonly string[] },
  anchor: ContextBudgetAnchor | TurnBudgetAnchor
): readonly unknown[] | undefined {
  if ("messages" in anchor) {
    return isExactAppend(payload, options, anchor)
      ? payload.messages.slice(anchor.messages.length)
      : undefined;
  }
  if (anchor.model !== options.model || anchor.metadataModel !== options.metadataModel) {
    return undefined;
  }
  const start = payload.messages.findLastIndex(
    (message) => (message as { role?: unknown } | null)?.role === "assistant"
  );
  if (start < 0) return undefined;
  const delta = payload.messages.slice(start);
  // A tool_reference expands into a definition the delta never charges (#5413), as above.
  return countToolReferences(delta).size === 0 ? delta : undefined;
}

/**
 * Anchored estimate (#4858). Contract: an in-turn anchor is used ONLY when this request is an
 * exact append of the step whose usage it carries: same model, the same system prompt and tool
 * set objects, the same advertised tool names, a message list that starts with that step's sent
 * messages (element identity, so any rewrite of the prefix fails), and a positive integer
 * provider input total plus a reasoning count whenever the step emitted reasoning. A turn
 * anchor (createTurnBudgetAnchor) needs the same model and a last assistant message. The
 * estimate is then the provider's count plus the existing estimator applied to the appended
 * messages only. ANY doubt means the full estimate; edge cases get a new full-estimate
 * condition here, never new mechanism.
 */
export async function estimateAnchoredRequestTokensForModel(
  payload: AssembledRequestBudgetInput,
  options: BudgetModel & {
    modelContextLimit: number | null | undefined;
    activeTools?: readonly string[];
  },
  anchor: ContextBudgetAnchor | TurnBudgetAnchor | undefined
): Promise<{ estimate: number; hardCeiling: number } | undefined> {
  const delta = anchor == null ? undefined : anchoredDelta(payload, options, anchor);
  if (anchor == null || delta == null) {
    return estimateAssembledRequestTokensForModel(payload, options);
  }
  const limit = options.modelContextLimit;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return undefined;
  const hardCeiling = getContextBudgetHardCeiling(limit);
  // Same early-exit lower bound as the full estimate: above the ceiling, not exact.
  const deltaEstimate = await countBudgetInput(
    prepareAssembledRequestTokenCount({ messages: delta }),
    options,
    REQUEST_FRAMING_TOKENS * (1 + delta.length),
    Math.max(0, hardCeiling - anchor.providerTokens)
  );
  return { estimate: anchor.providerTokens + deltaEstimate, hardCeiling };
}

/**
 * The budget check's single count, with its estimate (#5286). `exceeded`
 * is set iff the estimate is above the hard ceiling, where it is the early-exit lower bound.
 */
export async function measureAssembledRequestBudgetForModel(
  payload: AssembledRequestBudgetInput,
  options: BudgetModel & {
    modelContextLimit: number | null | undefined;
    activeTools?: readonly string[];
  },
  anchor?: ContextBudgetAnchor | TurnBudgetAnchor
): Promise<
  { estimate: number; hardCeiling: number; exceeded?: ContextBudgetExceeded } | undefined
> {
  const counted = await estimateAnchoredRequestTokensForModel(payload, options, anchor);
  if (counted == null || counted.estimate <= counted.hardCeiling) return counted;
  // Built field by field: the error is serialized to the frontend as a SendMessageError.
  const exceeded: ContextBudgetExceeded = {
    type: "context_budget_exceeded",
    model: options.model,
    estimate: counted.estimate,
    hardCeiling: counted.hardCeiling,
  };
  return { ...counted, exceeded };
}

export async function checkAssembledRequestBudgetForModel(
  payload: AssembledRequestBudgetInput,
  options: BudgetModel & {
    modelContextLimit: number | null | undefined;
    activeTools?: readonly string[];
  },
  anchor?: ContextBudgetAnchor | TurnBudgetAnchor
): Promise<ContextBudgetExceeded | undefined> {
  return (await measureAssembledRequestBudgetForModel(payload, options, anchor))?.exceeded;
}
