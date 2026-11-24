/**
 * InlineReviewNote - compact review note UI (comment + status + actions).
 *
 * Used for inline review notes rendered inside diff views (e.g. the Review pane).
 * Does NOT include code chunk rendering; parent components provide that context.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Pencil, Check, Trash2, Unlink, MessageSquare } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { formatLineRangeCompact } from "@/browser/utils/review/lineRange";
import { matchesKeybind, formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import type { Review } from "@/common/types/review";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReviewActionCallbacks {
  /** Edit the review comment */
  onEditComment?: (reviewId: string, newComment: string) => void;
  /** Notify parent when inline note enters/leaves edit mode */
  onEditingChange?: (reviewId: string, isEditing: boolean) => void;
  /** Mark review as complete (checked) */
  onComplete?: (reviewId: string) => void;
  /** Detach review from message (back to pending) */
  onDetach?: (reviewId: string) => void;
  /** Delete review entirely */
  onDelete?: (reviewId: string) => void;
  /** Attach review to message */
  onAttach?: (reviewId: string) => void;
  /** Uncheck review (back to pending) */
  onUncheck?: (reviewId: string) => void;
}

export interface InlineReviewNoteProps {
  review: Review;
  /** Show full file:line or just line range */
  showFilePath?: boolean;
  /** Optional action callbacks */
  actions?: ReviewActionCallbacks;
  /** Additional className for the container */
  className?: string;
  /** Request id that should put this note into edit mode */
  editRequestId?: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compact inline review note with header, status, and optional actions.
 * Used for consistent review display in both ChatInput and Review pane.
 */
export const InlineReviewNote: React.FC<InlineReviewNoteProps> = ({
  review,
  showFilePath = false,
  actions,
  className,
  editRequestId,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(review.data.userNote);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isEditingRef = useRef(false);
  const actionsRef = useRef(actions);
  const handledEditRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    return () => {
      if (isEditingRef.current) {
        actionsRef.current?.onEditingChange?.(review.id, false);
      }
    };
  }, [review.id]);

  const handleStartEdit = useCallback(() => {
    setEditValue(review.data.userNote);
    setIsEditing(true);
    isEditingRef.current = true;
    actions?.onEditingChange?.(review.id, true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [review.data.userNote, review.id, actions]);

  useEffect(() => {
    if (editRequestId == null || !actions?.onEditComment) {
      return;
    }

    if (handledEditRequestIdRef.current === editRequestId) {
      return;
    }

    handledEditRequestIdRef.current = editRequestId;
    handleStartEdit();
  }, [actions?.onEditComment, editRequestId, handleStartEdit]);

  const handleSaveEdit = useCallback(() => {
    if (actions?.onEditComment && editValue.trim() !== review.data.userNote) {
      actions.onEditComment(review.id, editValue.trim());
    }
    setIsEditing(false);
    isEditingRef.current = false;
    actions?.onEditingChange?.(review.id, false);
  }, [editValue, review.data.userNote, review.id, actions]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(review.data.userNote);
    setIsEditing(false);
    isEditingRef.current = false;
    actions?.onEditingChange?.(review.id, false);
  }, [review.data.userNote, review.id, actions]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SAVE_EDIT)) {
        stopKeyboardPropagation(e);
        e.preventDefault();
        handleSaveEdit();
      } else if (matchesKeybind(e, KEYBINDS.CANCEL_EDIT)) {
        stopKeyboardPropagation(e);
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSaveEdit, handleCancelEdit]
  );

  // Determine which actions are available based on status
  const canEdit = Boolean(actions?.onEditComment) && !isEditing;
  const canComplete = Boolean(actions?.onComplete) && review.status !== "checked";
  const canUncheck = Boolean(actions?.onUncheck) && review.status === "checked";
  const canDetach = Boolean(actions?.onDetach) && review.status === "attached";
  const canAttach = Boolean(actions?.onAttach) && review.status === "pending";
  const canDelete = Boolean(actions?.onDelete);

  const hasActions = [canEdit, canComplete, canUncheck, canDetach, canAttach, canDelete].some(
    Boolean
  );

  // Color based on status
  const tintColor =
    review.status === "checked" ? "var(--color-success)" : "var(--color-review-accent)";
  const containerBg =
    review.status === "checked"
      ? "hsl(from var(--color-success) h s l / 0.06)"
      : "hsl(from var(--color-review-accent) h s l / 0.08)";
  const borderColor =
    review.status === "checked"
      ? "hsl(from var(--color-success) h s l / 0.3)"
      : "hsl(from var(--color-review-accent) h s l / 0.3)";

  return (
    <div
      className={cn(
        "group/review-note flex w-full overflow-hidden rounded border shadow-sm",
        className
      )}
      style={{
        background: containerBg,
        borderColor,
        maxWidth: "min(560px, calc(100vw - 8rem))",
      }}
    >
      {/* Left accent bar */}
      <div className="w-[3px] shrink-0" style={{ background: tintColor }} />

      <div className="min-w-0 flex-1 px-2 py-1">
        {/* Header: icon, location, status badge, actions */}
        <div className="flex items-center gap-1.5 text-[10px]">
          <MessageSquare className="size-3 shrink-0" style={{ color: tintColor }} />

          {/* File path or just line range */}
          {showFilePath ? (
            <span className="text-primary min-w-0 flex-1 truncate font-mono text-[10px]">
              {review.data.filePath}:L{formatLineRangeCompact(review.data.lineRange)}
            </span>
          ) : (
            <span className="text-muted font-mono">
              L{formatLineRangeCompact(review.data.lineRange)}
            </span>
          )}

          {/* Status badge */}
          <span
            className={cn(
              "shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase",
              review.status === "checked"
                ? "bg-success/20 text-success-text"
                : review.status === "attached"
                  ? "bg-warning/20 text-warning"
                  : "bg-muted/20 text-muted"
            )}
          >
            {review.status}
          </span>

          {/* Action buttons - visible on hover */}
          {hasActions && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/review-note:opacity-100">
              {canEdit && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleStartEdit}
                      aria-label="Edit comment"
                      className="text-muted hover:text-secondary flex items-center justify-center rounded p-0.5 transition-colors"
                    >
                      <Pencil className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Edit comment</TooltipContent>
                </Tooltip>
              )}
              {canComplete && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => actions?.onComplete?.(review.id)}
                      aria-label="Mark as done"
                      className="text-muted hover:text-success-text flex items-center justify-center rounded p-0.5 transition-colors"
                    >
                      <Check className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Mark as done</TooltipContent>
                </Tooltip>
              )}
              {canUncheck && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => actions?.onUncheck?.(review.id)}
                      aria-label="Uncheck"
                      className="text-muted hover:text-warning flex items-center justify-center rounded p-0.5 transition-colors"
                    >
                      <Check className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Uncheck (back to pending)</TooltipContent>
                </Tooltip>
              )}
              {canAttach && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => actions?.onAttach?.(review.id)}
                      aria-label="Attach to message"
                      className="text-muted hover:text-review-accent flex items-center justify-center rounded p-0.5 transition-colors"
                    >
                      <MessageSquare className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Attach to message</TooltipContent>
                </Tooltip>
              )}
              {canDetach && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => actions?.onDetach?.(review.id)}
                      aria-label="Detach from message"
                      className="text-muted hover:text-secondary flex items-center justify-center rounded p-0.5 transition-colors"
                    >
                      <Unlink className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Detach from message</TooltipContent>
                </Tooltip>
              )}
              {canDelete && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => actions?.onDelete?.(review.id)}
                      aria-label="Delete review"
                      className="text-muted hover:text-error flex items-center justify-center rounded p-0.5 transition-colors"
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

        {/* Comment - editable when actions.onEditComment provided */}
        {(review.data.userNote || actions?.onEditComment) && (
          <div className="mt-1">
            {isEditing ? (
              <div className="space-y-1">
                <textarea
                  ref={textareaRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="text-primary w-full resize-none rounded border border-[var(--color-review-accent)]/40 bg-[var(--color-review-accent)]/10 px-1.5 py-1 text-[11px] focus:border-[var(--color-review-accent)]/60 focus:outline-none"
                  rows={2}
                  placeholder="Your comment..."
                />
                <div className="flex items-center justify-end gap-1">
                  <span className="text-muted text-[9px]">
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
            ) : review.data.userNote ? (
              <div className="text-secondary text-[11px] leading-[1.4] whitespace-pre-wrap">
                {review.data.userNote}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};
