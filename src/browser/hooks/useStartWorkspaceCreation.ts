import { useCallback, useEffect } from "react";
import type { ProjectConfig } from "@/common/types/project";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getAutoModelRoutingKey,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getTrunkBranchKey,
} from "@/common/constants/storage";
import {
  getFirstTopLevelProjectPath,
  resolveWorkspaceCreationScope,
} from "@/common/utils/subProjects";

export type StartWorkspaceCreationDetail =
  CustomEventPayloads[typeof CUSTOM_EVENTS.START_WORKSPACE_CREATION];

type PersistFn = typeof updatePersistedState;

export function persistWorkspaceCreationPrefill(
  projectPath: string,
  detail: StartWorkspaceCreationDetail | undefined,
  persist: PersistFn = updatePersistedState
): void {
  if (!detail) {
    return;
  }

  if (detail.startMessage !== undefined) {
    persist(getInputKey(getPendingScopeId(projectPath)), detail.startMessage);
  }

  if (detail.model !== undefined) {
    const projectScopeId = getProjectScopeId(projectPath);
    persist(getModelKey(projectScopeId), detail.model);
    // A prefilled model is an explicit pick, so it leaves Auto (see setWorkspaceModelWithOrigin);
    // otherwise the creation send would treat it as the routing fallback.
    persist(getAutoModelRoutingKey(projectScopeId), false);
  }

  if (detail.trunkBranch !== undefined) {
    const normalizedTrunk = detail.trunkBranch.trim();
    persist(
      getTrunkBranchKey(projectPath),
      normalizedTrunk.length > 0 ? normalizedTrunk : undefined
    );
  }

  // Note: runtime is intentionally NOT persisted here - it's a one-time override.
  // The default runtime can only be changed via the icon selector.
}

interface UseStartWorkspaceCreationOptions {
  projects: Map<string, ProjectConfig>;
  beginWorkspaceCreation: (projectPath: string) => void;
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
      // Sub-project creation shares the parent project's worktree/settings, so
      // persisted prefill belongs to the owning parent even when the route opens
      // the sub-project section.
      persistWorkspaceCreationPrefill(creationScope.projectPath, detail);
      beginWorkspaceCreation(creationScope.subProjectPath ?? creationScope.projectPath);
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
