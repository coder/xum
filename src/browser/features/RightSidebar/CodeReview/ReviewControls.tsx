/**
 * ReviewControls - Consolidated one-line control bar for review panel
 */

import React from "react";
import { ArrowLeft, Maximize2, Sparkles } from "lucide-react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import {
  Tooltip,
  TooltipContent,
  TooltipIfPresent,
  TooltipTrigger,
} from "@/browser/components/Tooltip/Tooltip";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { ReviewFilters, ReviewStats, ReviewSortOrder } from "@/common/types/review";
import type { LastRefreshInfo, RefreshFailureInfo } from "@/browser/utils/RefreshController";
import { RefreshButton } from "./RefreshButton";
import { BaseSelectorPopover } from "./BaseSelectorPopover";

const SORT_OPTIONS: Array<{ value: ReviewSortOrder; label: string }> = [
  { value: "file-order", label: "File order" },
  { value: "last-edit", label: "Last edit" },
];

interface ReviewControlsProps {
  filters: ReviewFilters;
  stats: ReviewStats;
  onFiltersChange: (filters: ReviewFilters | ((prev: ReviewFilters) => ReviewFilters)) => void;
  onDiffBaseInteraction?: (value: string) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
  /** Whether refresh is blocked (e.g., user composing review note) */
  isRefreshBlocked?: boolean;
  projectPath: string;
  /** Debug info about last refresh */
  lastRefreshInfo?: LastRefreshInfo | null;
  /** Info about last refresh failure (null = no recent failure) */
  lastRefreshFailure?: RefreshFailureInfo | null;
  /** Whether immersive review mode is active */
  isImmersive?: boolean;
  /** Toggle immersive review mode */
  onToggleImmersive?: () => void;
  /**
   * Number of agent-flagged "Assisted" hunks the agent has pinned via
   * the `review_pane_update` tool. When zero AND the user isn't currently
   * in Assisted mode, the toggle is hidden so the control bar stays compact
   * for normal review sessions. If the user already flipped Assisted on we
   * keep the toggle so they can flip back out without using the keyboard.
   */
  assistedCount?: number;
  /**
   * Number of unread assisted hunks. Surfaced next to the Assisted toggle so
   * the count tracks the remaining worklist rather than the static total,
   * matching the Review tab badge.
   */
  assistedUnreadCount?: number;
}

export const ReviewControls: React.FC<ReviewControlsProps> = ({
  filters,
  stats,
  onFiltersChange,
  onDiffBaseInteraction,
  onRefresh,
  isLoading = false,
  isRefreshBlocked = false,
  projectPath,
  lastRefreshInfo,
  lastRefreshFailure,
  isImmersive = false,
  onToggleImmersive,
  assistedCount = 0,
  assistedUnreadCount = 0,
}) => {
  // Per-project default base (used for new workspaces in this project)
  const [defaultBase, setDefaultBase] = usePersistedState<string>(
    STORAGE_KEYS.reviewDefaultBase(projectPath),
    WORKSPACE_DEFAULTS.reviewBase,
    { listener: true }
  );
  const { startSequence } = useTutorial();

  // Show the immersive review tutorial the first time the review panel is visible
  React.useEffect(() => {
    // Small delay to ensure the button is rendered and measurable
    const timer = setTimeout(() => startSequence("review"), 500);
    return () => clearTimeout(timer);
  }, [startSequence]);

  // Use callback form to avoid stale closure issues with filters prop
  const handleBaseChange = (value: string) => {
    onDiffBaseInteraction?.(value);
    onFiltersChange((prev) => ({ ...prev, diffBase: value }));
  };

  const handleUncommittedToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    onFiltersChange((prev) => ({ ...prev, includeUncommitted: checked }));
  };

  // While Assisted is on the "Read:" toggle binds to the assisted-scoped
  // flag so toggling it in worklist mode doesn't reach back into the user's
  // general review preference (and vice versa). The two flags persist
  // independently so a user who turns off "show read" globally still gets
  // the worklist default ("hide done") when they enter Assisted mode.
  const handleShowReadToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    if (filters.assistedOnly) {
      onFiltersChange((prev) => ({ ...prev, assistedShowReadHunks: checked }));
    } else {
      onFiltersChange((prev) => ({ ...prev, showReadHunks: checked }));
    }
  };

  const handleAssistedToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    onFiltersChange((prev) => ({ ...prev, assistedOnly: checked }));
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const sortOrder = e.target.value as ReviewSortOrder;
    onFiltersChange((prev) => ({ ...prev, sortOrder }));
  };

  const handleSetDefault = () => {
    setDefaultBase(filters.diffBase);
  };

  // Show "Set Default" button if current base is different from default
  const showSetDefault = filters.diffBase !== defaultBase;

  return (
    <div className="border-border-light flex flex-wrap items-center gap-2 border-b px-2 py-1 text-[11px]">
      {onToggleImmersive && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleImmersive}
                className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[11px] transition-colors duration-150"
                aria-label={isImmersive ? "Exit immersive review" : "Enter immersive review"}
                data-tutorial="immersive-review"
              >
                {isImmersive ? (
                  <ArrowLeft aria-hidden="true" className="h-3 w-3 shrink-0" />
                ) : (
                  <Maximize2 aria-hidden="true" className="h-3 w-3 shrink-0" />
                )}
                <span>{isImmersive ? "Exit" : "Full-screen review"}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isImmersive ? "Exit" : "Enter"} immersive review (
              {formatKeybind(KEYBINDS.TOGGLE_REVIEW_IMMERSIVE)})
            </TooltipContent>
          </Tooltip>
          <div className="bg-border-light h-3 w-px" />
        </>
      )}

      {onRefresh && (
        <RefreshButton
          onClick={onRefresh}
          isLoading={isLoading}
          disabled={isRefreshBlocked}
          lastRefreshInfo={lastRefreshInfo}
          lastRefreshFailure={lastRefreshFailure}
        />
      )}

      <div
        className="text-muted flex items-center gap-1 whitespace-nowrap"
        data-testid="review-base-selector"
      >
        <span>Base:</span>
        <BaseSelectorPopover
          value={filters.diffBase}
          onChange={handleBaseChange}
          data-testid="review-base-value"
        />
        {showSetDefault && (
          <TooltipIfPresent tooltip="Set as default base" side="bottom">
            <button
              onClick={handleSetDefault}
              className="text-dim font-primary hover:text-muted cursor-pointer border-none bg-transparent p-0 text-[10px] whitespace-nowrap transition-colors duration-150"
            >
              ★
            </button>
          </TooltipIfPresent>
        )}
      </div>

      <div className="bg-border-light h-3 w-px" />

      {/* Uncommitted is force-enabled while Assisted is on so agent pins that
          target uncommitted edits cannot disappear because of a stale toggle.
          We render the checkbox in a disabled state (rather than hiding it)
          so the user can tell why the value isn't editable. */}
      <TooltipIfPresent
        tooltip={
          filters.assistedOnly
            ? "Always on while Assisted is enabled — agent pins often target uncommitted edits"
            : undefined
        }
        side="bottom"
      >
        <label
          className={`flex items-center gap-1 whitespace-nowrap ${
            filters.assistedOnly
              ? "text-dim cursor-not-allowed"
              : "text-muted hover:text-foreground cursor-pointer"
          }`}
        >
          <span>Uncommitted:</span>
          <input
            type="checkbox"
            checked={filters.assistedOnly ? true : filters.includeUncommitted}
            disabled={filters.assistedOnly}
            onChange={handleUncommittedToggle}
            className={`h-3 w-3 ${filters.assistedOnly ? "cursor-not-allowed" : "cursor-pointer"}`}
          />
        </label>
      </TooltipIfPresent>

      <div className="bg-border-light h-3 w-px" />

      <TooltipIfPresent
        tooltip={
          filters.assistedOnly
            ? "Show pins you've already marked as read (Assisted-scoped — your general 'Read:' preference is unaffected)"
            : undefined
        }
        side="bottom"
      >
        <label className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1 whitespace-nowrap">
          <span>Read:</span>
          <input
            type="checkbox"
            checked={filters.assistedOnly ? filters.assistedShowReadHunks : filters.showReadHunks}
            onChange={handleShowReadToggle}
            className="h-3 w-3 cursor-pointer"
            data-testid="review-show-read-toggle"
          />
        </label>
      </TooltipIfPresent>

      {(assistedCount > 0 || filters.assistedOnly) && (
        <>
          <div className="bg-border-light h-3 w-px" />
          <TooltipIfPresent
            tooltip={
              assistedCount === 0
                ? `No agent-flagged hunks remain — toggle off to see the full diff (${formatKeybind(KEYBINDS.TOGGLE_ASSISTED_REVIEW)})`
                : assistedUnreadCount === assistedCount
                  ? `Show only the ${assistedCount} hunk${assistedCount === 1 ? "" : "s"} the agent flagged for review (${formatKeybind(KEYBINDS.TOGGLE_ASSISTED_REVIEW)})`
                  : `${assistedUnreadCount} of ${assistedCount} agent-flagged hunk${assistedCount === 1 ? "" : "s"} still unread (${formatKeybind(KEYBINDS.TOGGLE_ASSISTED_REVIEW)})`
            }
            side="bottom"
          >
            <label className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1 whitespace-nowrap">
              <Sparkles aria-hidden="true" className="text-review-accent h-3 w-3 shrink-0" />
              <span>Assisted:</span>
              <input
                type="checkbox"
                aria-label="Show only agent-flagged hunks"
                checked={filters.assistedOnly}
                onChange={handleAssistedToggle}
                className="h-3 w-3 cursor-pointer"
              />
              <span className="text-dim text-[10px]" data-testid="review-assisted-count">
                {/* Show "unread/total" in worklist mode and the total elsewhere.
                    The two-number form mirrors the Review tab badge and keeps
                    the user's remaining work front-and-center. */}
                ({assistedUnreadCount}/{assistedCount})
              </span>
            </label>
          </TooltipIfPresent>
        </>
      )}

      <div className="bg-border-light h-3 w-px" />

      <label className="text-muted flex items-center gap-1 whitespace-nowrap">
        <span>Sort:</span>
        <select
          aria-label="Sort hunks by"
          value={filters.sortOrder}
          onChange={handleSortChange}
          className="text-muted-light hover:bg-hover hover:text-foreground cursor-pointer rounded-sm bg-transparent px-1 py-0.5 font-mono transition-colors focus:outline-none"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <span className="text-dim ml-auto whitespace-nowrap">
        {stats.read}/{stats.total}
      </span>
    </div>
  );
};
