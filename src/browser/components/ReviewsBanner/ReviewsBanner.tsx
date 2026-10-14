/**
 * ReviewsBanner - Self-contained reviews UI
 *
 * Features:
 * - Collapsible banner above chat input
 * - Full review display with diff and editable comments
 * - Pending reviews first, then completed with "show more"
 * - Relative timestamps
 * - Error boundary for corrupted data
 */

import React, { useState, useCallback, useMemo, Component, type ReactNode, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Undo2,
  Send,
  Trash2,
  MessageSquare,
  AlertTriangle,
  Pencil,
  X,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Button } from "../Button/Button";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import type { Review } from "@/common/types/review";
import { useReviews } from "@/browser/hooks/useReviews";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import { formatReviewLocationLabel } from "@/browser/utils/review/lineRange";
import { DiffRenderer } from "@/browser/features/Shared/DiffRenderer";
import { matchesKeybind, formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════════

interface ErrorBoundaryState {
  hasError: boolean;
}

class BannerErrorBoundary extends Component<
  { children: ReactNode; onClear: () => void },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="border-border bg-surface-primary flex items-center gap-2 border-t px-3 py-1.5 text-xs">
          <AlertTriangle className="text-warning size-3.5" />
          <span className="text-muted">Reviews data corrupted</span>
          <Button
            variant="ghost"
            size="sm"
            className="text-error h-5 px-2 text-xs"
            onClick={() => {
              this.props.onClear();
              this.setState({ hasError: false });
            }}
          >
            <Trash2 className="mr-1 size-3" />
            Clear all
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW ITEM COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewItemProps {
  review: Review;
  onCheck: () => void;
  onUncheck: () => void;
  onSendToChat: () => void;
  onRemove: () => void;
  onUpdateNote: (newNote: string) => void;
}

const ReviewItem: React.FC<ReviewItemProps> = ({
  review,
  onCheck,
  onUncheck,
  onSendToChat,
  onRemove,
  onUpdateNote,
}) => {
  const isChecked = review.status === "checked";
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(review.data.userNote);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleStartEdit = useCallback(() => {
    setEditValue(review.data.userNote);
    setIsEditing(true);
    // Focus textarea after render
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [review.data.userNote]);

  const handleSaveEdit = useCallback(() => {
    if (editValue.trim() !== review.data.userNote) {
      onUpdateNote(editValue.trim());
    }
    setIsEditing(false);
  }, [editValue, review.data.userNote, onUpdateNote]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(review.data.userNote);
    setIsEditing(false);
  }, [review.data.userNote]);

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

  // Prefer selectedDiff (raw diff) when available so reviewers see syntax highlighting consistently.
  const diffContent = useMemo(() => {
    if (review.data.selectedDiff) {
      return review.data.selectedDiff;
    }

    // Legacy: selectedCode may be plain code or diff-ish text.
    const lines = review.data.selectedCode.split("\n");
    const hasDiffMarkers = lines.some((l) => /^[+-\s]/.test(l));
    if (hasDiffMarkers) {
      return review.data.selectedCode;
    }
    return lines.map((l) => ` ${l}`).join("\n");
  }, [review.data.selectedCode, review.data.selectedDiff]);

  const age = formatRelativeTime(review.createdAt);

  return (
    <div
      className={cn(
        "group rounded border transition-colors",
        isChecked
          ? "border-border-light bg-hover/50 opacity-70"
          : "border-border-medium bg-surface-secondary/50"
      )}
    >
      {/* Header row - always visible */}
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        {/* Expand toggle */}
        <button
          type="button"
          onClick={handleToggleExpand}
          className="text-muted hover:text-secondary shrink-0"
        >
          {isExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>

        {/* Check/Uncheck button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-5 shrink-0 [&_svg]:size-3", isChecked && "text-success")}
              onClick={isChecked ? onUncheck : onCheck}
            >
              {isChecked ? <Undo2 /> : <Check />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isChecked ? "Mark as pending" : "Mark as done"}</TooltipContent>
        </Tooltip>

        {/* Send to chat - always visible for pending items, away from delete */}
        {!isChecked && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-5 shrink-0 [&_svg]:size-3"
                onClick={onSendToChat}
              >
                <Send />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send to chat</TooltipContent>
          </Tooltip>
        )}

        {/* File path, comment preview, and age */}
        <button
          type="button"
          onClick={handleToggleExpand}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 truncate font-mono text-[var(--color-review-accent)]">
            {review.data.artifact != null
              ? formatReviewLocationLabel(review.data)
              : `${review.data.filePath}:${review.data.lineRange}`}
          </span>
          {review.data.userNote && (
            <span className="text-secondary min-w-0 flex-1 truncate italic">
              {review.data.userNote.split("\n")[0]}
            </span>
          )}
          <span className="text-muted shrink-0 text-[10px]">{age}</span>
        </button>

        {/* Delete action - separate from safe actions */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-error size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 [&_svg]:size-3"
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-border-light border-t">
          {/* Code diff */}
          <div className="max-h-32 overflow-auto text-[11px]">
            <DiffRenderer
              content={diffContent}
              showLineNumbers={Boolean(review.data.selectedDiff)}
              oldStart={review.data.oldStart ?? 1}
              newStart={review.data.newStart ?? 1}
              fontSize="11px"
            />
          </div>

          {/* Comment section */}
          <div className="border-border-light border-t p-2">
            {isEditing ? (
              <div className="space-y-1.5">
                <textarea
                  ref={textareaRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="bg-surface-secondary border-border text-secondary w-full resize-none rounded border p-2 text-xs focus:border-[var(--color-review-accent)] focus:outline-none"
                  rows={2}
                  placeholder="Your comment..."
                />
                <div className="flex items-center justify-end gap-1">
                  <span className="text-muted mr-2 text-[10px]">
                    {formatKeybind(KEYBINDS.SAVE_EDIT)} to save, Esc to cancel
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-2 text-xs"
                    onClick={handleCancelEdit}
                  >
                    <X className="mr-1 size-3" />
                    Cancel
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-5 px-2 text-xs"
                    onClick={handleSaveEdit}
                  >
                    <Check className="mr-1 size-3" />
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="group/comment flex items-start gap-2">
                <blockquote className="text-primary flex-1 border-l-2 border-[var(--color-review-accent)] pl-2 text-xs italic">
                  {review.data.userNote || <span className="text-muted">No comment</span>}
                </blockquote>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 [&_svg]:size-3"
                  onClick={handleStartEdit}
                >
                  <Pencil />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BANNER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewsBannerInnerProps {
  workspaceId: string;
}

const ReviewsBannerInner: React.FC<ReviewsBannerInnerProps> = ({ workspaceId }) => {
  const reviewsHook = useReviews(workspaceId);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  const INITIAL_COMPLETED_COUNT = 3;

  // Separate pending and completed reviews
  // "attached" reviews are shown in ChatInput, so we only show "pending" and "checked" here
  const { pendingList, completedList } = useMemo(() => {
    const pending = reviewsHook.reviews.filter((r) => r.status === "pending");
    // Sort completed reviews recent-first (by when they were checked, falling back to creation time)
    const completed = reviewsHook.reviews
      .filter((r) => r.status === "checked")
      .sort((a, b) => (b.statusChangedAt ?? b.createdAt) - (a.statusChangedAt ?? a.createdAt));
    return { pendingList: pending, completedList: completed };
  }, [reviewsHook.reviews]);

  // Completed reviews to display (limited unless expanded)
  const displayedCompleted = useMemo(() => {
    if (showAllCompleted) return completedList;
    return completedList.slice(0, INITIAL_COMPLETED_COUNT);
  }, [completedList, showAllCompleted]);

  const hiddenCompletedCount = completedList.length - INITIAL_COMPLETED_COUNT;

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleSendToChat = useCallback(
    (reviewId: string) => {
      reviewsHook.attachReview(reviewId);
    },
    [reviewsHook]
  );

  const handleUpdateNote = useCallback(
    (reviewId: string, newNote: string) => {
      reviewsHook.updateReviewNote(reviewId, newNote);
    },
    [reviewsHook]
  );

  // Nothing to list: attached reviews show in the composer, not here, so a banner holding only
  // those read "No pending reviews" (#5675).
  if (pendingList.length === 0 && completedList.length === 0) {
    return null;
  }

  return (
    <ChatInputDecoration
      expanded={isExpanded}
      onToggle={handleToggle}
      contentClassName="max-h-80 space-y-3 overflow-y-auto py-2"
      summary={
        <>
          <MessageSquare
            className={cn(
              "size-3.5 transition-colors",
              reviewsHook.pendingCount > 0
                ? "text-[var(--color-review-accent)]"
                : "text-muted group-hover:text-secondary"
            )}
          />
          <span className="text-muted group-hover:text-secondary transition-colors">
            {reviewsHook.pendingCount > 0 ? (
              <>
                <span className="font-medium text-[var(--color-review-accent)]">
                  {reviewsHook.pendingCount}
                </span>
                {" pending review"}
                {reviewsHook.pendingCount !== 1 && "s"}
              </>
            ) : (
              <>No pending reviews</>
            )}
            {reviewsHook.checkedCount > 0 && <> · {reviewsHook.checkedCount} completed</>}
          </span>
        </>
      }
      renderExpanded={() => (
        <>
          {/* Pending reviews section */}
          {pendingList.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-muted text-[10px]">Pending ({pendingList.length})</div>
                {pendingList.length > 1 && (
                  <button
                    type="button"
                    onClick={reviewsHook.attachAllPending}
                    className="text-muted flex items-center gap-1 text-[10px] transition-colors hover:text-[var(--color-review-accent)]"
                  >
                    <Send className="size-3" />
                    Attach all
                  </button>
                )}
              </div>
              {pendingList.map((review) => (
                <ReviewItem
                  key={review.id}
                  review={review}
                  onCheck={() => reviewsHook.checkReview(review.id)}
                  onUncheck={() => reviewsHook.uncheckReview(review.id)}
                  onSendToChat={() => handleSendToChat(review.id)}
                  onRemove={() => reviewsHook.removeReview(review.id)}
                  onUpdateNote={(note) => handleUpdateNote(review.id, note)}
                />
              ))}
            </div>
          )}

          {/* Completed reviews section */}
          {completedList.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-muted text-[10px]">Completed ({completedList.length})</div>
                {completedList.length > 0 && (
                  <button
                    type="button"
                    onClick={reviewsHook.clearChecked}
                    className="text-muted hover:text-error text-[10px] transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              {displayedCompleted.map((review) => (
                <ReviewItem
                  key={review.id}
                  review={review}
                  onCheck={() => reviewsHook.checkReview(review.id)}
                  onUncheck={() => reviewsHook.uncheckReview(review.id)}
                  onSendToChat={() => handleSendToChat(review.id)}
                  onRemove={() => reviewsHook.removeReview(review.id)}
                  onUpdateNote={(note) => handleUpdateNote(review.id, note)}
                />
              ))}
              {hiddenCompletedCount > 0 && !showAllCompleted && (
                <button
                  type="button"
                  onClick={() => setShowAllCompleted(true)}
                  className="text-muted hover:text-secondary w-full py-1 text-center text-xs transition-colors"
                >
                  Show {hiddenCompletedCount} more completed review
                  {hiddenCompletedCount !== 1 && "s"}
                </button>
              )}
            </div>
          )}
        </>
      )}
    />
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTED COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ReviewsBannerProps {
  workspaceId: string;
}

/**
 * Self-contained reviews banner.
 * Uses useReviews hook internally - only needs workspaceId.
 * Shows only "pending" and "checked" reviews (not "attached" which are in ChatInput).
 */
export const ReviewsBanner: React.FC<ReviewsBannerProps> = ({ workspaceId }) => {
  const reviewsHook = useReviews(workspaceId);

  return (
    <BannerErrorBoundary onClear={reviewsHook.clearAll}>
      <ReviewsBannerInner workspaceId={workspaceId} />
    </BannerErrorBoundary>
  );
};
