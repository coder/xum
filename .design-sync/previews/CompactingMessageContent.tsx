import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { CompactingMessageContent } from "@/browser/features/Messages/CompactingMessageContent";

// Compaction streaming wrapper: it only constrains height + fades older content.
// The story nests a MarkdownRenderer inside, but that's a heavy renderer — keep
// the preview thin by passing the summary as PLAIN TEXT instead (the wrapper
// doesn't care what its children are).
const STREAMING_SUMMARY = `Conversation Summary

The user requested help refactoring the codebase. Key changes made:

- Restructured component hierarchy for better separation of concerns
- Extracted shared utilities into dedicated modules
- Improved type safety across API boundaries
- Consolidated duplicated request-building paths into one helper
- Added defensive filtering so a malformed history line can't brick a workspace`;

export const StreamingCompaction = () => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-3xl">
        {/* Mirrors the story's CompactingCard frame (border + relative content). */}
        <div className="relative overflow-hidden rounded-md border border-[var(--color-border-medium)] p-4">
          <CompactingMessageContent>
            <div className="text-foreground text-sm whitespace-pre-wrap">{STREAMING_SUMMARY}</div>
          </CompactingMessageContent>
        </div>
      </div>
    </div>
  </MuxPreviewShell>
);
