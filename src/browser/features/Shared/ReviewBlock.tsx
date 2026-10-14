/**
 * ReviewBlock - Renders review data as styled components
 *
 * Used in:
 * - UserMessage to display submitted reviews (from metadata)
 * - ChatInput preview to show reviews before sending
 */

import React, { useState, useCallback, useRef, useMemo } from "react";
import { Pencil, Check, Trash2, Unlink } from "lucide-react";
import { DiffRenderer } from "./DiffRenderer";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import {
  formatLineRangeCompact,
  formatReviewLocationLabel,
} from "@/browser/utils/review/lineRange";
import { matchesKeybind, formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { parseReviewLineRange } from "@/common/types/review";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED INTERNAL COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewBlockCoreProps {
  filePath: string;
  lineRange: string;
  code: string;
  diff?: string;
  oldStart?: number;
  newStart?: number;
  comment: string;
  /** Header labels (full / compact) overriding `path:L<range>`, e.g. for artifact comments. */
  locationLabels?: { full: string; compact: string };
  /** Detach from chat (sets status back to pending) */
  onDetach?: () => void;
  /** Mark as complete (checked) */
  onComplete?: () => void;
  /** Permanently delete the review */
  onDelete?: () => void;
  onEditComment?: (newComment: string) => void;
  /** Compact mode: hide file header (when parent already shows file context) */
  compact?: boolean;
}

/**
 * Core review block rendering - used by both ReviewBlock and ReviewBlockFromData
 */
const ReviewBlockCore: React.FC<ReviewBlockCoreProps> = ({
  filePath,
  lineRange,
  code,
  diff,
  oldStart,
  newStart,
  comment,
  locationLabels,
  onDetach,
  onComplete,
  onDelete,
  onEditComment,
  compact = false,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(comment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Check if code has embedded line numbers (from review selection)
  // Format: "12 14 + content" or " 1  2   content"
  const hasEmbeddedLineNumbers = useMemo(() => {
    if (!code) return false;
    const firstLine = code.split("\n")[0] ?? "";
    // Match: optional digits, space, optional digits, space, then +/-/space
    return /^\s*\d*\s+\d*\s+[+-\s]/.test(firstLine);
  }, [code]);

  const plainCodeStartLine = useMemo(() => {
    const parsed = parseReviewLineRange(lineRange);
    return parsed?.new?.start ?? parsed?.old?.start ?? 1;
  }, [lineRange]);

  const handleStartEdit = useCallback(() => {
    setEditValue(comment);
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [comment]);

  const handleSaveEdit = useCallback(() => {
    if (onEditComment && editValue.trim() !== comment) {
      onEditComment(editValue.trim());
    }
    setIsEditing(false);
  }, [editValue, comment, onEditComment]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(comment);
    setIsEditing(false);
  }, [comment]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SAVE_EDIT)) {
        e.preventDefault();
        handleSaveEdit();
      } else if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSaveEdit, handleCancelEdit]
  );

  // Has any action available
  const hasActions = Boolean(onComplete ?? onDetach ?? onDelete ?? onEditComment);

  return (
    <div className="group/review min-w-0 overflow-hidden rounded border border-[var(--color-review-accent)]/30 bg-[var(--color-review-accent)]/5">
      {/* Header row: file:line on left, actions on right */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-review-accent)]/20 bg-[var(--color-review-accent)]/10 px-2 py-1 text-xs">
        {/* File path and line range - only show if not compact */}
        {!compact && (
          <span className="text-primary min-w-0 flex-1 truncate font-mono text-[11px]">
            {locationLabels?.full ?? `${filePath}:L${formatLineRangeCompact(lineRange)}`}
          </span>
        )}

        {/* In compact mode, show line range only */}
        {compact && (
          <span className="text-muted min-w-0 flex-1 truncate font-mono text-[10px]">
            {locationLabels?.compact ?? `L${formatLineRangeCompact(lineRange)}`}
          </span>
        )}

        {/* Action buttons - visible on hover */}
        {hasActions && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/review:opacity-100">
            {onEditComment && !isEditing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleStartEdit}
                    aria-label="Edit comment"
                    className="text-muted hover:text-secondary flex items-center justify-center rounded p-1 transition-colors"
                  >
                    <Pencil className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Edit comment</TooltipContent>
              </Tooltip>
            )}
            {onComplete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onComplete}
                    aria-label="Mark as done"
                    className="text-muted hover:text-success flex items-center justify-center rounded p-1 transition-colors"
                  >
                    <Check className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Mark as done</TooltipContent>
              </Tooltip>
            )}
            {onDetach && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onDetach}
                    aria-label="Detach from message"
                    className="text-muted hover:text-secondary flex items-center justify-center rounded p-1 transition-colors"
                  >
                    <Unlink className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Detach from message</TooltipContent>
              </Tooltip>
            )}
            {onDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onDelete}
                    aria-label="Delete review"
                    className="text-muted hover:text-error flex items-center justify-center rounded p-1 transition-colors"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Delete review</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Code snippet - horizontal scroll for long lines, vertical scroll limited to max-h-48 */}
      {(diff ?? code) && (
        <div className="max-h-48 overflow-auto text-[11px]">
          {diff ? (
            <DiffRenderer
              content={diff}
              showLineNumbers={true}
              oldStart={oldStart ?? 1}
              newStart={newStart ?? 1}
              fontSize="11px"
              filePath={filePath}
              maxHeight="none"
              className="min-w-fit rounded-none"
            />
          ) : hasEmbeddedLineNumbers ? (
            // Legacy: code with embedded line numbers - render as plain monospace
            <pre className="font-monospace bg-code-bg p-1.5 text-[11px] leading-[1.4] whitespace-pre">
              {code}
            </pre>
          ) : (
            // Plain code without diff markers: prefix each line with a
            // space so DiffRenderer treats them as context lines and keeps
            // the first real character intact.
            <DiffRenderer
              content={code
                .split("\n")
                .map((line) => ` ${line}`)
                .join("\n")}
              showLineNumbers={true}
              lineNumberMode="new"
              newStart={plainCodeStartLine}
              fontSize="11px"
              filePath={filePath}
              maxHeight="none"
              className="min-w-fit rounded-none"
            />
          )}
        </div>
      )}

      {/* Comment section - inline with edit support */}
      {(comment || onEditComment) && (
        <div className="border-t border-[var(--color-review-accent)]/20 px-2 py-1">
          {isEditing ? (
            <div className="space-y-1">
              <textarea
                ref={textareaRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="text-primary w-full resize-none rounded border border-[var(--color-review-accent)]/40 bg-[var(--color-review-accent)]/10 px-1.5 py-1 text-xs focus:border-[var(--color-review-accent)]/60 focus:outline-none"
                rows={2}
                placeholder="Your comment..."
              />
              <div className="flex items-center justify-end gap-1">
                <span className="text-muted text-[10px]">
                  {formatKeybind(KEYBINDS.SAVE_EDIT)} · {formatKeybind(KEYBINDS.CANCEL_EDIT)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleCancelEdit}
                >
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleSaveEdit}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <blockquote className="text-secondary border-l-2 border-[var(--color-review-accent)]/50 pl-2 text-xs leading-relaxed whitespace-pre-wrap">
              {comment || <span className="text-muted italic">No comment</span>}
            </blockquote>
          )}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewBlockFromDataProps {
  /** Structured review data (no parsing needed) */
  data: ReviewNoteDataForDisplay;
  /** Detach from chat (sets status back to pending) */
  onDetach?: () => void;
  /** Mark as complete (checked) */
  onComplete?: () => void;
  /** Permanently delete the review */
  onDelete?: () => void;
  /** Optional callback to edit the comment */
  onEditComment?: (newComment: string) => void;
  /** Compact mode: hide file header (when parent already shows file context) */
  compact?: boolean;
}

/**
 * ReviewBlock that takes structured data directly (preferred)
 * Used when review data is available from muxMetadata
 */
export const ReviewBlockFromData: React.FC<ReviewBlockFromDataProps> = ({
  data,
  onDetach,
  onComplete,
  onDelete,
  onEditComment,
  compact,
}) => {
  return (
    <ReviewBlockCore
      filePath={data.filePath}
      lineRange={data.lineRange}
      code={data.selectedCode}
      diff={data.selectedDiff}
      oldStart={data.oldStart}
      newStart={data.newStart}
      comment={data.userNote}
      locationLabels={
        data.artifact != null
          ? {
              full: formatReviewLocationLabel(data),
              compact: formatReviewLocationLabel(data, true),
            }
          : undefined
      }
      onDetach={onDetach}
      compact={compact}
      onComplete={onComplete}
      onDelete={onDelete}
      onEditComment={onEditComment}
    />
  );
};
