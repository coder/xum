import { useState } from "react";
import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";
import { useDraftStoreHydrated } from "@/browser/stores/DraftStore";
import type { CreationDraftAgent } from "@/browser/utils/creationDraftCarry";
import type { ParsedRuntime } from "@/common/types/runtime";

interface CreationDraftMoveSource {
  /** The composer's owning project. */
  projectPath: string;
  /** The composer route's draft id (none, blank, invalid or reserved: the default draft). */
  draftId: string | undefined;
  runtimePick: ParsedRuntime | null;
  agent: CreationDraftAgent | undefined;
  sendInFlight: boolean;
  processingAttachmentCount: number;
  /** Voice input is requesting the microphone, recording, or transcribing. */
  voiceInputActive: boolean;
  /** The composer's agent list answered (or failed): `agent` is known. */
  agentsLoaded: boolean;
}

/**
 * The creation header's project selector: it moves the draft being edited instead of opening
 * the destination's own draft.
 */
export function useCreationDraftMove(source: CreationDraftMoveSource) {
  const { moveWorkspaceDraft } = useWorkspaceActions();
  const hydrated = useDraftStoreHydrated();
  // The move waits for the backend; meanwhile the draft must not move again or be sent (the
  // send would take content the move has already given to the destination).
  const [moving, setMoving] = useState(false);
  return {
    moving,
    // The move waits for whatever is still on its way into the draft: the drafts themselves
    // (composers may render before they load, and an unloaded draft would move as an empty one),
    // a send in flight takes it, a file being read or a voice transcript is added to the draft it
    // was meant for (and a microphone grant after the move would start a recording no one sees).
    // Attachments not loaded yet need no wait: the backend move carries the stored ones. The
    // agent's definition says whether every project has it (see carryCreationAiSettings), so a
    // move waits for the composer's agents too.
    locked:
      moving ||
      !hydrated ||
      source.sendInFlight ||
      source.processingAttachmentCount > 0 ||
      source.voiceInputActive ||
      !source.agentsLoaded,
    move: (destination: string) => {
      setMoving(true);
      moveWorkspaceDraft({
        projectPath: source.projectPath,
        draftId: source.draftId,
        destination,
        runtimePick: source.runtimePick,
        agent: source.agent,
      })
        .catch((error: unknown) => console.warn("Failed to move the draft:", error))
        .finally(() => setMoving(false));
    },
  };
}
