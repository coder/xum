/**
 * Token Budget estimate corrections for requests counted with the local `claude` encoding
 * (ai-tokenizer's Opus 4.5 stand-in), #5219. These apply only to the context-budget estimator,
 * which only the opt-in Token Budget experiment uses; displayed token counts are unaffected.
 *
 * Calibrated 2026-09-29/30 by replaying 212 real requests (145 Anthropic with the new tokenizer,
 * including tool-heavy, image/file and 100k+ char system-prompt requests, all with prompt-cache
 * blocks; 67 OpenAI) against provider count endpoints. Newer Claude models (Opus 4.7+, 5.x,
 * Fable) count 1.33-1.55x the local encoding, so the uncorrected estimate ran 0.76-0.92x of the
 * provider count. The factor is the smallest 0.05 step of that sweep with no under-estimate and
 * at least 5% margin on every replayed request; the sweep table is in PR #5255.
 *
 * The same factor applies to every `claude`-encoded count, with no model-id classification, so
 * older Claude models (which count about 1.02-1.16x the local encoding) are over-counted on
 * purpose. That errs in the safe direction (Token Budget rolls over earlier; it never sends an
 * over-window request), is bounded by the factor, and only affects the opt-in experiment.
 * #4858 Phase 1 (anchoring each step on the previous provider-reported input tokens) removes
 * most of the over-count.
 */
export const CLAUDE_ENCODING_BUDGET_FACTOR = 1.6;

/**
 * Anthropic's tool-use framing beyond the schema JSON the estimator encodes, per advertised tool
 * (measured at 114-116 tokens per tool on the replayed requests, about 40 tools each).
 */
export const CLAUDE_TOOL_OVERHEAD_TOKENS = 120;

/**
 * Anthropic's fixed tool-use preamble, charged once when any tool is advertised. Measured with
 * count_tokens: a single small tool cost 542 tokens on claude-sonnet-4-6 and 346 on
 * claude-opus-5-5, which this charge plus the per-tool framing and schema text must cover.
 */
export const CLAUDE_TOOL_PREAMBLE_TOKENS = 400;
