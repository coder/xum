import { useCallback, useEffect } from "react";
import type { ProjectConfig } from "@/common/types/project";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import {
  getFirstTopLevelProjectPath,
  resolveWorkspaceCreationScope,
} from "@/common/utils/subProjects";

export type StartWorkspaceCreationDetail =
  CustomEventPayloads[typeof CUSTOM_EVENTS.START_WORKSPACE_CREATION];

/**
 * A prefilled creation opens a new draft holding the prefill (text, model, trunk). The prefill
 * belongs to that draft: project defaults stay unchanged. Returns the draft id, if one was made.
 */
export function persistWorkspaceCreationPrefill(
  projectPath: string,
  subProjectPath: string | null,
  detail: StartWorkspaceCreationDetail | undefined
): string | undefined {
  const { startMessage, model, trunkBranch } = detail ?? {};
  if (startMessage === undefined && model === undefined && trunkBranch === undefined) {
    return undefined;
  }
  const store = getCreationDraftStore();
  const draftId = store.create(projectPath, subProjectPath, { persist: true, text: startMessage });
  const draft = store.getView(draftId).draft;
  if (draft && model !== undefined) {
    // A prefilled model is an explicit pick, so it leaves Auto (see setWorkspaceModelWithOrigin).
    store.update(draftId, { ai: { ...draft.ai, model }, auto: { ...draft.auto, model: false } });
  }
  // The runtime is intentionally not prefilled: it is a one-time override.
  const trunk = trunkBranch?.trim();
  if (trunk) store.updateExecution(draftId, { trunkBranch: trunk });
  return draftId;
}

interface UseStartWorkspaceCreationOptions {
  projects: Map<string, ProjectConfig>;
  beginWorkspaceCreation: (projectPath: string, draftId?: string) => void;
}

export function useStartWorkspaceCreation({
  projects,
  beginWorkspaceCreation,
}: UseStartWorkspaceCreationOptions) {
  const startWorkspaceCreation = useCallback(
    (projectPath: string, detail?: StartWorkspaceCreationDetail) => {
      const resolvedProjectPath = projects.has(projectPath)
        ? projectPath
        : getFirstTopLevelProjectPath(projects);

      if (!resolvedProjectPath) {
        console.warn("No projects available for workspace creation");
        return;
      }

      const creationScope = resolveWorkspaceCreationScope(resolvedProjectPath, projects);
      const draftId = persistWorkspaceCreationPrefill(
        creationScope.projectPath,
        creationScope.subProjectPath ?? null,
        detail
      );
      beginWorkspaceCreation(creationScope.subProjectPath ?? creationScope.projectPath, draftId);
    },
    [projects, beginWorkspaceCreation]
  );

  useEffect(() => {
    const handleStartCreation = (event: Event) => {
      const customEvent = event as CustomEvent<StartWorkspaceCreationDetail | undefined>;
      const detail = customEvent.detail;

      if (!detail?.projectPath) {
        console.warn("START_WORKSPACE_CREATION event missing projectPath detail");
        return;
      }

      startWorkspaceCreation(detail.projectPath, detail);
    };

    window.addEventListener(
      CUSTOM_EVENTS.START_WORKSPACE_CREATION,
      handleStartCreation as EventListener
    );

    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.START_WORKSPACE_CREATION,
        handleStartCreation as EventListener
      );
  }, [startWorkspaceCreation]);

  return startWorkspaceCreation;
}
