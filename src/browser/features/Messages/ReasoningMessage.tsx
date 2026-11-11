import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { useStickyExpand } from "./useStickyExpand";
import { normalizeReasoningMarkdown } from "./MarkdownStyles";
import { cn } from "@/common/lib/utils";
import { Shimmer } from "../AIElements/Shimmer";
import { Lightbulb } from "lucide-react";
import {
  ExpandIcon,
  FOLDED_ROW_TEXT_CLASS,
  TOOL_RAIL_CLASS,
} from "@/browser/features/Tools/Shared/ToolPrimitives";

interface ReasoningMessageProps {
  message: DisplayedMessage & { type: "reasoning" };
  className?: string;
  /**
   * Workspace this reasoning belongs to. Forwarded to TypewriterMarkdown so the
   * smoothing engine can target the model's live emission rate. Optional —
   * tests render this component without a workspace context.
   */
  workspaceId?: string;
}

const REASONING_FONT_CLASSES = FOLDED_ROW_TEXT_CLASS;
const MAX_SUMMARY_CHARS = 240;

function parseLeadingBoldSummary(
  summary: string
): { boldText: string; trailingText: string } | null {
  // OpenAI reasoning summaries commonly start with markdown bold: "**Title**".
  // Parse only a leading pair so we can keep the cheap plain-text header render while
  // preserving the expected visual emphasis.
  if (!summary.startsWith("**")) {
    return null;
  }

  const closingMarkerIndex = summary.indexOf("**", 2);
  if (closingMarkerIndex <= 2) {
    return null;
  }

  const boldText = summary.slice(2, closingMarkerIndex).trim();
  if (!boldText) {
    return null;
  }

  return {
    boldText,
    trailingText: summary.slice(closingMarkerIndex + 2),
  };
}

export const ReasoningMessage: React.FC<ReasoningMessageProps> = ({
  message,
  className,
  workspaceId,
}) => {
  // Quiet default: new thinking starts collapsed (even while streaming). The sticky
  // "thinking" preference — set when the user expands/collapses any thinking block —
  // wins once present. Seeded once at mount, so a preference change never mutates a
  // present block.
  const { expanded: isExpanded, setExpanded: setIsExpanded } = useStickyExpand("thinking", false);
  const content = message.content;
  const isStreaming = message.isStreaming;
  const trimmedContent = content?.trim() ?? "";
  const hasContent = trimmedContent.length > 0;
  const summaryLineRaw = hasContent ? (trimmedContent.split(/\r?\n/)[0] ?? "") : "";
  const summaryLine =
    summaryLineRaw.length > MAX_SUMMARY_CHARS
      ? `${summaryLineRaw.slice(0, MAX_SUMMARY_CHARS)}…`
      : summaryLineRaw;
  const hasAdditionalLines = hasContent && /[\r\n]/.test(trimmedContent);
  // OpenAI models often emit terse, single-line traces; surface them inline instead of hiding behind the label.
  const isSingleLineTrace = !isStreaming && hasContent && !hasAdditionalLines;
  // Collapsible whenever there is content, including while streaming, so the user can opt
  // into watching the live trace. A one-line trace has no body to reveal, but its line can be
  // longer than the row: opening it lets that line wrap, so no thought is unreadable.
  // We deliberately no longer auto-collapse on stream completion: that mutated a present
  // block (a visible height tear) and fought the sticky preference. A block keeps whatever
  // expand state it mounted with until the user toggles it.
  const isCollapsible = hasContent;
  const showsWrappedLine = isExpanded && isSingleLineTrace;
  const headerLine = showsWrappedLine ? summaryLineRaw : summaryLine;
  const parsedLeadingBoldSummary = parseLeadingBoldSummary(headerLine);
  const showExpandedContent = isExpanded && !isSingleLineTrace;
  // Keep height uncontrolled while a streaming block is expanded so live markdown
  // growth (Shiki/Mermaid) can't be clipped by a stale measured height.
  const showStreamingExpanded = isStreaming && isExpanded;

  const toggleExpanded = () => {
    if (!isCollapsible) {
      return;
    }

    setIsExpanded(!isExpanded);
  };

  // Render appropriate content based on state
  const renderContent = () => {
    // Empty streaming state
    if (isStreaming && !content) {
      return <div className="text-muted">Thinking…</div>;
    }

    if (!content) {
      return null;
    }

    // Preserve single newlines so short section headers (e.g. "Fixing …") don't get
    // collapsed into the previous paragraph by the markdown renderer.
    //
    // Use TypewriterMarkdown for both streaming and settled reasoning so the component
    // identity is stable across stream completion — swapping to MarkdownRenderer at
    // stream end would unmount/remount the markdown subtree and visibly flash the
    // content. isComplete={!isStreaming} cleanly bypasses the smoothing engine once
    // the stream ends, matching the prior static-render behavior.
    // React Compiler auto-memoizes this normalize call between renders that
    // share the same `content` value; no manual useMemo needed.
    const normalizedContent = normalizeReasoningMarkdown(content);

    return (
      <TypewriterMarkdown
        content={normalizedContent}
        isComplete={!isStreaming}
        preserveLineBreaks
        streamKey={message.historyId}
        streamSource={message.streamPresentation?.source}
        workspaceId={workspaceId}
      />
    );
  };

  // A quiet line, not a box: reasoning is the least important row in a settled transcript, so
  // it gets the same muted one-line treatment as a folded summary row and no fill or accent
  // colour. Only a live trace (the shimmer) carries the thinking colour.
  return (
    <div className={cn("relative my-1.5", className)}>
      <div
        className={cn(
          "text-muted flex min-w-0 gap-2 px-1 select-none",
          showsWrappedLine ? "items-start" : "items-center",
          isCollapsible && "hover:text-foreground cursor-pointer transition-colors",
          isExpanded && !isSingleLineTrace && "mb-1.5"
        )}
        onClick={isCollapsible ? toggleExpanded : undefined}
      >
        {/* The chevron column is kept (as a spacer) when there is nothing to open, so every
            folded row's icon and text start on the same edges. The 3px offset centres the
            12px icons on the first 18px line when the text wraps. */}
        {isCollapsible ? (
          <ExpandIcon expanded={isExpanded} className={cn(showsWrappedLine && "mt-[3px]")} />
        ) : (
          <span className="w-3 shrink-0" aria-hidden="true" />
        )}
        <Lightbulb
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0",
            showsWrappedLine && "mt-[3px]",
            isStreaming && "animate-pulse"
          )}
        />
        <div className={cn("min-w-0", !showsWrappedLine && "truncate", REASONING_FONT_CLASSES)}>
          {isStreaming ? (
            <Shimmer className="thinking-shimmer" colorClass="var(--color-thinking-mode)">
              Thinking…
            </Shimmer>
          ) : hasContent ? (
            <span className={showsWrappedLine ? "break-words" : "whitespace-nowrap"}>
              {parsedLeadingBoldSummary ? (
                <>
                  <strong>{parsedLeadingBoldSummary.boldText}</strong>
                  {parsedLeadingBoldSummary.trailingText}
                </>
              ) : (
                headerLine
              )}
            </span>
          ) : (
            "Thought"
          )}
        </div>
      </div>

      {/* Always render the content container to prevent layout shifts. Keep an
          expanded streaming block's height uncontrolled so async markdown growth
          (Shiki/Mermaid) cannot be clipped by a stale measured height; everything
          else is driven by showExpandedContent so a collapsed block (including a
          collapsed streaming one) gets height:0. */}
      <div
        className={cn(
          REASONING_FONT_CLASSES,
          // The opened trace hangs off the same rail as any other opened row.
          TOOL_RAIL_CLASS,
          "italic opacity-85 [&_p]:mt-0 [&_p]:mb-1 [&_p:last-child]:mb-0",
          !showStreamingExpanded && "overflow-hidden transition-opacity duration-200 ease-in-out"
        )}
        style={
          showStreamingExpanded
            ? undefined
            : {
                height: showExpandedContent ? undefined : 0,
                opacity: showExpandedContent ? 1 : 0,
              }
        }
        aria-hidden={!showExpandedContent}
      >
        {showExpandedContent ? renderContent() : null}
      </div>
    </div>
  );
};
