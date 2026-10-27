/**
 * StepPreparation: what prepareStep does before each provider step of a turn (turn-engine
 * layer 5f). The pure step helpers live here: message transforms, the Auto thinking
 * raise, the prefix-swap rules, tool selection, the step-0 rebuild, the #5086 replay
 * boundary and strip, the context-budget request and preflight, and prepareStep's result.
 *
 * The StepPreparation class (below) builds the streamText call (createStreamResult) and
 * runs prepareStep (prepareStepMessages, prepareStepRequest, commitPrefixSwap). Its
 * StreamManager dependencies are injected. Imports stay one-way: nothing here imports a
 * value from streamManager.ts.
 */
import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type PrepareStepFunction,
  type PrepareStepResult,
  type stepCountIs,
  type ToolSet,
} from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { stripAnthropicReasoning } from "@/browser/utils/messages/modelMessageTransform";
import { getErrorMessage } from "@/common/utils/errors";
import {
  computeActiveToolNames,
  computeContextLoadedToolNames,
  dedupeNativeToolReferences,
} from "@/common/utils/tools/toolCatalog";
import {
  markAutoThinkingEscalationExhausted,
  proposeAutoThinkingEscalation,
  recordAutoThinkingEscalation,
  type AutoThinkingEscalationState,
} from "@/node/services/autoThinkingEscalation";
import {
  checkAssembledRequestBudgetForModel,
  createContextBudgetAnchor,
  type ContextBudgetAnchorRequest,
  type TurnBudgetAnchor,
} from "@/node/services/contextBudgetCounting";
import { ContextBudgetBlockedError } from "@/node/services/contextBudgetError";
import type { HistoryService } from "@/node/services/historyService";
import type { ContinuousPrefixSwap } from "@/node/services/continuousCompactionJournal";
import { log } from "@/node/services/log";
import type {
  ActiveTurnThinkingOverride,
  RebuildFirstStepForThinkingLevel,
} from "@/node/services/thinkingOverride";
import type {
  ProviderRequest,
  StreamRequestConfig,
} from "@/node/services/turnEngine/ProviderRequest";
import { isAgentToolsDisabled } from "@/node/utils/agentToolsDisabled";
import { extractToolMediaAsUserMessagesFromModelMessages } from "@/node/utils/messages/extractToolMediaAsUserMessagesFromModelMessages";
import { neutralizeAgentEnvelopeLookalikesInModelToolParts } from "@/node/utils/messages/neutralizeAgentEnvelopeLookalikesForProvider";
import { stripReasoningReplay } from "@/node/utils/messages/reasoningProviderOptions";
import { stripWorkflowRunRecordsFromModelMessages } from "@/node/utils/messages/stripWorkflowRunRecordsFromModelMessages";
import { summarizeInvalidToolInputErrors } from "@/node/utils/messages/summarizeInvalidToolInputErrors";
import type { StepMessageTracker } from "@/node/services/turnEngine/types";
export type { StepMessageTracker } from "@/node/services/turnEngine/types";

/**
 * Same-turn message transforms applied before every provider step: strip workflow run records
 * and redact binary-like strings in same-turn tool results (history-level redaction in
 * applyToolOutputRedaction can't see these), neutralize protocol-envelope lookalikes in same-turn tool inputs/results
 * (messagePipeline's neutralizer only sees persisted history), then extract supported
 * attachments out of tool-result JSON so providers don't treat them as text. Idempotent on an
 * already-transformed prefix. The settled-step budget floor reuses it so it measures exactly the
 * request the next step's preflight will check. Native tool_reference dedupe is NOT part of
 * this transform: it must run after a prefix swap (see prepareStep), which replaces the prefix
 * the projection is decided against.
 */
export function transformStepMessages(messages: ModelMessage[]): Promise<ModelMessage[]> {
  return extractToolMediaAsUserMessagesFromModelMessages(
    neutralizeAgentEnvelopeLookalikesInModelToolParts(
      stripWorkflowRunRecordsFromModelMessages(messages)
    )
  );
}

function sendsBetweenToolsThinking(providerOptions: Record<string, unknown> | undefined): boolean {
  const anthropic = providerOptions?.anthropic;
  if (typeof anthropic !== "object" || anthropic === null || !("thinking" in anthropic)) {
    return false;
  }
  const thinking = anthropic.thinking;
  return (
    typeof thinking === "object" &&
    thinking !== null &&
    "type" in thinking &&
    thinking.type === "between_tools"
  );
}

/**
 * #5886: a same-turn rebuild reads history, which does not hold this turn's thinking-replay
 * receipt yet. Keep the removed thinking out (all of it: the rebuild is a new prefix).
 */
export function applyTurnReplayReceipt(
  stepTracker: StepMessageTracker | undefined,
  messages: ModelMessage[]
): ModelMessage[] {
  return stepTracker?.hasAnthropicReplayReceipt?.() === true
    ? stripReasoningReplay(messages, "anthropic")
    : messages;
}

// Same idea for the Anthropic Messages wire, whose converter replays thinking
// from the `anthropic` providerOptions namespace on every route.
export function isAnthropicMessagesModel(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
  return model.provider === "anthropic.messages";
}

// Claude through Bedrock Converse (@ai-sdk/amazon-bedrock), whose converter replays
// in-turn thinking from the `bedrock` namespace. Same id test as the SDK's own
// isAnthropicModel, plus the metadata model for opaque ids that map to Claude
// (application inference profile ARNs with mappedToModel).
function isBedrockClaudeModel(model: LanguageModel, metadataModel: string | undefined): boolean {
  if (typeof model === "string" || model.provider !== "amazon-bedrock") return false;
  return model.modelId.includes("anthropic") || metadataModel?.includes("claude-") === true;
}

/** One Auto thinking raise, as proposeAutoThinkingEscalation stages it. */
type ProposedThinkingEscalation = NonNullable<ReturnType<typeof proposeAutoThinkingEscalation>>;

/** Stage an Auto thinking raise as the pending override; returns the raise it staged. */
export function stageAutoThinkingEscalation(
  escalationState: AutoThinkingEscalationState | undefined,
  overrideState: ActiveTurnThinkingOverride | undefined,
  stepMessages: ModelMessage[]
): ProposedThinkingEscalation | undefined {
  const escalation =
    escalationState && overrideState && !overrideState.manual && overrideState.pending == null
      ? proposeAutoThinkingEscalation(escalationState, stepMessages)
      : undefined;
  if (escalation && overrideState) {
    overrideState.pending = escalation.to;
  }
  return escalation;
}

/** True when a thinking change voids the staged prefix swap (see the prepareStep call). */
export function thinkingChangeVoidsPrefixSwap(
  overrideState: ActiveTurnThinkingOverride | undefined,
  pendingSwap: ContinuousPrefixSwap | undefined
): boolean {
  const appliedThinking = overrideState?.applied;
  return (
    overrideState?.pending != null ||
    (pendingSwap != null &&
      appliedThinking != null &&
      appliedThinking !== pendingSwap.journal.preparation.effectiveThinkingLevel)
  );
}

/** A prefix swap that swapPrefix applied to a step's messages, before its journal commits. */
interface StagedPrefixSwap {
  swap: ContinuousPrefixSwap;
  swapped: ModelMessage[];
  stepNumber: number;
}

/** The tools a step advertises, and the forced first-step tools when they apply. */
export function selectStepActiveTools(
  request: Pick<StreamRequestConfig, "toolSearchState" | "forcedFirstStepToolNames">,
  stepNumber: number,
  agentToolsDisabled: boolean
): { forceFirstStepTools: string[] | undefined; activeTools: string[] | undefined } {
  // Tool search: scope the advertised tool list to core tools +
  // activated deferred tools. Read per step so tools activated by
  // tool_catalog_search.execute appear on the following step.
  // undefined when the feature is inactive, keeping the return value
  // byte-identical to the pre-feature behavior, and in native mode, which
  // keeps the tools block stable (#5262).
  const searchedActiveTools = agentToolsDisabled
    ? undefined
    : computeActiveToolNames(request.toolSearchState);
  const forceFirstStepTools =
    !agentToolsDisabled && stepNumber === 0 && request.forcedFirstStepToolNames?.length
      ? request.forcedFirstStepToolNames
      : undefined;
  return { forceFirstStepTools, activeTools: forceFirstStepTools ?? searchedActiveTools };
}

/** Report a staged Auto thinking raise back to its escalation state once the step built options. */
export function settleAutoThinkingEscalation(
  escalation: ProposedThinkingEscalation | undefined,
  escalationState: AutoThinkingEscalationState | undefined,
  overrideState: ActiveTurnThinkingOverride | undefined,
  thinkingOverride: Record<string, unknown> | undefined
): void {
  if (!escalation || !escalationState) return;
  // The rebuild clamps to the model's ladder and reports a no-op as "not applicable";
  // only a level that actually changed is provenance, at the level it changed to (a
  // sparse ladder can land above the requested step). A slider write that raced the
  // step's awaits is the user's level, not Auto's.
  const applied = overrideState?.applied;
  if (
    thinkingOverride !== undefined &&
    applied != null &&
    applied !== escalation.from &&
    !overrideState?.manual
  ) {
    const effective = applied === escalation.to ? escalation : { ...escalation, to: applied };
    recordAutoThinkingEscalation(escalationState, effective);
    log.info("Auto thinking escalated mid-turn", effective);
  } else {
    markAutoThinkingEscalationExhausted(escalationState);
  }
}

/**
 * Start the step-0 message rebuild for a thinking override this step applied (see the
 * prepareStep call). Returns undefined when no rebuild applies, so the step awaits nothing extra.
 */
export function startFirstStepRebuild(
  request: Pick<
    StreamRequestConfig,
    "thinkingOverrideState" | "rebuildFirstStepForThinkingLevel" | "onStepMessages"
  >,
  stepTracker: StepMessageTracker | undefined,
  stepNumber: number,
  thinkingOverride: Record<string, unknown> | undefined
): Promise<ModelMessage[] | undefined> | undefined {
  const appliedLevel = request.thinkingOverrideState?.applied;
  const rebuild = request.rebuildFirstStepForThinkingLevel;
  if (
    thinkingOverride !== undefined &&
    stepNumber === 0 &&
    !stepTracker?.consumedPrefixSwap &&
    rebuild != null &&
    appliedLevel != null
  ) {
    return rebuildFirstStepMessages(request, stepTracker, stepNumber, () =>
      rebuild(appliedLevel, thinkingOverride)
    );
  }
  return undefined;
}

/** The step-0 rebuild itself; fails open to the options-only rebuild (undefined). */
async function rebuildFirstStepMessages(
  request: Pick<StreamRequestConfig, "onStepMessages">,
  stepTracker: StepMessageTracker | undefined,
  stepNumber: number,
  rebuild: () => ReturnType<RebuildFirstStepForThinkingLevel>
): Promise<ModelMessage[] | undefined> {
  let rebuiltFirstStepMessages: ModelMessage[] | undefined;
  try {
    const { messages: rebuilt, ...rebuiltSystem } = await rebuild();
    const receiptApplied = applyTurnReplayReceipt(stepTracker, rebuilt);
    // A retry's step 0 can rebuild this row's earlier steps too: what it stripped
    // is gone from here on, so the receipt's point moves to this step.
    if (stepTracker && receiptApplied !== rebuilt) {
      stepTracker.anthropicThinkingStripStep = stepNumber;
    }
    // Same per-step transforms the construction-time messages receive.
    rebuiltFirstStepMessages = dedupeNativeToolReferences(
      await transformStepMessages(receiptApplied)
    );
    if (stepTracker) {
      stepTracker.latestMessages = rebuiltFirstStepMessages;
      // The rebuilt request decides which volatile-tail rows the row recorded, and
      // what its system content (tail rows included) costs.
      stepTracker.recordSystemSections(rebuiltSystem);
    }
    // onStepMessages fired above with the pre-rebuild transcript;
    // re-notify so consumers track the
    // messages this step actually sends.
    request.onStepMessages?.(rebuiltFirstStepMessages);
  } catch (error) {
    // Fail open to the options-only rebuild rather than killing the
    // turn; the envelope then still matches the options change.
    log.warn("First-step message rebuild for thinking override failed", {
      error: getErrorMessage(error),
    });
  }
  return rebuiltFirstStepMessages;
}

/** #5086: where in-turn thinking stops replaying. One per streamText call (see prepareStep). */
interface ReasoningReplayBoundary {
  previousToolSetKey?: string;
  seenPrefixSwap?: ContinuousPrefixSwap;
  /** Outgoing rows before this index predate the latest in-turn prefix change. */
  index: number;
  /** The SDK step whose request first sent that boundary (stepTracker.anthropicThinkingStripStep). */
  step: number;
}

/** Why a step stops after a cross-family fallback invalidated its staged prefix swap. */
export function prefixSwapInvalidationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Prefix swap invalidated");
}

/** Clear the staged prefix swap when a thinking change voids it. */
export function dropVoidedPrefixSwap(
  request: Pick<StreamRequestConfig, "thinkingOverrideState">,
  stepTracker: StepMessageTracker | undefined
): void {
  if (
    stepTracker &&
    thinkingChangeVoidsPrefixSwap(request.thinkingOverrideState, stepTracker.pendingPrefixSwap)
  ) {
    stepTracker.pendingPrefixSwap = undefined;
  }
}

/** Record the messages a step sends and notify the request's step-messages listener. */
export function recordStepMessages(
  request: Pick<StreamRequestConfig, "onStepMessages">,
  stepTracker: StepMessageTracker | undefined,
  effectiveMessages: ModelMessage[]
): void {
  if (stepTracker) {
    stepTracker.latestMessages = effectiveMessages;
  }
  request.onStepMessages?.(effectiveMessages);
}

/** Whether a step sends the turn's first provider request; without a tracker, assume a step ran. */
export function isFirstTurnRequest(
  stepTracker: StepMessageTracker | undefined,
  stepNumber: number
): boolean {
  return stepTracker != null && stepNumber === 0 && !stepTracker.providerRequestPrepared;
}

/** What one streamText call's prepareStep reads, and the replay boundary its steps advance. */
interface StepPreparationContext {
  request: StreamRequestConfig;
  abortController: AbortController;
  stepTracker: StepMessageTracker | undefined;
  agentToolsDisabled: boolean;
  replayBoundary: ReasoningReplayBoundary;
}

/** The prepareStep options the phases read. */
type StepPreparationInput = Pick<
  Parameters<PrepareStepFunction<ToolSet>>[0],
  "messages" | "stepNumber" | "steps"
>;

/** A step after prepareStep's messages phase, as its request phase takes it. */
interface StagedStepMessages {
  effectiveMessages: ModelMessage[];
  escalation: ProposedThinkingEscalation | undefined;
  escalationState: AutoThinkingEscalationState | undefined;
  overrideState: ActiveTurnThinkingOverride | undefined;
}

/** Move the boundary to this step's outgoing length when its prefix changed. */
export function advanceReasoningReplayBoundary(
  boundary: ReasoningReplayBoundary,
  activeTools: string[] | undefined,
  consumedSwap: ContinuousPrefixSwap | undefined,
  outgoingLength: number,
  stepNumber: number
): void {
  const toolSetKey = activeTools === undefined ? "" : [...activeTools].sort().join("\n");
  if (
    (consumedSwap != null && consumedSwap !== boundary.seenPrefixSwap) ||
    (boundary.previousToolSetKey !== undefined && toolSetKey !== boundary.previousToolSetKey)
  ) {
    // Kept at the unstripped length: if stripping drops reasoning-only rows, the
    // boundary covers a few later rows too, which only strips more (fail safe).
    boundary.index = outgoingLength;
    boundary.step = stepNumber;
  }
  boundary.seenPrefixSwap = consumedSwap;
  boundary.previousToolSetKey = toolSetKey;
}

/**
 * Strip thinking from the rows before the boundary on routes that replay it (see the
 * prepareStep call). Returns the stripped messages, or undefined when there is nothing to strip.
 */
export function stripReasoningBeforeReplayBoundary(
  request: Pick<StreamRequestConfig, "providerOptions" | "model" | "budgetMetadataModel">,
  stepTracker: StepMessageTracker | undefined,
  boundary: ReasoningReplayBoundary,
  outgoing: ModelMessage[]
): ModelMessage[] | undefined {
  if (
    !(
      (sendsBetweenToolsThinking(request.providerOptions) ||
        isAnthropicMessagesModel(request.model) ||
        isBedrockClaudeModel(request.model, request.budgetMetadataModel)) &&
      outgoing.some(
        (message, index) =>
          index < boundary.index &&
          message.role === "assistant" &&
          typeof message.content !== "string" &&
          message.content.some((part) => part.type === "reasoning")
      )
    )
  ) {
    return undefined;
  }
  // No receipt for Bedrock: Xum never replays Bedrock thinking across turns
  // (sanitizeReasoningReplayMetadata keeps no `bedrock` namespace), so the
  // stripped blocks cannot come back, and a receipt would strip later
  // Anthropic-route thinking in the same segment for nothing.
  // The point is the step that first sent this boundary: its own thinking and later
  // keep replaying. Steps after it re-strip the same rows and repeat the same value.
  if (stepTracker && isAnthropicMessagesModel(request.model)) {
    stepTracker.anthropicThinkingStripStep = boundary.step;
  }
  return [
    ...stripAnthropicReasoning(outgoing.slice(0, boundary.index)),
    ...outgoing.slice(boundary.index),
  ];
}

/** The request this step sends, as the context budget measures and anchors it. */
export function buildContextBudgetRequest(
  request: Pick<
    StreamRequestConfig,
    "modelString" | "budgetMetadataModel" | "system" | "tools" | "toolSearchState"
  >,
  agentToolsDisabled: boolean,
  forceFirstStepTools: string[] | undefined,
  messages: ModelMessage[]
): ContextBudgetAnchorRequest {
  return {
    model: request.modelString,
    metadataModel: request.budgetMetadataModel,
    system: request.system,
    tools: agentToolsDisabled ? undefined : request.tools,
    // Native tool search sends deferred tools without loading them into context.
    activeTools:
      forceFirstStepTools ?? computeContextLoadedToolNames(request.toolSearchState, messages),
    messages,
  };
}

/**
 * The turn anchor counts the request at the level the turn started at. A thinking override the
 * step applied (the step-0 rebuild, or options only when it failed) changes which reasoning is
 * sent, so the step uses the full estimate then (#7662).
 */
function turnAnchorAfterOverride(
  request: Pick<StreamRequestConfig, "contextBudgetTurnAnchor">,
  thinkingOverride: Record<string, unknown> | undefined
): TurnBudgetAnchor | undefined {
  return thinkingOverride === undefined ? request.contextBudgetTurnAnchor : undefined;
}

/**
 * Hard-stop the step when its assembled request exceeds the safe context budget. Step zero has
 * no settled step, so it counts against the turn anchor, as the turn-start check did (#7662).
 */
async function enforceContextBudgetPreflight(
  request: Pick<StreamRequestConfig, "onStepSettled">,
  modelContextLimit: number,
  budgetRequest: ContextBudgetAnchorRequest,
  previousRequest: ContextBudgetAnchorRequest | undefined,
  lastStep: Parameters<typeof createContextBudgetAnchor>[1],
  stepNumber: number,
  turnAnchor: TurnBudgetAnchor | undefined
): Promise<void> {
  const budgetOptions = { ...budgetRequest, modelContextLimit };
  const anchor =
    stepNumber === 0 ? turnAnchor : createContextBudgetAnchor(previousRequest, lastStep);
  const exceeded = await checkAssembledRequestBudgetForModel(budgetRequest, budgetOptions, anchor);
  // Step zero can follow executed tools on a fallback. This late hard stop
  // preserves settled results; it must not reset/replay the activated catalog.
  if (exceeded) {
    // The settled-step callback measured this same request and should have rolled
    // over first; reaching here after a settled step means the two measures diverged.
    if (stepNumber > 0 && request.onStepSettled != null)
      log.warn("Context budget preflight blocked after a settled step", {
        model: exceeded.model,
        estimate: exceeded.estimate,
        hardCeiling: exceeded.hardCeiling,
      });
    throw new ContextBudgetBlockedError(
      `The estimated next request exceeds the safe context budget for ${exceeded.model} (${exceeded.hardCeiling} tokens). Use /compact or reduce the active tool/context payload.`
    );
  }
}

/** prepareStep's return: undefined when the step sends what the SDK assembled. */
export function buildPrepareStepResult(step: {
  stepMessages: ModelMessage[];
  effectiveMessages: ModelMessage[];
  rebuiltFirstStepMessages: ModelMessage[] | undefined;
  forceFirstStepTools: string[] | undefined;
  activeTools: string[] | undefined;
  thinkingOverride: Record<string, unknown> | undefined;
}): PrepareStepResult<ToolSet> {
  const {
    stepMessages,
    effectiveMessages,
    rebuiltFirstStepMessages,
    forceFirstStepTools,
    activeTools,
    thinkingOverride,
  } = step;
  if (
    effectiveMessages === stepMessages &&
    activeTools === undefined &&
    thinkingOverride === undefined
  ) {
    return undefined;
  }
  return {
    ...(rebuiltFirstStepMessages != null
      ? { messages: rebuiltFirstStepMessages }
      : effectiveMessages === stepMessages
        ? {}
        : { messages: effectiveMessages }),
    ...(forceFirstStepTools !== undefined ? { toolChoice: "required" as const } : {}),
    ...(activeTools !== undefined ? { activeTools } : {}),
    // Defense in depth: the in-place request mutation is authoritative
    // (per-step deep-merge cannot delete keys); returning the rebuilt
    // options also covers any future SDK options snapshotting.
    ...(thinkingOverride !== undefined
      ? { providerOptions: thinkingOverride as ProviderOptions }
      : {}),
  };
}

/** What StepPreparation reads from StreamManager. */
export interface StepPreparationDeps {
  readonly providerRequest: Pick<ProviderRequest, "swapPrefix" | "applyPendingThinkingOverride">;
  readonly historyService: Pick<HistoryService, "getContinuousCompactionJournal">;
  /** Injected stream factory; undefined uses the AI SDK's streamText, resolved at call time. */
  readonly streamTextOverride?: typeof streamText;
  /** StreamManager's stop conditions (step limit, settled-step budget, required tool). */
  readonly createStopWhenCondition: (
    request: StreamRequestConfig,
    stepTracker: StepMessageTracker | undefined
  ) => Array<ReturnType<typeof stepCountIs>>;
}

/**
 * Builds a turn's streamText call and prepares each of its steps: the messages phase
 * (rewrite, prefix swap, record) hands off to the request phase (tools, thinking, rebuild,
 * replay strip, context budget, result).
 */
export class StepPreparation {
  constructor(private readonly deps: StepPreparationDeps) {}

  /**
   * Write a swapped prefix's journal entry, then send the swapped messages only if the swap
   * is still current: same thinking level, not aborted, still the staged swap. Returns the
   * messages the step sends.
   */
  private async commitPrefixSwap(
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker: StepMessageTracker,
    workspaceId: string,
    { swap, swapped, stepNumber }: StagedPrefixSwap,
    effectiveMessages: ModelMessage[]
  ): Promise<ModelMessage[]> {
    const store = this.deps.historyService.getContinuousCompactionJournal(workspaceId);
    const thinkingLevel = request.thinkingOverrideState?.applied;
    const isCurrent = () =>
      stepTracker.pendingPrefixSwap === swap &&
      !abortController.signal.aborted &&
      request.thinkingOverrideState?.pending == null &&
      request.thinkingOverrideState?.applied === thinkingLevel;
    const journal = await store.write(
      { ...swap.journal, stepNumber },
      swap.prefix,
      isCurrent,
      (committed) => {
        swap.journal = committed;
      }
    );
    if (journal && isCurrent()) {
      swap.journal = journal;
      swap.consumed = true;
      stepTracker.consumedPrefixSwap = swap;
      return swapped;
    }
    if (journal && stepTracker.pendingPrefixSwap === swap) {
      // A thinking change can also arrive after write()'s last fence.
      await store.clear(journal);
    }
    return effectiveMessages;
  }

  /**
   * prepareStep's messages phase: rewrite the step's messages, apply a staged prefix swap
   * and record the messages the step sends. streamText runs one LLM call per step.
   */
  private async prepareStepMessages(
    context: StepPreparationContext,
    step: StepPreparationInput
  ): Promise<PrepareStepResult<ToolSet>> {
    const { request, abortController, stepTracker } = context;
    const { messages: stepMessages, stepNumber } = step;
    // streamText runs multiple internal LLM calls (steps) when tools are enabled.
    const rewritten = await transformStepMessages(stepMessages);
    let effectiveMessages = rewritten === stepMessages ? stepMessages : rewritten;
    if (stepTracker?.prefixSwapInvalidated) {
      // Cross-family fallback must not send the old provider's cached prefix.
      // Release only on the session's stop, after fallback reset/locks have completed.
      if (!abortController.signal.aborted) {
        await new Promise<void>((resolve) =>
          abortController.signal.addEventListener("abort", () => resolve(), { once: true })
        );
      }
      throw prefixSwapInvalidationReason(abortController.signal);
    }
    // Auto-set thinking raises itself when the turn looks stuck, through the same
    // override the slider uses (so the swap check below sees it too); a slider move
    // this turn hands the level to the user.
    const escalationState = stepTracker?.autoThinkingEscalation;
    const overrideState = request.thinkingOverrideState;
    const escalation = stageAutoThinkingEscalation(escalationState, overrideState, stepMessages);
    // The staged prefix was prepared under the previous thinking options.
    // Keep full context if those options change before the swap is consumed.
    dropVoidedPrefixSwap(request, stepTracker);
    const swap = stepTracker?.pendingPrefixSwap;
    if (swap && stepTracker?.workspaceId) {
      const swapped = this.deps.providerRequest.swapPrefix(effectiveMessages, swap);
      if (swapped) {
        effectiveMessages = await this.commitPrefixSwap(
          request,
          abortController,
          stepTracker,
          stepTracker.workspaceId,
          { swap, swapped, stepNumber },
          effectiveMessages
        );
      }
      if (stepTracker.pendingPrefixSwap === swap) stepTracker.pendingPrefixSwap = undefined;
    }
    // Dedupe after the swap, never before: the swap replaces the prefix this
    // projection is decided against, and the SDK accumulates the next step's
    // input from these returned messages, so a reference dropped against a
    // swapped-out prefix would stay lost for the rest of the turn.
    effectiveMessages = dedupeNativeToolReferences(effectiveMessages);
    recordStepMessages(request, stepTracker, effectiveMessages);
    // Hand off without an await, so the request phase starts in the same tick.
    return this.prepareStepRequest(context, step, {
      effectiveMessages,
      escalation,
      escalationState,
      overrideState,
    });
  }

  /**
   * prepareStep's request phase: tools, the thinking override, the step-0 rebuild, the
   * replay strip and the context budget, then the step's prepareStep result.
   */
  private async prepareStepRequest(
    context: StepPreparationContext,
    step: StepPreparationInput,
    staged: StagedStepMessages
  ): Promise<PrepareStepResult<ToolSet>> {
    const { request, stepTracker, agentToolsDisabled, replayBoundary } = context;
    const { messages: stepMessages, stepNumber, steps } = step;
    const { escalation, escalationState, overrideState } = staged;
    let { effectiveMessages } = staged;
    const { forceFirstStepTools, activeTools } = selectStepActiveTools(
      request,
      stepNumber,
      agentToolsDisabled
    );
    // Mid-turn thinking-level change: consume a pending override before
    // this step's provider request is built. Before the turn's first request it
    // resolves as at turn start (#5279); without a tracker, assume a step ran.
    const firstTurnRequest = isFirstTurnRequest(stepTracker, stepNumber);
    const thinkingOverride = this.deps.providerRequest.applyPendingThinkingOverride(
      request,
      firstTurnRequest
    );
    if (stepTracker) stepTracker.providerRequestPrepared = true;
    settleAutoThinkingEscalation(escalation, escalationState, overrideState, thinkingOverride);
    // Step 0: an override consumed here raced stream setup (written during
    // startStream's awaits, after TurnRequestBuilder's pre-construction quiescence
    // fold). Message preparation is thinking-level-dependent (Anthropic
    // signed-reasoning transforms), so rebuild the first-step messages
    // under the applied level too; the closure also emits a superseding
    // turn envelope so wire, envelope, and replay agree.
    const pendingRebuild = startFirstStepRebuild(
      request,
      stepTracker,
      stepNumber,
      thinkingOverride
    );
    let rebuiltFirstStepMessages = pendingRebuild == null ? undefined : await pendingRebuild;
    // #5086, preserved thinking: a replayed in-turn thinking block stays valid only
    // while everything before it is unchanged. A consumed prefix swap or a change to
    // the advertised tool set edits that prefix, so rows sent up to that step never
    // replay reasoning again. Blocks produced after it are bound to the new prefix and
    // keep replaying (#5279). This applies to every Anthropic Messages thinking mode,
    // not only `between_tools` (which cannot carry blockBinding): only the direct API
    // route and anthropic-typed Coder AI Gateway instances send `drop_block`, so
    // adaptive/enabled thinking on other routes would 400.
    // Claude on Bedrock gets the same strip (#5841): Bedrock cannot take drop_block.
    const outgoing = rebuiltFirstStepMessages ?? effectiveMessages;
    advanceReasoningReplayBoundary(
      replayBoundary,
      activeTools,
      stepTracker?.consumedPrefixSwap,
      outgoing.length,
      stepNumber
    );
    const stripped = stripReasoningBeforeReplayBoundary(
      request,
      stepTracker,
      replayBoundary,
      outgoing
    );
    if (stripped != null) {
      if (rebuiltFirstStepMessages != null) {
        rebuiltFirstStepMessages = stripped;
      } else {
        effectiveMessages = stripped;
      }
    }
    // Taken before this step records its own request; step zero has no settled step.
    const previousRequest = stepNumber > 0 ? stepTracker?.contextBudgetRequest : undefined;
    const budgetRequest = buildContextBudgetRequest(
      request,
      agentToolsDisabled,
      forceFirstStepTools,
      rebuiltFirstStepMessages ?? effectiveMessages
    );
    if (stepTracker) stepTracker.contextBudgetRequest = budgetRequest;
    if (request.contextBudgetLimit != null) {
      await enforceContextBudgetPreflight(
        request,
        request.contextBudgetLimit,
        budgetRequest,
        previousRequest,
        steps.at(-1),
        stepNumber,
        turnAnchorAfterOverride(request, thinkingOverride)
      );
    }
    return buildPrepareStepResult({
      stepMessages,
      effectiveMessages,
      rebuiltFirstStepMessages,
      forceFirstStepTools,
      activeTools,
      thinkingOverride,
    });
  }

  createStreamResult(
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker?: StepMessageTracker
  ): Awaited<ReturnType<typeof streamText>> {
    // Retries can reuse the request, but each stream makes its own stop decision.
    delete request.stopCause;
    // Explicit <ToolSet> pins RUNTIME_CONTEXT to its default: mux tools use
    // Tool's `any` context, which would otherwise infect the inferred result
    // type (no-unsafe-return).
    // XUM_DISABLE_AGENT_TOOLS=1 sends no tools at all (see isAgentToolsDisabled). Every chat
    // turn, sub-agent and workflow agent streams through here.
    const agentToolsDisabled = isAgentToolsDisabled();
    const context: StepPreparationContext = {
      request,
      abortController,
      stepTracker,
      agentToolsDisabled,
      // #5086: see the `between_tools` replay guard in prepareStepRequest.
      replayBoundary: { index: 0, step: 0 },
    };
    return (this.deps.streamTextOverride ?? streamText)<ToolSet>({
      model: request.model,
      messages: request.messages,
      system: request.system,
      // The assembler prepends Anthropic cached system prompts to `messages`.
      // AI SDK 7 rejects system messages inside `messages` unless opted in.
      // Trusted: mux builds these messages server-side.
      allowSystemInMessages: true,
      abortSignal: abortController.signal,
      prepareStep: (step) => this.prepareStepMessages(context, step),
      onChunk: request.onChunk,
      tools: agentToolsDisabled ? undefined : request.tools,
      experimental_transform: summarizeInvalidToolInputErrors(),
      stopWhen: this.deps.createStopWhenCondition(request, stepTracker),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      providerOptions: request.providerOptions as any, // Pass provider-specific options (thinking/reasoning config)
      headers: request.headers, // Per-request HTTP headers (e.g., anthropic-beta for 1M context)
      maxOutputTokens: request.maxOutputTokens,
      ...(request.streamCallSettings ?? {}),
    });
  }
}
