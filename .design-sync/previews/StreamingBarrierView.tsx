import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { StreamingBarrierView } from "@/browser/features/Messages/ChatBarrier/StreamingBarrierView";

// Presentation-only streaming barrier. Mirrors the story's card frame and its
// primary "Streaming" variant (stats slot revealed). onCancel is a no-op here.
const noop = () => {};

export const Streaming = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-3xl rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-4">
        <StreamingBarrierView
          statusText="claude-opus-4 streaming..."
          cancelText="hit Esc to cancel"
          cancelShortcutText="Esc"
          onCancel={noop}
          tokenCount={12_840}
          tps={73}
        />
      </div>
    </div>
  </MuxPreviewShell>
);

// Startup diagnostic state: stats slot reserved-but-hidden, row geometry unchanged.
export const WaitingForWorkspaceInitialization = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-3xl rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-4">
        <StreamingBarrierView
          statusText="Waiting for workspace initialization..."
          cancelText="hit Esc to cancel"
          cancelShortcutText="Esc"
          onCancel={noop}
        />
      </div>
    </div>
  </MuxPreviewShell>
);
