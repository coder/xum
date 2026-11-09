import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { StreamErrorMessage } from "@/browser/features/Messages/StreamErrorMessage";
import { RetryBarrierContent } from "@/browser/features/Messages/ChatBarrier/RetryBarrier";
import { STABLE_TIMESTAMP } from "@/browser/stories/storyTime";
import type { DisplayedMessage } from "@/common/types/message";

// Stream-error cards in a VS Code sidebar-sized pane — mirrors the NarrowPane200 story in
// StreamErrorMessage.stories.tsx (two error cards + the retry card, 200px pane with the
// webview transcript's p-3). The shell's APIProvider (empty mock client) replaces the
// story's own; the retry card reads workspace state and user preferences from it.

type StreamErrorRow = Extract<DisplayedMessage, { type: "stream-error" }>;

/** About the narrowest VS Code sidebar the webview transcript was measured at (#5151). */
const NARROW_PANE_WIDTH = 200;

// The widest header: a repeat count, the Status link and the debug button.
const OVERLOADED: StreamErrorRow = {
  type: "stream-error",
  id: "error-overloaded",
  historyId: "error-overloaded",
  error: "Anthropic is temporarily overloaded (HTTP 529). Please try again later.",
  errorType: "server_error",
  historySequence: 2,
  timestamp: STABLE_TIMESTAMP,
  model: "anthropic:claude-sonnet-4-5",
  errorCount: 3,
};

const REPEATED_QUOTA: StreamErrorRow = {
  type: "stream-error",
  id: "error-quota",
  historyId: "error-quota",
  error: "You exceeded your current quota. Check your plan and billing details.",
  errorType: "quota",
  historySequence: 3,
  timestamp: STABLE_TIMESTAMP,
  model: "openai:gpt-5",
  errorCount: 3,
};

export const NarrowPane200 = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground">
      <div data-narrow-pane className="p-3" style={{ width: NARROW_PANE_WIDTH }}>
        <StreamErrorMessage message={OVERLOADED} />
        <StreamErrorMessage message={REPEATED_QUOTA} />
        <RetryBarrierContent
          workspaceId="ws-narrow"
          messages={[REPEATED_QUOTA]}
          autoRetryStatus={null}
          isStreamStarting={false}
          canInterrupt={false}
        />
      </div>
    </div>
  </MuxPreviewShell>
);
