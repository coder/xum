import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import {
  checkAutoCompaction,
  type AutoCompactionCheckResult,
  type AutoCompactionUsageState,
} from "@/common/utils/compaction/autoCompactionCheck";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";
import { log } from "./log";

export type CompactionStatusEvent =
  | {
      type: "auto-compaction-triggered";
      reason: "on-send" | "mid-stream" | "idle";
      usagePercent: number;
    }
  | {
      type: "auto-compaction-completed";
      newUsagePercent: number;
    };

interface CheckBeforeSendParams {
  model: string | null;
  /** Threshold fraction resolved by the caller for this decision (`1` = disabled). */
  threshold: number;
  usage: AutoCompactionUsageState | undefined;
  use1MContext: boolean;
  providersConfig: ProvidersConfigMap | null;
  /** Request-level OpenAI wire format; decides whether the Codex OAuth cap applies. */
  openaiWireFormat?: OpenAIWireFormat | null;
}

interface CheckMidStreamParams {
  model: string;
  /** Threshold fraction resolved by the caller for this decision (`1` = disabled). */
  threshold: number;
  usage: LanguageModelV2Usage;
  use1MContext: boolean;
  providersConfig: ProvidersConfigMap | null;
  /** Request-level OpenAI wire format; decides whether the Codex OAuth cap applies. */
  openaiWireFormat?: OpenAIWireFormat | null;
}

/**
 * Tracks context-window pressure and decides when auto-compaction should trigger.
 *
 * The monitor holds no threshold of its own: the caller resolves it from the persisted user
 * preferences once per decision (see `resolveAutoCompactionThreshold`) so a slider change is
 * honored by the next decision without any RPC push or per-session cache.
 */
export class CompactionMonitor {
  private hasTriggeredForCurrentStream = false;
  /**
   * Set when auto-compaction triggers; cleared by a user turn or by a live mid-stream usage reading
   * below the threshold (proof that compaction relieved the pressure). While set, pressure that
   * stays high does not auto-compact again: when compaction cannot bring usage under the
   * threshold (a huge system prompt, or a provider reporting constant usage), every follow-up
   * would otherwise compact again in a loop (#4421). Clearing on relief, not only on a user
   * turn, keeps long autonomous runs (sub-agents never get user turns) able to compact again.
   */
  private awaitingRelief = false;

  constructor(
    private readonly workspaceId: string,
    private readonly onStatusChange: (event: CompactionStatusEvent) => void
  ) {
    assert(typeof workspaceId === "string", "CompactionMonitor requires a string workspaceId");
    assert(workspaceId.trim().length > 0, "CompactionMonitor requires a non-empty workspaceId");
    assert(
      typeof onStatusChange === "function",
      "CompactionMonitor requires an onStatusChange callback"
    );
  }

  /**
   * Called before sending a new message. The caller decides how to act on the result.
   */
  checkBeforeSend(params: CheckBeforeSendParams): AutoCompactionCheckResult {
    assert(
      params !== null && params !== undefined,
      "CompactionMonitor.checkBeforeSend requires params"
    );
    this.assertThreshold(params.threshold);

    return checkAutoCompaction(
      params.usage,
      params.model,
      params.use1MContext,
      params.threshold,
      undefined,
      params.providersConfig,
      { openaiWireFormat: params.openaiWireFormat }
    );
  }

  /**
   * Called on each usage-delta during streaming.
   * Returns true when mid-stream compaction should be triggered.
   */
  checkMidStream(params: CheckMidStreamParams): boolean {
    assert(
      params !== null && params !== undefined,
      "CompactionMonitor.checkMidStream requires params"
    );
    assert(
      params.model.trim().length > 0,
      "CompactionMonitor.checkMidStream requires a non-empty model"
    );
    this.assertThreshold(params.threshold);

    if (this.hasTriggeredForCurrentStream) {
      return false;
    }

    // Threshold 1.0 means auto-compaction is disabled.
    if (params.threshold >= 1) {
      return false;
    }

    const contextLimit = getEffectiveContextLimit(
      params.model,
      params.use1MContext,
      params.providersConfig,
      { openaiWireFormat: params.openaiWireFormat }
    );
    // Defensive: malformed provider overrides can yield invalid/non-positive limits.
    // Treat those as "no compaction signal" instead of throwing inside usage-delta handlers.
    if (!contextLimit || contextLimit <= 0) {
      return false;
    }

    // AI SDK v6 reports inputTokens as the full prompt context (including cache reads),
    // so adding cachedInputTokens here double-counts prompt-cached requests.
    // Fallback to cachedInputTokens only when inputTokens is unavailable.
    const usageTokens = params.usage.inputTokens ?? params.usage.cachedInputTokens ?? 0;
    assert(
      usageTokens >= 0,
      `CompactionMonitor(${this.workspaceId}): usage tokens must be non-negative`
    );

    const usagePercent = (usageTokens / contextLimit) * 100;
    const forceThresholdPercent = params.threshold * 100 + FORCE_COMPACTION_BUFFER_PERCENT;
    // Relief counts only from a live provider reading of the prompt. The on-send usage state
    // right after a compaction is an estimate (the summary's size), not a reading.
    if (usagePercent < params.threshold * 100) this.awaitingRelief = false;

    if (usagePercent < forceThresholdPercent) {
      return false;
    }

    this.hasTriggeredForCurrentStream = true;
    if (this.suppressRepeatedAutoCompaction("mid-stream", usagePercent)) {
      return false;
    }
    this.onStatusChange({
      type: "auto-compaction-triggered",
      reason: "mid-stream",
      usagePercent: Math.round(usagePercent),
    });
    return true;
  }

  resetForNewStream(): void {
    this.hasTriggeredForCurrentStream = false;
  }

  /** A real user turn re-arms auto-compaction even while pressure stays high. */
  noteUserTurn(): void {
    this.awaitingRelief = false;
  }

  /**
   * Returns true, and logs, when an auto-compaction must be skipped because the previous one
   * brought no relief and no user turn happened since. Otherwise arms the guard and returns false:
   * the caller then runs the compaction.
   */
  suppressRepeatedAutoCompaction(reason: "on-send" | "mid-stream", usagePercent: number): boolean {
    if (this.awaitingRelief) {
      log.warn(
        "Skipping auto-compaction: the previous auto-compaction did not bring usage under the threshold and no user turn happened since",
        { workspaceId: this.workspaceId, reason, usagePercent: Math.round(usagePercent) }
      );
      return true;
    }
    this.awaitingRelief = true;
    return false;
  }

  private assertThreshold(threshold: number): void {
    assert(
      Number.isFinite(threshold),
      `CompactionMonitor(${this.workspaceId}): threshold must be finite`
    );
    assert(
      threshold > 0 && threshold <= 1,
      `CompactionMonitor(${this.workspaceId}): invalid threshold ${threshold}`
    );
  }
}
