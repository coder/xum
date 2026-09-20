import { parseWorkspaceTurnTaskCorrelation, type MuxMessageMetadata } from "@/common/types/message";
import { eventSpine } from "../events/eventSpine";
import { isRlmModeEnabled } from "../branchSummary";
import {
  buildAutoCompactionFollowUp,
  inheritOpenWorkspaceTurnMetadata,
  computeKeepRecentTailStamp,
  isCompactionRequestMetadata,
} from "./compactionRequests";
import type { BeforeSendInput, BeforeSendOutcome } from "./types";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { SendMessageOptions } from "@/common/orpc/types";
import { isAnthropic1MEffectivelyEnabled } from "@/common/utils/ai/providerOptions";
import { log } from "../log";
import { ContinuousStrategy } from "./strategies/continuous";
import { SummarizeStrategy } from "./strategies/summarize";
import { resolveContextStrategy } from "./selection";
import type { StreamContextSnapshot, ContextResetReason } from "./types";
import { CompactionHandler } from "../compactionHandler";
import { CompactionMonitor } from "../compactionMonitor";
import type { ContextManagementDependencies } from "./contextManagementService";
import type { SessionContextHost } from "./sessionContextHost";

/** Owns automatic context policy; the session retains admission, publication and dispatch. */
export class SessionContextController {
  readonly compaction: Pick<
    CompactionHandler,
    | "handleCompletion"
    | "ackPendingStateConsumed"
    | "peekPendingState"
    | "peekCarryoverState"
    | "peekCachedFilePaths"
    | "discardPendingStateDurably"
    | "appendHeartbeatContextResetBoundary"
    | "rollbackHeartbeatContextResetBoundary"
  >;
  /** Removed after Continuous construction and Token Budget retry move behind this controller. */
  readonly transitionalCompactionHandler: CompactionHandler;
  private readonly compactionMonitor: CompactionMonitor;

  private readonly continuous: ContinuousStrategy;
  private readonly summarize: SummarizeStrategy;

  constructor(
    private readonly deps: ContextManagementDependencies,
    private readonly host: SessionContextHost
  ) {
    this.transitionalCompactionHandler = new CompactionHandler({
      workspaceId: host.workspaceId,
      historyService: deps.historyService,
      sessionDir: host.sessionDir,
      telemetryService: deps.telemetryService,
      emitter: host.emitter,
      onCompactionComplete: (metadata) => {
        // RLM keep-recent floor: tail copies make the summary no longer the last row.
        // Record before notifying the session's external observer, including clearing a
        // previous continuous summary ID when a later resumeless fold has no tail.
        host.coordinator.recordCompactionSummary(
          (metadata.preservedTailMessageCount ?? 0) > 0 ? metadata.summaryMessageId : null
        );
        host.onCompactionComplete?.(metadata);
      },
      onIdleCompactionOutcome: (success) => host.onIdleCompactionOutcome?.(success),
    });
    // Keep the handler receiver intact while limiting the session's permanent API surface.
    this.compaction = this.transitionalCompactionHandler;
    this.compactionMonitor = new CompactionMonitor(host.workspaceId, (event) =>
      host.emitChatEvent(event)
    );
    this.continuous = new ContinuousStrategy(
      deps,
      host,
      this.transitionalCompactionHandler,
      this.compactionMonitor
    );
    this.summarize = new SummarizeStrategy(host, this.continuous);
  }

  get autoCompactionThreshold(): number {
    return this.compactionMonitor.getThreshold();
  }

  setAutoCompactionThreshold(threshold: number): void {
    const previous = this.autoCompactionThreshold;
    this.compactionMonitor.setThreshold(threshold);
    if (previous !== threshold) this.continuous.continuousCompactor.reset("threshold-changed");
  }

  onStreamStarting(): void {
    this.compactionMonitor.resetForNewStream();
  }

  reset(reason: ContextResetReason): void {
    this.continuous.continuousCompactor.reset(
      reason === "settings-changed"
        ? "context-changed"
        : reason === "context-refresh"
          ? "context-mutation"
          : reason
    );
  }

  onUserInterrupt(input: { abandonPartial: boolean }): void {
    if (input.abandonPartial || this.host.coordinator.midStreamCompactionPending) {
      this.host.coordinator.abandonCompaction();
      this.reset("user-interrupt");
    }
  }

  beginShutdown(): void {
    this.continuous.continuousCompactor.reset("shutdown");
  }
  dispose(): void {
    this.continuous.continuousCompactor.reset("dispose");
  }
  isApplying(): boolean {
    return this.continuous.continuousCompactor.isApplying();
  }
  recover(): Promise<boolean> {
    return this.continuous.recoverCompaction();
  }

  onStreamSettled(input: { model: string; options?: SendMessageOptions }): Promise<void> {
    return this.continuous.observeContinuousCompactionAtStreamEnd(input.model, input.options);
  }

  isTokenBudgetActive(options?: SendMessageOptions): boolean {
    const selection = resolveContextStrategy({
      experiments: options?.experiments,
      isEnabled: (id) =>
        typeof this.deps.aiService.isExperimentEnabled === "function" &&
        this.deps.aiService.isExperimentEnabled(id),
      isCompactionRequest: isCompactionRequestMetadata(options?.muxMetadata),
    });
    if (
      selection.tokenBudgetSuppressedBy === "continuous" ||
      selection.tokenBudgetSuppressedBy === "rlm"
    ) {
      log.debug("Token-budget rollover yields to continuous/RLM compaction", {
        workspaceId: this.host.workspaceId,
      });
    }
    return selection.configured === "token-budget" && selection.tokenBudgetSuppressedBy == null;
  }

  async onPrefixSwapInvalidated(messageId: string): Promise<void> {
    try {
      if (messageId !== this.host.streams.getStreamInfo(this.host.workspaceId)?.messageId) return;
      // Wait for the entire owning observer, including its follow-up dispatch.
      await this.continuous.waitForContinuousCompactionObservation();
      await this.continuous.continuousCompactor.waitForIdle();
      await this.continuous.waitForContinuousCompactionObservation();
      const context = this.host.state.stream;
      if (
        !context ||
        this.host.coordinator.compactionIntent.observation?.kind === "continuous" ||
        this.host.coordinator.midStreamCompactionPending ||
        messageId !== this.host.streams.getStreamInfo(this.host.workspaceId)?.messageId ||
        !this.host.streams.isStreaming(this.host.workspaceId)
      )
        return;
      await this.continuous.runContinuousCompactionObservation(async (token) => {
        const result = await this.continuous.observeCompaction(0, {
          ...this.continuous.getContinuousCompactionContext(context.modelString, context.options),
          phase: "mid-stream",
        });
        // The observation's finally settles the pending window only after this dispatches the
        // continuation; settling earlier would let an idle waiter race the follow-up send.
        await this.continuous.finishContinuousCompaction(result === "applied", context, token);
      });
    } catch (error) {
      await this.continuous.recoverContinuousCompactionFailure(error);
    }
  }

  async onUsage(input: {
    modelForUsage: string;
    usage: LanguageModelV2Usage;
    stream: StreamContextSnapshot | undefined;
    isCompactionRequest: boolean;
  }): Promise<void> {
    const { modelForUsage } = input;
    // Never recurse compaction while we're already running a compaction request.
    if (
      input.isCompactionRequest ||
      this.host.coordinator.midStreamCompactionPending ||
      this.host.coordinator.compactionIntent.observation?.kind === "continuous" ||
      this.isTokenBudgetActive(input.stream?.options)
    ) {
      return;
    }

    const streamContext = input.stream;
    const streamOptions = streamContext?.options;
    if (streamContext?.modelString !== modelForUsage) return;
    const continuousContext = this.continuous.getContinuousCompactionContext(
      modelForUsage,
      streamOptions
    );
    const usagePercent =
      continuousContext.contextWindowTokens > 0
        ? ((input.usage.inputTokens ?? input.usage.cachedInputTokens ?? 0) /
            continuousContext.contextWindowTokens) *
          100
        : 0;
    if (!continuousContext.enabled) this.continuous.continuousCompactor.reset("disabled");
    const consumedSwapPending = this.continuous.continuousCompactor.hasConsumedSwap();
    let continuousResult: "none" | "applied" | "fallback" = "none";
    if (continuousContext.enabled || consumedSwapPending) {
      // One usage handler owns the eventual resume; observe itself shares its
      // latch result, which must not dispatch the continuation twice.
      const observed = await this.continuous.runContinuousCompactionObservation(async (token) => {
        const result = await this.continuous.observeCompaction(usagePercent, {
          ...continuousContext,
          phase: "mid-stream",
        });
        if (this.host.coordinator.midStreamCompactionPending) {
          await this.continuous.finishContinuousCompaction(
            result === "applied",
            streamContext,
            token
          );
          return undefined;
        }
        if (result === "applied") this.host.transitionContextState("invalidate");
        return result;
      });
      if (observed === undefined) return;
      continuousResult = observed;
    }
    if (
      continuousResult === "applied" ||
      ((continuousContext.enabled || consumedSwapPending) && continuousResult !== "fallback")
    )
      return;
    if (this.host.state.stream !== streamContext) return;
    const shouldInterruptForCompaction = this.compactionMonitor.checkMidStream({
      model: modelForUsage,
      usage: input.usage,
      use1MContext: isAnthropic1MEffectivelyEnabled(
        modelForUsage,
        streamOptions?.providerOptions,
        streamContext?.providersConfig ?? null
      ),
      providersConfig: streamContext?.providersConfig ?? null,
      openaiWireFormat: streamOptions?.providerOptions?.openai?.wireFormat,
    });

    if (shouldInterruptForCompaction) {
      await this.summarize.interruptForCompaction();
    }
  }

  async beforeSend(input: BeforeSendInput): Promise<BeforeSendOutcome> {
    const modelForStream = input.modelForStream;
    const optionsForStream = input.options;
    const providersConfigForCompaction = this.host.state.providersConfig;
    // Recover before measuring pressure so the old pre-swap usage cannot force another fold.
    if (await this.recover()) this.host.transitionContextState("invalidate");
    const compactionResult = this.compactionMonitor.checkBeforeSend({
      model: modelForStream,
      usage: this.host.state.usage,
      use1MContext: isAnthropic1MEffectivelyEnabled(
        modelForStream,
        optionsForStream.providerOptions,
        providersConfigForCompaction
      ),
      providersConfig: providersConfigForCompaction,
      openaiWireFormat: optionsForStream.providerOptions?.openai?.wireFormat,
    });

    const continuousContext = this.continuous.getContinuousCompactionContext(
      modelForStream,
      optionsForStream
    );
    if (!continuousContext.enabled) this.reset("disabled");
    const continuousResult = continuousContext.enabled
      ? await this.continuous.observeCompaction(compactionResult.usagePercentage, {
          ...continuousContext,
          phase: "on-send",
        })
      : "none";
    if (continuousResult === "applied") this.host.transitionContextState("invalidate");
    if (await input.cancelBeforeAcceptance()) return { kind: "cancelled" };

    // A staged fold needs no compact turn. Without one, the experiment waits
    // until the force threshold; the legacy path retains its on-send threshold.
    const shouldCompactBeforeSend =
      this.autoCompactionThreshold < 1 &&
      (continuousContext.enabled
        ? continuousResult === "fallback" && compactionResult.shouldForceCompact
        : compactionResult.usagePercentage >= compactionResult.thresholdPercentage);
    // A new boundary would hide the summary needed to retire scoped Stop debt.
    // Keep ordinary input flowing, but defer legacy compaction until cleanup succeeds.
    // An explicit replacement instead publishes its witness before compaction can hide debt.
    if (
      shouldCompactBeforeSend &&
      (input.replacement || !(await this.host.isCompactionRecoveryBlocked()))
    ) {
      this.reset("legacy-fallback");
      const followUpFileParts = input.fileParts?.map((part) => ({
        url: part.url,
        mediaType: part.mediaType,
        filename: part.filename,
      }));

      // A monitor-wake continuation of an open delegated turn is about to be
      // consumed by compaction; capture the correlation from pre-compaction
      // history now, because the correlated queue-cut assistant will be
      // hidden behind the new boundary when the follow-up dispatches.
      let inheritedWorkspaceTurnMetadata:
        | Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
        | undefined;
      if (input.muxMetadata?.type === "bash-monitor-wake") {
        // Reactivated continuations carry a fresh identity that older history must not replace.
        const explicitCorrelation = parseWorkspaceTurnTaskCorrelation(input.muxMetadata);
        if (explicitCorrelation != null) {
          inheritedWorkspaceTurnMetadata = {
            type: "workspace-turn-task",
            ...explicitCorrelation,
          };
        } else {
          const preCompactionHistory = await this.deps.historyService.getHistoryFromLatestBoundary(
            this.host.workspaceId
          );
          if (preCompactionHistory.success) {
            inheritedWorkspaceTurnMetadata = inheritOpenWorkspaceTurnMetadata(
              preCompactionHistory.data
            );
          }
        }
      }

      const followUpContent = buildAutoCompactionFollowUp({
        messageText: input.messageText,
        options: optionsForStream,
        modelForStream,
        fileParts: followUpFileParts,
        agentInitiated: input.agentInitiated,
        goalKind: input.goalKind,
        goalId: input.goalId,
        muxMetadata: input.muxMetadata,
        workspaceTurnMetadata: inheritedWorkspaceTurnMetadata,
        autoModelRouting: input.autoModelRouting,
      });

      // Waterfall hook point: lets registered middleware (e.g. refinement
      // journaling) run before context is compacted away. No-op when empty.
      await eventSpine.run("compaction.prepare", {
        workspaceId: this.host.workspaceId,
        reason: "on-send",
      });

      const autoCompactionRequest = this.host.buildAutoCompactionRequest({
        followUpContent,
        baseOptions: optionsForStream,
        reason: "on-send",
      });

      // RLM keep-recent floor: stamp on-send auto-compaction requests with
      // the durable tail-start sequence. No-op when RLM is off.
      if (autoCompactionRequest.metadata.type === "compaction-request") {
        const enabled = isRlmModeEnabled(
          optionsForStream.experiments,
          typeof this.deps.aiService.isExperimentEnabled === "function"
            ? (id) => this.deps.aiService.isExperimentEnabled(id)
            : undefined
        );
        const stamp = await computeKeepRecentTailStamp(
          this.deps.historyService,
          this.host.workspaceId,
          enabled
        );
        if (stamp !== undefined)
          autoCompactionRequest.metadata = {
            ...autoCompactionRequest.metadata,
            keepRecentTail: stamp,
          };
      }

      return {
        kind: "compact-first",
        request: autoCompactionRequest,
        usagePercent: Math.round(compactionResult.usagePercentage),
      };
    }
    return { kind: "proceed" };
  }
}
