/**
 * Context-budget corrections for Claude models whose provider tokenizer counts more tokens than
 * the local `claude` encoding (ai-tokenizer's Opus 4.5 stand-in) we estimate with.
 *
 * Measured 2026-09-29 by replaying 212 real requests (145 Anthropic, including 37 tool-heavy,
 * 30 with images/files and 43 with 100k+ char system prompts, all with prompt-cache blocks; and
 * 67 OpenAI) through the estimator and comparing with provider count endpoints (#5219):
 * - Claude Opus 4.7+, the 5.x generation and Fable count 1.33-1.55x the local encoding on the
 *   same text, so the estimate ran 0.76-0.92x of the provider count (116 of 145 under).
 * - Every replayed step needed a ratio of at most 1.523 on the encoded text (with the tool
 *   overhead below) to stay at or above the provider count; 1.55 leaves ~2% margin
 *   (min estimate/provider 1.016, median 1.36).
 * - Older Claude models count 1.02-1.16x the local encoding; the estimate's per-byte structure
 *   charge keeps them above the provider count on the replay (min 1.036), so they get no ratio.
 * Trade-off: the corrected estimate runs above provider usage (median ~1.36x on long replayed
 * sessions), so Token Budget rolls over earlier and its final checkpoint prompt rarely opens
 * until #5223; anchoring to provider-reported input (#4858 Phase 1) tightens the estimate.
 */
export const NEW_CLAUDE_TOKENIZER_RATIO = 1.55;

/**
 * Anthropic's tool-use framing costs this much per advertised tool beyond the schema JSON the
 * estimator encodes, on every Claude model: 114-116 tokens per tool on the replayed requests
 * (about 40 tools each), and a code-heavy 6-tool fixture came out 0.6% under the provider count
 * on claude-sonnet-4-6 without it.
 */
export const CLAUDE_TOOL_OVERHEAD_TOKENS = 120;

/**
 * Anthropic's fixed tool-use preamble, charged once when any tool is advertised: a single small
 * tool cost 542 tokens on claude-sonnet-4-6 and 346 on claude-opus-5-5 (count_tokens, same date),
 * about 400 more than that tool's schema text and per-tool framing.
 */
export const CLAUDE_TOOL_PREAMBLE_TOKENS = 400;

/**
 * Claude model ids counted with the older tokenizer: the pre-3 families (claude-2.x, claude-v2 and
 * claude-instant on Bedrock), the 3.x family, Opus/Sonnet 4.x up to 4.6 and Haiku 4.x up to 4.5, in
 * family-first ("claude-opus-4-6") or generation-first ("claude-4-opus", "claude-4.5-haiku") order.
 * Versions may be dotted, dashed or joined (Copilot's "claude-opus-41"), and may carry
 * letter-led or date qualifiers ("-fast", "-latest", "-20250929", Bedrock "-v1"); a digit-led
 * qualifier never matches, so "claude-opus-4-7" is not read as 4 plus a suffix. Any other Claude
 * id, newer or unknown, gets the conservative new-tokenizer ratio.
 */
export const OLDER_CLAUDE_TOKENIZER_MODEL_ID =
  /^claude-(?:v[12]|instant|2(?:[.-]\d)?|3(?:[.-]?[57])?-(?:haiku|sonnet|opus)|(?:sonnet|opus)-4(?:[.-]?[0-6])?|haiku-4(?:[.-]?[0-5])?|4(?:[.-]?[0-6])?-(?:sonnet|opus)|4(?:[.-]?[0-5])?-haiku)(?:-(?:\d{8}|[a-z][a-z0-9]*))*$/;
