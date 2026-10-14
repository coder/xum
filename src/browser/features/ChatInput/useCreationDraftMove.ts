import { useEffect, useRef, useState } from "react";
import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";
import { useDraftStoreHydrated } from "@/browser/stores/DraftStore";
import type { CreationDraftAgent } from "@/browser/utils/creationDraftCarry";
import type { ParsedRuntime } from "@/common/types/runtime";

interface CreationDraftMoveSource {
  /** The composer's owning project. */
  projectPath: string;
  /** The composer route's draft id (none, blank or invalid: the project's default draft). */
  draftId: string | undefined;
  runtimePick: ParsedRuntime | null;
  agent: CreationDraftAgent | undefined;
  sendInFlight: boolean;
  processingAttachmentCount: number;
  payloadsLoaded: boolean;
  /** Voice input is requesting the microphone, recording, or transcribing. */
  voiceInputActive: boolean;
}

/**
 * The creation header's project selector: it moves the draft being edited instead of opening
 * the destination's own draft.
 */
export function useCreationDraftMove(source: CreationDraftMoveSource) {
  const { moveWorkspaceDraft } = useWorkspaceActions();
  const hydrated = useDraftStoreHydrated();
  // A move may wait for the destination's agents before it opens the destination.
  const [moving, setMoving] = useState(false);
  // The move waits for whatever is still on its way into the draft: the drafts themselves
  // (composers may render before they load, and an unloaded draft would move as an empty one),
  // a send in flight takes it, a file being read or a voice transcript is added to the draft it
  // was meant for (and a microphone grant after the move would start a recording no one sees),
  // and loading attachments would reach the moved copy only once loaded (lost if the user moved
  // it on meanwhile).
  const blocked =
    !hydrated ||
    source.sendInFlight ||
    source.processingAttachmentCount > 0 ||
    !source.payloadsLoaded ||
    source.voiceInputActive;
  // Read when the move is done waiting: a send, a file read or voice input may have begun, or the
  // user left the draft (its composer is keyed by project and draft), and a move then would open
  // the destination in place of the page they went to.
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  return {
    locked: moving || blocked,
    move: (destination: string) => {
      setMoving(true);
      moveWorkspaceDraft({
        projectPath: source.projectPath,
        draftId: source.draftId,
        destination,
        runtimePick: source.runtimePick,
        agent: source.agent,
        isLocked: () => blockedRef.current || !isMountedRef.current,
      })
        .catch((error: unknown) => {
          console.warn("Failed to move the draft:", error);
        })
        .finally(() => setMoving(false));
    },
  };
}
