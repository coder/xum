export const EAGER_LEAD_PERCENT = 15;
export const TAIL_FRACTION = 0.2;
export const TAIL_MIN_TOKENS = 4_000;
export const TAIL_MAX_TOKENS = 60_000;
export const MIN_HEAD_TOKENS = 8_000;
export const SUMMARIZER_INPUT_FRACTION = 0.7;
// A compaction request that still hit context_exceeded retries once with this share of the
// input budget (trimCompactionInput): the chars/4 estimate missed, so leave a wide margin.
export const COMPACTION_RETRY_INPUT_BUDGET_SCALE = 0.5;
export const CONTINUOUS_COMPACTION_JOURNAL_FILE = "continuous-compaction.json";
export const CONTINUOUS_COMPACTION_GENERATION_FILE = "continuous-compaction-generation";
export const COMPACTION_CANCELLATION_FILE = "compaction-cancellation.json";
