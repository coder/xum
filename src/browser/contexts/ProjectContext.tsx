import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAPI } from "@/browser/contexts/API";
import type { ProjectConfig } from "@/common/types/project";
import type { BranchListResult } from "@/common/orpc/types";
import type { z } from "zod";
import type { ProjectRemoveErrorSchema } from "@/common/orpc/schemas/errors";
import type { Secret } from "@/common/types/secrets";
import type { Result } from "@/common/types/result";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  deleteWorkspaceStorage,
  getDraftScopeId,
} from "@/common/constants/storage";
import { getErrorMessage } from "@/common/utils/errors";
import { getProjectRouteId } from "@/common/utils/projectRouteId";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { getFirstTopLevelProjectPath } from "@/common/utils/subProjects";
import {
  normalizeProjectPathForComparison,
  resolveProjectPathFromProjectQuery,
} from "@/common/utils/deepLink";

interface WorkspaceModalState {
  isOpen: boolean;
  projectPath: string | null;
  projectName: string;
  branches: string[];
  defaultTrunkBranch?: string;
  loadErrorMessage: string | null;
  isLoading: boolean;
}

type ProjectRemoveError = z.infer<typeof ProjectRemoveErrorSchema>;

type ProjectRemoveResult =
  | { success: true }
  | {
      success: false;
      error: ProjectRemoveError;
    };

export type ProjectQuery =
  | { type: "path"; value: string }
  | { type: "routeId"; value: string }
  | { type: "fuzzy"; value: string };

/** Selector fields from a deep-link payload for resolving which project to open a new chat in. */
export interface NewChatProjectSelector {
  projectPath?: string | null;
  projectId?: string | null;
  project?: string | null;
}

export interface ProjectContext {
  /** User-visible projects only (system projects filtered out). */
  userProjects: Map<string, ProjectConfig>;
  /** Canonical system project path when configured, otherwise null. */
  systemProjectPath: string | null;
  /** Resolve project path by caller intent (exact path, route ID, or fuzzy deep-link query). */
  resolveProjectPath: (query: ProjectQuery) => string | null;
  /** Read project config from the full project map (includes system projects). */
  getProjectConfig: (projectPath: string) => ProjectConfig | undefined;
  /** True while the initial project list request is in flight. */
  loading: boolean;
  /** True after at least one project list request completes successfully. */
  loaded: boolean;
  /** Last project list load failure, if the latest completed request failed. */
  loadError: string | null;
  refreshProjects: () => Promise<void>;
  addProject: (normalizedPath: string, projectConfig: ProjectConfig) => void;
  removeProject: (path: string, options?: { force?: boolean }) => Promise<ProjectRemoveResult>;

  // Project creation modal
  projectCreateInitialPath?: string;
  isProjectCreateModalOpen: boolean;
  openProjectCreateModal: (options?: { initialPath?: string }) => void;
  closeProjectCreateModal: () => void;

  // Workspace modal state
  workspaceModalState: WorkspaceModalState;
  openWorkspaceModal: (projectPath: string, options?: { projectName?: string }) => Promise<void>;
  closeWorkspaceModal: () => void;

  // Helpers
  getBranchesForProject: (projectPath: string) => Promise<BranchListResult>;
  getSecrets: (projectPath: string) => Promise<Secret[]>;
  updateSecrets: (projectPath: string, secrets: Secret[]) => Promise<void>;
  updateDisplayName: (projectPath: string, displayName: string | null) => Promise<Result<void>>;
  updateColor: (projectPath: string, color: string | null) => Promise<Result<void>>;
  updateCustomInstructions: (
    projectPath: string,
    customInstructions: string | null
  ) => Promise<Result<void>>;
  updateCodeWorkspaceSyncPath: (
    projectPath: string,
    codeWorkspaceSyncPath: string | null
  ) => Promise<Result<void>>;

  assignWorkspaceToSubProject: (
    projectPath: string,
    workspaceId: string,
    subProjectPath: string | null
  ) => Promise<Result<void>>;
  /** Whether any project (user or system) is loaded. */
  hasAnyProject: boolean;
  /** Resolve the target project for a new-chat deep link. Tries explicit selectors, then falls back to default. */
  resolveNewChatProjectPath: (selector: NewChatProjectSelector) => string | null;
}

const ProjectContext = createContext<ProjectContext | undefined>(undefined);

function deriveProjectName(projectPath: string): string {
  if (!projectPath) {
    return "Project";
  }
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

/** Normalize a selector field: trim whitespace, treat empty/whitespace-only as absent. */
function toNonEmptyTrimmed(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function ProjectProvider(props: { children: ReactNode }) {
  const { api } = useAPI();
  const [allProjectsInternal, setAllProjectsInternal] = useState<Map<string, ProjectConfig>>(
    new Map()
  );
  const userProjects = useMemo(
    () => new Map([...allProjectsInternal].filter(([, cfg]) => cfg.projectKind !== "system")),
    [allProjectsInternal]
  );
  const systemProjectPath = useMemo(
    () =>
      [...allProjectsInternal.entries()].find(([, cfg]) => cfg.projectKind === "system")?.[0] ??
      null,
    [allProjectsInternal]
  );
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectCreateInitialPath, setProjectCreateInitialPath] = useState<string | undefined>();
  const [isProjectCreateModalOpen, setProjectCreateModalOpen] = useState(false);
  const [workspaceModalState, setWorkspaceModalState] = useState<WorkspaceModalState>({
    isOpen: false,
    projectPath: null,
    projectName: "",
    branches: [],
    defaultTrunkBranch: undefined,
    loadErrorMessage: null,
    isLoading: false,
  });
  const workspaceModalProjectRef = useRef<string | null>(null);

  // Used to guard against refreshProjects() races.
  //
  // Example: the initial refresh (on mount) can start before a workspace fork, then
  // resolve after a fork-triggered refresh. Without this guard, the stale response
  // could overwrite the newer project list and make the forked workspace disappear
  // from the sidebar again.
  const projectsRefreshSeqRef = useRef(0);
  const latestAppliedProjectsRefreshSeqRef = useRef(0);

  const refreshProjects = useCallback(async () => {
    if (!api) {
      setLoaded(false);
      setLoadError("API not connected");
      return;
    }

    const refreshSeq = projectsRefreshSeqRef.current + 1;
    projectsRefreshSeqRef.current = refreshSeq;

    try {
      const projectsList = await api.projects.list();

      // Ignore out-of-date refreshes so an older response can't clobber a newer success.
      if (refreshSeq < latestAppliedProjectsRefreshSeqRef.current) {
        return;
      }

      latestAppliedProjectsRefreshSeqRef.current = refreshSeq;
      setAllProjectsInternal(new Map(projectsList));
      setLoaded(true);
      setLoadError(null);
    } catch (error) {
      // Ignore out-of-date refreshes so an older error can't clobber a newer success.
      if (refreshSeq < latestAppliedProjectsRefreshSeqRef.current) {
        return;
      }

      // Keep the previous project list on error so scoped user preferences are not pruned.
      console.error("Failed to load projects:", error);
      setLoadError(getErrorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const initialRefresh = async () => {
      await refreshProjects();
      if (!cancelled) {
        setLoading(false);
      }
    };

    const refreshPromise = initialRefresh();
    refreshPromise.catch((error) => {
      if (!cancelled) {
        setLoadError(getErrorMessage(error));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [refreshProjects]);

  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (onConfigChanged == null) {
      return;
    }

    const abortController = new AbortController();
    const signal = abortController.signal;
    let iterator: AsyncIterator<unknown> | null = null;

    void (async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void refreshProjects();
        }
      } catch {
        // Subscription cancellation is expected during unmount/API reconnects.
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, refreshProjects]);

  const addProject = useCallback((normalizedPath: string, projectConfig: ProjectConfig) => {
    setAllProjectsInternal((prev) => {
      const next = new Map(prev);
      next.set(normalizedPath, projectConfig);
      return next;
    });
  }, []);

  const removeProject = useCallback(
    async (path: string, options?: { force?: boolean }): Promise<ProjectRemoveResult> => {
      if (!api) {
        return {
          success: false,
          error: { type: "unknown", message: "API not connected" },
        };
      }
      try {
        const result = await api.projects.remove({
          projectPath: path,
          force: options?.force,
        });
        if (result.success) {
          setAllProjectsInternal((prev) => {
            const next = new Map(prev);
            next.delete(path);
            return next;
          });

          // Clean up any UI-only workspace drafts for this project.
          const draftsValue = readPersistedState<unknown>(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {});
          if (draftsValue && typeof draftsValue === "object") {
            const record = draftsValue as Record<string, unknown>;
            const drafts = record[path];
            if (drafts !== undefined) {
              if (Array.isArray(drafts)) {
                for (const draft of drafts) {
                  if (!draft || typeof draft !== "object") continue;
                  const draftId = (draft as { draftId?: unknown }).draftId;
                  if (typeof draftId === "string" && draftId.trim().length > 0) {
                    deleteWorkspaceStorage(getDraftScopeId(path, draftId));
                  }
                }
              }

              updatePersistedState<Record<string, unknown>>(
                WORKSPACE_DRAFTS_BY_PROJECT_KEY,
                (prev) => {
                  const next = prev && typeof prev === "object" ? { ...prev } : {};
                  delete next[path];
                  return next;
                },
                {}
              );
            }
          }

          await refreshProjects();
          return { success: true };
        }

        const error = result.error;
        if (error.type === "workspace_blockers") {
          // Expected user-facing validation failures should surface in UI without
          // polluting error-level console output.
          console.warn("Failed to remove project:", error);
        } else {
          console.error("Failed to remove project:", error);
        }
        return { success: false, error };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to remove project:", errorMessage);
        return {
          success: false,
          error: { type: "unknown" as const, message: errorMessage },
        };
      }
    },
    [api, refreshProjects]
  );

  const resolveProjectPath = useCallback(
    (query: ProjectQuery): string | null => {
      // The scratch sentinel is not a configured project until the first
      // scratch chat is created, so a reloaded scratch draft route cannot be
      // resolved from projects.list; resolve it statically instead.
      if (
        query.value === SCRATCH_PROJECT_CONFIG_KEY ||
        (query.type === "routeId" && query.value === getProjectRouteId(SCRATCH_PROJECT_CONFIG_KEY))
      ) {
        return SCRATCH_PROJECT_CONFIG_KEY;
      }

      if (query.type === "path") {
        const platform = globalThis.window?.api?.platform;
        const normalizedTarget = normalizeProjectPathForComparison(query.value, platform);

        for (const projectPath of allProjectsInternal.keys()) {
          if (normalizeProjectPathForComparison(projectPath, platform) === normalizedTarget) {
            return projectPath;
          }
        }

        return null;
      }

      if (query.type === "routeId") {
        for (const projectPath of allProjectsInternal.keys()) {
          if (getProjectRouteId(projectPath) === query.value) {
            return projectPath;
          }
        }

        return null;
      }

      return resolveProjectPathFromProjectQuery(allProjectsInternal.keys(), query.value);
    },
    [allProjectsInternal]
  );

  const getProjectConfig = useCallback(
    (projectPath: string): ProjectConfig | undefined => {
      return allProjectsInternal.get(projectPath);
    },
    [allProjectsInternal]
  );

  const hasAnyProject = allProjectsInternal.size > 0;

  // Canonical resolver for new-chat deep links: explicit selectors first, default fallback last.
  const resolveNewChatProjectPath = useCallback(
    (selector: NewChatProjectSelector): string | null => {
      const exactPath = toNonEmptyTrimmed(selector.projectPath);
      if (exactPath) {
        const byPath = resolveProjectPath({ type: "path", value: exactPath });
        if (byPath) return byPath;
      }

      const routeId = toNonEmptyTrimmed(selector.projectId);
      if (routeId) {
        const byRoute = resolveProjectPath({ type: "routeId", value: routeId });
        if (byRoute) return byRoute;
      }

      // Back-compat: if projectPath didn't match exactly, try fuzzy matching by path segment.
      const projectQuery = toNonEmptyTrimmed(selector.project);
      const fuzzy = projectQuery ?? exactPath;
      if (fuzzy) {
        const byQuery = resolveProjectPath({ type: "fuzzy", value: fuzzy });
        if (byQuery) return byQuery;
      }

      // Default project selection targets parent-owned projects because sub-projects
      // are displayed as sections under their parent rather than standalone routes.
      return getFirstTopLevelProjectPath(userProjects);
    },
    [resolveProjectPath, userProjects]
  );

  const getBranchesForProject = useCallback(
    async (projectPath: string): Promise<BranchListResult> => {
      if (!api) {
        return { branches: [], recommendedTrunk: "" };
      }
      const branchResult = await api.projects.listBranches({ projectPath });
      const branches = branchResult.branches;
      const sanitizedBranches = Array.isArray(branches)
        ? branches.filter((branch): branch is string => typeof branch === "string")
        : [];

      const recommended =
        typeof branchResult?.recommendedTrunk === "string" &&
        sanitizedBranches.includes(branchResult.recommendedTrunk)
          ? branchResult.recommendedTrunk
          : (sanitizedBranches[0] ?? "");

      return {
        branches: sanitizedBranches,
        recommendedTrunk: recommended,
      };
    },
    [api]
  );

  const openWorkspaceModal = useCallback(
    async (projectPath: string, options?: { projectName?: string }) => {
      const projectName = options?.projectName ?? deriveProjectName(projectPath);
      workspaceModalProjectRef.current = projectPath;
      setWorkspaceModalState((prev) => ({
        ...prev,
        isOpen: true,
        projectPath,
        projectName,
        branches: [],
        defaultTrunkBranch: undefined,
        loadErrorMessage: null,
        isLoading: true,
      }));

      try {
        const { branches, recommendedTrunk } = await getBranchesForProject(projectPath);
        if (workspaceModalProjectRef.current !== projectPath) {
          return;
        }
        setWorkspaceModalState((prev) => ({
          ...prev,
          branches,
          defaultTrunkBranch: recommendedTrunk ?? undefined,
          loadErrorMessage: null,
          isLoading: false,
        }));
      } catch (error) {
        console.error("Failed to load branches for project:", error);
        if (workspaceModalProjectRef.current !== projectPath) {
          return;
        }
        const errorMessage =
          error instanceof Error ? error.message : "Failed to load branches for project";
        setWorkspaceModalState((prev) => ({
          ...prev,
          branches: [],
          defaultTrunkBranch: undefined,
          loadErrorMessage: errorMessage,
          isLoading: false,
        }));
      }
    },
    [getBranchesForProject]
  );

  const closeWorkspaceModal = useCallback(() => {
    workspaceModalProjectRef.current = null;
    setWorkspaceModalState({
      isOpen: false,
      projectPath: null,
      projectName: "",
      branches: [],
      defaultTrunkBranch: undefined,
      loadErrorMessage: null,
      isLoading: false,
    });
  }, []);

  const getSecrets = useCallback(
    async (projectPath: string): Promise<Secret[]> => {
      if (!api) return [];
      return await api.secrets.get({ projectPath });
    },
    [api]
  );

  const updateSecrets = useCallback(
    async (projectPath: string, secrets: Secret[]) => {
      if (!api) return;
      const result = await api.secrets.update({ projectPath, secrets });
      if (!result.success) {
        console.error("Failed to update secrets:", result.error);
      }
    },
    [api]
  );

  const updateDisplayName = useCallback(
    async (projectPath: string, displayName: string | null): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        await api.projects.setDisplayName({ projectPath, displayName });
        await refreshProjects();
        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
    [api, refreshProjects]
  );

  const updateColor = useCallback(
    async (projectPath: string, color: string | null): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        await api.projects.setColor({ projectPath, color });
        await refreshProjects();
        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
    [api, refreshProjects]
  );

  const updateCustomInstructions = useCallback(
    async (projectPath: string, customInstructions: string | null): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        await api.projects.setCustomInstructions({ projectPath, customInstructions });
        await refreshProjects();
        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
    [api, refreshProjects]
  );

  const assignWorkspaceToSubProject = useCallback(
    async (
      projectPath: string,
      workspaceId: string,
      subProjectPath: string | null
    ): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      const result = await api.projects.subProjects.assignWorkspace({
        projectPath,
        workspaceId,
        subProjectPath,
      });
      if (result.success) {
        await refreshProjects();
      }
      return result;
    },
    [api, refreshProjects]
  );

  const value = useMemo<ProjectContext>(
    () => ({
      userProjects,
      systemProjectPath,
      resolveProjectPath,
      hasAnyProject,
      resolveNewChatProjectPath,
      getProjectConfig,
      loading,
      loaded,
      loadError,
      refreshProjects,
      addProject,
      removeProject,
      projectCreateInitialPath,
      isProjectCreateModalOpen,
      openProjectCreateModal: (options?: { initialPath?: string }) => {
        setProjectCreateInitialPath(options?.initialPath);
        setProjectCreateModalOpen(true);
      },
      closeProjectCreateModal: () => {
        setProjectCreateModalOpen(false);
        setProjectCreateInitialPath(undefined);
      },
      workspaceModalState,
      openWorkspaceModal,
      closeWorkspaceModal,
      getBranchesForProject,
      getSecrets,
      updateSecrets,
      updateDisplayName,
      updateColor,
      updateCustomInstructions,
      // Defined inline (not useCallback): the repo bans new manual useCallback
      // memoization, and inlining keeps exhaustive-deps satisfied via `api`.
      updateCodeWorkspaceSyncPath: async (
        projectPath: string,
        codeWorkspaceSyncPath: string | null
      ): Promise<Result<void>> => {
        if (!api) return { success: false, error: "API not connected" };
        try {
          await api.projects.setCodeWorkspaceSyncPath({ projectPath, codeWorkspaceSyncPath });
          await refreshProjects();
          return { success: true, data: undefined };
        } catch (error) {
          return { success: false, error: getErrorMessage(error) };
        }
      },
      assignWorkspaceToSubProject,
    }),
    [
      userProjects,
      systemProjectPath,
      resolveProjectPath,
      hasAnyProject,
      resolveNewChatProjectPath,
      getProjectConfig,
      loading,
      loaded,
      loadError,
      refreshProjects,
      addProject,
      removeProject,
      projectCreateInitialPath,
      isProjectCreateModalOpen,
      workspaceModalState,
      openWorkspaceModal,
      closeWorkspaceModal,
      getBranchesForProject,
      getSecrets,
      updateSecrets,
      updateDisplayName,
      updateColor,
      updateCustomInstructions,
      api,
      assignWorkspaceToSubProject,
    ]
  );

  return <ProjectContext.Provider value={value}>{props.children}</ProjectContext.Provider>;
}

export function useProjectContext(): ProjectContext {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProjectContext must be used within ProjectProvider");
  }
  return context;
}
