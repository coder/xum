/**
 * Cache-bust auditor: diffs consecutive turn-envelope rows and attributes
 * prompt-prefix invalidations. Providers cache the request prefix (system
 * prompt + tool definitions + early messages); any change to the system
 * prompt hash, the toolset manifest, the model, the thinking level, or the
 * resolved provider options re-writes that prefix and busts the cache.
 *
 * Token attribution is approximate: where the paired assistant row recorded
 * usage, the busted cost ≈ non-cache-read input (fresh input + cache-write
 * tokens) of the turn that saw the invalidation.
 */

import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import {
  comparePromptCachePrefix,
  describePromptCacheBreak,
  fingerprintAnthropicRequest,
  type PromptCacheBlock,
  type PromptCachePrefixBreak,
} from "@/node/services/promptCachePrefix";
import type { RecordedStepRequest, TurnEnvelopeEvent } from "./replayVerify";

export interface CacheAuditCause {
  kind: "system-prompt" | "toolset" | "model" | "thinking-level" | "provider-options";
  detail: string;
}

export interface CacheAuditTurn {
  turnIndex: number;
  envelopeSeq: number;
  ts: number;
  modelString: string;
  thinkingLevel: string;
  /** Empty for the baseline first turn and for prefix-stable turns. */
  causes: CacheAuditCause[];
  /** Recorded usage for the paired assistant turn, when available. */
  usage?: ChatUsageDisplay;
  /**
   * Approximate tokens re-processed because of the bust: non-cache-read
   * input (fresh + cache-write) of this turn. Only set when causes exist and
   * usage is available.
   */
  approxBustedTokens?: number;
}

function diffToolsetManifest(
  previous: TurnEnvelopeEvent["data"]["toolsetManifest"],
  current: TurnEnvelopeEvent["data"]["toolsetManifest"]
): string[] {
  const previousByName = new Map(previous.map((entry) => [entry.name, entry.schemaHash]));
  const currentByName = new Map(current.map((entry) => [entry.name, entry.schemaHash]));
  const details: string[] = [];
  for (const [name] of previousByName) {
    if (!currentByName.has(name)) {
      details.push(`removed:${name}`);
    }
  }
  for (const [name, hash] of currentByName) {
    const previousHash = previousByName.get(name);
    if (previousHash === undefined) {
      details.push(`added:${name}`);
    } else if (previousHash !== hash) {
      details.push(`schema-changed:${name}`);
    }
  }
  return details;
}

/**
 * Collapse envelopes to the FINAL row per requestHistorySequence, matching
 * pairSessionTurns: a model-fallback turn emits a superseding envelope for the
 * same sequence, and auditing both would count the turn twice, attach the
 * surviving assistant's usage twice, and report artificial busts between the
 * failed primary and the fallback request. Rows without a sequence (legacy
 * sessions) are kept in place.
 */
export function collapseEnvelopesToFinalPerSequence(
  envelopes: TurnEnvelopeEvent[]
): TurnEnvelopeEvent[] {
  const result: TurnEnvelopeEvent[] = [];
  const indexBySequence = new Map<number, number>();
  for (const envelope of envelopes) {
    const sequence = envelope.data.requestHistorySequence;
    if (sequence == null) {
      result.push(envelope);
      continue;
    }
    const existing = indexBySequence.get(sequence);
    if (existing == null) {
      indexBySequence.set(sequence, result.length);
      result.push(envelope);
    } else {
      result[existing] = envelope;
    }
  }
  return result;
}

/**
 * Attribute prompt-prefix invalidations across consecutive turn envelopes.
 * `usageByTurn` pairs ordinally with `envelopes` (missing/undefined entries
 * simply skip token attribution).
 */
export function auditCacheBusts(
  envelopes: TurnEnvelopeEvent[],
  usageByTurn: Array<ChatUsageDisplay | undefined> = []
): CacheAuditTurn[] {
  return envelopes.map((envelope, index) => {
    const causes: CacheAuditCause[] = [];
    const previous = index > 0 ? envelopes[index - 1] : undefined;

    if (previous) {
      if (previous.data.systemPromptHash !== envelope.data.systemPromptHash) {
        causes.push({
          kind: "system-prompt",
          detail: `${previous.data.systemPromptHash.slice(7, 19)} → ${envelope.data.systemPromptHash.slice(7, 19)}`,
        });
      }
      const toolsetDetails = diffToolsetManifest(
        previous.data.toolsetManifest,
        envelope.data.toolsetManifest
      );
      if (toolsetDetails.length > 0) {
        causes.push({ kind: "toolset", detail: toolsetDetails.join(", ") });
      }
      if (previous.data.modelString !== envelope.data.modelString) {
        causes.push({
          kind: "model",
          detail: `${previous.data.modelString} → ${envelope.data.modelString}`,
        });
      }
      if (previous.data.thinkingLevel !== envelope.data.thinkingLevel) {
        causes.push({
          kind: "thinking-level",
          detail: `${previous.data.thinkingLevel} → ${envelope.data.thinkingLevel}`,
        });
      }
      if (previous.data.providerOptionsHash !== envelope.data.providerOptionsHash) {
        causes.push({
          kind: "provider-options",
          detail: `${previous.data.providerOptionsHash.slice(0, 12)} → ${envelope.data.providerOptionsHash.slice(0, 12)}`,
        });
      }
    }

    const usage = usageByTurn[index];
    const approxBustedTokens =
      causes.length > 0 && usage !== undefined
        ? usage.input.tokens + usage.cacheCreate.tokens
        : undefined;

    return {
      turnIndex: index,
      envelopeSeq: envelope.seq,
      ts: envelope.ts,
      modelString: envelope.data.modelString,
      thinkingLevel: envelope.data.thinkingLevel,
      causes,
      ...(usage !== undefined ? { usage } : {}),
      ...(approxBustedTokens !== undefined ? { approxBustedTokens } : {}),
    };
  });
}

export interface StepPrefixBreak {
  runId: string;
  stepId: string;
  stepNumber: number;
  /** "turn": a run's first step broke the previous run's last step; "step": a later step did. */
  boundary: "turn" | "step";
  comparison: PromptCachePrefixBreak;
  description: string;
}

export interface StepPrefixAudit {
  /** Chat-turn steps the audit read (ignored side calls excluded). */
  auditedSteps: number;
  /** Consecutive request pairs held to the prefix rule. */
  comparedPairs: number;
  breaks: StepPrefixBreak[];
}

/**
 * The prefix rule over every recorded step, not only each turn's first: each
 * request must start with every block of the workspace's previous request, or
 * the provider re-processes the conversation from the first differing block
 * uncached. The turn envelope comparison above only sees prefix inputs; this
 * also catches a rebuild that changes history bytes (lost step boundaries,
 * truncated tool results). Each route and model keeps its own baseline, like
 * the runtime monitor, so Sonnet -> Opus -> Sonnet compares the two Sonnet
 * requests. Pairs across a context epoch change are not compared, and a side
 * run (compaction) is skipped and resets every baseline. A non-Anthropic step is skipped and keeps the last Anthropic
 * baseline, as the runtime monitor (which observes only Anthropic wires) does.
 * With recorded wire facts (DevToolsStep.promptCacheWire), steps run in the order
 * their OK responses arrived, the TTL runs from that time, and a step without an
 * OK response or without cache markers is skipped, all as the monitor does.
 * A pair with a request the fingerprint does not model (`unsupported`) is not
 * counted, and that request becomes the baseline.
 */
/**
 * Legacy check for steps without a wire record: the AI SDK provider id starts with "anthropic"
 * for the Anthropic provider (e.g. "anthropic.messages"). A wire record proves an Anthropic
 * wire by itself (see isMonitoredAnthropicStep).
 */
function isAnthropicStep(step: RecordedStepRequest): boolean {
  return step.provider?.startsWith("anthropic") === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The cache-key call options of a recorded step, in the body fields the fingerprint reads.
 * The AI SDK maps them 1:1 onto the wire (`thinking`, `effort` -> `output_config.effort`,
 * `speed`, `contextManagement` -> `context_management`, the call's `toolChoice` plus
 * `disableParallelToolUse` -> `tool_choice` in the provider's wire shape, see
 * wireToolChoice). The audit compares recorded steps only with each other, so the other
 * values keep their AI SDK shape. Structured-output formats are not in the
 * DevTools record and stay unmodeled here.
 */
/**
 * The wire `tool_choice` the AI SDK Anthropic provider sends (its prepareTools): with no
 * call tool choice, `{ type: "auto", disable_parallel_tool_use }` only when that option is
 * truthy, so an omitted value and `false` are the same request. Models that reject forced
 * tool use downgrade "required" and "tool" to "auto"; the record does not show that, so
 * those keep their own value.
 */
function wireToolChoice(choice: unknown, disableParallelToolUse: unknown): unknown {
  if (!isRecord(choice)) {
    return disableParallelToolUse === true
      ? { type: "auto", disable_parallel_tool_use: true }
      : undefined;
  }
  switch (choice.type) {
    case "none":
      return undefined;
    case "required":
      return { type: "any", disable_parallel_tool_use: disableParallelToolUse };
    case "tool":
      return {
        type: "tool",
        name: choice.toolName,
        disable_parallel_tool_use: disableParallelToolUse,
      };
    default:
      return { type: "auto", disable_parallel_tool_use: disableParallelToolUse };
  }
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * The cache lifetime a recorded step asked for, from its prompt-form cache markers
 * (`providerOptions.anthropic.cacheControl.ttl` on tools, messages and content parts), else
 * Anthropic's 5-minute default, as the runtime monitor reads it from the wire markers.
 */
function stepCacheTtlMs(step: RecordedStepRequest): number {
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const messages = asArray(step.prompt);
  const markable = [
    ...asArray(step.tools),
    ...messages,
    ...messages.flatMap((message) => (isRecord(message) ? asArray(message.content) : [])),
  ];
  const isHourMarker = (entry: unknown): boolean => {
    const providerOptions = isRecord(entry) ? entry.providerOptions : undefined;
    const anthropic = isRecord(providerOptions) ? providerOptions.anthropic : undefined;
    const marker = isRecord(anthropic) ? anthropic.cacheControl : undefined;
    return isRecord(marker) && marker.ttl === "1h";
  };
  return markable.some(isHourMarker) ? ONE_HOUR_MS : FIVE_MINUTES_MS;
}

/**
 * When the runtime monitor observed the step: the time its OK response arrived, else (older
 * logs, non-Anthropic wires) its start time. NaN when unreadable.
 */
function stepObservedAtMs(step: RecordedStepRequest): number {
  return Date.parse(step.promptCacheWire?.observedAt ?? step.startedAt);
}

/**
 * Whether the runtime monitor observed this step on an Anthropic wire. A wire record decides:
 * only the Anthropic cache wrapper writes one, also behind SDKs that report another provider
 * id (the mux-gateway SDK reports "gateway"), and the monitor observes a request only once it
 * was answered OK with cache markers injected. One that failed before, got an error status, or
 * ran with caching off neither created nor broke a cache entry. Older logs carry no record:
 * their Anthropic steps stay audited.
 */
function isMonitoredAnthropicStep(step: RecordedStepRequest): boolean {
  const wire = step.promptCacheWire;
  if (wire == null) return isAnthropicStep(step);
  return wire.dispatched && wire.cacheMarkersInjected && wire.observedAt != null;
}

/**
 * Requests compare only within one route, endpoint and effective model, like the monitor's
 * baseline key. Older logs have no route: they key by the AI SDK provider id and model id.
 * Logs from before the endpoint was recorded key it as empty.
 */
function baselineKeyOf(step: RecordedStepRequest): string {
  const wire = step.promptCacheWire;
  return wire != null
    ? `route\u0000${wire.route}\u0000${wire.endpoint ?? ""}\u0000${wire.modelString}`
    : `provider\u0000${step.provider ?? ""}\u0000${step.modelId}`;
}

interface ObservationSortKey {
  step: RecordedStepRequest;
  /** Position in the log: the last tie-breaker, and the whole order for older logs. */
  index: number;
  at: number;
  /** Process-wide observation counter (DevToolsPromptCacheWire.observedSeq), when recorded. */
  seq: number | undefined;
}

/**
 * Observation time, then the observation counter for responses in the same millisecond,
 * then the log order (older logs without a counter, unreadable times).
 */
function compareObservation(a: ObservationSortKey, b: ObservationSortKey): number {
  const delta = a.at - b.at;
  if (!Number.isNaN(delta) && delta !== 0) return delta;
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
  return a.index - b.index;
}

/**
 * Steps in the order the monitor observed them. Overlapping runs can get their OK responses
 * in another order than they started (the log order). Logs without observation times keep
 * the log order.
 */
function inObservationOrder(steps: readonly RecordedStepRequest[]): RecordedStepRequest[] {
  if (!steps.some((step) => step.promptCacheWire?.observedAt != null)) return [...steps];
  return steps
    .map((step, index) => ({
      step,
      index,
      at: stepObservedAtMs(step),
      seq: step.promptCacheWire?.observedSeq,
    }))
    .sort(compareObservation)
    .map(({ step }) => step);
}

function wireOptionsFromStep(step: RecordedStepRequest): Record<string, unknown> {
  const providerOptions = isRecord(step.providerOptions) ? step.providerOptions : {};
  const anthropic = isRecord(providerOptions.anthropic) ? providerOptions.anthropic : {};
  const toolChoice = wireToolChoice(step.toolChoice, anthropic.disableParallelToolUse);
  return {
    ...(anthropic.thinking != null ? { thinking: anthropic.thinking } : {}),
    ...(anthropic.effort != null ? { output_config: { effort: anthropic.effort } } : {}),
    ...(anthropic.speed != null ? { speed: anthropic.speed } : {}),
    ...(anthropic.contextManagement != null
      ? { context_management: anthropic.contextManagement }
      : {}),
    ...(toolChoice != null ? { tool_choice: toolChoice } : {}),
  };
}

export function auditStepPrefixes(
  steps: readonly RecordedStepRequest[],
  isSideRun: (step: RecordedStepRequest) => boolean = () => false,
  /** Steps outside any chat turn (headless side calls): skipped without touching the baseline. */
  isIgnored: (step: RecordedStepRequest) => boolean = () => false
): StepPrefixAudit {
  const breaks: StepPrefixBreak[] = [];
  let auditedSteps = 0;
  let comparedPairs = 0;
  // Keyed by provider and model: a model switch must not discard the other model's
  // baseline while its cache entry is still live.
  const baselines = new Map<string, { step: RecordedStepRequest; blocks: PromptCacheBlock[] }>();
  for (const step of inObservationOrder(steps)) {
    if (isIgnored(step)) continue;
    auditedSteps++;
    if (isSideRun(step)) {
      baselines.clear();
      continue;
    }
    // Block order and normalization are Anthropic's, like the runtime detector, which
    // observes only Anthropic wires: other providers neither break nor replace the baseline.
    // Neither does a request the monitor did not observe.
    if (!isMonitoredAnthropicStep(step)) continue;
    const baselineKey = baselineKeyOf(step);
    let previous = baselines.get(baselineKey);
    // `/clear`, "start here" or a rollover replaced the context: a new baseline, no break.
    // Runs from older binaries carry no epoch and keep the old behavior.
    if (
      previous?.step.contextEpoch != null &&
      step.contextEpoch != null &&
      previous.step.contextEpoch !== step.contextEpoch
    ) {
      previous = undefined;
    }
    // The previous step's cache entry expired before this one was observed: cold by time, like
    // the runtime monitor, so start a new baseline without a break. An unreadable time compares.
    if (
      previous != null &&
      stepObservedAtMs(step) - stepObservedAtMs(previous.step) > stepCacheTtlMs(previous.step)
    ) {
      previous = undefined;
    }
    // The DevTools record is the AI SDK prompt (system messages inline), the
    // same shape the gateway wire carries.
    const blocks = fingerprintAnthropicRequest({
      tools: step.tools,
      prompt: step.prompt,
      ...wireOptionsFromStep(step),
    });
    if (previous != null) {
      const comparison = comparePromptCachePrefix(previous.blocks, blocks);
      if (comparison.kind !== "unsupported") comparedPairs++;
      if (comparison.kind === "break") {
        breaks.push({
          runId: step.runId,
          stepId: step.stepId,
          stepNumber: step.stepNumber,
          boundary: previous.step.runId === step.runId ? "step" : "turn",
          comparison,
          description: describePromptCacheBreak(comparison),
        });
      }
    }
    baselines.set(baselineKey, { step, blocks });
  }
  return { auditedSteps, comparedPairs, breaks };
}
