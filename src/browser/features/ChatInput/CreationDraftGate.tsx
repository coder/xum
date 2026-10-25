import { useEffect, type ReactNode } from "react";
import { Button } from "@/browser/components/Button/Button";
import { getCreationDraftStore, useCreationDraft } from "@/browser/stores/CreationDraftStore";

/**
 * Shows the creation composer once its draft resolved (found, or absent and blank). A failed
 * read shows Retry and no editor: a blank editor could save over a record this window never saw.
 */
export function CreationDraftGate(props: {
  draftId: string | null | undefined;
  projectPath: string;
  subProjectPath: string | null;
  children: ReactNode;
}) {
  const { draftId, projectPath, subProjectPath } = props;
  const view = useCreationDraft(draftId ?? "");
  useEffect(() => {
    if (draftId) getCreationDraftStore().open(draftId, projectPath, subProjectPath);
  }, [draftId, projectPath, subProjectPath]);
  // A draft that lives in another project waits for WorkspaceContext to reopen it there.
  const livesElsewhere =
    view.load.status === "ready" && view.draft !== null && view.draft.projectPath !== projectPath;

  if (!draftId || view.load.status === "loading" || livesElsewhere) {
    return <div className="text-muted py-4 text-center text-xs">Loading draft…</div>;
  }
  if (view.load.status === "loadFailed") {
    return (
      <div role="alert" className="text-error flex items-center justify-center gap-2 py-4 text-xs">
        <span>The draft did not load: {view.load.message}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => getCreationDraftStore().retryLoad(draftId)}
        >
          Retry
        </Button>
      </div>
    );
  }
  return props.children;
}
