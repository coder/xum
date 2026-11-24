import React from "react";
import type { ToolSearchToolArgs, ToolSearchToolResult } from "@/common/types/tools";
import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  unwrapResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

/**
 * Transcript card for the `tool_catalog_search` tool, the call the model makes
 * to discover deferred MCP tools. Collapsed it reads as a glanceable
 * "Tool search · <query> · N matches"; expanded it lists the matched tool
 * names with their descriptions.
 */

type ToolSearchView =
  | { kind: "matches"; result: ToolSearchToolResult }
  | { kind: "error"; error: string }
  | { kind: "none" };

type ToolSearchDiscovery = NonNullable<ToolSearchToolResult["discovery"]>;

/** Keep only well-formed discovery data (persisted results may be corrupted); drop it otherwise. */
function toDiscovery(value: unknown): ToolSearchDiscovery | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const discovery = value as { candidates?: unknown; note?: unknown };
  if (!Array.isArray(discovery.candidates) || typeof discovery.note !== "string") {
    return undefined;
  }
  // Rebuild each candidate from validated fields only: a malformed optional
  // field (e.g. an object serverName) rendered as a React child would throw.
  const candidates: ToolSearchDiscovery["candidates"] = [];
  for (const candidate of discovery.candidates) {
    if (candidate == null || typeof candidate !== "object") continue;
    const { name, approxTokens, serverName, oversized } = candidate as {
      name?: unknown;
      approxTokens?: unknown;
      serverName?: unknown;
      oversized?: unknown;
    };
    if (typeof name !== "string" || typeof approxTokens !== "number") continue;
    candidates.push({
      name,
      approxTokens,
      ...(typeof serverName === "string" ? { serverName } : {}),
      ...(oversized === true ? { oversized: true as const } : {}),
    });
  }
  if (candidates.length === 0) return undefined;
  return { candidates, note: discovery.note };
}

/** Normalize a persisted tool result into a render view (defensive: pending / malformed ⇒ none). */
export function toToolSearchView(result: unknown): ToolSearchView {
  const unwrapped = unwrapResult(result);
  if (unwrapped == null || typeof unwrapped !== "object") return { kind: "none" };
  if (isToolErrorResult(unwrapped)) return { kind: "error", error: unwrapped.error };
  if (!("matches" in unwrapped) || !Array.isArray((unwrapped as { matches: unknown }).matches)) {
    return { kind: "none" };
  }
  const candidate = unwrapped as ToolSearchToolResult;
  return {
    kind: "matches",
    result: {
      query: typeof candidate.query === "string" ? candidate.query : "",
      matches: candidate.matches
        .filter(
          (match): match is ToolSearchToolResult["matches"][number] =>
            match != null && typeof match === "object" && typeof match.name === "string"
        )
        // Coerce non-string descriptions (corrupted/persisted results) so the
        // expanded card never renders an object/array as a React child.
        .map((match) =>
          typeof match.description === "string" ? match : { ...match, description: "" }
        ),
      totalDeferred: typeof candidate.totalDeferred === "number" ? candidate.totalDeferred : 0,
      discovery: toDiscovery(candidate.discovery),
    },
  };
}

interface ToolSearchToolCallProps {
  args: ToolSearchToolArgs;
  result?: unknown;
  status?: ToolStatus;
  /** Initial expansion fallback (until the user toggles this tool in the workspace). */
  defaultExpanded?: boolean;
}

export const ToolSearchToolCall: React.FC<ToolSearchToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);

  const view = toToolSearchView(props.result);
  const matches = view.kind === "matches" ? view.result.matches : [];
  const discovery = view.kind === "matches" ? view.result.discovery : undefined;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="tool_catalog_search" />
        <span className="text-muted-foreground truncate italic">{props.args.query}</span>
        {view.kind === "matches" && (
          // Hide the count in very narrow containers so the truncating query keeps priority.
          <span className="text-muted hidden whitespace-nowrap @[300px]:inline">
            {discovery != null && matches.length === 0
              ? `${discovery.candidates.length} found, none loaded`
              : `${matches.length} ${matches.length === 1 ? "match" : "matches"}`}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {view.kind === "error" && <ErrorBox>{view.error}</ErrorBox>}

          {view.kind === "matches" && matches.length === 0 && discovery == null && (
            <div className="text-muted px-1 py-1 text-[11px] italic">
              No deferred tools matched “{view.result.query}”
              {view.result.totalDeferred > 0 &&
                ` (${view.result.totalDeferred} deferred ${view.result.totalDeferred === 1 ? "tool" : "tools"} available)`}
            </div>
          )}

          {discovery != null && (
            <div className="flex flex-col">
              {discovery.candidates.map((candidate, index) => (
                <div
                  key={candidate.name}
                  className={index === 0 ? "px-2 py-1.5" : "border-t border-white/5 px-2 py-1.5"}
                >
                  <div className="text-foreground text-[12.5px] font-medium break-all">
                    {candidate.name}
                    {candidate.serverName && (
                      <span className="text-muted ml-1.5 font-normal">{candidate.serverName}</span>
                    )}
                  </div>
                  <div className="text-secondary mt-0.5 text-[11.5px] leading-snug">
                    ~{candidate.approxTokens.toLocaleString("en-US")} tokens
                    {candidate.oversized && <span className="text-muted"> · oversized</span>}
                  </div>
                </div>
              ))}
              <div className="text-muted border-t border-white/5 px-2 py-1.5 text-[11px] italic">
                {discovery.note}
              </div>
            </div>
          )}

          {matches.length > 0 && (
            <div className="flex flex-col">
              {matches.map((match, index) => (
                <div
                  key={match.name}
                  className={index === 0 ? "px-2 py-1.5" : "border-t border-white/5 px-2 py-1.5"}
                >
                  <div className="text-foreground text-[12.5px] font-medium break-all">
                    {match.name}
                  </div>
                  {match.description && (
                    <div className="text-secondary mt-0.5 text-[11.5px] leading-snug break-words">
                      {match.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
