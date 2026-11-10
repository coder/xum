import { isPlainObject } from "@/common/utils/isPlainObject";

/**
 * Finish reasons that signal the provider deliberately declined to answer.
 * - "content-filter": the AI SDK's unified finish reason for refusals
 *   (Anthropic maps stop_reason "refusal" to it; OpenAI maps content filters).
 * - "refusal": Anthropic's raw stop_reason, matched defensively in case a
 *   provider adapter passes the raw value through.
 */
export function isRefusalFinishReason(reason: string | undefined): reason is string {
  return reason === "content-filter" || reason === "refusal";
}

/**
 * Anthropic refusal categories with no recommended fallback model: "the refusal stands", and
 * the prompt must change instead (Fable 5.2 "Refusals, fallback, and billing"; "Keep reasoning
 * in thinking blocks" in https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
 * Every other category, and a refusal without one, may still fall back.
 */
const NO_FALLBACK_REFUSAL_CATEGORIES: ReadonlySet<string> = new Set(["reasoning_extraction"]);

/**
 * The refusing step's no-fallback category, read from `anthropic.stopDetails.category` in its
 * provider metadata (the shape @ai-sdk/anthropic maps `stop_details` to), else undefined.
 */
export function readNoFallbackRefusalCategory(providerMetadata: unknown): string | undefined {
  const anthropic = isPlainObject(providerMetadata) ? providerMetadata.anthropic : undefined;
  const stopDetails = isPlainObject(anthropic) ? anthropic.stopDetails : undefined;
  const category = isPlainObject(stopDetails) ? stopDetails.category : undefined;
  return typeof category === "string" && NO_FALLBACK_REFUSAL_CATEGORIES.has(category)
    ? category
    : undefined;
}
