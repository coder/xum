import type React from "react";
import { isToolContentResult } from "@/common/utils/tools/toolContentResult";
import {
  isDisplayOnlyFilePart,
  type DisplayOnlyFilePart,
} from "@/common/utils/attachments/displayOnlyFileParts";
import { DisplayOnlyFile, MediaAttachmentDownloadCard } from "./Shared/AttachmentCards";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";
import { redactToolResultAttachmentsForDisplay } from "./Shared/toolResultDisplay";
import {
  ToolResultImages,
  extractImagesFromToolResult,
  sanitizeImageData,
} from "./Shared/ToolResultImages";

interface AttachFileToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
}

function extractDisplayFilesFromToolResult(result: unknown): DisplayOnlyFilePart[] {
  if (!isToolContentResult(result)) {
    return [];
  }

  return result.value.filter(isDisplayOnlyFilePart);
}

export const AttachFileToolCall: React.FC<AttachFileToolCallProps> = (props) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const displayFiles = extractDisplayFilesFromToolResult(props.result);
  const hasDisplayFiles = displayFiles.length > 0;
  const hasDetails = props.args !== undefined || props.result !== undefined;
  const images = extractImagesFromToolResult(props.result);
  const hasImages = images.length > 0;
  // Media attachments the image gallery refuses to render (PDF, SVG) would
  // otherwise be invisible in the tool card; surface them as download cards.
  const downloadOnlyMedia = images.filter(
    (image) => sanitizeImageData(image.mediaType, image.data) === null
  );
  const shouldShowDetails = expanded || hasImages || hasDisplayFiles;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={expanded}>▶</ExpandIcon>}
        <ToolIcon toolName={props.toolName} />
        <ToolName>{props.toolName}</ToolName>
        <StatusIndicator status={props.status ?? "pending"}>
          {getStatusDisplay(props.status ?? "pending")}
        </StatusIndicator>
      </ToolHeader>

      {hasImages && <ToolResultImages result={props.result} />}
      {downloadOnlyMedia.length > 0 && (
        <div className="space-y-2">
          {downloadOnlyMedia.map((media, index) => (
            <MediaAttachmentDownloadCard
              key={`${media.filename ?? media.mediaType}-${index}`}
              media={media}
            />
          ))}
        </div>
      )}
      {hasDisplayFiles && (
        <div className="space-y-2">
          {displayFiles.map((file, index) => (
            <DisplayOnlyFile key={`${file.filename ?? file.mediaType}-${index}`} file={file} />
          ))}
        </div>
      )}

      {expanded && hasDetails && (
        <ToolDetails>
          {props.args !== undefined && (
            <DetailSection>
              <DetailLabel>Arguments</DetailLabel>
              <DetailContent>
                <JsonHighlight value={props.args} />
              </DetailContent>
            </DetailSection>
          )}

          {props.result !== undefined && (
            <DetailSection>
              <DetailLabel>Result</DetailLabel>
              <DetailContent>
                <JsonHighlight value={redactToolResultAttachmentsForDisplay(props.result)} />
              </DetailContent>
            </DetailSection>
          )}

          {props.status === "executing" && props.result === undefined && (
            <DetailSection>
              <DetailContent>
                Waiting for result
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
          {props.status === "redacted" && (
            <DetailSection>
              <DetailContent className="text-muted italic">
                Output excluded from shared transcript
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
