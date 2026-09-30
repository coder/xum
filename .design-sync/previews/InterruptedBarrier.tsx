import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { InterruptedBarrier } from "@/browser/features/Messages/ChatBarrier/InterruptedBarrier";

// The story drives the FULL app to reach an interrupted stream state; the
// component itself is presentation-only (a BaseBarrier reading "interrupted"),
// so render it directly inside a chat-card frame.
export const Interrupted = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-3xl">
        <InterruptedBarrier />
      </div>
    </div>
  </MuxPreviewShell>
);
