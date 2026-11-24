import type { ServiceTier } from "@/common/config/schemas/providersConfig";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { normalizeSelectedModel } from "@/common/utils/ai/models";

export interface SendMessageOptionsInput {
  model: string;
  thinkingLevel: ThinkingLevel;
  reasoningMode: OpenAIReasoningMode;
  serviceTier?: ServiceTier;
  agentId: string;
  providerOptions: MuxProviderOptions;
  /** Composer Auto selection; only real user sends set it (compaction/resume paths leave it unset). */
  autoModelRouting?: boolean;
  /** Composer thinking level set to Auto; independent of autoModelRouting. */
  autoThinkingLevel?: boolean;
}

/** Normalize a preferred model string for routing while preserving explicit gateway choices. */
export function normalizeModelPreference(rawModel: unknown, fallbackModel: string): string {
  const trimmed =
    typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : null;
  return normalizeSelectedModel(trimmed ?? fallbackModel);
}

/**
 * Construct SendMessageOptions from normalized inputs.
 * Single source of truth for the send-option shape — backend enforces per-model policy.
 */
export function buildSendMessageOptions(input: SendMessageOptionsInput): SendMessageOptions {
  return {
    thinkingLevel: input.thinkingLevel,
    reasoningMode: input.reasoningMode,
    ...(input.serviceTier != null ? { serviceTier: input.serviceTier } : {}),
    model: input.model,
    agentId: input.agentId,
    providerOptions: input.providerOptions,
    autoModelRouting: input.autoModelRouting ? true : undefined,
    autoThinkingLevel: input.autoThinkingLevel ? true : undefined,
  };
}
