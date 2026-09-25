import React, { useContext } from "react";
import { useSmoothStreamingText } from "@/browser/hooks/useSmoothStreamingText";
import { useWorkspaceStreamingStats } from "@/browser/stores/WorkspaceStore";
import { cn } from "@/common/lib/utils";
import { MarkdownCore } from "./MarkdownCore";
import { StreamingContext } from "./StreamingContext";
import { TranscriptBackfillContext } from "./TranscriptBackfillContext";

interface TypewriterMarkdownProps {
  /** Full text to render. During streaming this grows monotonically. */
  content: string;
  isComplete: boolean;
  className?: string;
  /**
   * Preserve single newlines as line breaks (like GitHub-flavored markdown).
   * Useful for plain-text-ish content (e.g. reasoning blocks) where line breaks
   * are often intentional.
   */
  preserveLineBreaks?: boolean;
  /** Unique key for the current stream — reset smooth engine on change. */
  streamKey?: string;
  /** Whether this stream originated from live tokens or replay. Defaults to "live". */
  streamSource?: "live" | "replay";
  /**
   * Workspace this content belongs to. When provided, the smoothing engine is
   * fed the live model emission rate so the visible cursor tracks the model's
   * actual output rather than the constant BASE rate. Optional because some
   * surfaces (storybook, preview popovers) render markdown without a workspace.
   */
  workspaceId?: string;
}

// React Compiler memoizes this component automatically based on prop changes;
// no manual React.memo wrapper. The previous deltas: string[] shape forced a new
// array literal on every parent render and defeated the memo anyway.
export const TypewriterMarkdown: React.FC<TypewriterMarkdownProps> = ({
  content,
  isComplete,
  className,
  preserveLineBreaks,
  streamKey,
  streamSource = "live",
  workspaceId,
}) => {
  const isStreaming = !isComplete && content.length > 0;

  // Read the live model emission rate (chars/sec) for the active stream of this
  // workspace. The hook subscribes to its own MapStore so per-delta updates
  // re-render this component WITHOUT cascading through the parent — see
  // useWorkspaceStreamingStats.
  //
  // Subscribe to the real workspace key ONLY while this message is actively
  // streaming. Completed historical messages subscribe to the stable empty-key
  // sentinel, which is never bumped — so a long transcript of finished
  // assistant messages does not re-render on every delta of a new stream.
  // (Hooks must run unconditionally; we toggle the key, not the call site.)
  const subscriptionKey = isStreaming && workspaceId ? workspaceId : "";
  const streamingStats = useWorkspaceStreamingStats(subscriptionKey);
  const liveCharsPerSec = isStreaming && workspaceId ? (streamingStats?.charsPerSec ?? 0) : 0;

  // Two-clock streaming: ingestion (content) vs presentation (visibleText).
  // The jitter buffer reveals text at a steady cadence instead of bursty token clumps.
  // Replay and completed streams bypass smoothing entirely.
  const { visibleText } = useSmoothStreamingText({
    fullText: content,
    isStreaming,
    bypassSmoothing: streamSource === "replay",
    streamKey: streamKey ?? "",
    liveCharsPerSec,
  });

  // React Compiler memoizes this object; no manual useMemo needed.
  const streamingContextValue = { isStreaming };

  // During the transcript backfill, render streaming text in MarkdownCore's static mode (no
  // incomplete-markdown repair) so it paints without a transition (see TranscriptBackfillContext).
  // The static render keeps Streamdown's block state current, so switching back never blanks.
  const isTranscriptBackfilling = useContext(TranscriptBackfillContext);
  const parseIncompleteMarkdown = isStreaming && !isTranscriptBackfilling;

  return (
    <StreamingContext.Provider value={streamingContextValue}>
      <div className={cn("markdown-content", className)}>
        <MarkdownCore
          content={visibleText}
          parseIncompleteMarkdown={parseIncompleteMarkdown}
          preserveLineBreaks={preserveLineBreaks}
        />
      </div>
    </StreamingContext.Provider>
  );
};
