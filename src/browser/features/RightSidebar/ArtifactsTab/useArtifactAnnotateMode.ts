import { useState } from "react";
import { ARTIFACTS_SELECTION_MAX_WORKSPACES } from "@/common/constants/storage";
import type { ArtifactAnnotationPick, ArtifactAnnotationSupport } from "./artifactAnnotation";
import { createCappedMemory, useCappedMemory } from "./cappedMemory";

// Workspaces with annotate mode on. A sidebar tab switch unmounts the panel, and component state
// alone turned annotate off while fullscreen kept it. Shared by every mounted panel of the
// workspace (cappedMemory.ts). Bounded like the persisted selection map; only "on" is stored,
// so a workspace dropped from the map is simply off.
const annotatingWorkspaces = createCappedMemory<true>(ARTIFACTS_SELECTION_MAX_WORKSPACES);

function setWorkspaceAnnotating(workspaceId: string, on: boolean) {
  annotatingWorkspaces.set(workspaceId, on ? true : undefined);
}

/**
 * Annotate mode (M5b) of the Artifacts panel: comments on the selected artifact become review
 * notes in the composer. Owns whether the mode is on and the open comment box (the pick), and
 * the rules every way in uses: the toolbar button and the annotate shortcut (on the panel, or
 * from inside an HTML frame) toggle it, and the cancel shortcut (panel or frame) peels one layer
 * per press.
 *
 * `support` is the selected artifact's annotate flavour (null: it cannot be annotated, so the
 * mode reads as off). `pickKey` identifies the shown file version: a pick made on another
 * version is not shown.
 */
export function useArtifactAnnotateMode(
  workspaceId: string,
  support: ArtifactAnnotationSupport | null,
  pickKey: string
) {
  const on = useCappedMemory(annotatingWorkspaces, workspaceId, (value) => value === true);
  const [pick, setPick] = useState<{ key: string; pick: ArtifactAnnotationPick } | null>(null);
  const annotating = on && support != null;
  const pendingPick = annotating && pick?.key === pickKey ? pick.pick : null;
  // React's state setter, so its identity is stable: the panel's fullscreen effect clears the
  // pick, and a new function each render would re-run that effect (focus, inert siblings).
  // Typed to clearing only: openAnnotation is the one way to open a box (it sets the key).
  const setAnnotationPick: (value: null) => void = setPick;
  return {
    annotating,
    /** The open comment box's pick, if one is open on the shown version. */
    pendingPick,
    openAnnotation: (next: ArtifactAnnotationPick) => setPick({ key: pickKey, pick: next }),
    setAnnotationPick,
    toggleAnnotate: () => {
      if (support == null) return;
      setPick(null);
      setWorkspaceAnnotating(workspaceId, !annotating);
    },
    /**
     * The cancel shortcut steps out of annotating one layer at a time: an open comment box
     * first, then annotate mode. Returns whether it consumed the key, so fullscreen closes only
     * on a later press.
     */
    escapeAnnotate: (): boolean => {
      if (pendingPick != null) {
        setPick(null);
        return true;
      }
      if (!annotating) return false;
      setWorkspaceAnnotating(workspaceId, false);
      return true;
    },
  };
}
