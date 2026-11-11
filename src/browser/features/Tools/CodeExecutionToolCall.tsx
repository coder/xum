import React, { useState, useMemo } from "react";
import {
  CodeIcon,
  TerminalIcon,
  CheckCircleIcon,
  XCircleIcon,
  AlertTriangleIcon,
  CirclePauseIcon,
} from "lucide-react";
import { DetailContent, LoadingDots, ToolIcon } from "./Shared/ToolPrimitives";
import { type ToolStatus } from "./Shared/toolUtils";
import { HighlightedCode } from "./Shared/HighlightedCode";
import { ConsoleOutputDisplay } from "./Shared/ConsoleOutput";
import { NestedToolsContainer } from "./Shared/NestedToolsContainer";
import type { CodeExecutionResult, NestedToolCall } from "./Shared/codeExecutionTypes";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import {
  getCodePreviewLine,
  getHiddenNestedCallCount,
  resolveCodeExecutionViewMode,
  type CodeExecutionViewMode,
} from "./codeExecutionViewMode";
import { ToolResultImages, sanitizeImageData } from "./Shared/ToolResultImages";
import { isDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { isMediaPart } from "@/common/utils/attachments/toolAttachmentParts";
import { DisplayOnlyFile, MediaAttachmentDownloadCard } from "./Shared/AttachmentCards";

interface CodeExecutionToolCallProps {
  args: { code: string };
  result?: CodeExecutionResult;
  status?: ToolStatus;
  /** Nested tool calls from streaming (takes precedence over result.toolCalls) */
  nestedCalls?: NestedToolCall[];
  workspaceId?: string;
  toolCallTimestamp?: number;
}

interface ViewToggleProps {
  active: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
  variant?: "default" | "success" | "error" | "warning";
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  active,
  onClick,
  tooltip,
  children,
  variant = "default",
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        onClick={onClick}
        aria-label={tooltip}
        aria-pressed={active}
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-full p-0.5 transition-colors",
          active && "bg-foreground/10",
          variant === "default" && "text-muted hover:text-foreground",
          variant === "success" && "text-success-text hover:text-foreground",
          variant === "error" && "text-red-400 hover:text-red-300",
          variant === "warning" && "text-yellow-400 hover:text-yellow-300"
        )}
      >
        {children}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">{tooltip}</TooltipContent>
  </Tooltip>
);

/**
 * Code execution renders like the other tool rows (Claude Code / Codex / Cursor style): one header
 * line, with the calls it made listed under a thin rail instead of inside a dashed frame.
 * Consecutive executions then stack as an even list rather than a column of boxes, and the code,
 * console and return value stay one click away in the header.
 */
export const CodeExecutionToolCall: React.FC<CodeExecutionToolCallProps> = ({
  args,
  result,
  status = "pending",
  nestedCalls,
  workspaceId,
  toolCallTimestamp,
}) => {
  // Use streaming nested calls if available, otherwise fall back to result
  const toolCalls = nestedCalls ?? [];
  const consoleOutput = result?.consoleOutput ?? [];
  const hasToolCalls = toolCalls.length > 0;
  const isComplete = status === "completed" || status === "failed";

  const [viewMode, setViewMode] = useState<CodeExecutionViewMode>("tools");
  const [showAllCalls, setShowAllCalls] = useState(false);

  // With no nested calls, a successful run collapses to its header line (the code preview says
  // what it ran); a failed one opens on its error so the failure is not hidden.
  const hasFailed = isComplete && result && !result.success;
  const noToolCallsDefaultView = hasFailed ? "result" : "header";

  const effectiveViewMode = resolveCodeExecutionViewMode(viewMode, {
    isComplete,
    hasToolCalls,
    noToolCallsDefaultView,
  });

  const toggleView = (mode: CodeExecutionViewMode) => {
    // When toggling off, return to tools if available, otherwise the no-tool-calls default.
    // Resolve the current mode first so a completed execution with no nested tools doesn't
    // render an empty body for one commit before an effect switches tabs.
    const defaultView = hasToolCalls || !isComplete ? "tools" : noToolCallsDefaultView;
    setViewMode((prev) =>
      resolveCodeExecutionViewMode(prev, { isComplete, hasToolCalls, noToolCallsDefaultView }) ===
      mode
        ? defaultView
        : mode
    );
  };

  // Format result for display
  const formattedResult = useMemo(() => {
    if (!result?.success || result.result === undefined) return null;
    return typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result, null, 2);
  }, [result]);

  // Carrier attachments from nested tool results, split by kind: images
  // render inline via ToolResultImages, media the gallery refuses (PDF, SVG)
  // gets download cards, and display-only files get preview/download cards.
  // Self-healing: history replays hand this renderer unvalidated results, so
  // a non-array attachments value or malformed members must be filtered out
  // rather than allowed to throw and brick the workspace.
  const attachmentParts: unknown[] = Array.isArray(result?.attachments) ? result.attachments : [];
  const mediaAttachments = attachmentParts.filter(isMediaPart);
  const displayAttachments = attachmentParts.filter(isDisplayOnlyFilePart);
  const attachmentsResult =
    mediaAttachments.length > 0 ? { type: "content" as const, value: mediaAttachments } : null;
  const downloadOnlyMedia = mediaAttachments
    .filter((media) => sanitizeImageData(media.mediaType, media.data) === null)
    .map((media) => ({
      type: "media" as const,
      data: media.data,
      mediaType: media.mediaType,
      // Untrusted optional metadata (r24/r25): only well-formed filenames
      // reach the download card.
      ...(typeof media.filename === "string" && media.filename.length > 0
        ? { filename: media.filename }
        : {}),
    }));
  const hasAttachments =
    attachmentsResult !== null || downloadOnlyMedia.length > 0 || displayAttachments.length > 0;

  // Long runs show only their latest calls by default; earlier ones are one click away.
  const hiddenCallCount = getHiddenNestedCallCount(toolCalls.length, showAllCalls);
  const visibleCalls = hiddenCallCount > 0 ? toolCalls.slice(hiddenCallCount) : toolCalls;
  const canCollapseCalls = getHiddenNestedCallCount(toolCalls.length, false) > 0;

  // Determine result icon and variant
  const isInterrupted = status === "interrupted";
  const isBackgrounded = status === "backgrounded";
  const resultVariant = isInterrupted
    ? "warning"
    : isBackgrounded
      ? "default"
      : !isComplete
        ? "default"
        : result?.success
          ? "success"
          : "error";

  const isRunning = !isComplete && !isInterrupted && !isBackgrounded;
  const pinViewToggles = hasFailed === true || isInterrupted || viewMode !== "tools";
  const showsBody =
    (effectiveViewMode === "tools" && hasToolCalls) ||
    effectiveViewMode === "code" ||
    effectiveViewMode === "console" ||
    effectiveViewMode === "result" ||
    hasAttachments;
  const codePreview = hasToolCalls ? "" : getCodePreviewLine(args.code);

  return (
    <div
      role="group"
      aria-label="Code Execution"
      className="[container-type:inline-size] my-2 font-mono text-[11px]"
    >
      <div className="group/header text-secondary flex min-w-0 items-center gap-2 px-3 py-1">
        <ToolIcon toolName="code_execution" />
        <span className="text-foreground shrink-0 font-medium">Code execution</span>
        {hasToolCalls ? (
          <span className="text-muted shrink-0 whitespace-nowrap">
            {toolCalls.length.toLocaleString()} {toolCalls.length === 1 ? "call" : "calls"}
          </span>
        ) : (
          codePreview && (
            <span className="text-muted font-monospace min-w-0 truncate">{codePreview}</span>
          )
        )}
        {isRunning && <LoadingDots aria-hidden="true" />}
        {/* View toggles are drill-down chrome: hidden until hover or keyboard focus, like the
            row actions in Cursor, but pinned when they carry news (a failure or interruption) or
            the user has switched views. Touch screens have no hover, so they always show there. */}
        <div
          className={cn(
            "ml-auto flex shrink-0 items-center transition-opacity",
            !pinViewToggles &&
              "opacity-0 group-hover/header:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
          )}
        >
          <div className="mr-0.5">
            <ViewToggle
              active={effectiveViewMode === "result"}
              onClick={() => toggleView("result")}
              tooltip="Show Result"
              variant={resultVariant}
            >
              {isInterrupted ? (
                <AlertTriangleIcon className="h-3.5 w-3.5" />
              ) : isBackgrounded ? (
                <CirclePauseIcon className="h-3.5 w-3.5" />
              ) : !isComplete ? (
                <span className="text-xs font-medium">...</span>
              ) : result?.success ? (
                <CheckCircleIcon className="h-3.5 w-3.5" />
              ) : (
                <XCircleIcon className="h-3.5 w-3.5" />
              )}
            </ViewToggle>
          </div>
          <ViewToggle
            active={effectiveViewMode === "code"}
            onClick={() => toggleView("code")}
            tooltip="Show Code"
          >
            <CodeIcon className="h-3.5 w-3.5" />
          </ViewToggle>
          <ViewToggle
            active={effectiveViewMode === "console"}
            onClick={() => toggleView("console")}
            tooltip="Show Console"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
          </ViewToggle>
        </div>
      </div>

      {/* The rail sits under the header icon so the body reads as the header's children. */}
      {showsBody && (
        <div className="border-foreground/15 ml-[17px] flex min-w-0 flex-col gap-1.5 border-l py-0.5 pl-2">
          {effectiveViewMode === "tools" && hasToolCalls && (
            <>
              {canCollapseCalls && (
                <button
                  type="button"
                  className="text-muted hover:text-foreground self-start px-3 text-left transition-colors"
                  aria-expanded={showAllCalls}
                  onClick={() => setShowAllCalls((prev) => !prev)}
                >
                  {showAllCalls
                    ? "Show fewer calls"
                    : `Show ${hiddenCallCount.toLocaleString()} earlier ${
                        hiddenCallCount === 1 ? "call" : "calls"
                      }`}
                </button>
              )}
              <NestedToolsContainer
                calls={visibleCalls}
                parentInterrupted={isInterrupted}
                workspaceId={workspaceId}
                toolCallTimestamp={toolCallTimestamp}
              />
            </>
          )}

          {effectiveViewMode === "code" && (
            <div className="border-foreground/10 bg-code-bg rounded border p-2">
              <HighlightedCode language="javascript" code={args.code.trim()} />
            </div>
          )}

          {effectiveViewMode === "console" && (
            <div className="border-foreground/10 bg-code-bg rounded border p-2">
              {consoleOutput.length > 0 ? (
                <ConsoleOutputDisplay output={consoleOutput} />
              ) : (
                <span className="text-muted text-xs italic">No console output</span>
              )}
            </div>
          )}

          {effectiveViewMode === "result" &&
            (isComplete && result ? (
              result.success ? (
                formattedResult ? (
                  <DetailContent className="p-2">{formattedResult}</DetailContent>
                ) : (
                  <div className="text-muted text-xs italic">(no return value)</div>
                )
              ) : (
                <DetailContent className="border border-red-500/30 bg-red-500/10 p-2 text-red-400">
                  {result.error}
                </DetailContent>
              )
            ) : isInterrupted ? (
              <div className="text-xs text-yellow-400 italic">Execution interrupted</div>
            ) : isBackgrounded ? (
              <div className="text-muted text-xs italic">Execution backgrounded</div>
            ) : (
              <div className="text-muted text-xs italic">Execution in progress...</div>
            ))}

          {/* Attachments carried out of nested tool results (attach_file): the
          nested result only holds a stub, so previews render from the carrier. */}
          {attachmentsResult && <ToolResultImages result={attachmentsResult} />}
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
          {displayAttachments.length > 0 && (
            <div className="space-y-2">
              {displayAttachments.map((file, index) => (
                <DisplayOnlyFile key={`${file.filename ?? file.mediaType}-${index}`} file={file} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
