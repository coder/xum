import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { TranscriptHydrationSkeleton } from "@/browser/components/ChatPane/TranscriptHydrationSkeleton";

// Shimmer placeholder shown while a transcript hydrates. Takes no props; the
// story just centers it in a max-width column to match the real transcript.
export const Default = () => (
  <MuxPreviewShell>
    <div className="bg-background min-h-screen overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <TranscriptHydrationSkeleton />
      </div>
    </div>
  </MuxPreviewShell>
);
