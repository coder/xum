import React, { useState, useMemo } from "react";
import {
  CodeIcon,
  TerminalIcon,
  CheckCircleIcon,
  XCircleIcon,
  AlertTriangleIcon,
  CirclePauseIcon,
} from "lucide-react";
import {
  DetailContent,
  ErrorBox,
  ExpandIcon,
  LoadingDots,
  TOOL_RAIL_CLASS,
  ToolHeader,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import { isRoutineToolCall } from "@/browser/utils/messages/transcriptRenderProjection";
import { type ToolStatus } from "./Shared/toolUtils";
import { HighlightedCode } from "./Shared/HighlightedCode";
import { ConsoleOutputDisplay } from "./Shared/ConsoleOutput";
import { NestedToolsContainer } from "./Shared/NestedToolsContainer";
import type { CodeExecutionResult, NestedToolCall } from "./Shared/codeExecutionTypes";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import {
  getCodePreviewLine,
  selectVisibleNestedCalls,
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
  variant?: "default" | "error" | "warning";
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
          // 16px, the height of a row's text line, so a script header is as tall as any other row.
          "flex h-4 w-4 items-center justify-center rounded-full transition-colors",
          // A finger needs more than 16px; touch screens trade the row height for the target.
          "[@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6",
          active && "bg-foreground/10",
          // Success is silent here as on every row; only a failure or interruption has colour.
          variant === "default" && "text-muted hover:text-foreground",
          variant === "error" && "text-danger hover:text-foreground",
          variant === "warning" && "text-interrupted hover:text-foreground"
        )}
      >
        {children}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">{tooltip}</TooltipContent>
  </Tooltip>
);

/**
 * A script (code execution) is a tool row like any other (Claude Code / Codex / Cursor style):
 * one header line behind the shared chevron, and the calls it made on the rail beneath it.
 * Opening a summary row therefore reveals script headers, and opening a script reveals its
 * calls: one level per click. The code, console and return value are views of the opened body.
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
  const isInterrupted = status === "interrupted";
  const isBackgrounded = status === "backgrounded";
  const isRunning = !isComplete && !isInterrupted && !isBackgrounded;
  const hasFailed = isComplete && result != null && !result.success;

  const [viewMode, setViewMode] = useState<CodeExecutionViewMode>("tools");
  const [showAllCalls, setShowAllCalls] = useState(false);
  // null until the user toggles the row; their choice then wins over the default below.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  // With no nested calls the body is the code itself, or the error when the run failed.
  const noToolCallsDefaultView = hasFailed ? "result" : "code";
  const viewOptions = { isComplete, hasToolCalls, noToolCallsDefaultView } as const;
  const effectiveViewMode = resolveCodeExecutionViewMode(viewMode, viewOptions);

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

  // A settled script that only made routine calls is one line, like the summary row it may sit
  // under. It opens by default only when there is something to watch or review: it is still
  // running, it failed or was interrupted, it ran something the reader must see (an edit, a
  // question, a message), or it carries attachments.
  const madeOnlyRoutineCalls = toolCalls.every((call) =>
    isRoutineToolCall(call.toolName, call.input, call.output)
  );
  const expandedByDefault =
    isRunning || hasFailed || isInterrupted || !madeOnlyRoutineCalls || hasAttachments;
  const expanded = userExpanded ?? expandedByDefault;

  const toggleView = (mode: CodeExecutionViewMode) => {
    if (!expanded) {
      // Asking for a view of a closed script opens it on that view.
      setViewMode(mode);
      setUserExpanded(true);
      return;
    }
    // Toggling the open view off returns to the calls, or to the default when there are none.
    // Resolve the current mode first so a completed script with no nested calls doesn't render
    // an empty body for one commit.
    const defaultView = hasToolCalls || !isComplete ? "tools" : noToolCallsDefaultView;
    setViewMode((prev) =>
      resolveCodeExecutionViewMode(prev, viewOptions) === mode ? defaultView : mode
    );
  };

  // Long runs show only their latest calls by default; earlier ones are one click away.
  const { visible: visibleCalls, hiddenCount: hiddenCallCount } = selectVisibleNestedCalls(
    toolCalls,
    showAllCalls
  );
  const canCollapseCalls = selectVisibleNestedCalls(toolCalls, false).hiddenCount > 0;

  const pinViewToggles = hasFailed || isInterrupted || (expanded && viewMode !== "tools");
  const codePreview = hasToolCalls ? "" : getCodePreviewLine(args.code);

  return (
    <div
      role="group"
      aria-label="Script"
      className="font-monospace [container-type:inline-size] my-2 text-[11px]"
    >
      <ToolHeader className="group/header min-w-0 cursor-default px-1 py-1">
        {/* The disclosure is a real button, so opening and closing a script works from the
            keyboard (Tab, then Enter or Space) and announces its state. It is a sibling of the
            view toggles, not their parent: buttons must not nest. */}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setUserExpanded(!expanded)}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left",
            "focus-visible:outline-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          )}
        >
          <ExpandIcon expanded={expanded} />
          <ToolIcon toolName="code_execution" />
          <span className="text-foreground shrink-0">Script</span>
          {hasToolCalls ? (
            <span className="text-muted shrink-0 whitespace-nowrap">
              {toolCalls.length.toLocaleString()} {toolCalls.length === 1 ? "call" : "calls"}
            </span>
          ) : (
            codePreview && (
              <span className="text-muted font-monospace min-w-0 truncate">{codePreview}</span>
            )
          )}
          {isRunning && <LoadingDots aria-hidden="true" className="text-muted" />}
        </button>
        {/* View toggles are drill-down chrome: hidden until hover or keyboard focus, pinned when
            they carry news (a failure or interruption) or a view is open. Touch screens have no
            hover, so they always show there. */}
        <div
          className={cn(
            "ml-auto flex shrink-0 items-center gap-0.5 transition-opacity",
            !pinViewToggles &&
              "opacity-0 group-hover/header:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
          )}
        >
          {!isRunning && (
            <ViewToggle
              active={expanded && effectiveViewMode === "result"}
              onClick={() => toggleView("result")}
              tooltip="Result"
              variant={isInterrupted ? "warning" : hasFailed ? "error" : "default"}
            >
              {isInterrupted ? (
                <AlertTriangleIcon className="h-3.5 w-3.5" />
              ) : isBackgrounded ? (
                <CirclePauseIcon className="h-3.5 w-3.5" />
              ) : hasFailed ? (
                <XCircleIcon className="h-3.5 w-3.5" />
              ) : (
                <CheckCircleIcon className="h-3.5 w-3.5" />
              )}
            </ViewToggle>
          )}
          <ViewToggle
            active={expanded && effectiveViewMode === "code"}
            onClick={() => toggleView("code")}
            tooltip="Code"
          >
            <CodeIcon className="h-3.5 w-3.5" />
          </ViewToggle>
          <ViewToggle
            active={expanded && effectiveViewMode === "console"}
            onClick={() => toggleView("console")}
            tooltip="Console"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
          </ViewToggle>
        </div>
      </ToolHeader>

      {expanded && (
        <div className={cn(TOOL_RAIL_CLASS, "flex min-w-0 flex-col gap-1.5 py-0.5")}>
          {effectiveViewMode === "tools" && hasToolCalls && (
            <>
              {canCollapseCalls && (
                <button
                  type="button"
                  className="text-muted hover:text-foreground self-start px-1 text-left transition-colors"
                  aria-expanded={showAllCalls}
                  onClick={() => setShowAllCalls((prev) => !prev)}
                >
                  {showAllCalls
                    ? "Hide earlier calls"
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
                <span className="text-muted italic">No console output</span>
              )}
            </div>
          )}

          {effectiveViewMode === "result" &&
            (isComplete && result ? (
              result.success ? (
                formattedResult ? (
                  <DetailContent className="p-2">{formattedResult}</DetailContent>
                ) : (
                  <div className="text-muted italic">No return value</div>
                )
              ) : (
                <ErrorBox className="break-words whitespace-pre-wrap">{result.error}</ErrorBox>
              )
            ) : isInterrupted ? (
              <div className="text-interrupted italic">Interrupted</div>
            ) : isBackgrounded ? (
              <div className="text-muted italic">Backgrounded</div>
            ) : (
              <div className="text-muted italic">Running…</div>
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
