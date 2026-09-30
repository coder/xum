import React from "react";
import { FileIcon } from "@/browser/components/FileIcon/FileIcon";
import { parsePatch } from "diff";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";
import type {
  FileEditInsertToolArgs,
  FileEditInsertToolResult,
  FileEditReplaceStringToolArgs,
  FileEditReplaceStringToolResult,
  FileEditReplaceLinesToolArgs,
  FileEditReplaceLinesToolResult,
} from "@/common/types/tools";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
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
  ErrorBox,
} from "./Shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { useStickyExpand } from "../Messages/useStickyExpand";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { DiffContainer, DiffRenderer, SelectableDiffRenderer } from "../Shared/DiffRenderer";
import { KebabMenu, type KebabMenuItem } from "@/browser/components/KebabMenu/KebabMenu";
import { JsonHighlight } from "./Shared/HighlightedCode";
import type { ReviewNoteData } from "@/common/types/review";

type FileEditOperationArgs =
  | FileEditReplaceStringToolArgs
  | FileEditReplaceLinesToolArgs
  | FileEditInsertToolArgs;

type FileEditToolResult =
  | FileEditReplaceStringToolResult
  | FileEditReplaceLinesToolResult
  | FileEditInsertToolResult;

// Large file-edit patches can create thousands of DOM nodes and trigger expensive layout
// measurement while opening chats; preview first and let users opt into the full parsed render.
const LARGE_DIFF_PREVIEW_LINE_THRESHOLD = 600;
const LARGE_DIFF_PREVIEW_CHAR_THRESHOLD = 80_000;
const LARGE_DIFF_PREVIEW_LINE_LIMIT = 240;

interface LargeDiffPreview {
  previewDiff: string;
  totalLines: number;
  displayedLines: number;
  omittedLines: number;
}

export function buildLargeDiffPreview(diff: string): LargeDiffPreview | null {
  const lines = diff.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const totalLines = lines.length;
  if (
    totalLines <= LARGE_DIFF_PREVIEW_LINE_THRESHOLD &&
    diff.length <= LARGE_DIFF_PREVIEW_CHAR_THRESHOLD
  ) {
    return null;
  }

  const previewLines = lines.slice(0, LARGE_DIFF_PREVIEW_LINE_LIMIT);
  const omittedLines = Math.max(0, totalLines - previewLines.length);
  const previewDiff =
    omittedLines > 0
      ? [
          ...previewLines,
          `... ${omittedLines.toLocaleString()} diff lines omitted from preview ...`,
        ].join("\n")
      : previewLines.join("\n");

  return {
    previewDiff,
    totalLines,
    displayedLines: previewLines.length,
    omittedLines,
  };
}

interface DiffLineDeltaPreview {
  additions: number;
  deletions: number;
  additionsLabel: string;
  deletionsLabel: string;
  title: string;
}

function formatLineDeltaTitle(count: number, noun: "added" | "removed"): string {
  return `${count.toLocaleString()} ${count === 1 ? "line" : "lines"} ${noun}`;
}

export function buildDiffLineDeltaPreview(diff: string): DiffLineDeltaPreview | null {
  let additions = 0;
  let deletions = 0;

  try {
    // Count parsed hunk payload lines instead of filtering raw +/- prefixes: real edited
    // content can itself begin with +++ or ---, which looks like a file header in raw text.
    for (const patch of parsePatch(diff)) {
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) {
            additions += 1;
          } else if (line.startsWith("-")) {
            deletions += 1;
          }
        }
      }
    }
  } catch {
    return null;
  }

  if (additions === 0 && deletions === 0) {
    return null;
  }

  return {
    additions,
    deletions,
    additionsLabel: `+${additions.toLocaleString()}`,
    deletionsLabel: `-${deletions.toLocaleString()}`,
    title: `${formatLineDeltaTitle(additions, "added")}, ${formatLineDeltaTitle(
      deletions,
      "removed"
    )}`,
  };
}

interface FileEditToolCallProps {
  toolName: "file_edit_replace_string" | "file_edit_replace_lines" | "file_edit_insert";
  args: FileEditOperationArgs;
  result?: FileEditToolResult;
  status?: ToolStatus;
  onReviewNote?: (data: ReviewNoteData) => void;
}

function renderDiff(
  diff: string,
  filePath?: string,
  onReviewNote?: (data: ReviewNoteData) => void
): React.ReactNode {
  try {
    const patches = parsePatch(diff);
    if (patches.length === 0) {
      return <div style={{ padding: "8px", color: "var(--color-muted)" }}>No changes</div>;
    }

    // Render each hunk using SelectableDiffRenderer if we have a callback, otherwise DiffRenderer
    return patches.map((patch, patchIdx) => (
      <React.Fragment key={patchIdx}>
        {patch.hunks.map((hunk, hunkIdx) => (
          <React.Fragment key={hunkIdx}>
            {onReviewNote && filePath ? (
              <SelectableDiffRenderer
                content={hunk.lines.join("\n")}
                showLineNumbers={true}
                oldStart={hunk.oldStart}
                newStart={hunk.newStart}
                filePath={filePath}
                fontSize="11px"
                onReviewNote={onReviewNote}
              />
            ) : (
              <DiffRenderer
                content={hunk.lines.join("\n")}
                showLineNumbers={true}
                oldStart={hunk.oldStart}
                newStart={hunk.newStart}
                filePath={filePath}
                fontSize="11px"
              />
            )}
          </React.Fragment>
        ))}
      </React.Fragment>
    ));
  } catch (error) {
    return <ErrorBox>Failed to parse diff: {String(error)}</ErrorBox>;
  }
}

function renderRawDiff(diff: string): React.ReactNode {
  return (
    <DiffContainer>
      <pre className="font-monospace m-0 text-[11px] leading-[1.4] break-words whitespace-pre-wrap">
        {diff}
      </pre>
    </DiffContainer>
  );
}

export const FileEditToolCall: React.FC<FileEditToolCallProps> = ({
  toolName,
  args,
  result,
  status = "pending",
  onReviewNote,
}) => {
  // Collapse failed edits by default since they're common and expected. This is just
  // the fallback: the per-workspace sticky tools preference (set once the user
  // expands/collapses any tool here) wins. Seeded once at mount, so a later result or
  // preference change never mutates this present block.
  const isFailed = result?.success === false;
  const { expanded, toggleExpanded } = useStickyExpand("tools", !isFailed);
  const [showRaw, setShowRaw] = React.useState(false);
  const [showInvocation, setShowInvocation] = React.useState(false);
  const [showFullDiff, setShowFullDiff] = React.useState(false);

  const uiOnlyDiff = getToolOutputUiOnly(result)?.file_edit?.diff;
  const diff = result && result.success ? (uiOnlyDiff ?? result.diff) : undefined;
  const filePath = extractToolFilePath(args);
  const diffLineDelta = diff ? buildDiffLineDeltaPreview(diff) : null;
  const largeDiffPreview = diff ? buildLargeDiffPreview(diff) : null;
  // Single nullable handle for the active preview so JSX truthiness checks narrow the type
  // directly (no separate boolean + repeated `&& largeDiffPreview` guards).
  const activeDiffPreview = largeDiffPreview && !showRaw && !showFullDiff ? largeDiffPreview : null;

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard();

  // Build kebab menu items - only show menu when there's a result
  const kebabMenuItems: KebabMenuItem[] = result
    ? [
        {
          label: showInvocation ? "Hide Invocation" : "Show Invocation",
          onClick: () => setShowInvocation(!showInvocation),
          active: showInvocation,
        },
        // Copy/show patch options only for successful edits with diffs
        ...(result.success && diff
          ? [
              {
                label: copied ? "Copied" : "Copy Patch",
                onClick: () => void copyToClipboard(diff),
              },
              {
                label: showRaw ? "Show Parsed" : "Show Patch",
                onClick: () => setShowRaw(!showRaw),
                active: showRaw,
              },
            ]
          : []),
      ]
    : [];

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader className="hover:text-secondary cursor-default">
        <div
          onClick={toggleExpanded}
          className="hover:text-text flex flex-1 cursor-pointer items-center gap-2"
        >
          <ExpandIcon expanded={expanded}>▶</ExpandIcon>
          <ToolIcon toolName={toolName} />
          <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
            <FileIcon filePath={filePath} className="text-[15px] leading-none" />
            <span className="font-monospace truncate">{filePath}</span>
          </div>
          {diffLineDelta && (
            <span
              className="counter-nums-mono shrink-0 text-[10px] whitespace-nowrap [@container(max-width:420px)]:hidden"
              title={diffLineDelta.title}
              aria-label={diffLineDelta.title}
            >
              <span className="text-success">{diffLineDelta.additionsLabel}</span>
              <span className="text-muted">, </span>
              <span className="text-danger">{diffLineDelta.deletionsLabel}</span>
            </span>
          )}
        </div>
        {!(result && result.success && diff) && (
          <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
        )}
        {kebabMenuItems.length > 0 && (
          <div className="mr-2">
            <KebabMenu items={kebabMenuItems} />
          </div>
        )}
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {showInvocation && (
            <DetailSection>
              <DetailLabel>Invocation</DetailLabel>
              <JsonHighlight value={{ tool: toolName, args }} />
            </DetailSection>
          )}

          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {result.success && diff && (
                <>
                  {activeDiffPreview && (
                    <DetailSection>
                      <div className="text-muted text-[11px]">
                        Large diff preview: showing{" "}
                        {activeDiffPreview.displayedLines.toLocaleString()} of{" "}
                        {activeDiffPreview.totalLines.toLocaleString()} lines. Full patch is still
                        available from the menu.
                      </div>
                      <button
                        type="button"
                        className="text-accent hover:text-accent-light mt-1 text-left text-[11px] underline underline-offset-2"
                        onClick={() => setShowFullDiff(true)}
                      >
                        Render full parsed diff
                      </button>
                    </DetailSection>
                  )}
                  {showRaw
                    ? renderRawDiff(diff)
                    : activeDiffPreview
                      ? renderRawDiff(activeDiffPreview.previewDiff)
                      : renderDiff(diff, filePath, onReviewNote)}
                </>
              )}
            </>
          )}

          {status === "executing" && result === undefined && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                Waiting for result
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
