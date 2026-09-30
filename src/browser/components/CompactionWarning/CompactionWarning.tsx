import React from "react";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";

/**
 * Warning indicator shown when context usage is approaching the compaction threshold.
 *
 * Displays as subtle right-aligned text:
 * - Below threshold: "Auto-Compact in X% usage" (where X = threshold - current)
 * - At/above threshold (not streaming): Bold "Next message will Auto-Compact"
 * - At/above threshold (streaming): "Force-compacting in N%" (where N = force threshold - current usage)
 *
 * In rollover mode the threshold is the agent handoff target, not a forced point: the text
 * counts down to that target and, past it, only states that the usable limit forces a
 * rollover. It never claims a handoff request was delivered; the transcript row does that.
 *
 * @param usagePercentage - Current token usage as percentage (0-100), reflects live usage when streaming
 * @param thresholdPercentage - Auto-compaction trigger threshold (0-100, default 70); the
 *   effective (clamped) value in rollover mode
 * @param isStreaming - Whether currently streaming a response
 */
export const CompactionWarning: React.FC<{
  usagePercentage: number;
  thresholdPercentage: number;
  isStreaming: boolean;
  rolloverEnabled: boolean;
}> = (props) => {
  // At threshold or above, next message will trigger compaction
  const willCompactNext = props.usagePercentage >= props.thresholdPercentage;
  const remaining = props.thresholdPercentage - props.usagePercentage;

  // When streaming and above threshold, show countdown to force-compaction
  const forceCompactThreshold = props.thresholdPercentage + FORCE_COMPACTION_BUFFER_PERCENT;
  const showForceCompactCountdown =
    props.isStreaming && willCompactNext && props.usagePercentage < forceCompactThreshold;
  const forceCompactRemaining = forceCompactThreshold - props.usagePercentage;

  let text: string;
  let isUrgent: boolean;

  if (props.rolloverEnabled) {
    text =
      remaining > 0
        ? `Handoff target in ${Math.round(remaining)}% usage`
        : "Past the handoff target; rollover is forced at the usable limit";
    // Passing the target is expected (the agent finishes a small unit first), so no urgency.
    isUrgent = false;
  } else if (showForceCompactCountdown) {
    text = `Force-compacting in ${Math.round(forceCompactRemaining)}%`;
    isUrgent = false;
  } else if (willCompactNext) {
    text = "Next message will Auto-Compact";
    isUrgent = true;
  } else {
    text = `Auto-Compact in ${Math.round(remaining)}% usage`;
    isUrgent = false;
  }

  return (
    <div
      className={`counter-nums text-right text-[10px] ${
        isUrgent ? "text-plan-mode font-semibold" : "text-muted"
      }`}
    >
      {text}
    </div>
  );
};
