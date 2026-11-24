/**
 * StreamingTPSCalculator - Calculates tokens-per-second from timestamped delta records
 *
 * Maintains a sliding window of recent deltas and calculates TPS based on time span.
 * Designed to be independently testable from the main aggregator.
 */

import { createDeltaStorage, type DeltaRecordStorage } from "@/common/utils/tokens/tps";

export { createDeltaStorage };
export type { DeltaRecordStorage };

/**
 * Maximum reasonable TPS for sanity checking.
 * No current model exceeds ~200 tok/s sustained; 500 provides margin.
 * Values above this indicate corrupted data (e.g., from timestamp bugs).
 */
const MAX_REASONABLE_TPS = 500;

/**
 * Calculate average tokens-per-second from aggregate timing data.
 * Used for session/historical stats (not live streaming).
 *
 * @param streamingMs - Time spent streaming tokens (excludes TTFT and tool execution)
 * @param modelTimeMs - Total model time (fallback when streamingMs unavailable/corrupted)
 * @param totalTokens - Total output tokens
 * @param liveTPS - Live TPS from trailing window (preferred for active streams)
 * @returns TPS value or null if insufficient data
 */
export function calculateAverageTPS(
  streamingMs: number,
  modelTimeMs: number,
  totalTokens: number,
  liveTPS: number | null
): number | null {
  // Use live TPS if available (active stream) - real-time trailing window
  if (liveTPS !== null) return liveTPS;

  // Calculate from streaming time (most accurate for completed streams)
  if (streamingMs > 0 && totalTokens > 0) {
    const tps = totalTokens / (streamingMs / 1000);
    // Sanity check: reject unreasonable values (corrupted persisted data)
    if (tps <= MAX_REASONABLE_TPS) {
      return tps;
    }
    // Fall through to modelTime calculation
  }

  // Fallback: use modelTime for old data without streamingMs or corrupted data
  if (modelTimeMs > 0 && totalTokens > 0) {
    return totalTokens / (modelTimeMs / 1000);
  }

  return null;
}
