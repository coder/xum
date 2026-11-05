import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { PromptCacheHealth } from "@/browser/features/RightSidebar/PromptCacheHealth";
import { STABLE_TIMESTAMP } from "@/browser/stories/storyTime";
import type { TurnCacheHealth } from "@/common/utils/tokens/cacheHealth";

// Prompt-cache section of the right sidebar's Costs tab — one cell per story in
// PromptCacheHealth.stories.tsx, same session/turn data and frame widths. Pure props.

const MINUTE = 60_000;
// The table shows absolute times, so a fixed timestamp keeps the render stable.
const now = STABLE_TIMESTAMP;

const TURNS: TurnCacheHealth[] = [
  {
    messageId: "turn-4",
    timestamp: now - 2.5 * MINUTE,
    readRatio: 0.96,
    cacheWriteTokens: 3_200,
    rewriteCostUsd: 0.0128,
    coldStart: false,
  },
  {
    messageId: "turn-3",
    timestamp: now - 7.5 * MINUTE,
    readRatio: 0.91,
    cacheWriteTokens: 8_400,
    rewriteCostUsd: 0.0336,
    coldStart: false,
  },
  {
    // A 1h-TTL cache expired after a long pause: the whole prefix was rewritten.
    messageId: "turn-2",
    timestamp: now - 72.5 * MINUTE,
    readRatio: 0.02,
    cacheWriteTokens: 118_000,
    rewriteCostUsd: 0.472,
    coldStart: true,
  },
  {
    messageId: "turn-1",
    timestamp: now - 75.5 * MINUTE,
    readRatio: 0.88,
    cacheWriteTokens: 12_000,
    rewriteCostUsd: 0.048,
    coldStart: false,
  },
];

const SESSION = {
  readRatio: 0.71,
  cacheWriteTokens: 141_600,
  rewriteCostUsd: 0.5664,
  coldStart: false,
};

/** Costs tab section at a typical right-sidebar width. */
export const SidebarWidth = () => (
  <MuxPreviewShell>
    <div className="bg-background text-light font-primary w-[350px] p-4 text-[13px]">
      <PromptCacheHealth session={SESSION} turns={TURNS} />
    </div>
  </MuxPreviewShell>
);

/** Pixel's phone viewport width. */
export const PhoneWidth = () => (
  <MuxPreviewShell>
    <div className="bg-background text-light font-primary p-2 text-[13px]" style={{ width: 390 }}>
      <PromptCacheHealth session={SESSION} turns={TURNS} />
    </div>
  </MuxPreviewShell>
);
