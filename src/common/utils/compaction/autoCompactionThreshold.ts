import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import {
  AUTO_COMPACTION_THRESHOLD_EFFECTIVE_MIN_PERCENT,
  AUTO_COMPACTION_THRESHOLD_STORAGE_MAX,
  DEFAULT_AUTO_COMPACTION_THRESHOLD,
} from "@/common/constants/ui";
import assert from "@/common/utils/assert";

/** A stored 0% would compact before the first token; the monitor requires > 0. */
const MIN_FRACTION = AUTO_COMPACTION_THRESHOLD_EFFECTIVE_MIN_PERCENT / 100;

/**
 * Resolves the auto-compaction threshold (fraction, `1` = disabled) for one model from the
 * persisted user preferences. The backend owns this decision: the slider persists a percent
 * per raw model string in `userPreferences.ai.autoCompactionThresholdByModel`, and every
 * compaction/rollover decision resolves it fresh from config so no RPC push is needed.
 *
 * Never throws for corrupt persisted data: a missing, non-numeric, non-finite or out-of-range
 * entry resolves to the default so startup recovery cannot crash on a bad config value.
 */
export function resolveAutoCompactionThreshold(
  preferences: UserPreferences | undefined,
  model: string
): number {
  assert(typeof model === "string" && model.length > 0, "threshold resolution needs a model");
  const stored = preferences?.ai?.autoCompactionThresholdByModel?.[model];
  let fraction = DEFAULT_AUTO_COMPACTION_THRESHOLD;
  if (
    typeof stored === "number" &&
    Number.isFinite(stored) &&
    stored >= 0 &&
    stored <= AUTO_COMPACTION_THRESHOLD_STORAGE_MAX
  ) {
    fraction = Math.max(MIN_FRACTION, stored / 100);
  }
  assert(
    Number.isFinite(fraction) && fraction >= MIN_FRACTION && fraction <= 1,
    `resolved threshold out of range: ${fraction}`
  );
  return fraction;
}
