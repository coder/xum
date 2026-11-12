import React from "react";
import { FileIcon } from "@/browser/components/FileIcon/FileIcon";
import type { AgentSkillReadFileToolArgs } from "@/common/types/tools";
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
import {
  useToolExpansion,
  getStatusDisplay,
  type ToolStatus,
  isToolErrorResult,
} from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";
import { formatBytes } from "@/common/utils/formatBytes";

interface AgentSkillReadFileToolCallProps {
  args: AgentSkillReadFileToolArgs;
  result?: unknown;
  status?: ToolStatus;
}

interface FileReadSuccessResult {
  success: true;
  file_size: number;
  modifiedTime: string;
  lines_read: number;
  content: string;
  warning?: string;
}

function isFileReadSuccessResult(val: unknown): val is FileReadSuccessResult {
  if (!val || typeof val !== "object") return false;
  const record = val as Record<string, unknown>;
  if (record.success !== true) return false;

  return (
    typeof record.file_size === "number" &&
    typeof record.modifiedTime === "string" &&
    typeof record.lines_read === "number" &&
    typeof record.content === "string"
  );
}

/**
 * Parse file_read content which comes formatted as:
 * LINE_NUMBER\tCONTENT
 * LINE_NUMBER\tCONTENT
 * ...
 */
function parseFileContent(content: string): {
  lineNumbers: string[];
  actualContent: string;
  actualBytes: number;
} {
  const lines = content.split("\n");
  const lineNumbers: string[] = [];
  const contentLines: string[] = [];

  for (const line of lines) {
    const tabIndex = line.indexOf("\t");
    if (tabIndex !== -1) {
      // Line has format: NUMBER\tCONTENT
      lineNumbers.push(line.substring(0, tabIndex));
      contentLines.push(line.substring(tabIndex + 1));
    } else {
      // Malformed or empty line - preserve as-is
      lineNumbers.push("");
      contentLines.push(line);
    }
  }

  const actualContent = contentLines.join("\n");
  // Calculate actual bytes (content + newlines, without line number prefixes)
  const actualBytes = new TextEncoder().encode(actualContent).length;

  return { lineNumbers, actualContent, actualBytes };
}

export const AgentSkillReadFileToolCall: React.FC<AgentSkillReadFileToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  const successResult = isFileReadSuccessResult(result) ? result : null;
  const errorResult = isToolErrorResult(result) ? result : null;
  const hasResult = result !== undefined && result !== null;
  const hasUnrecognizedResult = hasResult && !successResult && !errorResult;

  // Parse the file content to extract line numbers and actual content
  const parsedContent = successResult?.content ? parseFileContent(successResult.content) : null;

  const displayPath = `${args.name}/${args.filePath}`;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded} />
        <ToolIcon toolName="agent_skill_read_file" />
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          <FileIcon filePath={args.filePath} className="text-[15px] leading-none" />
          <span className="font-monospace truncate">{displayPath}</span>
        </div>
        {successResult && parsedContent && (
          <span className="text-secondary font-monospace ml-2 text-[10px] whitespace-nowrap">
            <span className="hidden @sm:inline">read </span>
            {formatBytes(parsedContent.actualBytes)}
            <span className="hidden @lg:inline"> of {formatBytes(successResult.file_size)}</span>
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex items-baseline gap-1.5">
                <span className="text-secondary font-medium">Skill:</span>
                <span className="text-text font-monospace break-all">{args.name}</span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-secondary font-medium">File:</span>
                <span className="text-text font-monospace break-all">{args.filePath}</span>
              </div>
              {args.offset != null && (
                <div className="flex items-baseline gap-1.5">
                  <span className="text-secondary font-medium">Offset:</span>
                  <span className="text-text font-monospace break-all">line {args.offset}</span>
                </div>
              )}
              {args.limit != null && (
                <div className="flex items-baseline gap-1.5">
                  <span className="text-secondary font-medium">Limit:</span>
                  <span className="text-text font-monospace break-all">{args.limit} lines</span>
                </div>
              )}
              {successResult && (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-secondary font-medium">Modified:</span>
                    <span className="text-text font-monospace break-all">
                      {successResult.modifiedTime}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-secondary font-medium">Lines:</span>
                    <span className="text-text font-monospace break-all">
                      {successResult.lines_read}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-secondary font-medium">Size:</span>
                    <span className="text-text font-monospace break-all">
                      {formatBytes(successResult.file_size)}
                    </span>
                  </div>
                </>
              )}
            </div>
          </DetailSection>

          {errorResult && (
            <DetailSection>
              <DetailLabel>Error</DetailLabel>
              <ErrorBox>{errorResult.error}</ErrorBox>
            </DetailSection>
          )}

          {hasUnrecognizedResult && (
            <>
              <DetailSection>
                <DetailLabel>Error</DetailLabel>
                <ErrorBox>Unrecognized tool output shape</ErrorBox>
              </DetailSection>
              <DetailSection>
                <DetailLabel>Result</DetailLabel>
                <DetailContent>
                  <JsonHighlight value={result} />
                </DetailContent>
              </DetailSection>
            </>
          )}

          {parsedContent && (
            <DetailSection>
              <DetailLabel>Content</DetailLabel>
              <div className="bg-code-bg m-0 flex max-h-[200px] overflow-y-auto rounded px-2 py-1.5 text-[11px] leading-[1.4]">
                <div className="text-secondary font-monospace mr-2 min-w-10 border-r border-white/10 pr-3 text-right opacity-40 select-none">
                  {parsedContent.lineNumbers.map((lineNum, i) => (
                    <div key={i}>{lineNum}</div>
                  ))}
                </div>
                <pre className="font-monospace m-0 flex-1 p-0 break-words whitespace-pre-wrap">
                  {parsedContent.actualContent}
                </pre>
              </div>
            </DetailSection>
          )}

          {status === "executing" && !hasResult && (
            <DetailSection>
              <DetailContent>
                Reading skill file
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
