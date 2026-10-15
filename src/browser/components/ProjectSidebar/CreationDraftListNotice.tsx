import {
  getCreationDraftStore,
  useCreationDraftListState,
} from "@/browser/stores/CreationDraftStore";

/**
 * Why the sidebar may lack drafts: their list failed to load (with Retry), or the one-way import
 * kept older drafts that differ from newer ones (their data stays where it was).
 */
export function CreationDraftListNotice() {
  const state = useCreationDraftListState();
  if (state.status !== "failed" && state.importError === null) return null;
  return (
    <div
      role="alert"
      className="bg-warning-overlay text-warning-text border-dark flex flex-col gap-1 border-b px-4 py-2 text-xs break-words"
    >
      {state.status === "failed" && (
        <div className="flex items-center justify-between gap-2">
          <span>Drafts could not be loaded.</span>
          <button
            onClick={() => getCreationDraftStore().retryList()}
            className="border-border-light hover:bg-hover shrink-0 cursor-pointer rounded border bg-transparent px-2 py-0.5 text-xs text-inherit"
          >
            Retry
          </button>
        </div>
      )}
      {state.importError !== null && <span>{state.importError}</span>}
    </div>
  );
}
