import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ContextSwitchWarning } from "@/browser/components/ContextSwitchWarning/ContextSwitchWarning";

// Warning banner shown when switching to a model that can't fit current context.
// Rendered directly with inline warning props (mirrors the story's primary args):
// ~150K tokens of context vs. a 128K target limit, so the banner surfaces and
// offers a "Compact with <model>" action.
export const Warning = () => (
  <MuxPreviewShell>
    <div className="bg-background flex min-h-[180px] items-start p-4">
      <div className="w-full max-w-3xl">
        <ContextSwitchWarning
          warning={{
            currentTokens: 150000,
            targetLimit: 128000,
            targetModel: "openai:gpt-4o",
            compactionModel: "anthropic:claude-sonnet-4-5",
            errorMessage: null,
          }}
          onCompact={() => {}}
          onDismiss={() => {}}
        />
      </div>
    </div>
  </MuxPreviewShell>
);
