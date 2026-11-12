import React from "react";
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

/** The summary line of an opened read: the path, the requested range and how much was read. */
function FileReadSummary(props: {
  filePath: string;
  args: FileReadToolArgs;
  result: FileReadToolResult | undefined;
  parsedContent: ReturnType<typeof parseFileContent> | null;
}) {
  return (
    <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
      <div className="flex gap-1.5">
        <span className="text-secondary font-medium">Path:</span>
        <span className="text-text font-monospace break-all">{props.filePath}</span>
      </div>
      {props.args.offset != null && (
        <div className="flex gap-1.5">
          <span className="text-secondary font-medium">Offset:</span>
          <span className="text-text font-monospace break-all">line {props.args.offset}</span>
        </div>
      )}
      {props.args.limit != null && (
        <div className="flex gap-1.5">
          <span className="text-secondary font-medium">Limit:</span>
          <span className="text-text font-monospace break-all">{props.args.limit} lines</span>
        </div>
      )}
      {/* History replays can carry results without a numeric file_size. */}
      {props.result?.success && props.parsedContent && (
        <div className="flex gap-1.5">
          <span className="text-secondary font-medium">Read:</span>
          <span className="text-text font-monospace">
            {formatBytes(props.parsedContent.actualBytes)}
            {Number.isFinite(props.result.file_size) &&
              ` of ${formatBytes(props.result.file_size)}`}
          </span>
        </div>
      )}
    </div>
  );
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
        <ExpandIcon expanded={expanded} />
        <ToolIcon toolName="file_read" />
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          {/* The collapsed row is the path and nothing else: the tool icon already says "read",
              and how much was read is detail (see the expanded block). */}
          <span className="font-monospace truncate">{filePath}</span>
          <OpenAsArtifactButton workspaceId={workspaceId} path={filePath} relativeTo="tool-cwd" />
        </div>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <FileReadSummary
              filePath={filePath}
              args={args}
              result={result}
              parsedContent={parsedContent}
            />
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
