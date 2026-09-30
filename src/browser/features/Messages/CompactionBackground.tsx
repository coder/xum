import React from "react";

/**
 * Animated background for compaction streaming.
 * Combines a subtle gradient with a GPU-accelerated shimmer effect.
 *
 * Uses CSS transform animation (compositor thread) instead of background-position
 * (main thread repaint) to avoid frame drops during heavy streaming work.
 */
export const CompactionBackground: React.FC = () => {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
      {/* Subtle gradient background */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          background:
            "linear-gradient(-45deg, var(--color-plan-mode-alpha), color-mix(in srgb, var(--color-plan-mode) 30%, transparent), var(--color-plan-mode-alpha), color-mix(in srgb, var(--color-plan-mode) 25%, transparent))",
        }}
      />
      {/* Shimmer uses CSS transform animation - runs on compositor thread, not main thread */}
      {/* Math: element is 300% wide, highlight at 50% = 150% from left edge.
          marginLeft -180% puts highlight at -30% (off-screen left).
          translateX 53.33% (of 300%) = 160%, moving highlight to 130% (off-screen right). */}
      <div
        className="absolute inset-0 animate-[shimmer-slide_3s_infinite_linear]"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, transparent 40%, var(--color-plan-mode-alpha) 50%, transparent 60%, transparent 100%)",
          width: "300%",
          marginLeft: "-180%",
        }}
      />
    </div>
  );
};
