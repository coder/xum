import React from "react";
import type { MemoryToolArgs, MemoryToolResult } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";

interface MemoryToolCallProps {
  args: MemoryToolArgs;
  result?: MemoryToolResult;
  status?: ToolStatus;
}

/** Compact per-command summary shown in the collapsed header. */
function getHeaderPath(args: MemoryToolArgs): string {
  if (args.command === "rename") {
    const from = args.old_path ?? args.path ?? "";
    return args.new_path ? `${from} → ${args.new_path}` : from;
  }
  return args.path ?? "";
}

/** Op-specific detail rows (label/value pairs), skipping absent fields. */
function getDetailRows(args: MemoryToolArgs): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (args.path != null) rows.push(["Path", args.path]);
  if (args.old_path != null) rows.push(["From", args.old_path]);
  if (args.new_path != null) rows.push(["To", args.new_path]);
  if (args.old_str != null) rows.push(["Old", args.old_str]);
  if (args.new_str != null) rows.push(["New", args.new_str]);
  if (args.insert_line != null) rows.push(["After line", String(args.insert_line)]);
  if (args.insert_text != null) rows.push(["Text", args.insert_text]);
  if (args.file_text != null) rows.push(["Content", args.file_text]);
  if (args.offset != null) rows.push(["Offset", `line ${args.offset}`]);
  if (args.limit != null) rows.push(["Limit", `${args.limit} lines`]);
  return rows;
}

// SECURITY: memory content is attacker-influenceable. Render as plain
// text/React trees only — never through innerHTML-family sinks.
export const MemoryToolCall: React.FC<MemoryToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const headerPath = getHeaderPath(args);

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="memory" />
        <span className="text-text font-medium">{args.command}</span>
        <span className="font-monospace text-secondary max-w-96 min-w-0 truncate">
          {headerPath}
        </span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              {getDetailRows(args).map(([label, value]) => (
                <div key={label} className="flex gap-1.5">
                  <span className="text-secondary font-medium">{label}:</span>
                  <span className="text-text font-monospace break-all whitespace-pre-wrap">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </DetailSection>

          {result && !result.success && (
            <DetailSection>
              <DetailLabel>Error</DetailLabel>
              <ErrorBox>{result.error}</ErrorBox>
            </DetailSection>
          )}

          {result?.success && result.output && (
            <DetailSection>
              <DetailLabel>Result</DetailLabel>
              <pre className="bg-code-bg font-monospace m-0 max-h-[200px] overflow-y-auto rounded px-2 py-1.5 text-[11px] leading-[1.4] break-words whitespace-pre-wrap">
                {result.output}
              </pre>
            </DetailSection>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <DetailContent>
                Working on memory
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
