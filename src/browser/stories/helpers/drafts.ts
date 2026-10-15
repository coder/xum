import {
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  getDraftScopeId,
  getInputKey,
  getWorkspaceNameStateKey,
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
 * Set workspace drafts for a project in localStorage.
 * This seeds the sidebar with UI-only draft placeholders.
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

    // Set workspace name state if provided
    if (draft.workspaceName !== undefined) {
      const nameState = {
        autoGenerate: false,
        manualName: draft.workspaceName,
      };
      localStorage.setItem(getWorkspaceNameStateKey(scopeId), JSON.stringify(nameState));
    }
  }
}
