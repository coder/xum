import React from "react";
import {
  ErrorBox,
  ExpandIcon,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import { ToolResultImages, extractImagesFromToolResult } from "./Shared/ToolResultImages";
import {
  getStatusDisplay,
  isToolErrorResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

interface DesktopScreenshotArgs {
  scaledWidth?: number | null;
  scaledHeight?: number | null;
}

interface DesktopScreenshotContentItem {
  type: string;
  text?: string;
}

interface DesktopScreenshotContentResult {
  type: "content";
  value: DesktopScreenshotContentItem[];
}

interface DesktopScreenshotToolCallProps {
  args?: DesktopScreenshotArgs;
  result?: unknown;
  status?: ToolStatus;
}

function getScreenshotTextItems(result: unknown): string[] {
  if (typeof result !== "object" || result === null) {
    return [];
  }

  const contentResult = result as Partial<DesktopScreenshotContentResult>;
  if (contentResult.type !== "content" || !Array.isArray(contentResult.value)) {
    return [];
  }

  return contentResult.value
    .filter(
      (item): item is DesktopScreenshotContentItem =>
        typeof item === "object" &&
        item !== null &&
        item.type === "text" &&
        typeof item.text === "string"
    )
    .map((item) => item.text ?? "");
}

function getScreenshotDimensions(result: unknown): string | null {
  const dimensionsPattern = /\b(\d+)x(\d+)\b/i;

  for (const text of getScreenshotTextItems(result)) {
    const match = dimensionsPattern.exec(text);
    if (match) {
      return `${match[1]}×${match[2]}`;
    }
  }

  return null;
}

function getScaleHint(args?: DesktopScreenshotArgs): string | null {
  if (args?.scaledWidth != null && args.scaledHeight != null) {
    return `${args.scaledWidth}×${args.scaledHeight}`;
  }

  return null;
}

export const DesktopScreenshotToolCall: React.FC<DesktopScreenshotToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const errorResult = isToolErrorResult(result) ? result : null;
  const images = extractImagesFromToolResult(result);
  const hasImages = images.length > 0;
  const screenshotDimensions = getScreenshotDimensions(result);
  const scaleHint = getScaleHint(args);
  const hasDetails =
    hasImages || errorResult !== null || scaleHint !== null || status === "executing";
  const shouldShowDetails = expanded || hasImages || errorResult !== null;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={shouldShowDetails} />}
        <ToolIcon toolName="desktop_screenshot" />
        <ToolName>Desktop Screenshot</ToolName>
        {screenshotDimensions && (
          <span className="text-secondary text-[10px] whitespace-nowrap">
            {screenshotDimensions}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {shouldShowDetails && (
        <ToolDetails>
          {screenshotDimensions && (
            <div className="text-secondary mb-2 text-[11px]">
              Captured at {screenshotDimensions}
            </div>
          )}
          {scaleHint && (
            <div className="text-secondary mb-2 text-[11px]">Scale hint: {scaleHint}</div>
          )}
          {hasImages && <ToolResultImages result={result} />}
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}
          {expanded &&
            !hasImages &&
            !errorResult &&
            scaleHint === null &&
            status === "executing" && (
              <div className="text-secondary text-[11px]">
                Waiting for screenshot
                <LoadingDots />
              </div>
            )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
