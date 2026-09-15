import assert from "@/common/utils/assert";
import type { SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxMessage, CompactionFollowUpRequest } from "@/common/types/message";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import { isAnthropic1MEffectivelyEnabled } from "@/common/utils/ai/providerOptions";
import { injectPostCompactionAttachments } from "@/browser/utils/messages/modelMessageTransform";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { extractEditedFileDiffs } from "@/common/utils/messages/extractEditedFiles";
import { extractReadFilePaths, mergeReadFilePaths } from "@/common/utils/messages/extractReadFiles";
import {
  extractLoadedSkillSnapshotsFromMessages,
  mergeLoadedSkillSnapshots,
} from "../../agentSkills/loadedSkillSnapshots";
import { ContinuousCompactor, type ContinuousCompactionContext } from "../../continuousCompactor";
import { summarizeContinuousCompaction } from "../../continuousCompactionSummary";
import type { CompactionHandler } from "../../compactionHandler";
import type { CompactionMonitor } from "../../compactionMonitor";
import type { CompactionToken } from "../../turnCoordinator";
import { eventSpine } from "../../events/eventSpine";
import { log } from "../../log";
import { resolveContextStrategy } from "../selection";
import { buildAutoCompactionFollowUp, isCompactionRequestMetadata } from "../compactionRequests";
import type { ContextManagementDependencies } from "../contextManagementService";
import type { SessionContextHost } from "../sessionContextHost";
import type { StreamContextSnapshot } from "../types";

type SessionCompactionContext = ContinuousCompactionContext & { sendOptions?: SendMessageOptions };

function is1MContextEnabledForModel(
  model: string,
  options?: SendMessageOptions,
  providers?: ProvidersConfigMap | null
): boolean {
  return isAnthropic1MEffectivelyEnabled(model, options?.providerOptions, providers);
}

/** Owns eager work, prefix swaps and observation latches; the session retains dispatch authority. */
export class ContinuousStrategy {
  readonly continuousCompactor: ContinuousCompactor;
  private continuousCompactionObservation: Promise<void> | null = null;

  constructor(
    private readonly deps: ContextManagementDependencies,
    private readonly host: SessionContextHost,
    private readonly handler: CompactionHandler,
    private readonly monitor: CompactionMonitor
  ) {
    this.continuousCompactor = new ContinuousCompactor({
      workspaceId: this.host.workspaceId,
      enterExecution: () => this.host.coordinator.enterExecution(),
      historyService: this.deps.historyService,
      compactionHandler: handler,
      streamManager: {
        isStreaming: (workspaceId) => this.host.streams.isStreaming(workspaceId),
        setPrefixSwap: (workspaceId, swap) =>
          this.host.streams.setPrefixSwap?.(workspaceId, swap) ?? false,
        clearPrefixSwap: (workspaceId) => this.host.streams.clearPrefixSwap?.(workspaceId),
        getPrefixSwapState: (workspaceId) =>
          this.host.streams.getPrefixSwapState?.(workspaceId) ?? "none",
        getStreamInfo: (workspaceId) => {
          const info = this.host.streams.getStreamInfo(workspaceId);
          return (
            info && {
              ...info,
              stepStartIndices: info.stepStartIndices ?? [],
              currentStepStartIndex: info.currentStepStartIndex ?? 0,
            }
          );
        },
      },
      prepare: () =>
        eventSpine.run("compaction.prepare", {
          workspaceId: this.host.workspaceId,
          reason: "continuous-eager",
        }),
      estimateAttachmentTokens: async (head) => {
        const attachments = await this.buildContinuousCompactionAttachments(head);
        return injectPostCompactionAttachments([], attachments).reduce(
          (sum, row) => sum + estimateMuxMessageTokens(row),
          0
        );
      },
      prepareSwap: async (head) => {
        // A consumed swap may need the fast-stop fallback on a provider-family hop.
        if (!this.host.state.stream?.options) return null;
        const prepared = this.host.streams.getPrefixSwapPreparation?.(this.host.workspaceId);
        if (!prepared) return null;
        const attachments = await this.buildContinuousCompactionAttachments(head);
        return { ...prepared, attachments };
      },
      summarize: (head, signal, context: SessionCompactionContext) => {
        const baseOptions = context.sendOptions ?? { model: context.model, agentId: "exec" };
        const request = this.host.buildAutoCompactionRequest({
          baseOptions,
          followUpContent: { text: "Continue", model: context.model, agentId: "exec" },
          reason: "on-send",
        });
        return summarizeContinuousCompaction({
          workspaceId: this.host.workspaceId,
          config: this.deps.config,
          aiService: this.deps.aiService,
          sessionUsageService: this.deps.sessionUsageService,
          head,
          signal,
          context,
          baseOptions,
          compactOptions: request.sendOptions,
        });
      },
      fastApply: (apply) => this.interruptForContinuousCompaction(apply),
    });
  }

  private async buildContinuousCompactionAttachments(head: MuxMessage[]) {
    const pending = await this.handler.peekPendingState();
    const warm = await this.handler.peekCarryoverState();
    return this.host.buildAttachments({
      diffs: [...(pending?.diffs ?? []), ...extractEditedFileDiffs(head)],
      loadedSkills: mergeLoadedSkillSnapshots([
        ...(warm?.loadedSkills ?? []),
        ...(pending?.loadedSkills ?? []),
        ...extractLoadedSkillSnapshotsFromMessages(head),
      ]),
      readFilePaths: mergeReadFilePaths(warm?.readFiles ?? [], [
        ...(pending?.readFiles ?? []),
        ...extractReadFilePaths(head),
      ]),
      reportsCompletedBeforeMs: Date.now(),
    });
  }

  getContinuousCompactionContext(
    model: string,
    options?: SendMessageOptions
  ): SessionCompactionContext {
    const providersConfig = this.host.state.providersConfig;
    const selection = resolveContextStrategy({
      experiments: options?.experiments,
      isEnabled: (id) =>
        typeof this.deps.aiService.isExperimentEnabled === "function" &&
        this.deps.aiService.isExperimentEnabled(id),
      isCompactionRequest: isCompactionRequestMetadata(options?.muxMetadata),
    });
    return {
      enabled:
        selection.configured === "continuous" &&
        this.monitor.getThreshold() < 1 &&
        !this.host.coordinator.disposed &&
        !this.host.coordinator.closing &&
        !this.host.coordinator.compactionIntent.abandoned &&
        !this.host.coordinator.admissionBlocked &&
        !this.host.coordinator.editReserved &&
        !this.host.isWorkspaceArchivedOnDisk(),
      model,
      contextWindowTokens:
        getEffectiveContextLimit(
          model,
          is1MContextEnabledForModel(model, options, providersConfig),
          providersConfig
        ) ?? 0,
      thresholdPercent: this.monitor.getThreshold() * 100,
      systemMessageTokens:
        this.host.streams.getStreamInfo(this.host.workspaceId)?.initialMetadata
          ?.systemMessageTokens ?? this.host.state.systemMessageTokens,
      sendOptions: options,
    };
  }

  async observeContinuousCompactionAtStreamEnd(
    model: string,
    options?: SendMessageOptions
  ): Promise<void> {
    // fastApply waits for this handler to reach IDLE; waiting on its latch here
    // (or re-entering it from the generated Continue send) would deadlock.
    if (
      this.host.coordinator.midStreamCompactionPending ||
      this.continuousCompactor.isApplying() ||
      this.host.coordinator.editBlocked()
    )
      return;
    try {
      const context = this.getContinuousCompactionContext(model, options);
      if (!context.enabled && !this.continuousCompactor.hasConsumedSwap()) {
        this.continuousCompactor.reset("disabled");
        return;
      }
      const usage = this.monitor.checkBeforeSend({
        model,
        usage: this.host.state.usage,
        use1MContext: is1MContextEnabledForModel(model, options, this.host.state.providersConfig),
        providersConfig: this.host.state.providersConfig,
      });
      const result = await this.observeCompaction(usage.usagePercentage, {
        ...context,
        phase: "stream-end",
      });
      if (result === "applied") this.host.transitionContextState("invalidate");
    } catch (error) {
      await this.recoverContinuousCompactionFailure(error);
    }
  }

  async recoverContinuousCompactionFailure(error: unknown, ownsObservation = false): Promise<void> {
    log.warn(
      "[continuous-compaction] observation failed; preserving durable recovery state",
      error
    );
    try {
      // An invalidated prepareStep waits for abort. If failure preceded the stop,
      // release that wait without resetting the consumed journal or saved follow-up.
      if (
        (!ownsObservation && this.host.coordinator.midStreamCompactionPending) ||
        !this.host.streams.isStreaming(this.host.workspaceId) ||
        this.host.streams.getPrefixSwapState?.(this.host.workspaceId) !== "invalidated"
      )
        return;
      const result = await this.host.streams.stopStream(this.host.workspaceId, {
        abortReason: "system",
      });
      if (!result.success) log.warn("[continuous-compaction] recovery stop failed", result.error);
    } catch (stopError) {
      log.warn("[continuous-compaction] recovery stop failed", stopError);
    }
  }

  async waitForContinuousCompactionObservation(): Promise<void> {
    while (this.continuousCompactionObservation) await this.continuousCompactionObservation;
  }

  async runContinuousCompactionObservation<T>(
    observe: (token: CompactionToken) => Promise<T>
  ): Promise<T | undefined> {
    if (this.host.coordinator.closing) return undefined;
    // Own the actual apply and its continuation; the compactor separately owns detached eager work.
    using _execution = this.host.coordinator.enterExecution();
    if (this.continuousCompactionObservation) {
      await this.continuousCompactionObservation;
      return undefined;
    }
    const token = this.host.coordinator.beginCompactionObservation("continuous");
    if (token == null) return undefined;
    let finish!: () => void;
    const observation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.continuousCompactionObservation = observation;
    try {
      return await observe(token);
    } catch (error) {
      await this.recoverContinuousCompactionFailure(error, true);
      return undefined;
    } finally {
      // Reserve through dispatch and cleanup, not just the compactor's apply latch.
      // Waiters/duplicate invalidations never own or clear these flags.
      if (this.continuousCompactionObservation === observation) {
        this.host.coordinator.finishCompactionObservation(token);
        this.continuousCompactionObservation = null;
        try {
          this.host.onCompactionObservationSettled();
        } catch (error) {
          log.warn("[continuous-compaction] queued drain failed", error);
        }
      }
      finish();
    }
  }

  async interruptForContinuousCompaction(
    apply: (pendingFollowUp?: CompactionFollowUpRequest) => Promise<boolean>
  ): Promise<boolean> {
    const context = this.host.state.stream;
    const observation = this.host.coordinator.compactionIntent.observation;
    if (
      observation?.kind !== "continuous" ||
      this.host.coordinator.midStreamCompactionPending ||
      !context?.options ||
      this.host.coordinator.disposed ||
      this.host.coordinator.closing
    ) {
      return false;
    }
    this.host.coordinator.setCompactionStage(observation.token, "stopping");
    const stopped = await this.host.streams.stopStream(this.host.workspaceId, {
      abortReason: "system",
    });
    if (!stopped.success) return false;
    this.host.coordinator.setCompactionStage(observation.token, "stopped");
    await this.host.waitForIdle();
    if (
      this.host.coordinator.disposed ||
      this.host.coordinator.closing ||
      this.host.coordinator.compactionIntent.abandoned ||
      this.host.isWorkspaceArchivedOnDisk()
    )
      return false;
    const followUp = this.buildContinuousCompactionFollowUp(context);
    // observe owns the apply latch. Its caller dispatches this continuation only
    // after observe returns, so the resumed send can observe normally.
    return apply(followUp);
  }

  private buildContinuousCompactionFollowUp(
    context: StreamContextSnapshot
  ): CompactionFollowUpRequest {
    assert(context.options, "Continuous compaction requires the interrupted send options");
    const followUp = buildAutoCompactionFollowUp({
      messageText: "Continue",
      modelForStream: context.modelString,
      options: context.options,
      agentInitiated: context.agentInitiated,
      goalKind: context.goalKind,
      goalId: context.goalId,
      muxMetadata: context.workspaceTurnMetadata,
    });
    followUp.dispatchOptions = { ...followUp.dispatchOptions, source: "internal-resume" };
    return followUp;
  }

  async finishContinuousCompaction(
    applied: boolean,
    context: StreamContextSnapshot,
    token: CompactionToken
  ): Promise<void> {
    assert(
      !this.continuousCompactor.isApplying(),
      "Continue must dispatch after the apply latch clears"
    );
    const observation = this.host.coordinator.compactionIntent.observation;
    if (observation?.token !== token || observation.stage !== "stopped" || !context.options) return;
    // A consumed journal is an outstanding durable obligation, not a failed
    // speculative summary. Leave it retryable instead of resetting into legacy compaction.
    if (!applied && this.continuousCompactor.hasConsumedSwap()) return;
    if (!applied) {
      const followUp = this.buildContinuousCompactionFollowUp(context);
      // The completed step can outgrow the staged tail budget during stop.
      // We already interrupted the turn, so recover using its captured context
      // rather than relying on activeStreamContext (cleared by stream-abort).
      if (
        this.host.coordinator.compactionIntent.abandoned ||
        this.host.coordinator.disposed ||
        this.host.coordinator.closing ||
        this.host.isWorkspaceArchivedOnDisk() ||
        this.host.coordinator.admissionBlocked
      )
        return;
      const pressure = this.monitor.checkBeforeSend({
        model: context.modelString,
        usage: this.host.state.usage,
        use1MContext: is1MContextEnabledForModel(
          context.modelString,
          context.options,
          context.providersConfig
        ),
        providersConfig: context.providersConfig,
      });
      if (pressure.shouldForceCompact) {
        await eventSpine.run("compaction.prepare", {
          workspaceId: this.host.workspaceId,
          reason: "mid-stream",
        });
      }
      const fallback = pressure.shouldForceCompact
        ? this.host.buildAutoCompactionRequest({
            baseOptions: context.options,
            followUpContent: followUp,
            reason: "mid-stream",
          })
        : undefined;
      this.continuousCompactor.reset("failed-fast-apply");
      await this.host.sendCompactionRequest(
        {
          messageText: fallback?.messageText ?? followUp.text,
          sendOptions: fallback
            ? { ...fallback.sendOptions, muxMetadata: fallback.metadata }
            : context.options,
          agentInitiated: fallback?.agentInitiated ?? context.agentInitiated,
          goalKind: fallback ? undefined : context.goalKind,
          goalId: fallback ? undefined : context.goalId,
        },
        {
          stream: context,
          admissionStale: () => this.host.coordinator.compactionIntent.abandoned,
          failureDisposition: "continuous-fallback",
        }
      );
      return;
    }
    this.host.transitionContextState("clear-usage");
    const summaryId = this.host.coordinator.compactionIntent.summaryId;
    await this.host.dispatchPendingFollowUp(
      summaryId,
      () => this.host.coordinator.compactionIntent.abandoned
    );
    if (this.host.coordinator.compactionIntent.summaryId === summaryId)
      this.host.coordinator.recordCompactionSummary(null);
  }

  async recoverCompaction(): Promise<boolean> {
    const admissionStale = this.host.captureCompactionAdmission("automatic");
    return (
      !(await this.host.isCompactionRecoveryBlocked()) &&
      !admissionStale() &&
      this.continuousCompactor.recover()
    );
  }

  async observeCompaction(...args: Parameters<ContinuousCompactor["observe"]>) {
    const admissionStale = this.host.captureCompactionAdmission("automatic");
    if ((await this.host.isCompactionRecoveryBlocked()) || admissionStale()) return "none" as const;
    return this.continuousCompactor.observe(...args);
  }
}
