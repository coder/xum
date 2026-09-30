import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ContextUsageIndicatorButton } from "@/browser/components/ContextUsageIndicatorButton/ContextUsageIndicatorButton";
import { TOKEN_COMPONENT_COLORS, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

// Context-usage chip shown in the chat input area. Pure data props (token meter
// segments + compaction config) — only needs theme + tooltip from the shell.
// Mirrors the story's `ContextMeterWithIdleCompaction` primary variant: high
// usage (~65%) with idle compaction enabled (the hourglass badge).
const CONTEXT_METER_DATA: TokenMeterData = {
  totalTokens: 130000,
  maxTokens: 200000,
  totalPercentage: 65,
  segments: [
    { type: "input", tokens: 124000, percentage: 62, color: TOKEN_COMPONENT_COLORS.input },
    { type: "output", tokens: 6000, percentage: 3, color: TOKEN_COMPONENT_COLORS.output },
  ],
};

export const ContextMeterWithIdleCompaction = () => (
  <MuxPreviewShell>
    <div className="bg-background flex min-h-[180px] items-end p-6">
      <ContextUsageIndicatorButton
        data={CONTEXT_METER_DATA}
        autoCompaction={{ threshold: 80, setThreshold: () => undefined }}
        idleCompaction={{ hours: 4, setHours: () => undefined }}
      />
    </div>
  </MuxPreviewShell>
);
