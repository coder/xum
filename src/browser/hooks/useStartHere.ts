import { useState } from "react";
import React from "react";
import { StartHereModal } from "@/browser/components/StartHereModal/StartHereModal";
import { createMuxMessage } from "@/common/types/message";
import { useAPI } from "@/browser/contexts/API";
import {
  isTranscriptMutationAllowed,
  useTranscriptMutationAllowed,
} from "@/browser/utils/transcriptBarrier";

/**
 * Hook for managing Start Here button state and modal.
 * Returns a button config and modal state management.
 *
 * @param workspaceId - Current workspace ID (required for operation)
 * @param content - Content to use as the new conversation starting point
 * @param isCompacted - Whether the message is already compacted (disables button if true)
 * @param options - Optional behavior flags for this Start Here action
 */
export function useStartHere(
  workspaceId: string | undefined,
  content: string,
  isCompacted = false,
  options?: { deletePlanFile?: boolean; sourceAgentId?: string }
) {
  const { api } = useAPI();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isStartingHere, setIsStartingHere] = useState(false);
  // Rendered disabled state follows the barrier, so the button never offers a click that
  // `openModal`/`executeStartHere` would refuse.
  const transcriptMutationAllowed = useTranscriptMutationAllowed(workspaceId);

  // Opens the confirmation modal
  const openModal = () => {
    if (!workspaceId || isCompacted) return;
    // Start Here rewrites the request window around a row the user sees; refuse while the
    // transcript is not yet a verified copy of history (same barrier as sends and edits).
    if (!isTranscriptMutationAllowed(workspaceId)) return;
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
  };

  // Executes the Start Here operation
  const executeStartHere = async () => {
    if (!workspaceId || isStartingHere || isCompacted || !api) return;
    // Re-checked at dispatch: the replay can drop out between opening the modal and confirming.
    if (!isTranscriptMutationAllowed(workspaceId)) return;

    setIsStartingHere(true);
    try {
      const summaryMessage = createMuxMessage(
        `start-here-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        "assistant",
        content,
        {
          timestamp: Date.now(),
          compacted: "user",
          agentId: options?.sourceAgentId,
        }
      );

      const result = await api.workspace.replaceChatHistory({
        workspaceId,
        summaryMessage,
        // Start Here should create a durable boundary so older turns remain recoverable
        // while request payloads begin at this point.
        mode: "append-compaction-boundary",
        deletePlanFile: options?.deletePlanFile,
      });

      if (!result.success) {
        console.error("Failed to start here:", result.error);
      }
    } catch (err) {
      console.error("Start here error:", err);
    } finally {
      setIsStartingHere(false);
    }
  };

  // Pre-configured modal component
  const modal = React.createElement(StartHereModal, {
    isOpen: isModalOpen,
    onClose: closeModal,
    onConfirm: executeStartHere,
  });

  return {
    openModal,
    isStartingHere,
    buttonLabel: `Start Here`,
    disabled: !workspaceId || isStartingHere || isCompacted || !transcriptMutationAllowed,
    modal, // Pre-configured modal to render
  };
}
