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

    if (usagePercent < forceThresholdPercent) {
      return false;
    }

    this.hasTriggeredForCurrentStream = true;
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
