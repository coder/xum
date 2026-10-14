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
}

/**
 * The creation header's project selector: it moves the draft being edited instead of opening
 * the destination's own draft.
 */
export function useCreationDraftMove(source: CreationDraftMoveSource) {
  const { moveWorkspaceDraft } = useWorkspaceActions();
  const hydrated = useDraftStoreHydrated();
  return {
    // The move waits for whatever is still on its way into the draft: the drafts themselves
    // (composers may render before they load, and an unloaded draft would move as an empty one),
    // a send in flight takes it, a file being read is added to the draft it was attached to, and
    // loading attachments would reach the moved copy only once loaded (lost if the user moved it
    // on meanwhile).
    locked:
      !hydrated ||
      source.sendInFlight ||
      source.processingAttachmentCount > 0 ||
      !source.payloadsLoaded,
    move: (destination: string) =>
      moveWorkspaceDraft({
        projectPath: source.projectPath,
        draftId: source.draftId,
        destination,
        runtimePick: source.runtimePick,
        agent: source.agent,
      }),
  };
}
