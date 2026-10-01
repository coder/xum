import React, { useRef, useCallback, useState, useEffect } from "react";
import { Menu } from "lucide-react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { cn } from "@/common/lib/utils";
import { CREATION_COLUMN_MAX_WIDTH_CLASS } from "@/constants/layout";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { ChatInput } from "@/browser/features/ChatInput/index";
import type { ChatInputAPI, WorkspaceCreatedOptions } from "@/browser/features/ChatInput/types";
import { ProjectMCPOverview } from "../ProjectMCPOverview/ProjectMCPOverview";
import { ArchivedWorkspaces } from "../ArchivedWorkspaces/ArchivedWorkspaces";
import { useAPI } from "@/browser/contexts/API";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import { GitInitBanner } from "../GitInitBanner/GitInitBanner";
import { ConfiguredProvidersBar } from "../ConfiguredProvidersBar/ConfiguredProvidersBar";
import { ConfigureProvidersPrompt } from "../ConfigureProvidersPrompt/ConfigureProvidersPrompt";
import { hasConfiguredProvider, useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { AgentsInitBanner } from "../AgentsInitBanner/AgentsInitBanner";
import {
  usePersistedState,
  updatePersistedState,
  readPersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  ARCHIVED_WORKSPACES_CACHE_MAX_CHARS,
  getAgentIdKey,
  getAgentsInitNudgeKey,
  getArchivedWorkspacesKey,
  getArchivedWorkspacesExpandedKey,
  getProjectScopeId,
} from "@/common/constants/storage";
import { getDraftStore } from "@/browser/stores/DraftStore";
import { trimArrayToChars } from "@/browser/utils/boundedPersistedValue";
import { getComposerDraftScope } from "@/browser/features/ChatInput/useComposerDraft";
import { Button } from "@/browser/components/Button/Button";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

interface ProjectPageProps {
  projectPath: string;
  projectName: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  /** Sub-project path for parent-owned draft creation. */
  pendingSubProjectPath?: string | null;
  /** Draft ID for UI-only workspace creation drafts (from URL) */
  pendingDraftId?: string | null;
  onWorkspaceCreated: (
    metadata: FrontendWorkspaceMetadata,
    options?: WorkspaceCreatedOptions
  ) => void;
}

/** Compare archived workspace lists by ID set (order doesn't matter for equality) */
function archivedListsEqual(
  prev: FrontendWorkspaceMetadata[],
  next: FrontendWorkspaceMetadata[]
): boolean {
  if (prev.length !== next.length) return false;
  const prevIds = new Set(prev.map((w) => w.id));
  return next.every((w) => prevIds.has(w.id));
}

// Rendered with key={projectPath}: ProjectPage stays mounted across project navigation,
// and a collapsed section never refetches, so the archived list must reset per project.
const ProjectArchivedWorkspaces: React.FC<{ projectPath: string; projectName: string }> = ({
  projectPath,
  projectName,
}) => {
  const { api } = useAPI();
  // Initialize from localStorage cache to avoid flash when archived workspaces appear
  const [archivedWorkspaces, setArchivedWorkspaces] = useState<
    FrontendWorkspaceMetadata[] | undefined
  >(() =>
    readPersistedState<FrontendWorkspaceMetadata[] | undefined>(
      getArchivedWorkspacesKey(projectPath),
      undefined
    )
  );
  const [archivedLoadError, setArchivedLoadError] = useState<string>();
  const [archivedExpanded] = usePersistedState(
    getArchivedWorkspacesExpandedKey(projectPath),
    false,
    { listener: true }
  );

  // Track archived workspaces in a ref; only update state when the list actually changes
  const archivedMapRef = useRef<Map<string, FrontendWorkspaceMetadata>>(new Map());

  const syncArchivedState = useCallback(() => {
    const next = Array.from(archivedMapRef.current.values());
    // Persist outside the state updater: a restore navigates away before its refresh
    // resolves, and an unmounted component's updater never runs, so the next mount
    // would otherwise start from a cache that still lists the restored workspace.
    // The cache only seeds the first render, so keep just the leading entries that fit its budget.
    updatePersistedState(
      getArchivedWorkspacesKey(projectPath),
      trimArrayToChars(next, ARCHIVED_WORKSPACES_CACHE_MAX_CHARS)
    );
    setArchivedWorkspaces((prev) => (prev && archivedListsEqual(prev, next) ? prev : next));
  }, [projectPath]);

  const replaceArchivedList = useCallback(
    (allArchived: FrontendWorkspaceMetadata[]) => {
      const projectArchived = allArchived.filter((w) => w.projectPath === projectPath);
      archivedMapRef.current = new Map(projectArchived.map((w) => [w.id, w]));
      syncArchivedState();
    },
    [projectPath, syncArchivedState]
  );

  // Bumped to re-list after a restore/delete: a fresh stream's snapshot stays ordered with the
  // updates around it, unlike a separate list() (#5189).
  const [archivedListRevision, setArchivedListRevision] = useState(0);

  // Keep archived metadata off the project page startup path. The stream's first event is the
  // archived snapshot, built after the server attached the listener, so no update falls between.
  useEffect(() => {
    if (!api || !archivedExpanded) return;
    const controller = new AbortController();
    let snapshotReceived = false;

    (async () => {
      try {
        const iterator = await api.workspace.onMetadata(
          { archived: true },
          { signal: controller.signal }
        );
        for await (const event of iterator) {
          if (controller.signal.aborted) break;

          if ("type" in event) {
            snapshotReceived = true;
            setArchivedLoadError(undefined);
            replaceArchivedList(event.workspaces);
            continue;
          }

          const meta = event.metadata;
          // Only care about workspaces in this project
          if (meta && meta.projectPath !== projectPath) continue;
          // For deletions, check if it was in our map (i.e., was in this project)
          if (!meta && !archivedMapRef.current.has(event.workspaceId)) continue;

          const isArchived = meta && isWorkspaceArchived(meta.archivedAt, meta.unarchivedAt);

          if (isArchived) {
            archivedMapRef.current.set(meta.id, meta);
          } else {
            archivedMapRef.current.delete(event.workspaceId);
          }

          syncArchivedState();
        }
        if (!snapshotReceived && !controller.signal.aborted) {
          throw new Error("Archived workspace stream ended before its snapshot");
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("Failed to load archived workspaces:", err);
          setArchivedLoadError(getErrorMessage(err));
        }
      }
    })();

    return () => controller.abort();
  }, [
    api,
    projectPath,
    replaceArchivedList,
    syncArchivedState,
    archivedExpanded,
    archivedListRevision,
  ]);

  return (
    <div className="flex justify-center px-4 pb-4">
      <div className={cn("w-full", CREATION_COLUMN_MAX_WIDTH_CLASS)}>
        <ArchivedWorkspaces
          projectPath={projectPath}
          projectName={projectName}
          workspaces={archivedWorkspaces}
          loadError={archivedLoadError}
          onWorkspacesChanged={() => {
            // Refresh archived list after unarchive/delete
            setArchivedListRevision((revision) => revision + 1);
          }}
        />
      </div>
    </div>
  );
};

/**
 * Project page shown when a project is selected but no workspace is active.
 * Combines workspace creation with archived workspaces view.
 */
export const ProjectPage: React.FC<ProjectPageProps> = ({
  projectPath,
  projectName,
  leftSidebarCollapsed,
  onToggleLeftSidebarCollapsed,
  pendingSubProjectPath,
  pendingDraftId,
  onWorkspaceCreated,
}) => {
  const { api } = useAPI();
  const chatInputRef = useRef<ChatInputAPI | null>(null);
  const pendingAgentsInitSendRef = useRef(false);
  const [showAgentsInitNudge, setShowAgentsInitNudge] = usePersistedState<boolean>(
    getAgentsInitNudgeKey(projectPath),
    false,
    { listener: true }
  );
  const { config: providersConfig, loading: providersLoading } = useProvidersConfig();
  const hasProviders = hasConfiguredProvider(providersConfig);
  const shouldShowAgentsInitBanner = !providersLoading && hasProviders && showAgentsInitNudge;

  // Git repository state for the banner
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [hasBranches, setHasBranches] = useState(true); // Assume git repo until proven otherwise
  const [branchRefreshKey, setBranchRefreshKey] = useState(0);

  // Load branches to determine if this is a git repository.
  // Uses local cancelled flag (not ref) to handle StrictMode double-renders correctly.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    (async () => {
      // Don't reset branchesLoaded - it starts false, becomes true after first load.
      // This keeps banner mounted during refetch so success message stays visible.
      try {
        const result = await api.projects.listBranches({ projectPath });
        if (cancelled) return;
        setHasBranches(result.branches.length > 0);
      } catch (err) {
        console.error("Failed to load branches:", err);
        if (cancelled) return;
        setHasBranches(true); // On error, don't show banner
      } finally {
        if (!cancelled) {
          setBranchesLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, projectPath, branchRefreshKey]);

  const isNonGitRepo = branchesLoaded && !hasBranches;

  // Trigger branch refetch after git init to verify it worked
  const handleGitInitSuccess = useCallback(() => {
    setBranchRefreshKey((k) => k + 1);
  }, []);

  const didAutoFocusRef = useRef(false);

  const handleDismissAgentsInit = useCallback(() => {
    setShowAgentsInitNudge(false);
  }, [setShowAgentsInitNudge]);

  const handleRunAgentsInit = useCallback(() => {
    // Switch project-scope mode to exec.
    updatePersistedState(getAgentIdKey(getProjectScopeId(projectPath)), "exec");

    // Run the /init skill and start the creation chat.
    if (chatInputRef.current) {
      chatInputRef.current.restoreText("/init");
      requestAnimationFrame(() => {
        void chatInputRef.current?.send();
      });
    } else {
      pendingAgentsInitSendRef.current = true;
      getDraftStore().setText(
        getComposerDraftScope({
          variant: "creation",
          workspaceId: null,
          creationProjectPath: projectPath,
          pendingDraftId: pendingDraftId ?? undefined,
        }),
        "/init"
      );
    }

    setShowAgentsInitNudge(false);
  }, [projectPath, pendingDraftId, setShowAgentsInitNudge]);

  const handleChatReady = useCallback((api: ChatInputAPI) => {
    chatInputRef.current = api;

    if (pendingAgentsInitSendRef.current) {
      pendingAgentsInitSendRef.current = false;
      didAutoFocusRef.current = true;
      api.restoreText("/init");
      requestAnimationFrame(() => {
        void api.send();
      });
      return;
    }

    // Auto-focus the prompt once when entering the creation screen.
    // Defensive: avoid re-focusing on unrelated re-renders (e.g. workspace list updates),
    // which can move the user's caret.
    if (didAutoFocusRef.current) {
      return;
    }
    didAutoFocusRef.current = true;
    api.focus();
  }, []);

  return (
    <AgentProvider projectPath={projectPath}>
      <ThinkingProvider projectPath={projectPath}>
        {/* Flex container to fill parent space */}
        <div className="bg-surface-primary relative flex flex-1 flex-col overflow-hidden">
          {/* Draggable header bar - matches WorkspaceMenuBar for consistency */}
          <div
            className={cn(
              "bg-sidebar border-border-light mobile-sticky-header flex shrink-0 items-center border-b px-2 [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2",
              isDesktopMode() ? "h-10 titlebar-drag" : "h-8"
            )}
          >
            {leftSidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleLeftSidebarCollapsed}
                title="Open sidebar"
                aria-label="Open sidebar menu"
                className={cn(
                  "hidden mobile-menu-btn h-6 w-6 shrink-0 text-muted hover:text-foreground",
                  isDesktopMode() && "titlebar-no-drag"
                )}
              >
                <Menu className="h-4 w-4" />
              </Button>
            )}
          </div>
          {/* Scrollable content area. mobile-header-spacer keeps content below
              the fixed mobile header on touch devices. */}
          <div className="mobile-header-spacer min-h-0 flex-1 overflow-y-auto">
            {/* Main content - vertically centered with reduced gaps */}
            <div className="flex min-h-[50vh] flex-col items-center justify-center px-4 py-6">
              <div className={cn("flex w-full flex-col gap-4", CREATION_COLUMN_MAX_WIDTH_CLASS)}>
                {/* Git init banner - shown above ChatInput when not a git repo */}
                {isNonGitRepo && (
                  <GitInitBanner projectPath={projectPath} onSuccess={handleGitInitSuccess} />
                )}
                {/* Show configure prompt when no providers, otherwise show ChatInput */}
                {!providersLoading && !hasProviders ? (
                  <ConfigureProvidersPrompt />
                ) : (
                  <>
                    {shouldShowAgentsInitBanner && (
                      <AgentsInitBanner
                        onRunInit={handleRunAgentsInit}
                        onDismiss={handleDismissAgentsInit}
                      />
                    )}
                    {/* ChatInput for workspace creation. */}
                    <ChatInput
                      // Key by project + draft so project navigation and draft switches both remount
                      // creation-local state (including any in-flight creation send).
                      key={`${projectPath}:${pendingDraftId ?? "__pending__"}`}
                      variant="creation"
                      projectPath={projectPath}
                      projectName={projectName}
                      pendingSubProjectPath={pendingSubProjectPath}
                      pendingDraftId={pendingDraftId}
                      onReady={handleChatReady}
                      onWorkspaceCreated={onWorkspaceCreated}
                    />
                    {providersLoading ? (
                      <div className="flex items-center justify-center gap-2 py-1.5">
                        <Skeleton className="h-7 w-32" />
                      </div>
                    ) : (
                      hasProviders &&
                      providersConfig && (
                        <ConfiguredProvidersBar providersConfig={providersConfig} />
                      )
                    )}
                  </>
                )}
              </div>
            </div>

            {/* MCP servers: overview between creation and archived workspaces */}
            <div className="flex justify-center px-4 pb-4">
              <div className={cn("w-full", CREATION_COLUMN_MAX_WIDTH_CLASS)}>
                <ProjectMCPOverview projectPath={projectPath} />
              </div>
            </div>

            {/* Archived workspaces: separate section below centered area */}
            <ProjectArchivedWorkspaces
              key={projectPath}
              projectPath={projectPath}
              projectName={projectName}
            />
          </div>
        </div>
      </ThinkingProvider>
    </AgentProvider>
  );
};
