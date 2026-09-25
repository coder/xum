import { useState, type ComponentProps } from "react";
import type { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import type { WorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  buildArchiveConfirmDescription,
  buildArchiveConfirmWarning,
} from "@/browser/utils/archiveConfirmation";

interface ArchiveConfirmation {
  workspaceId: string;
  displayTitle: string | undefined;
  /** When set, the confirmation warns about permanent deletion of untracked files. */
  untrackedPaths?: string[];
  /** Whether the workspace has an active stream that will be interrupted. */
  isStreaming: boolean;
}

export interface UseArchiveWorkspaceConfirmationOptions {
  preflightArchiveWorkspace: WorkspaceContext["preflightArchiveWorkspace"];
  archiveWorkspace: WorkspaceContext["archiveWorkspace"];
  /** True while an archive request for this workspace is already in flight. */
  isArchiving: (workspaceId: string) => boolean;
  /** True when archiving now would interrupt an active (or starting) stream. */
  isStreaming: (workspaceId: string) => boolean;
  /** Title shown in the streaming confirmation; empty falls back to a generic title. */
  getDisplayTitle: (workspaceId: string) => string | undefined;
  /** `anchorEl` is the control that started the archive, when there is one. */
  showError: (workspaceId: string, error: string, anchorEl?: HTMLElement) => void;
}

function didUntrackedPathSetChange(acknowledged: string[], latest: string[]): boolean {
  if (acknowledged.length !== latest.length) {
    return true;
  }
  const acknowledgedSet = new Set(acknowledged);
  return latest.some((path) => !acknowledgedSet.has(path));
}

/**
 * Archive flow shared by the sidebar rows and the workspace menu bar: preflight, one combined
 * confirmation for streaming + untracked-file warnings, and a re-confirmation when new untracked
 * files appear between confirmation and the archive snapshot. Keeping one copy prevents the two
 * entry points from drifting apart.
 */
export function useArchiveWorkspaceConfirmation(options: UseArchiveWorkspaceConfirmationOptions) {
  const [confirmation, setConfirmation] = useState<ArchiveConfirmation | null>(null);

  const performArchive = async (
    workspaceId: string,
    anchorEl?: HTMLElement,
    acknowledgedUntrackedPaths?: string[]
  ): Promise<void> => {
    const result = await options.archiveWorkspace(
      workspaceId,
      acknowledgedUntrackedPaths ? { acknowledgedUntrackedPaths } : undefined
    );
    if (result.success && result.data?.kind === "confirm-lossy-untracked-files") {
      setConfirmation({
        workspaceId,
        displayTitle: options.getDisplayTitle(workspaceId),
        untrackedPaths: result.data.paths,
        // The retry path already handled any earlier streaming warning. Only surface the
        // interruption warning again when the archive attempt has not yet been confirmed.
        isStreaming: acknowledgedUntrackedPaths == null ? options.isStreaming(workspaceId) : false,
      });
      return;
    }
    if (result.success) {
      return;
    }

    if (acknowledgedUntrackedPaths != null) {
      // Archive may fail if new untracked files appear between confirmation and capture.
      // Re-run preflight so we can reopen the modal with the latest paths.
      const preflight = await options.preflightArchiveWorkspace(workspaceId);
      if (
        preflight.success &&
        preflight.data?.kind === "confirm-lossy-untracked-files" &&
        didUntrackedPathSetChange(acknowledgedUntrackedPaths, preflight.data.paths)
      ) {
        setConfirmation({
          workspaceId,
          displayTitle: options.getDisplayTitle(workspaceId),
          untrackedPaths: preflight.data.paths,
          isStreaming: options.isStreaming(workspaceId),
        });
        return;
      }
    }

    options.showError(workspaceId, result.error ?? "Failed to archive chat", anchorEl);
  };

  /** Entry point for archive actions: archives now, asks for confirmation, or shows an error. */
  const requestArchive = async (workspaceId: string, anchorEl?: HTMLElement): Promise<void> => {
    // Keyboard shortcuts bypass disabled archive controls, so guard here as well.
    if (options.isArchiving(workspaceId)) return;
    const isStreaming = options.isStreaming(workspaceId);

    // Run preflight to check for untracked files that can't be preserved.
    const preflight = await options.preflightArchiveWorkspace(workspaceId);
    if (!preflight.success) {
      options.showError(
        workspaceId,
        preflight.error ?? "Failed to check archive readiness",
        anchorEl
      );
      return;
    }

    const untrackedPaths =
      preflight.data?.kind === "confirm-lossy-untracked-files" ? preflight.data.paths : undefined;
    if (isStreaming || untrackedPaths) {
      // Show a single combined confirmation dialog for streaming + untracked-file warnings.
      setConfirmation({
        workspaceId,
        displayTitle: options.getDisplayTitle(workspaceId),
        untrackedPaths,
        isStreaming,
      });
      return;
    }

    await performArchive(workspaceId, anchorEl);
  };

  const untrackedPaths = confirmation?.untrackedPaths;
  const isStreaming = confirmation?.isStreaming ?? false;
  const modalProps: ComponentProps<typeof ConfirmationModal> = {
    isOpen: confirmation !== null,
    title: untrackedPaths
      ? "Archive workspace with untracked files?"
      : confirmation?.displayTitle
        ? `Archive "${confirmation.displayTitle}" while streaming?`
        : "Archive chat?",
    description: buildArchiveConfirmDescription(isStreaming, untrackedPaths),
    warning: buildArchiveConfirmWarning(isStreaming, untrackedPaths),
    confirmLabel: untrackedPaths ? "Archive and delete files" : "Archive",
    confirmVariant: "destructive",
    onConfirm: async () => {
      if (!confirmation) return;
      setConfirmation(null);
      await performArchive(confirmation.workspaceId, undefined, confirmation.untrackedPaths);
    },
    onCancel: () => setConfirmation(null),
  };

  return {
    requestArchive,
    modalProps,
    /** Workspace the open confirmation targets, or null when closed. */
    confirmationWorkspaceId: confirmation?.workspaceId ?? null,
    cancel: () => setConfirmation(null),
  };
}
