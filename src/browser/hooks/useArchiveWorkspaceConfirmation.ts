import { useState, type ComponentProps } from "react";
import type { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import type { WorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import type { ArchiveLossyUntrackedFilesConfirmation } from "@/common/orpc/schemas/api";
import {
  buildArchiveConfirmText,
  flattenLossyPaths,
  type ArchiveConfirmTextInput,
} from "@/browser/utils/archiveConfirmation";

interface ArchiveConfirmation extends ArchiveConfirmTextInput {
  workspaceId: string;
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

const NOTHING_ACKNOWLEDGED: ArchiveLossyUntrackedFilesConfirmation = {
  kind: "confirm-lossy-untracked-files",
  paths: [],
};

function didUntrackedPathSetChange(
  acknowledged: ArchiveLossyUntrackedFilesConfirmation,
  latest: ArchiveLossyUntrackedFilesConfirmation
): boolean {
  // Tag sub-agent paths with their workspace so equal paths in two checkouts differ.
  const tag = (subagent: { workspaceId: string }) => `${subagent.workspaceId}\0`;
  const acknowledgedKeys = flattenLossyPaths(acknowledged, tag);
  const latestKeys = flattenLossyPaths(latest, tag);
  if (acknowledgedKeys.length !== latestKeys.length) {
    return true;
  }
  const acknowledgedSet = new Set(acknowledgedKeys);
  return latestKeys.some((key) => !acknowledgedSet.has(key));
}

function archiveAcknowledgement(lossy: ArchiveLossyUntrackedFilesConfirmation) {
  const subagents = lossy.subagents ?? [];
  if (subagents.length === 0) return { acknowledgedUntrackedPaths: lossy.paths };
  return {
    acknowledgedUntrackedPaths: lossy.paths,
    acknowledgedSubagentUntrackedPaths: Object.fromEntries(
      subagents.map((subagent) => [subagent.workspaceId, subagent.paths])
    ),
  };
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
    acknowledged?: ArchiveLossyUntrackedFilesConfirmation
  ): Promise<void> => {
    const result = await options.archiveWorkspace(
      workspaceId,
      acknowledged ? archiveAcknowledgement(acknowledged) : undefined
    );
    if (result.success && result.data?.kind === "confirm-lossy-untracked-files") {
      setConfirmation({
        workspaceId,
        displayTitle: options.getDisplayTitle(workspaceId),
        lossy: result.data,
        // The retry path already handled any earlier streaming warning. Only surface the
        // interruption warning again when the archive attempt has not yet been confirmed.
        isStreaming: acknowledged == null ? options.isStreaming(workspaceId) : false,
      });
      return;
    }
    if (result.success) {
      return;
    }

    // Archive may fail if new untracked files appear after the preflight or the confirmation,
    // in the workspace or in a sub-agent its archive cascades over. Re-run preflight so we can
    // reopen the modal with the latest paths.
    const preflight = await options.preflightArchiveWorkspace(workspaceId);
    if (
      preflight.success &&
      preflight.data?.kind === "confirm-lossy-untracked-files" &&
      didUntrackedPathSetChange(acknowledged ?? NOTHING_ACKNOWLEDGED, preflight.data)
    ) {
      setConfirmation({
        workspaceId,
        displayTitle: options.getDisplayTitle(workspaceId),
        lossy: preflight.data,
        isStreaming: options.isStreaming(workspaceId),
      });
      return;
    }

    options.showError(workspaceId, result.error ?? "Failed to archive workspace", anchorEl);
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

    const lossy =
      preflight.data?.kind === "confirm-lossy-untracked-files" ? preflight.data : undefined;
    if (isStreaming || lossy) {
      // Show a single combined confirmation dialog for streaming + untracked-file warnings.
      setConfirmation({
        workspaceId,
        displayTitle: options.getDisplayTitle(workspaceId),
        lossy,
        isStreaming,
      });
      return;
    }

    await performArchive(workspaceId, anchorEl);
  };

  const modalProps: ComponentProps<typeof ConfirmationModal> = {
    isOpen: confirmation !== null,
    ...buildArchiveConfirmText(confirmation),
    confirmVariant: "destructive",
    onConfirm: async () => {
      if (!confirmation) return;
      setConfirmation(null);
      await performArchive(confirmation.workspaceId, undefined, confirmation.lossy);
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
