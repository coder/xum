import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";
import type { ParsedRuntime } from "@/common/types/runtime";

interface CreationDraftMoveSource {
  /** The composer's owning project. */
  projectPath: string;
  /** The composer's listed draft, or undefined for the project's default creation draft. */
  draftId: string | undefined;
  runtimePick: ParsedRuntime | null;
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
  return {
    // The move waits for whatever is still on its way into the draft: a send in flight takes it,
    // a file being read is added to the draft it was attached to, and loading attachments would
    // reach the moved copy only once loaded (lost if the user moved it on meanwhile).
    locked: source.sendInFlight || source.processingAttachmentCount > 0 || !source.payloadsLoaded,
    move: (destination: string) =>
      moveWorkspaceDraft({
        projectPath: source.projectPath,
        draftId: source.draftId,
        destination,
        runtimePick: source.runtimePick,
      }),
  };
}
