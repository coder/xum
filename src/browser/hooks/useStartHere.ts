import { useState } from "react";
import React from "react";
import { StartHereModal } from "@/browser/components/StartHereModal/StartHereModal";
import { createMuxMessage } from "@/common/types/message";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import {
  isTranscriptMutationAllowed,
  useTranscriptMutationAllowed,
} from "@/browser/utils/transcriptBarrier";
import { TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE } from "@/constants/transcriptBarrier";

interface StartHereOptions {
  deletePlanFile?: boolean;
  sourceAgentId?: string;
  /**
   * A turn is running. The backend does not refuse Start Here then (compaction replaces run
   * inside turns), so a caller that knows the turn state passes it to keep the boundary from
   * landing under the running turn, also from a confirmation opened before the turn started.
   */
  turnActive?: boolean;
}

/**
 * Appends the Start Here boundary, with `content` as the summary that requests start from.
 * Throws the backend's refusal instead of logging it: the modal keeps itself open and shows the
 * reason (for example a workspace replaying a session tape refuses history changes).
 */
async function appendStartHereBoundary(
  api: APIClient,
  workspaceId: string,
  content: string,
  options: StartHereOptions | undefined
): Promise<void> {
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
    throw new Error(String(result.error));
  }
}

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
  options?: StartHereOptions
) {
  const { api } = useAPI();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isStartingHere, setIsStartingHere] = useState(false);
  // Rendered disabled state follows the barrier, so the button never offers a click that
  // `openModal`/`executeStartHere` would refuse.
  const transcriptMutationAllowed = useTranscriptMutationAllowed(workspaceId);
  // The open dialog follows it too, and the turn state: a replay that drops out, or a turn that
  // starts, after it opened disables OK (its click and its keybind) rather than letting a confirm
  // resolve to nothing or land under the turn.
  const blocked = !transcriptMutationAllowed || options?.turnActive === true;

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
    // Thrown (not silently resolved) so the modal stays open instead of closing as if it worked;
    // the rendered OK button is already disabled through `confirmDisabled` by then.
    if (!isTranscriptMutationAllowed(workspaceId)) {
      throw new Error(TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE);
    }

    setIsStartingHere(true);
    try {
      await appendStartHereBoundary(api, workspaceId, content, options);
    } finally {
      setIsStartingHere(false);
    }
  };

  // Pre-configured modal component
  const modal = React.createElement(StartHereModal, {
    isOpen: isModalOpen,
    onClose: closeModal,
    onConfirm: executeStartHere,
    confirmDisabled: blocked,
  });

  return {
    openModal,
    isStartingHere,
    buttonLabel: `Start Here`,
    disabled: !workspaceId || isStartingHere || isCompacted || blocked,
    modal, // Pre-configured modal to render
  };
}
