/**
 * Every priced model usage attached to one persisted assistant message.
 *
 * IMPORTANT: renderer-safe; must NOT import the tokenizer.
 */

import {
  hasTokenUsage,
  MODEL_FALLBACK_REFUSAL_TOOL_NAME,
  type MuxMetadata,
  type PersistedToolModelUsage,
} from "@/common/types/message";
import { createDisplayUsage } from "./displayUsage";
import type { ChatUsageDisplay } from "./usageAggregator";

export interface MessageModelUsage {
  /** Raw model ID as persisted (the ledger bucket derives from it). */
  model: string;
  metadataModel?: string;
  usage: ChatUsageDisplay;
  /** True for the message's own `metadata.usage`; false for a `toolModelUsages` entry. */
  isMessageUsage: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedToolModelUsage(value: unknown): value is PersistedToolModelUsage {
  return isPlainRecord(value) && typeof value.model === "string" && isPlainRecord(value.usage);
}

/**
 * The message's own usage, then each model-backed tool or refused fallback attempt in
 * `toolModelUsages`. The session-usage rebuild and the Costs tab's per-turn cache health
 * both read this, so a turn's rows add up to what the session ledger charged for it.
 *
 * Persisted history is not schema-validated: malformed tool snapshots are skipped instead
 * of failing the whole read.
 */
export function getAssistantMessageModelUsages(
  metadata: MuxMetadata | undefined,
  options?: {
    /** Pricing model for a usage without a persisted `metadataModel`. */
    resolveMetadataModel?: (model: string) => string;
  }
): MessageModelUsage[] {
  const result: MessageModelUsage[] = [];
  const push = (
    model: string,
    rawUsage: Parameters<typeof createDisplayUsage>[0],
    providerMetadata: Record<string, unknown> | undefined,
    metadataModel: string | undefined,
    isMessageUsage: boolean
  ) => {
    const usage = createDisplayUsage(
      rawUsage,
      model,
      providerMetadata,
      metadataModel ?? options?.resolveMetadataModel?.(model)
    );
    if (usage) result.push({ model, metadataModel, usage, isMessageUsage });
  };

  if (metadata?.usage) {
    push(
      // A row without a record-time model stays unpriced rather than borrowing another one.
      metadata.model ?? "unknown",
      metadata.usage,
      metadata.providerMetadata,
      metadata.metadataModel,
      true
    );
  }

  const toolModelUsages: unknown = metadata?.toolModelUsages;
  if (!Array.isArray(toolModelUsages)) return result;
  for (const toolModelUsage of toolModelUsages) {
    if (!isPersistedToolModelUsage(toolModelUsage)) continue;
    const model = toolModelUsage.model.trim();
    if (!model) continue;
    // Zero-usage refusal markers exist only so analytics can count refused
    // attempts; the live path never records them in the session ledger
    // (recordRefusedAttemptUsage skips recordSessionUsage without tokens).
    // Skip them here too so a rebuilt ledger matches the live one instead
    // of growing 0-token/$0 Costs rows for models that only ever refused.
    if (
      toolModelUsage.toolName === MODEL_FALLBACK_REFUSAL_TOOL_NAME &&
      !hasTokenUsage(toolModelUsage.usage)
    ) {
      continue;
    }
    push(
      model,
      toolModelUsage.usage,
      isPlainRecord(toolModelUsage.providerMetadata) ? toolModelUsage.providerMetadata : undefined,
      typeof toolModelUsage.metadataModel === "string" ? toolModelUsage.metadataModel : undefined,
      false
    );
  }
  return result;
}
