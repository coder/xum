import React, { useState, useCallback } from "react";
import type { GitStatus } from "@/common/types/workspace";
import type { GitStatusIndicatorMode } from "@/common/constants/storage";
import { useWorkspaceDiffBase } from "@/browser/utils/reviewDefaultBase";
import { invalidateGitStatus, useGitStatusRefreshing } from "@/browser/stores/GitStatusStore";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import { GitStatusIndicatorView } from "../GitStatusIndicatorView/GitStatusIndicatorView";
import { useGitBranchDetails } from "@/browser/features/Hooks/useGitBranchDetails";

interface GitStatusIndicatorProps {
  gitStatus: GitStatus | null;
  workspaceId: string;
  projectPath: string;
  tooltipPosition?: "right" | "bottom";
  /** When true, shows blue pulsing styling to indicate agent is working */
  isWorking?: boolean;
}

/**
 * Container component for git status indicator.
 * Manages dialog visibility and data fetching.
 * Delegates rendering to GitStatusIndicatorView.
 */
export const GitStatusIndicator: React.FC<GitStatusIndicatorProps> = ({
  gitStatus,
  workspaceId,
  projectPath,
  tooltipPosition = "right",
  isWorking = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const trimmedWorkspaceId = workspaceId.trim();
  const isRefreshing = useGitStatusRefreshing(trimmedWorkspaceId);

  const mode =
    useUserPreferences((preferences) => preferences.appearance?.gitStatusIndicatorMode) ??
    "line-delta";

  // Per-workspace base ref (shared with review panel), falling back to the project default
  const [baseRef, setBaseRef] = useWorkspaceDiffBase(trimmedWorkspaceId, projectPath);

  const handleBaseChange = useCallback(
    (value: string) => {
      setBaseRef(value);
      invalidateGitStatus(trimmedWorkspaceId);
    },
    [setBaseRef, trimmedWorkspaceId]
  );

  const handleModeChange = useCallback((nextMode: GitStatusIndicatorMode) => {
    updateUserPreferences({ appearance: { gitStatusIndicatorMode: nextMode } });
  }, []);

  console.assert(
    trimmedWorkspaceId.length > 0,
    "GitStatusIndicator requires workspaceId to be a non-empty string."
  );

  // Fetch branch details only while the divergence dialog is open
  const { branchHeaders, commits, dirtyFiles, isLoading, errorMessage } = useGitBranchDetails(
    trimmedWorkspaceId,
    gitStatus,
    isOpen
  );

  return (
    <GitStatusIndicatorView
      mode={mode}
      gitStatus={gitStatus}
      tooltipPosition={tooltipPosition}
      branchHeaders={branchHeaders}
      commits={commits}
      dirtyFiles={dirtyFiles}
      isLoading={isLoading}
      errorMessage={errorMessage}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      onModeChange={handleModeChange}
      baseRef={baseRef}
      onBaseChange={handleBaseChange}
      workspaceId={trimmedWorkspaceId}
      isWorking={isWorking}
      isRefreshing={isRefreshing}
    />
  );
};
