/**
 * Shared duration formatter. Every site that converts ms→human-readable string
 * should use this instead of rolling its own threshold ladder.
 *
 * Styles:
 * - "coarse"  → 42ms, 5s, 2m, 1h        (replaces toolUtils.tsx formatDuration)
 * - "precise" → 42ms, 3.2s, 15s, 2m 30s  (replaces dateTime.ts formatDurationPrecise)
 * - "decimal" → 427.3ms, 3.2s, 1.5m       (replaces toolFormatters.ts formatDuration)
 */
export type DurationStyle = "coarse" | "precise" | "decimal";

export function formatDuration(ms: number, style: DurationStyle = "coarse"): string {
  if (!Number.isFinite(ms)) return "—";

  if (ms < 1000) {
    // CLI "decimal" preserves raw ms (e.g. "427.3ms"); others round ("427ms").
    return style === "decimal" ? `${ms}ms` : `${Math.round(ms)}ms`;
  }

  switch (style) {
    case "coarse":
      if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
      if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
      return `${Math.round(ms / 3_600_000)}h`;

    case "precise":
      if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
      if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
      {
        const mins = Math.floor(ms / 60_000);
        const secs = Math.round((ms % 60_000) / 1000);
        // Always show seconds — matches original formatDurationPrecise ("2m 0s" not "2m")
        return `${mins}m ${secs}s`;
      }

    case "decimal":
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
      return `${(ms / 60_000).toFixed(1)}m`;
  }
}

/**
 * A running timer: 45s, 12m 04s, 1h 02m. The smaller unit is zero-padded so a value that ticks
 * every second keeps its width.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
