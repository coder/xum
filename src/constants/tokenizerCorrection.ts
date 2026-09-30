/**
 * Token Budget estimate corrections for requests counted with the local `claude` encoding
 * (ai-tokenizer's Opus 4.5 stand-in), #5219. These apply only to the context-budget estimator,
 * which only the opt-in Token Budget experiment uses; displayed token counts are unaffected.
 *
 * Measured 2026-09-29/30 by replaying 212 real requests (145 Anthropic with the new tokenizer,
 * including tool-heavy, image/file and 100k+ char system-prompt requests, all with prompt-cache
 * blocks; 67 OpenAI) against provider count endpoints. Newer Claude models (Opus 4.7+, 5.x,
 * Fable) count 1.33-1.55x the local encoding, so the uncorrected estimate ran 0.76-0.92x of the
 * provider count. Factor sweep (with the tool framing below), minimum estimate/provider:
 * 1.40 -> 0.934, 1.45 -> 0.963, 1.50 -> 0.993, 1.55 -> 1.023, 1.60 -> 1.052. 1.60 is the smallest
 * 0.05 step with no under-estimate and at least 5% margin on every replayed request.
 *
 * The same factor applies to every `claude`-encoded count, with no model-id classification, so
 * older Claude models (which count about 1.02-1.16x the local encoding) are over-counted on
 * purpose: about 1.5-1.9x their provider count on the replay. That errs in the safe direction
 * (Token Budget rolls over earlier; it never sends an over-window request), is bounded by this
 * factor, and only affects the opt-in experiment. #4858 Phase 1 (anchoring each step on the
 * previous provider-reported input tokens) removes most of the over-count.
 */
export const CLAUDE_ENCODING_BUDGET_FACTOR = 1.6;

/**
 * Anthropic's tool-use framing beyond the schema JSON the estimator encodes: 114-116 tokens per
 * advertised tool on the replayed requests (about 40 tools each).
 */
export const CLAUDE_TOOL_OVERHEAD_TOKENS = 120;

/**
 * Anthropic's fixed tool-use preamble, charged once when any tool is advertised: a single small
 * tool cost 542 tokens on claude-sonnet-4-6 and 346 on claude-opus-5-5 (count_tokens), about 400
 * more than that tool's schema text and per-tool framing.
 */
export const CLAUDE_TOOL_PREAMBLE_TOKENS = 400;
