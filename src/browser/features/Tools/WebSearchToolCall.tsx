import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  LoadingDots,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  unwrapResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";

interface WebSearchToolCallProps {
  args: { query?: string }; // Anthropic puts query in args
  result?: unknown;
  status?: ToolStatus;
}

/**
 * Extract query from either args (Anthropic) or result.action.query (OpenAI)
 */
function extractQuery(args: { query?: string }, result: unknown): string | undefined {
  if (args.query) return args.query;
  const unwrapped = unwrapResult(result);
  // OpenAI puts query in result.action.query
  if (
    unwrapped !== null &&
    typeof unwrapped === "object" &&
    "action" in unwrapped &&
    typeof (unwrapped as Record<string, unknown>).action === "object"
  ) {
    const action = (unwrapped as { action: Record<string, unknown> }).action;
    if (typeof action.query === "string") return action.query;
  }
  return undefined;
}

/**
 * Get result count - Anthropic returns array, OpenAI returns { sources: [] }
 */
function getResultCount(result: unknown): number {
  const unwrapped = unwrapResult(result);
  if (Array.isArray(unwrapped)) return unwrapped.length;
  if (
    unwrapped !== null &&
    typeof unwrapped === "object" &&
    "sources" in unwrapped &&
    Array.isArray((unwrapped as { sources: unknown }).sources)
  ) {
    return (unwrapped as { sources: unknown[] }).sources.length;
  }
  return 0;
}

export const WebSearchToolCall: React.FC<WebSearchToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const query = extractQuery(args, result);
  const resultCount = getResultCount(result);

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="web_search" />
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          <span className="font-monospace truncate">{query ?? "searching..."}</span>
        </div>
        {result !== undefined && resultCount > 0 && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            {resultCount} result{resultCount !== 1 ? "s" : ""}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              {query && (
                <div className="flex min-w-0 gap-1.5">
                  <span className="text-secondary font-medium">Query:</span>
                  <span className="text-text">{query}</span>
                </div>
              )}
            </div>
          </DetailSection>

          {result != null && (
            <DetailSection>
              <DetailLabel>Results</DetailLabel>
              <div className="bg-code-bg max-h-[300px] overflow-y-auto rounded px-3 py-2 text-[12px]">
                <JsonHighlight value={result} />
              </div>
            </DetailSection>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                Searching
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
