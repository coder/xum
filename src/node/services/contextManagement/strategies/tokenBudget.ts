import type { CompactionHandler } from "../../compactionHandler";
import { applyToolPolicyToNames } from "@/common/utils/tools/toolPolicy";
import { getRequestPreludeMessageIds } from "@/common/utils/messages/requestPrelude";
import { isSyntheticSnapshotUserMessage } from "@/common/types/message";
import { createUserMessageId } from "../../utils/messageIds";
import type {
  StreamContextSnapshot,
  RestoreContextStreamInput,
  ContextRecoveryInput,
  ContextRecovery,
} from "../types";
import assert from "@/common/utils/assert";
import { randomUUID } from "crypto";
import type { MuxMessage } from "@/common/types/message";
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
import { isSessionHistoryDisabled } from "@/common/utils/tools/toolPolicy";
import {
  CONTEXT_CONTINUE_DEDUPE_KEY,
  CONTEXT_WARNING_DEDUPE_KEY,
} from "@/common/constants/contextBudget";
import {
  evaluateStepBudget,
  type StepBudgetEvaluation,
  getContextBudgetHardCeiling,
  getContextBudgetHandoffPoint,
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
  private contextBudgetHandoffClaimed = false;
  /** One final prompt per window; derived from history on restart. */
  private contextBudgetFinalClaimed = false;
  private contextBudgetGeneration = 0;

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
  clearContextBudgetState(): void {
    this.contextBudgetGeneration += 1;
    this.pendingRollover = undefined;
    this.contextBudgetHandoffClaimed = false;
    this.contextBudgetFinalClaimed = false;
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
        "sessionHistoryAvailable" | "newContextAvailable"
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
    return {
      sessionHistoryAvailable: allowed.includes("session_history"),
      // Mirrors applyToolPolicy: new_context is only offered with memory and session_history.
      newContextAvailable: ["memory", "session_history", "new_context"].every((name) =>
        allowed.includes(name)
      ),
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
    this.contextBudgetHandoffClaimed = history.data.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.handoff === true
    );
    this.contextBudgetFinalClaimed = history.data.some(
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
    const evaluateBudget = (finalHandoffAvailable: boolean): StepBudgetEvaluation =>
      knownLimit
        ? evaluateStepBudget({
            contextTokens: contextTokens + newRequestTokens,
            outputTokens: tokenCount(lastAssistant?.metadata?.contextUsage?.outputTokens) ?? 0,
            ...estimateLastStepToolResults(lastAssistant),
            toolResultTokens,
            modelContextLimit: maxTokens,
            threshold,
            // The final prompt supersedes the handoff request.
            handoffRequested: this.contextBudgetHandoffClaimed || this.contextBudgetFinalClaimed,
            finalHandoffAvailable,
          })
        : {
            decision: "continue",
            projected: contextTokens + newRequestTokens,
            hardCeiling: undefined,
          };
    // Only the rollover decision and measurements matter here; prompts are chosen below.
    const decision = evaluateBudget(false);
    if (this.pendingRollover != null && threshold >= 1) {
      // Rollover was disabled after the intent was recorded: a stale intent must not seal a
      // later, unrelated send once rollover is re-enabled.
      this.pendingRollover = undefined;
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
            flushOpportunity: this.contextBudgetFinalClaimed,
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
      const captured = await this.captureRolloverRequestAssembly();
      if (!captured.success) return captured;
      this.pendingRollover = rollover;
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
      // The final prompt asks for new_context, so it is only offered when that tool is.
      const advisory = evaluateBudget(
        !this.contextBudgetFinalClaimed && permissions?.newContextAvailable === true
      );
      if (
        permissions &&
        this.validatePreparation(receipt) &&
        this.isActive(options) &&
        (advisory.decision === "handoff" || advisory.decision === "final")
      ) {
        return Ok({
          prefix: [
            createContextBudgetWarning({
              contextTokens: advisory.projected,
              maxTokens: recordedLimit,
              budgetTokens: getContextBudgetHardCeiling(recordedLimit),
              ...(advisory.decision === "handoff"
                ? {
                    handoffTokens: getContextBudgetHandoffPoint(recordedLimit, threshold),
                    handoff: true,
                  }
                : { final: true }),
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
    if (!context?.options || !this.isActive(context.options)) return { decision: "continue" };
    // Fallbacks rebuild this callback's model binding; never use the requested primary's limit.
    context.modelString = step.model;
    const usage = createDisplayUsage(step.usage, step.model, step.providerMetadata);
    const maxTokens = getEffectiveContextLimit(
      step.model,
      this.is1MContextEnabledForModel(step.model, context.options, context.providersConfig ?? null),
      context.providersConfig ?? null,
      { openaiWireFormat: context.options?.providerOptions?.openai?.wireFormat }
    );
    const threshold = this.resolveThreshold(step.model);
    const contextTokens = usage
      ? usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens
      : 0;
    // A settled successful new_context result asks for a rollover regardless of usage. Without
    // session_history nothing could be retrieved from the sealed window (and the reset could not
    // be admitted), and with automatic rollover disabled nothing could seal it, so such requests
    // are ignored rather than left to fail every send.
    const modelRequested =
      step.newContextRequested === true && step.sessionHistoryAvailable && threshold < 1;
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
          nextRequestTokens: step.nextRequestTokens,
          modelContextLimit: maxTokens,
          threshold,
          // The final prompt supersedes the handoff request.
          handoffRequested: this.contextBudgetHandoffClaimed || this.contextBudgetFinalClaimed,
          // The final prompt asks for new_context, so skip it when this step could not call it.
          finalHandoffAvailable: !this.contextBudgetFinalClaimed && step.newContextAvailable,
        })
      : { decision: "continue", projected: contextTokens, hardCeiling: undefined };
    // Rollover metadata records the limit the window was measured against; an unknown limit is
    // recorded as the observed usage so the row stays valid for display and downgrade parsing.
    const recordedLimit = knownLimit ? maxTokens : Math.max(1, contextTokens);
    // "block" only exists at threshold 100%, where requests are not offered and never honored.
    if (decision.decision === "block") return { decision: "block" };
    // A model request is honored like a budget rollover (continuation queued after every sibling
    // settled) so the model never re-executes side effects; the persisted tool result doubles as
    // the durable receipt that prepareRolloverRequest recovers after a restart.
    if (decision.decision === "continue" && !modelRequested) return { decision: "continue" };
    // The handoff request and the final prompt are prefix rows: the queued continuation's send
    // re-evaluates the budget, publishes the row, and claims it (prepareContextBudgetSend).
    const prompt =
      !modelRequested && (decision.decision === "handoff" || decision.decision === "final");
    if (!prompt) {
      const history = await this.deps.historyService.getHistoryFromLatestBoundary(
        this.host.workspaceId
      );
      if (!history.success) throw new Error(history.error);
      if (this.host.state.stream !== context || !this.validatePreparation(receipt))
        return { decision: "continue" };
      this.pendingRollover ??= {
        type: "context-window-rollover",
        rolloverId: randomUUID(),
        reason: "mid-stream",
        ...(modelRequested ? { requestedBy: "model" as const } : {}),
        previousWindowId: currentContextWindowId(history.data),
        flushOpportunity: this.contextBudgetFinalClaimed,
        contextTokens: decision.projected,
        maxTokens: recordedLimit,
        budgetTokens: getContextBudgetHardCeiling(recordedLimit),
      };
    }
    // Keep the continuation's delegated-turn/goal attribution; the prompt
    // itself is a separate durable prefix row when this entry dispatches.
    // Capture the exact successor before publishing the queue so the stop retains upstream
    // queue-cut attribution.
    let continuationEntryId: string | undefined;
    if (this.host.continuations.isEmpty()) {
      const entry: ContinuationEntry = {
        admissionCapture: context.admissionCapture,
        text: "Continue",
        dedupeKey: prompt ? CONTEXT_WARNING_DEDUPE_KEY : CONTEXT_CONTINUE_DEDUPE_KEY,
        options: context.options,
        model: step.model,
        muxMetadata: {
          ...(context.workspaceTurnMetadata ?? { type: "normal" }),
          contextBudgetContinuation: true,
        },
        autoModelRouting: context.autoModelRouting,
        goalKind: context.goalKind,
        goalId: context.goalId,
      };
      continuationEntryId = this.host.continuations.enqueue([entry], true);
    }
    // Nothing enqueued (unrelated input already queued): the stop designates no successor.
    return {
      decision: prompt ? "warn" : "rollover",
      ...(continuationEntryId != null ? { continuationEntryId } : {}),
    };
  }

  /** Re-derive this window's once-only claims from history before a stream resumes. */
  restoreStream(input: RestoreContextStreamInput): void {
    if (!this.isActive(input.options)) return;
    this.contextBudgetHandoffClaimed = input.history.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.handoff === true
    );
    this.contextBudgetFinalClaimed = input.history.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.final === true
    );
  }

  /**
   * A send dispatched while token-budget mode is inactive (e.g. the queued Continue of a reset
   * decided before the mode was turned off) drops the pending intent, so re-enabling the mode
   * later (possibly with a larger model) cannot seal a below-threshold context.
   */
  dropPendingRollover(): void {
    this.pendingRollover = undefined;
  }

  onSendAccepted(userMessage: MuxMessage, prefixRows: readonly MuxMessage[]): void {
    const published = [...prefixRows, userMessage];
    this.contextBudgetHandoffClaimed ||= published.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.handoff === true
    );
    this.contextBudgetFinalClaimed ||= published.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.final === true
    );
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
    const access = await this.checkContextBudgetHistoryAccess(context.options);
    if (!input.isCurrent()) return Ok(undefined);
    if (!access.success) return access;
    const captured = await this.captureRolloverRequestAssembly();
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
    const muxMetadata = metadata.muxMetadata ?? {
      type: "context-window-continuation" as const,
    };
    const continuation: MuxMessage = {
      ...user,
      id: createUserMessageId(),
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
      options: context.options,
      preludeIds,
    });
  }
}
