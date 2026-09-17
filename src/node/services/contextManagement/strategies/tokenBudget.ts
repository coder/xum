import type { CompactionHandler } from "../../compactionHandler";
import { applyToolPolicyToNames } from "@/common/utils/tools/toolPolicy";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { resolveMemoryAccessPolicy } from "../../tools/memory";
import { getRequestPreludeMessageIds } from "@/common/utils/messages/requestPrelude";
import { isSyntheticSnapshotUserMessage } from "@/common/types/message";
import { createUserMessageId } from "../../utils/messageIds";
import type {
  StreamContextSnapshot,
  RestoreContextStreamInput,
  RestoredContextStream,
  ContextPublicationInput,
  ContextPublication,
  ContextRecoveryInput,
  ContextRecovery,
} from "../types";
import assert from "@/common/utils/assert";
import { randomUUID } from "crypto";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import type { SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import { Ok, Err, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { isAnthropic1MEffectivelyEnabled } from "@/common/utils/ai/providerOptions";
import { createRuntimeContextForWorkspace } from "@/node/runtime/runtimeHelpers";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { isSessionHistoryDisabled } from "@/common/utils/tools/toolPolicy";
import {
  CONTEXT_CONTINUE_DEDUPE_KEY,
  CONTEXT_WARNING_DEDUPE_KEY,
  FLUSH_RESERVE_TOKENS,
  OUTPUT_RESERVE_TOKENS,
} from "@/common/constants/contextBudget";
import {
  evaluateStepBudget,
  type StepBudgetEvaluation,
  getContextBudgetHardCeiling,
  getContextBudgetHandoffPoint,
  resolveContextBudgetFlushThinking,
} from "@/common/utils/compaction/contextBudget";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import {
  estimateFreshRequestTokensForModel,
  estimateToolResultTokensForModel,
} from "../../contextBudgetCounting";
import {
  createRolloverPrefix,
  createContextBudgetWarning,
  currentContextWindowId,
  hasRolloverEligibleMessages,
  hasUnconsumedNewContextRequest,
  estimateLastStepToolResults,
  getLastStepToolResults,
  type ContextWindowRollover,
} from "../../contextWindowRollover";
import { resolveAgentForStream, type AgentResolutionResult } from "../../agentResolution";
import { resolveWorkspaceModelFallbackChain } from "../../taskUtils";
import type { SettledStepBudget, SettledStepOutcome } from "../../streamManager";
import type { RequestAssemblySnapshot } from "../../events/eventSpine";
import { createUnknownSendMessageError } from "../../utils/sendMessageError";
import { log } from "../../log";
import type { ContextManagementDependencies } from "../contextManagementService";
import type { SessionContextHost } from "../sessionContextHost";
import type { ContinuationEntry, PreparationReceipt } from "../types";

/** Budget policy and window claims; the host retains queue and publication authority. */
export class TokenBudgetStrategy {
  // Slider edits cannot expand the budget of a reset that has already been queued.
  private pendingRollover?: ContextWindowRollover & { budgetTokens: number };
  /** Request-assembly snapshot admitted when a final flush was promised; pins the sealing reset. */
  private pendingRolloverSnapshot?: RequestAssemblySnapshot;
  private contextBudgetWarningClaimed = false;
  private contextBudgetHandoffClaimed = false;
  /** One final pre-rollover notes flush per window; derived from history on restart. */
  private contextBudgetFlushClaimed = false;
  private pendingBudgetPrompt?: "warn" | "handoff";
  private contextBudgetGeneration = 0;
  // Settled-step capability, used only to admit a legacy persisted final flush; advisories
  // resolve the dispatching permissions instead (unknown after restart until a step settles).
  private contextBudgetMemoryWritable: boolean | undefined;
  private contextBudgetHistoryAvailable = false;

  constructor(
    private readonly deps: ContextManagementDependencies,
    private readonly host: SessionContextHost,
    /** Persisted per-model threshold (fraction, `1` = disabled); resolved once per decision. */
    private readonly resolveThreshold: (model: string) => number,
    private readonly compaction: CompactionHandler,
    private readonly isActive: (options?: SendMessageOptions) => boolean
  ) {}

  discardFailedCarryover(
    pendingState: Parameters<CompactionHandler["discardPendingState"]>[1]
  ): Promise<void> {
    return this.compaction.discardPendingState("context_exceeded", pendingState);
  }

  capturePreparation(): PreparationReceipt {
    return { owner: this, generation: this.contextBudgetGeneration };
  }

  validatePreparation(receipt: PreparationReceipt): boolean {
    return receipt.owner === this && receipt.generation === this.contextBudgetGeneration;
  }

  private is1MContextEnabledForModel(
    model: string,
    options?: SendMessageOptions,
    providersConfig?: ProvidersConfigMap | null
  ): boolean {
    return isAnthropic1MEffectivelyEnabled(model, options?.providerOptions, providersConfig);
  }
  /**
   * A flush entry that can no longer run as the hidden memory-only step (mode inactive, rollover
   * disabled, intent dropped) becomes an ordinary continuation: neither the trigger text nor the
   * flag may reach the provider, delegated turns resolve stream metadata from the send options
   * (strip it there too), and the paired rollover continuation is dropped.
   */
  degradeFlushEntryToContinuation(
    userMessage: MuxMessage,
    options: SendMessageOptions
  ): SendMessageOptions {
    assert(
      userMessage.metadata?.muxMetadata?.contextBudgetFlush === true,
      "only flush entries are degraded"
    );
    userMessage.parts = [{ type: "text", text: "Continue" }];
    const { contextBudgetFlush: _dropped, ...rest } = userMessage.metadata.muxMetadata;
    userMessage.metadata.muxMetadata = rest;
    let next = options;
    if ((options.muxMetadata as MuxMessageMetadata | undefined)?.contextBudgetFlush === true) {
      const { contextBudgetFlush: _optionFlag, ...optionRest } =
        options.muxMetadata as MuxMessageMetadata;
      next = { ...options, muxMetadata: optionRest };
    }
    this.host.continuations.withdraw([CONTEXT_CONTINUE_DEDUPE_KEY], "removed");
    return next;
  }

  /**
   * Drop a pending reset (intent, pinned snapshot, flush claim) without touching queued
   * continuations: used when rollover can no longer seal the window but a paired "Continue"
   * must still dispatch as an ordinary continuation.
   */
  dropContextBudgetIntent(): void {
    this.pendingRollover = undefined;
    this.pendingRolloverSnapshot = undefined;
    this.contextBudgetFlushClaimed = false;
  }

  clearContextBudgetState(): void {
    this.contextBudgetGeneration += 1;
    this.pendingRollover = undefined;
    this.pendingRolloverSnapshot = undefined;
    this.pendingBudgetPrompt = undefined;
    this.contextBudgetWarningClaimed = false;
    this.contextBudgetHandoffClaimed = false;
    this.contextBudgetFlushClaimed = false;
    this.contextBudgetMemoryWritable = undefined;
    this.contextBudgetHistoryAvailable = false;
    this.host.continuations.withdraw(
      [CONTEXT_CONTINUE_DEDUPE_KEY, CONTEXT_WARNING_DEDUPE_KEY],
      "withdrawn-cut"
    );
  }

  async checkContextBudgetHistoryAccess(
    options: SendMessageOptions | undefined
  ): Promise<Result<void, SendMessageError>> {
    const blocked: Result<void, SendMessageError> = Err({
      type: "context_budget_blocked",
      message:
        "Context budget reached, but session_history is disabled. Enable it, use /compact, or /clear --soft.",
    });
    if (isSessionHistoryDisabled(options?.toolPolicy)) {
      return blocked;
    }
    // Agent allowlists and removals are absent from caller options. Resolve them before sealing
    // history, including after restart or switching agents between turns.
    const resolved = await this.resolveAgentForBudgetChecks(options);
    if (!resolved.success) return resolved;
    return isSessionHistoryDisabled(resolved.data.effectiveToolPolicy) ? blocked : Ok(undefined);
  }

  private async resolveContextBudgetAdvisoryPermissions(
    options: SendMessageOptions
  ): Promise<
    | Pick<
        Parameters<typeof createContextBudgetWarning>[0],
        "memoryWritable" | "sessionHistoryAvailable" | "newContextAvailable"
      >
    | undefined
  > {
    // A queued send may switch agents, policies, or experiments after the previous step settled.
    // Resolve the dispatching turn once; an inconclusive lookup must not claim an optional advisory.
    const resolved = await this.resolveAgentForBudgetChecks(options);
    if (!resolved.success) return undefined;
    const allowed = applyToolPolicyToNames(
      ["memory", "session_history", "new_context"],
      resolved.data.effectiveToolPolicy
    );
    const memoryEnabled =
      options.experiments?.memory ?? this.deps.aiService.isExperimentEnabled(EXPERIMENT_IDS.MEMORY);
    return {
      memoryWritable:
        memoryEnabled &&
        allowed.includes("memory") &&
        resolveMemoryAccessPolicy({
          planLike: resolved.data.agentIsPlanLike,
          editingCapable: isExecLikeEditingCapableInResolvedChain(
            resolved.data.agentInheritanceChain
          ),
        }).workspace === "readwrite",
      sessionHistoryAvailable: allowed.includes("session_history"),
      newContextAvailable: allowed.includes("new_context"),
    };
  }

  async resolveAgentForBudgetChecks(
    options: SendMessageOptions | undefined
  ): Promise<Result<AgentResolutionResult, SendMessageError>> {
    try {
      const metadata = await this.deps.aiService.getWorkspaceMetadata(this.host.workspaceId);
      if (!metadata.success) return Err(createUnknownSendMessageError(metadata.error));
      const resolved = await resolveAgentForStream({
        workspaceId: this.host.workspaceId,
        metadata: metadata.data,
        ...createRuntimeContextForWorkspace(metadata.data),
        requestedAgentId: options?.agentId,
        strictAgentResolution: options?.strictAgentResolution,
        disableWorkspaceAgents: options?.disableWorkspaceAgents ?? false,
        callerToolPolicy: options?.toolPolicy,
        cfg: this.deps.config.loadConfigOrDefault(),
        emitError: () => undefined,
        isAdvisorExperimentEnabled:
          options?.experiments?.advisorTool ??
          this.deps.aiService.isExperimentEnabled(EXPERIMENT_IDS.ADVISOR_TOOL),
        includeAgentPlugins: this.deps.aiService.isAgentPluginsEnabled?.() ?? false,
      });
      return resolved.success ? Ok(resolved.data) : Err(resolved.error);
    } catch (error) {
      return Err(createUnknownSendMessageError(getErrorMessage(error)));
    }
  }

  async captureRolloverRequestAssembly(): Promise<
    Result<RequestAssemblySnapshot, SendMessageError>
  > {
    if (!this.deps.aiService.captureRequestAssemblySnapshot)
      return Err({
        type: "context_budget_blocked",
        message: "Request assembly safety is unavailable; use /compact or retry after restarting.",
      });
    const captured = await this.deps.aiService.captureRequestAssemblySnapshot(
      this.host.workspaceId
    );
    if (!captured.success) return captured;
    assert(
      captured.data.workspaceId === this.host.workspaceId,
      "Rollover snapshot must match its workspace"
    );
    if (!captured.data.preservesToolset)
      return Err({
        type: "context_budget_blocked",
        message:
          "Context rollover is unavailable with request middleware that can change tools. Use /compact or a context-only integration.",
      });
    return captured;
  }

  async checkFreshContextBudget(
    userMessage: MuxMessage,
    model: string,
    options: SendMessageOptions | undefined,
    prelude: readonly MuxMessage[],
    providersConfig: ProvidersConfigMap | null = this.host.state.providersConfig
  ): Promise<Result<void, SendMessageError>> {
    const maxTokens = getEffectiveContextLimit(
      model,
      this.is1MContextEnabledForModel(model, options, providersConfig),
      providersConfig,
      { openaiWireFormat: options?.providerOptions?.openai?.wireFormat }
    );
    if (maxTokens == null || maxTokens <= 0) return Ok(undefined);
    // Historical usage includes old user/history content, not just system/schema
    // overhead. Keep the model-scaled floor; final assembly checks the actual prompt.
    const estimate = await estimateFreshRequestTokensForModel(
      {
        userText: userMessage.parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n"),
        attachments: userMessage.parts.filter((part) => part.type === "file"),
        prelude: prelude.map((row) => row.parts),
        modelContextLimit: maxTokens,
      },
      {
        model,
        metadataModel: resolveModelForMetadata(model, providersConfig),
      }
    );
    return estimate >= getContextBudgetHardCeiling(maxTokens)
      ? Err({
          type: "context_budget_blocked",
          message: `This message plus its snapshots and system context does not fit in a fresh context window for ${model}; shorten it, remove attachments, or use a larger model.`,
        })
      : Ok(undefined);
  }

  async prepareContextBudgetSend(
    userMessage: MuxMessage,
    options: SendMessageOptions
  ): Promise<
    Result<
      { prefix: MuxMessage[]; requestAssemblySnapshot?: RequestAssemblySnapshot },
      SendMessageError
    >
  > {
    const history = await this.deps.historyService.getHistoryFromLatestBoundary(
      this.host.workspaceId
    );
    if (!history.success) return Err(createUnknownSendMessageError(history.error));
    // A filesystem error can be reported after an atomic replacement became visible.
    // Disk wins over an unconsumed in-memory claim: never append the same rollover twice.
    if (
      this.pendingRollover &&
      history.data.some(
        (row) =>
          row.metadata?.muxMetadata?.type === "context-window-rollover" &&
          row.metadata.muxMetadata.rolloverId === this.pendingRollover?.rolloverId
      )
    ) {
      this.clearContextBudgetState();
    }
    this.contextBudgetWarningClaimed = history.data.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.handoff !== true
    );
    this.contextBudgetHandoffClaimed = history.data.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.handoff === true
    );
    // Retain legacy flush recovery; new windows no longer offer a final flush.
    this.contextBudgetFlushClaimed ||= history.data.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.final === true
    );
    const providersConfig = this.host.state.providersConfig;
    const maxTokens = getEffectiveContextLimit(
      options.model,
      this.is1MContextEnabledForModel(options.model, options, providersConfig),
      providersConfig,
      { openaiWireFormat: options.providerOptions?.openai?.wireFormat }
    );
    // Without a known limit the budget cannot be evaluated, but an already pending or durably
    // requested (new_context) rollover must still seal the window; the row then records the
    // observed usage as its limit.
    const knownLimit = maxTokens != null && maxTokens > 0;
    if (!knownLimit)
      log.warn("Token budget has no known model context limit", { model: options.model });
    // One threshold per budget decision; every gate below reads this same value.
    const threshold = this.resolveThreshold(options.model);
    const lastAssistant = history.data.findLast(
      (row) => row.role === "assistant" && row.metadata?.contextUsage
    );
    // History parsing is tolerant: discard corrupt counters at this boundary,
    // while the final assembled-request preflight still enforces the hard limit.
    const tokenCount = (value: unknown): number | undefined =>
      isNonNegativeInteger(value) && Number.isSafeInteger(value) ? value : undefined;
    const persistedUsage: AiSdkUsageLike | undefined = lastAssistant?.metadata?.contextUsage;
    const persistedProviderMetadata =
      lastAssistant?.metadata?.contextProviderMetadata ?? lastAssistant?.metadata?.providerMetadata;
    const persistedCacheWrite = (
      persistedProviderMetadata?.anthropic as { cacheCreationInputTokens?: unknown } | undefined
    )?.cacheCreationInputTokens;
    // A best-effort restart seed may be absent. Validate before display conversion:
    // SDK input is cache-inclusive, so adding raw cache counters would count them twice.
    const usage =
      this.host.state.usage?.lastContextUsage ??
      createDisplayUsage(
        {
          inputTokens: tokenCount(persistedUsage?.inputTokens),
          cachedInputTokens:
            tokenCount(persistedUsage?.cachedInputTokens) ??
            tokenCount(persistedUsage?.inputTokenDetails?.cacheReadTokens),
          inputTokenDetails: {
            cacheWriteTokens:
              tokenCount(persistedCacheWrite) ??
              tokenCount(persistedUsage?.inputTokenDetails?.cacheWriteTokens),
          },
        },
        options.model
      );
    const contextTokens =
      (tokenCount(usage?.input.tokens) ?? 0) +
      (tokenCount(usage?.cached.tokens) ?? 0) +
      (tokenCount(usage?.cacheCreate.tokens) ?? 0);
    const userText = userMessage.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const attachments = userMessage.parts.filter((part) => part.type === "file");
    const budgetModel = {
      model: options.model,
      metadataModel: resolveModelForMetadata(options.model, providersConfig),
    };
    const recordedLimit = knownLimit ? maxTokens : Math.max(1, contextTokens);
    // The estimate only feeds the budget decision; without a limit there is nothing to compare
    // against, so skip the (tokenizer-backed) work and its failure modes entirely.
    const newRequestTokens = knownLimit
      ? await estimateFreshRequestTokensForModel(
          { userText, attachments, systemFloorTokens: 0, modelContextLimit: maxTokens },
          budgetModel
        )
      : 0;
    // Dispatch must screen the same dense tool outputs as settlement, including after restart.
    const toolResultTokens = knownLimit
      ? await estimateToolResultTokensForModel(getLastStepToolResults(lastAssistant), budgetModel)
      : 0;
    const evaluateBudget = (): StepBudgetEvaluation =>
      knownLimit
        ? evaluateStepBudget({
            contextTokens: contextTokens + newRequestTokens,
            outputTokens: tokenCount(lastAssistant?.metadata?.contextUsage?.outputTokens) ?? 0,
            ...estimateLastStepToolResults(lastAssistant),
            toolResultTokens,
            modelContextLimit: maxTokens,
            threshold,
            warningEmitted: this.contextBudgetWarningClaimed,
            handoffRequested: this.contextBudgetHandoffClaimed,
          })
        : {
            decision: "continue",
            flushOpportunity: true,
            projected: contextTokens + newRequestTokens,
            hardCeiling: undefined,
          };
    const decision = evaluateBudget();
    // The queued flush entry must be recognized before the rollover logic below, which
    // `pendingRollover` would otherwise pre-empt. Re-check the headroom and the tool gates
    // with on-send numbers; degrade to an ordinary continuation when any no longer holds.
    if (userMessage.metadata?.muxMetadata?.contextBudgetFlush === true) {
      const rolloverEnabled = threshold < 1;
      // The hard ceiling reserves OUTPUT_RESERVE_TOKENS for the step's output; a model whose
      // inherent thinking minimum needs a larger flush cap must find that extra room too. A
      // refusal may hand the flush to a fallback model with its own (possibly higher) minimum,
      // so size the headroom for the largest cap any model in the chain would run with.
      const flushOutputBeyondReserve = Math.max(
        0,
        ...[
          options.model,
          ...resolveWorkspaceModelFallbackChain(
            this.deps.config.loadConfigOrDefault(),
            this.host.workspaceId,
            options.model,
            providersConfig
          ),
        ].map(
          (model) =>
            resolveContextBudgetFlushThinking(model, providersConfig).maxOutputTokens -
            OUTPUT_RESERVE_TOKENS
        )
      );
      const flushStillSafe =
        decision.hardCeiling !== undefined &&
        decision.projected + FLUSH_RESERVE_TOKENS + flushOutputBeyondReserve < decision.hardCeiling;
      // The prompt promises that the next message seals the window, so require the same
      // admission the rollover itself needs (history access, toolset-preserving middleware).
      // Threshold 100% disables automatic rollover: a flush promising a sealed window would lie.
      const receipt = this.capturePreparation();
      const admitted =
        this.pendingRollover != null &&
        rolloverEnabled &&
        flushStillSafe &&
        this.contextBudgetMemoryWritable === true &&
        this.contextBudgetHistoryAvailable &&
        (await this.checkContextBudgetHistoryAccess(options)).success
          ? await this.captureRolloverRequestAssembly()
          : undefined;
      // Re-read the intent gates after the last await: a Stop (interruptStream →
      // clearContextBudgetState) drops the intent and its paired continuation, so a flush
      // accepted now would run with nothing to seal the window. The threshold is fixed for
      // this decision; a slider move lands on the next one.
      if (
        admitted?.success &&
        this.validatePreparation(receipt) &&
        this.pendingRollover != null &&
        rolloverEnabled
      ) {
        // Keep pendingRollover and pin this admitted snapshot: the promised reset must not be
        // invalidated by registry changes that happen during the flush turn itself. The flush
        // request runs the same pinned middleware, so a tool-mutating hook registered after
        // this capture cannot add an executable tool to the memory-only turn either.
        this.pendingRolloverSnapshot = admitted.data;
        return Ok({
          prefix: [
            createContextBudgetWarning({
              contextTokens: decision.projected,
              maxTokens: recordedLimit,
              budgetTokens: this.pendingRollover.budgetTokens,
              memoryWritable: true,
              sessionHistoryAvailable: true,
              final: true,
            }),
          ],
          requestAssemblySnapshot: admitted.data,
        });
      }
      // Neither the trigger text nor the flush flag may leak into the fresh window.
      userMessage.parts = [{ type: "text", text: "Continue" }];
      const { contextBudgetFlush: _dropped, ...rest } = userMessage.metadata.muxMetadata;
      userMessage.metadata.muxMetadata = rest;
      if (!rolloverEnabled) {
        // Rollover was disabled after the pair was queued: drop the paired rollover entry and
        // the stale claims so nothing seals the window if rollover is re-enabled later, and a
        // later genuine rollover may offer the flush this turn never delivered.
        this.pendingRollover = undefined;
        this.contextBudgetFlushClaimed = false;
        this.host.continuations.withdraw([CONTEXT_CONTINUE_DEDUPE_KEY], "removed");
      }
    }
    if (this.pendingRollover != null && threshold >= 1) {
      // Rollover was disabled after the intent was recorded (e.g. during a flush turn that
      // ended without a settled tool step): a stale intent must not seal a later, unrelated
      // send once rollover is re-enabled.
      this.pendingRollover = undefined;
      this.pendingRolloverSnapshot = undefined;
      this.contextBudgetFlushClaimed = false;
    }
    // Durable model request: a successful new_context result in the window's last completed
    // assistant row whose rollover has not happened yet (it would sit behind a boundary
    // otherwise). Survives a restart that lost the in-memory intent and its queued
    // continuation; an interrupted (partial) row or a manual reset cancels it.
    // The receipt stays the window's last assistant row while history access is denied, so a
    // rejected send here would repeat on every later send: require access before honoring it.
    const modelRequested =
      this.pendingRollover == null &&
      hasUnconsumedNewContextRequest(history.data) &&
      (await this.checkContextBudgetHistoryAccess(options)).success;
    const shouldRollover =
      threshold < 1 &&
      (this.pendingRollover != null || decision.decision === "rollover" || modelRequested);
    const rollover: TokenBudgetStrategy["pendingRollover"] =
      shouldRollover && hasRolloverEligibleMessages(history.data)
        ? (this.pendingRollover ?? {
            type: "context-window-rollover",
            rolloverId: randomUUID(),
            reason: "on-send",
            ...(modelRequested ? { requestedBy: "model" as const } : {}),
            previousWindowId: currentContextWindowId(history.data),
            flushOpportunity: decision.flushOpportunity,
            contextTokens: decision.projected,
            maxTokens: recordedLimit,
            budgetTokens: getContextBudgetHardCeiling(recordedLimit),
          })
        : undefined;
    // Recovery access is required only when sealing old context, not for a
    // first request that crosses the proactive threshold but still fits below.
    if (rollover) {
      const access = await this.checkContextBudgetHistoryAccess(options);
      if (!access.success) return access;
    }
    const freshBudget = await this.checkFreshContextBudget(
      userMessage,
      options.model,
      options,
      rollover ? createRolloverPrefix(rollover) : []
    );
    if (!freshBudget.success) return freshBudget;
    if (rollover) {
      const pinned =
        this.pendingRollover != null && rollover === this.pendingRollover
          ? this.pendingRolloverSnapshot
          : undefined;
      const captured = pinned ? Ok(pinned) : await this.captureRolloverRequestAssembly();
      if (!captured.success) return captured;
      this.pendingRollover = rollover;
      this.pendingBudgetPrompt = undefined;
      userMessage.metadata = {
        ...userMessage.metadata,
        muxMetadata: {
          ...(userMessage.metadata?.muxMetadata ?? { type: "context-window-continuation" }),
          rolloverId: rollover.rolloverId,
        },
      };
      // An enqueued warning superseded by rollover must not warn in the fresh window.
      if (userMessage.metadata?.muxMetadata?.type === "context-budget-warning") {
        userMessage.parts = [{ type: "text", text: "Continue" }];
        userMessage.metadata.muxMetadata = undefined;
      }
      return Ok({ prefix: createRolloverPrefix(rollover), requestAssemblySnapshot: captured.data });
    }
    if (shouldRollover) {
      log.warn("Context-budget window is already fresh; skipping duplicate reset", {
        workspaceId: this.host.workspaceId,
      });
      this.pendingRollover = undefined;
    }
    if (userMessage.metadata?.muxMetadata?.type === "context-budget-warning") {
      this.pendingBudgetPrompt = undefined;
      return Ok({ prefix: [] });
    }
    // Advisory capabilities come from the dispatching agent, policy and experiments, so the first
    // send after a restart (where no step has settled yet, and a text-only reply never settles
    // one) still publishes its single advisory instead of staying silent until the ceiling.
    if (knownLimit && this.isActive(options)) {
      const receipt = this.capturePreparation();
      const permissions = await this.resolveContextBudgetAdvisoryPermissions(options);
      // Pending intent only owns the queued Continue. Recompute after awaits: a slider or policy
      // edit may upgrade, downgrade, or omit the row, and nothing is claimed until publication.
      const advisory = evaluateBudget();
      if (
        permissions &&
        this.validatePreparation(receipt) &&
        this.isActive(options) &&
        (advisory.decision === "warn" || advisory.decision === "handoff")
      ) {
        return Ok({
          prefix: [
            createContextBudgetWarning({
              contextTokens: advisory.projected,
              maxTokens: recordedLimit,
              budgetTokens: getContextBudgetHardCeiling(recordedLimit),
              handoffTokens: getContextBudgetHandoffPoint(recordedLimit, threshold),
              handoff: advisory.decision === "handoff",
              ...permissions,
            }),
          ],
        });
      }
    }
    return Ok({ prefix: [] });
  }

  async onContextBudgetStepSettled(step: SettledStepBudget): Promise<SettledStepOutcome> {
    const context = this.host.state.stream;
    const receipt = this.capturePreparation();
    if (!context?.options || !this.isActive(context.options)) {
      // Token-budget mode was disabled after the flush trigger was persisted or queued: nothing
      // restores or seals the window any more, so end the hidden turn after its single step
      // and drop whatever intent the disabled mode left behind. A queued paired "Continue"
      // stays: without a reset it is an ordinary continuation of the interrupted work, and for
      // a delegated turn it keeps the notes-only finish from being recorded as the task's
      // outcome (WorkspaceTurnManager defers while a same-turn continuation is pending).
      if (context?.contextBudgetFlushTurn === true) {
        this.dropContextBudgetIntent();
        return this.flushTurnRolloverOutcome();
      }
      return { decision: "continue" };
    }
    // Fallbacks rebuild this callback's model binding; never use the requested primary's limit.
    context.modelString = step.model;
    // A flush turn's memory-only toolset says nothing about what ordinary turns can use.
    if (context.contextBudgetFlushTurn !== true) {
      this.contextBudgetMemoryWritable = step.memoryWritable;
      this.contextBudgetHistoryAvailable = step.sessionHistoryAvailable;
    }
    const usage = createDisplayUsage(step.usage, step.model, step.providerMetadata);
    const maxTokens = getEffectiveContextLimit(
      step.model,
      this.is1MContextEnabledForModel(step.model, context.options, context.providersConfig ?? null),
      context.providersConfig ?? null,
      { openaiWireFormat: context.options?.providerOptions?.openai?.wireFormat }
    );
    // One threshold per settled step; the flush gate below reuses it.
    const threshold = this.resolveThreshold(step.model);
    const contextTokens = usage
      ? usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens
      : 0;
    // A settled successful new_context result asks for a rollover regardless of usage. Without
    // session_history nothing could be retrieved from the sealed window (and the reset could not
    // be admitted), and with automatic rollover disabled nothing could seal it, so such requests
    // are ignored rather than left to fail every send.
    const modelRequested =
      step.newContextRequested === true &&
      step.sessionHistoryAvailable &&
      threshold < 1 &&
      context.contextBudgetFlushTurn !== true;
    const knownLimit = maxTokens != null && maxTokens > 0;
    if (!knownLimit) {
      log.warn("Token budget has no known model context limit", { model: step.model });
      // Budget evaluation is impossible, but an explicit request needs no limit to be honored.
      if (!modelRequested) return { decision: "continue" };
    }
    const decision: StepBudgetEvaluation = knownLimit
      ? evaluateStepBudget({
          contextTokens,
          outputTokens: step.usage?.outputTokens ?? 0,
          toolResultChars: step.toolResultChars,
          imageParts: step.imageParts,
          toolResultTokens: step.toolResultTokens,
          modelContextLimit: maxTokens,
          threshold,
          warningEmitted: this.contextBudgetWarningClaimed,
          handoffRequested: this.contextBudgetHandoffClaimed,
        })
      : {
          decision: "continue",
          flushOpportunity: true,
          projected: contextTokens,
          hardCeiling: undefined,
        };
    // Rollover metadata records the limit the window was measured against; an unknown limit is
    // recorded as the observed usage so the row stays valid for display and downgrade parsing.
    const recordedLimit = knownLimit ? maxTokens : Math.max(1, contextTokens);
    // "block" only exists at threshold 100%, where requests are not offered and never honored.
    if (decision.decision === "block") return { decision: "block" };
    if (context.contextBudgetFlushTurn === true) {
      if (threshold >= 1) {
        // Rollover was disabled while the flush ran: nothing may seal this window, so drop the
        // stale intent. The paired "Continue" is kept on purpose: with the intent gone it
        // dispatches as an ordinary continuation of the interrupted work in this window, and a
        // delegated turn must not record the notes-only flush finish as the task's outcome
        // (WorkspaceTurnManager defers finalization while a same-turn continuation is pending).
        this.dropContextBudgetIntent();
        return this.flushTurnRolloverOutcome();
      }
      // A flush turn is bounded to one provider step even when the step no longer crosses the
      // threshold (larger model after a restart): stopping here lets the queued rollover
      // continuation seal the window.
      if (decision.decision !== "rollover") return this.flushTurnRolloverOutcome();
    }
    // A model request is honored like a budget rollover (continuation queued after every sibling
    // settled) so the model never re-executes side effects; the persisted tool result doubles as
    // the durable receipt that prepareRolloverRequest recovers after a restart.
    if (decision.decision === "continue" && !modelRequested) return { decision: "continue" };
    if (decision.decision === "rollover" || modelRequested) {
      const history = await this.deps.historyService.getHistoryFromLatestBoundary(
        this.host.workspaceId
      );
      if (!history.success) throw new Error(history.error);
      if (this.host.state.stream !== context || !this.validatePreparation(receipt))
        return { decision: "continue" };
      // The usable ceiling is the only forced boundary; there is no new final-flush offer.
      this.pendingBudgetPrompt = undefined;
      this.pendingRollover ??= {
        type: "context-window-rollover",
        rolloverId: randomUUID(),
        reason: "mid-stream",
        ...(modelRequested ? { requestedBy: "model" as const } : {}),
        previousWindowId: currentContextWindowId(history.data),
        flushOpportunity: decision.flushOpportunity,
        contextTokens: decision.projected,
        maxTokens: recordedLimit,
        budgetTokens: getContextBudgetHardCeiling(recordedLimit),
      };
    } else {
      assert(
        decision.decision === "warn" || decision.decision === "handoff",
        "Expected a budget advisory"
      );
      this.pendingBudgetPrompt = decision.decision;
    }
    // Keep the continuation's delegated-turn/goal attribution; the warning
    // itself is a separate durable prefix row when this entry dispatches.
    // Attachments of the triggering send must not ride along on maintenance continuations
    // (they would be re-sent, and could consume the flush's reserved headroom).
    const { fileParts: _fileParts, ...streamOptions } = context.options as SendMessageOptions & {
      fileParts?: unknown;
    };
    // Capture the exact successor before publishing the queue so handoff stops retain
    // upstream queue-cut attribution without creating a final-flush pair.
    let continuationEntryId: string | undefined;
    if (this.host.continuations.isEmpty()) {
      const entry: ContinuationEntry = {
        admissionCapture: context.admissionCapture,
        text: "Continue",
        dedupeKey:
          this.pendingBudgetPrompt != null
            ? CONTEXT_WARNING_DEDUPE_KEY
            : CONTEXT_CONTINUE_DEDUPE_KEY,
        options: streamOptions,
        model: step.model,
        muxMetadata: {
          ...(context.workspaceTurnMetadata ?? { type: "normal" }),
          contextBudgetContinuation: true,
        },
        goalKind: context.goalKind,
        goalId: context.goalId,
      };
      continuationEntryId = this.host.continuations.enqueue([entry], true);
    }
    // Nothing enqueued (unrelated input already queued): the stop designates no successor.
    return {
      decision: modelRequested
        ? "rollover"
        : decision.decision === "handoff"
          ? "warn"
          : decision.decision,
      ...(continuationEntryId != null ? { continuationEntryId } : {}),
    };
  }

  /**
   * A flush turn ends after one step for the rollover entry enqueued alongside it. That paired
   * entry (not whatever else may lead the queue) is the successor; if it was already dropped
   * (degraded flush, cleared queue) the stop designates none.
   */
  private flushTurnRolloverOutcome(): SettledStepOutcome {
    const continuationEntryId = this.host.continuations.designateSuccessor(
      CONTEXT_CONTINUE_DEDUPE_KEY
    );
    return {
      decision: "rollover",
      ...(continuationEntryId != null ? { continuationEntryId } : {}),
    };
  }

  restoreStream(
    input: RestoreContextStreamInput
  ):
    | Result<RestoredContextStream | undefined, SendMessageError>
    | Promise<Result<RestoredContextStream | undefined, SendMessageError>> {
    const { options, model: modelString, admissionCapture, goalKind, goalId } = input;
    let resumedFlushCannotWrite = false;
    // A resumed flush runs the middleware chain admitted for its promised reset (see
    // prepareContextBudgetSend), never the live registry.
    let resumedFlushSnapshot: RequestAssemblySnapshot | undefined;
    if (this.isActive(options)) {
      this.contextBudgetWarningClaimed = input.history.some(
        (row) =>
          row.metadata?.muxMetadata?.type === "context-budget-warning" &&
          row.metadata.muxMetadata.handoff !== true
      );
      this.contextBudgetHandoffClaimed = input.history.some(
        (row) =>
          row.metadata?.muxMetadata?.type === "context-budget-warning" &&
          row.metadata.muxMetadata.handoff === true
      );
      // A resumed final-flush turn must not offer a second flush in the same window.
      this.contextBudgetFlushClaimed ||= input.history.some(
        (row) =>
          row.metadata?.muxMetadata?.type === "context-budget-warning" &&
          row.metadata.muxMetadata.final === true
      );
      // Resuming a persisted flush turn must also restore its sealing intent: the durable
      // final warning promised that the next message starts fresh, so re-queue the rollover
      // continuation and keep the pending claim even if the resumed step no longer crosses
      // the threshold (e.g. a larger model was selected).
      const finalRow = input.history.findLast(
        (row) =>
          row.metadata?.muxMetadata?.type === "context-budget-warning" &&
          row.metadata.muxMetadata.final === true
      )?.metadata?.muxMetadata;
      const flushMuxMetadata = input.userMessage?.metadata?.muxMetadata;
      if (
        options &&
        flushMuxMetadata?.contextBudgetFlush === true &&
        finalRow?.type === "context-budget-warning" &&
        this.pendingRollover == null &&
        this.resolveThreshold(modelString) < 1
      ) {
        return (async () => {
          // The promised reset needs the same admission as any rollover; surface a failure
          // now (as the reset itself would) instead of resuming a flush that cannot be sealed.
          const access = await this.checkContextBudgetHistoryAccess(options);
          if (input.isAborted()) return Ok(undefined);
          if (!access.success) return access;
          const captured = await this.captureRolloverRequestAssembly();
          if (input.isAborted()) return Ok(undefined);
          if (!captured.success) return captured;
          this.pendingRolloverSnapshot = captured.data;
          resumedFlushSnapshot = captured.data;
          // The promised notes write needs a writable memory tool under the *current* options
          // and agent; when it is gone, degrade the resumed flush to a tool-less step so the
          // queued rollover still seals the window instead of running an unwritable flush.
          const resolvedAgent = await this.resolveAgentForBudgetChecks(options);
          if (input.isAborted()) return Ok(undefined);
          const memoryEnabled =
            options.experiments?.memory ??
            this.deps.aiService.isExperimentEnabled(EXPERIMENT_IDS.MEMORY);
          resumedFlushCannotWrite =
            !memoryEnabled ||
            !resolvedAgent.success ||
            applyToolPolicyToNames(["memory"], resolvedAgent.data.effectiveToolPolicy).length ===
              0 ||
            resolveMemoryAccessPolicy({
              planLike: resolvedAgent.data.agentIsPlanLike,
              editingCapable: isExecLikeEditingCapableInResolvedChain(
                resolvedAgent.data.agentInheritanceChain
              ),
            }).workspace !== "readwrite";
          this.pendingRollover = {
            type: "context-window-rollover",
            rolloverId: randomUUID(),
            reason: "mid-stream",
            previousWindowId: currentContextWindowId(input.history),
            flushOpportunity: true,
            contextTokens: finalRow.contextTokens,
            maxTokens: finalRow.maxTokens,
            // Legacy final warnings reported the full model limit.
            budgetTokens: finalRow.budgetTokens ?? finalRow.maxTokens,
          };
          if (this.host.continuations.isEmpty()) {
            const { contextBudgetFlush: _flush, ...continuationMetadata } = flushMuxMetadata;
            this.host.continuations.enqueue(
              [
                {
                  admissionCapture,
                  text: "Continue",
                  dedupeKey: CONTEXT_CONTINUE_DEDUPE_KEY,
                  options,
                  model: modelString,
                  muxMetadata: continuationMetadata,
                  goalKind,
                  goalId,
                },
              ],
              false
            );
          }
          return Ok({
            assemblySnapshot: resumedFlushSnapshot,
            cannotWrite: resumedFlushCannotWrite,
          });
        })();
      }
    } else if (input.userMessage?.metadata?.muxMetadata?.contextBudgetFlush === true) {
      // Token-budget mode is inactive but the persisted trigger still makes this a hidden
      // memory-only turn: pin a toolset-preserving middleware chain for it too, or run it
      // without tools when none can be pinned (the turn then only ends).
      return (async () => {
        const captured = await this.captureRolloverRequestAssembly();
        if (input.isAborted()) return Ok(undefined);
        if (captured.success) resumedFlushSnapshot = captured.data;
        else resumedFlushCannotWrite = true;
        return Ok({ assemblySnapshot: resumedFlushSnapshot, cannotWrite: resumedFlushCannotWrite });
      })();
    }

    return Ok({ assemblySnapshot: resumedFlushSnapshot, cannotWrite: resumedFlushCannotWrite });
  }

  normalizeSend(
    userMessage: MuxMessage,
    options: SendMessageOptions,
    active: boolean
  ): SendMessageOptions {
    // Token-budget mode went inactive with a reset pending: a flush turn may have stopped on a
    // required-tool success or a text-only finish, both of which bypass the settled-step callback
    // that normally drops the intent. Drop it here, unconditionally, so re-enabling the mode later
    // (possibly with a larger model) cannot seal a below-threshold context with a stale snapshot.
    if (!active && this.pendingRollover != null) this.dropContextBudgetIntent();
    // A queued flush entry dispatched after the mode went inactive cannot be admitted (no pinned
    // middleware snapshot, nothing to seal): dispatch it as an ordinary continuation instead of a
    // hidden memory-only turn, and drop its paired continuation (mirrors the pre-dispatch degrade).
    if (!active && userMessage.metadata?.muxMetadata?.contextBudgetFlush === true) {
      options = this.degradeFlushEntryToContinuation(userMessage, options);
    }
    return options;
  }

  preparePublication(input: ContextPublicationInput): ContextPublication {
    const { userMessage } = input;
    let { prefixRows, options, assemblySnapshot } = input;
    // The flush admission above happened several awaits ago (snapshots, goal safety, history).
    // Re-check at publication: if rollover was disabled or a Stop dropped the intent meanwhile,
    // the durable final warning would promise a fresh window nothing will deliver. Publish an
    // ordinary continuation instead (same degrade as the dispatch-time check).
    const flushPrefix =
      prefixRows[0]?.metadata?.muxMetadata?.type === "context-budget-warning" &&
      prefixRows[0].metadata.muxMetadata.final === true;
    if (
      flushPrefix &&
      (this.pendingRollover == null || this.resolveThreshold(options.model) >= 1) &&
      userMessage.metadata?.muxMetadata?.contextBudgetFlush === true
    ) {
      options = this.degradeFlushEntryToContinuation(userMessage, options);
      prefixRows = [];
      assemblySnapshot = undefined;
      this.dropContextBudgetIntent();
    }
    return { prefixRows, options, assemblySnapshot, receipt: this.capturePreparation() };
  }

  onSendAccepted(userMessage: MuxMessage, prefixRows: readonly MuxMessage[]): void {
    const published = [...prefixRows, userMessage];
    this.contextBudgetWarningClaimed ||= published.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.handoff !== true
    );
    this.contextBudgetHandoffClaimed ||= published.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.handoff === true
    );
    this.contextBudgetFlushClaimed ||= prefixRows.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.final === true
    );
    this.pendingBudgetPrompt = undefined;
  }

  /** `model` is the failing request's model: fallbacks may differ from the requested primary. */
  canRecover(stream: StreamContextSnapshot, model: string): boolean {
    return !stream.contextBudgetRetried && this.resolveThreshold(model) < 1;
  }

  async prepareRecovery(
    input: ContextRecoveryInput
  ): Promise<Result<ContextRecovery | undefined, SendMessageError>> {
    const { userMessage: user, context, model, estimate } = input;
    const preludeIds = new Set(
      getRequestPreludeMessageIds(user.metadata?.requestPreludeMessageIds)
    );
    const priorRows = input.history.filter(
      (row) =>
        row !== user &&
        !isSyntheticSnapshotUserMessage(row) &&
        !(preludeIds.has(row.id) && row.role === "assistant" && row.metadata?.synthetic === true)
    );
    if (!hasRolloverEligibleMessages(priorRows)) return Ok(undefined);
    const maxTokens = getEffectiveContextLimit(
      model,
      this.is1MContextEnabledForModel(model, context.options, context.providersConfig),
      context.providersConfig,
      { openaiWireFormat: context.options?.providerOptions?.openai?.wireFormat }
    );
    if (maxTokens == null || maxTokens <= 0) return Ok(undefined);
    // An admitted final-flush trigger that overflowed at assembly must not carry its
    // internal text or flag into the fresh window; without the flag the request builder
    // applies the ordinary toolset again, so it continues as a normal turn. Delegated turns
    // resolve stream metadata from the send options, so strip the flag there too.
    const wasFlush = user.metadata?.muxMetadata?.contextBudgetFlush === true;
    const optionsMuxMetadata = context.options?.muxMetadata as MuxMessageMetadata | undefined;
    let retryOptions = context.options;
    if (wasFlush && context.options && optionsMuxMetadata?.contextBudgetFlush === true) {
      const { contextBudgetFlush: _flag, ...rest } = optionsMuxMetadata;
      retryOptions = { ...context.options, muxMetadata: rest };
    }
    const access = await this.checkContextBudgetHistoryAccess(retryOptions);
    if (!input.isCurrent()) return Ok(undefined);
    if (!access.success) return access;
    // A flush's promised reset was admitted when the flush dispatched; reuse that snapshot
    // so registry changes during the flush cannot reject the emergency reset either.
    const captured =
      wasFlush && this.pendingRolloverSnapshot
        ? Ok(this.pendingRolloverSnapshot)
        : await this.captureRolloverRequestAssembly();
    if (!input.isCurrent()) return Ok(undefined);
    if (!captured.success) return captured;
    const rollover: ContextWindowRollover = {
      type: "context-window-rollover",
      rolloverId: randomUUID(),
      reason: "context-exceeded",
      previousWindowId: currentContextWindowId(input.history),
      flushOpportunity: false,
      contextTokens: estimate ?? maxTokens,
      maxTokens,
    };
    const { historySequence: _sequence, ...metadata } = user.metadata ?? {};
    const { contextBudgetFlush: _flushFlag, ...muxMetadata } = metadata.muxMetadata ?? {
      type: "context-window-continuation" as const,
    };
    const continuation: MuxMessage = {
      ...user,
      id: createUserMessageId(),
      ...(wasFlush ? { parts: [{ type: "text", text: "Continue" }] } : {}),
      metadata: {
        ...metadata,
        timestamp: Date.now(),
        muxMetadata: { ...muxMetadata, rolloverId: rollover.rolloverId },
      },
    };
    return Ok({
      prefixRows: createRolloverPrefix(rollover),
      assemblySnapshot: captured.data,
      continuation,
      options: retryOptions,
      preludeIds,
    });
  }
}
