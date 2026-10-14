import { getDraftStore } from "@/browser/stores/DraftStore";
import {
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  getDraftScopeId,
  getInputKey,
} from "@/common/constants/storage";

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE DRAFTS
// ═══════════════════════════════════════════════════════════════════════════════
export interface WorkspaceDraftFixture {
  draftId: string;
  /** Optional: sub-project path the draft belongs to */
  subProjectPath?: string | null;
  /** Optional: draft prompt text */
  prompt?: string;
  /** Optional: workspace name (either manual or generated) */
  workspaceName?: string;
  /** Optional: timestamp for sorting */
  createdAt?: number;
}

/**
 * Seed workspace drafts for a project: the list and prompts as legacy localStorage keys (imported
 * on hydration), the workspace names through the DraftStore.
 */
export function setWorkspaceDrafts(projectPath: string, drafts: WorkspaceDraftFixture[]): void {
  // Set the drafts index
  const draftsByProject = JSON.parse(
    localStorage.getItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY) ?? "{}"
  ) as Record<
    string,
    Array<{ draftId: string; subProjectPath?: string | null; createdAt?: number }>
  >;

  draftsByProject[projectPath] = drafts.map((d) => ({
    draftId: d.draftId,
    subProjectPath: d.subProjectPath,
    createdAt: d.createdAt ?? Date.now(),
  }));

  localStorage.setItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY, JSON.stringify(draftsByProject));

  // Set individual draft data (prompt and name)
  for (const draft of drafts) {
    const scopeId = getDraftScopeId(projectPath, draft.draftId);

    // Set prompt if provided
    if (draft.prompt !== undefined) {
      localStorage.setItem(getInputKey(scopeId), JSON.stringify(draft.prompt));
    }

    // The name lives in the draft body: set it like the creation form does. Unsaved until the
    // story's mock backend hydrates the store, which then saves it there.
    if (draft.workspaceName !== undefined) {
      getDraftStore().setNameState(
        { kind: "creation", projectPath, draftId: draft.draftId },
        {
          generatedIdentity: null,
          manualName: draft.workspaceName,
          autoGenerate: false,
          lastGeneratedFor: "",
        }
      );
    }
  }
}
