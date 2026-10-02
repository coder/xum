import React from "react";
import { FileIcon } from "@/browser/components/FileIcon/FileIcon";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";
import type { FileReadToolArgs, FileReadToolResult } from "@/common/types/tools";
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
import { formatBytes } from "@/common/utils/formatBytes";

import { OpenAsArtifactButton } from "@/browser/features/RightSidebar/ArtifactsTab/OpenAsArtifactButton";

interface FileReadToolCallProps {
  args: FileReadToolArgs;
  result?: FileReadToolResult;
  status?: ToolStatus;
  workspaceId?: string;
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

export const FileReadToolCall: React.FC<FileReadToolCallProps> = ({
  args,
  result,
  status = "pending",
  workspaceId,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  const filePath = extractToolFilePath(args) ?? "";

  // Parse the file content to extract line numbers and actual content
  const parsedContent = result?.success && result.content ? parseFileContent(result.content) : null;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="file_read" />
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          <FileIcon filePath={filePath} className="text-[15px] leading-none" />
          <span className="font-monospace truncate">{filePath}</span>
          <OpenAsArtifactButton workspaceId={workspaceId} path={filePath} relativeTo="tool-cwd" />
        </div>
        {result && result.success && parsedContent && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            <span className="hidden @sm:inline">read </span>
            {formatBytes(parsedContent.actualBytes)}
            <span className="hidden @lg:inline"> of {formatBytes(result.file_size)}</span>
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex gap-1.5">
                <span className="text-secondary font-medium">Path:</span>
                <span className="text-text font-monospace break-all">{filePath}</span>
              </div>
              {args.offset != null && (
                <div className="flex gap-1.5">
                  <span className="text-secondary font-medium">Offset:</span>
                  <span className="text-text font-monospace break-all">line {args.offset}</span>
                </div>
              )}
              {args.limit != null && (
                <div className="flex gap-1.5">
                  <span className="text-secondary font-medium">Limit:</span>
                  <span className="text-text font-monospace break-all">{args.limit} lines</span>
                </div>
              )}
            </div>
          </DetailSection>

          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {result.success && result.content && parsedContent && (
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
            </>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <DetailContent>
                Reading file
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
