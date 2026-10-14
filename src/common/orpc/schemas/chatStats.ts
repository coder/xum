import { z } from "zod";

/** Top file path entry for file_read/file_edit consumers */
export const TopFilePathSchema = z.object({
  path: z.string().meta({ description: "File path (relative or absolute)" }),
  tokens: z.number().meta({ description: "Token count for this file" }),
});

export const TokenConsumerSchema = z.object({
  name: z.string().meta({ description: '"User", "Assistant", "bash", "readFile", etc.' }),
  tokens: z.number().meta({ description: "Total token count for this consumer" }),
  percentage: z.number().meta({ description: "% of total tokens" }),
  fixedTokens: z
    .number()
    .optional()
    .meta({ description: "Fixed overhead (e.g., tool definitions)" }),
  variableTokens: z
    .number()
    .optional()
    .meta({ description: "Variable usage (e.g., actual tool calls, text)" }),
});

export const ChatUsageComponentSchema = z.object({
  tokens: z.number(),
  cost_usd: z.number().optional(),
});

export const ChatUsageDisplaySchema = z.object({
  input: ChatUsageComponentSchema,
  cached: ChatUsageComponentSchema,
  cacheCreate: ChatUsageComponentSchema,
  // Without it, the schema would strip the 1h-TTL share and repricing would drop its premium.
  cacheCreate1hTokens: z.number().optional(),
  output: ChatUsageComponentSchema,
  reasoning: ChatUsageComponentSchema,
  model: z.string().optional(),
  costsIncluded: z.boolean().optional(),
  // Without it, the schema would strip the tier and repricing would drop the premium (#4787).
  serviceTier: z.enum(["flex", "fast", "ultrafast", "unknown", "mixed"]).optional(),
  // Merged sums of unpriced requests hold numeric partial costs, so only this flag keeps the
  // unknown-pricing warning across IPC.
  hasUnknownCosts: z.boolean().optional(),
});

export const ChatStatsSchema = z.object({
  consumers: z.array(TokenConsumerSchema).meta({ description: "Sorted descending by token count" }),
  totalTokens: z.number(),
  model: z.string(),
  tokenizerName: z.string().meta({ description: 'e.g., "o200k_base", "claude"' }),
  usageHistory: z
    .array(ChatUsageDisplaySchema)
    .meta({ description: "Ordered array of actual usage statistics from API responses" }),
  topFilePaths: z
    .array(TopFilePathSchema)
    .optional()
    .meta({ description: "Top 10 files by token count aggregated across all file tools" }),
});

/**
 * Cached token statistics for consumer/file breakdown in the Costs tab.
 *
 * Stored inside session-usage.json to avoid re-tokenizing on every app start.
 */
export const SessionUsageTokenStatsCacheSchema = z.object({
  version: z.literal(1),
  computedAt: z.number().meta({ description: "Unix timestamp (ms) when this cache was computed" }),
  providersConfigVersion: z
    .number()
    .optional()
    .meta({ description: "Stable provider-config fingerprint used for this cache" }),
  model: z
    .string()
    .meta({ description: "Model used for tokenization (affects tokenizer + tool definitions)" }),
  tokenizerName: z.string().meta({ description: 'e.g., "o200k_base", "claude"' }),
  history: z.object({
    messageCount: z.number().meta({ description: "Number of messages used to compute this cache" }),
    maxHistorySequence: z
      .number()
      .optional()
      .meta({ description: "Max MuxMessage.metadata.historySequence seen in the message list" }),
  }),
  consumers: z.array(TokenConsumerSchema).meta({ description: "Sorted descending by token count" }),
  totalTokens: z.number(),
  topFilePaths: z
    .array(TopFilePathSchema)
    .optional()
    .meta({ description: "Top 10 files by token count aggregated across all file tools" }),
  // Non-strict object: an older build strips this on downgrade and simply recounts.
  source: z
    .object({ historyReceipt: z.string(), inputsKey: z.string() })
    .optional()
    .meta({ description: "History receipt + inputs digest this cache was counted from" }),
});

export const RolledUpChildEntrySchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  cacheCreateTokens: z.number().optional(),
  contextTokens: z.number().optional(), // input + cached + cacheCreate (for compaction estimates)
  totalCostUsd: z.number().optional(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  rolledUpAtMs: z.number(),
});
export type RolledUpChildEntry = z.infer<typeof RolledUpChildEntrySchema>;

/**
 * Cumulative session usage file format.
 * Stored in ~/.xum/sessions/{workspaceId}/session-usage.json
 */
/** Clock skew tolerated between the machine that wrote a fork marker and this one. */
const FORK_BOUNDARY_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function isPlausibleForkBoundary(timestamp: number): boolean {
  return (
    Number.isSafeInteger(timestamp) &&
    timestamp >= 0 &&
    timestamp <= Date.now() + FORK_BOUNDARY_MAX_FUTURE_SKEW_MS
  );
}

export const SessionUsageFileSchema = z.object({
  byModel: z.record(z.string(), ChatUsageDisplaySchema),
  lastRequest: z
    .object({
      model: z.string(),
      usage: ChatUsageDisplaySchema,
      timestamp: z.number(),
    })
    .optional(),
  /**
   * Idempotency ledger for rolled-up sub-agent usage.
   * Key: child workspaceId, value: true (legacy) or enriched roll-up metadata.
   */
  rolledUpFrom: z
    .record(z.string(), z.union([z.literal(true), RolledUpChildEntrySchema]))
    .optional(),
  tokenStatsCache: SessionUsageTokenStatsCacheSchema.optional(),
  /**
   * Set when a fork reset this ledger: the newest timestamp (ms since epoch) among the rows
   * the fork copied from its parent. Rows at or before it are inherited, so per-turn views
   * skip them; every row the fork writes itself is newer. A timestamp, not a history
   * sequence: editing an inherited message in the fork reuses lower sequences.
   * Self-healing: a value that cannot be a real timestamp (fractional, negative, or later
   * than now plus clock skew, which would hide every turn) is dropped, and the workspace
   * then shows every turn, as old forks without the marker do.
   */
  forkedAt: z.number().refine(isPlausibleForkBoundary).optional().catch(undefined),
  version: z.literal(1),
});
