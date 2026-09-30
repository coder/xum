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
