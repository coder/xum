import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  getAgentIdKey,
  getProjectScopeId,
  getDisableWorkspaceAgentsKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { sortAgentsStable } from "@/browser/utils/agents";
import { normalizeAgentId, resolveRemovedBuiltinAgentId } from "@/common/utils/agentIds";
import {
  clearPendingWorkspaceAgentId,
  markPendingWorkspaceAgentId,
} from "@/browser/utils/workspaceAiSettingsSync";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

export interface AgentContextValue {
  agentId: string;
  setAgentId: Dispatch<SetStateAction<string>>;
  /** The current agent's descriptor, or undefined if agents haven't loaded yet */
  currentAgent: AgentDefinitionDescriptor | undefined;
  agents: AgentDefinitionDescriptor[];
  loaded: boolean;
  loadFailed: boolean;
  /** Reload agent definitions from the backend */
  refresh: () => Promise<void>;
  /** True while a refresh is in progress */
  refreshing: boolean;
  /**
   * When true, agents are loaded from projectPath only (ignoring workspace worktree).
   * Useful for unbricking when iterating on agent files in a workspace.
   */
  disableWorkspaceAgents: boolean;
  setDisableWorkspaceAgents: Dispatch<SetStateAction<boolean>>;
  /** True when workspace metadata locks agent selection changes. */
  isAgentSelectionLocked?: boolean;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

type AgentProviderProps =
  | { value: AgentContextValue; children: ReactNode }
  | {
      workspaceId?: string;
      projectPath?: string;
      children: ReactNode;
    };

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
}

function coerceAgentId(value: unknown): string {
  return normalizeAgentId(value, WORKSPACE_DEFAULTS.agentId);
}

export function AgentProvider(props: AgentProviderProps) {
  if ("value" in props) {
    return <AgentContext.Provider value={props.value}>{props.children}</AgentContext.Provider>;
  }

  return <AgentProviderWithState {...props} />;
}

function AgentProviderWithState(props: {
  workspaceId?: string;
  projectPath?: string;
  children: ReactNode;
}) {
  const { api } = useAPI();
  const { workspaceMetadata } = useWorkspaceMetadata();
  const currentMeta = props.workspaceId ? workspaceMetadata.get(props.workspaceId) : undefined;

  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const isProjectScope = !props.workspaceId && Boolean(props.projectPath);

  const [globalDefaultAgentId] = usePersistedState<string>(
    getAgentIdKey(GLOBAL_SCOPE_ID),
    WORKSPACE_DEFAULTS.agentId,
    {
      listener: true,
    }
  );

  const [scopedAgentId, setAgentIdRaw] = usePersistedState<string | null>(
    getAgentIdKey(scopeId),
    isProjectScope ? null : WORKSPACE_DEFAULTS.agentId,
    {
      listener: true,
    }
  );
  const explicitScopedAgentId =
    typeof scopedAgentId === "string" && scopedAgentId.trim().length > 0 ? scopedAgentId : null;

  const [disableWorkspaceAgents, setDisableWorkspaceAgents] = usePersistedState<boolean>(
    getDisableWorkspaceAgentsKey(scopeId),
    false,
    { listener: true }
  );

  // The UI toggle for disableWorkspaceAgents was removed — clear persisted
  // true values so users who had it enabled aren't stranded with no way to
  // re-enable workspace agents.
  useEffect(() => {
    if (disableWorkspaceAgents) {
      setDisableWorkspaceAgents(false);
    }
  }, [disableWorkspaceAgents, setDisableWorkspaceAgents]);

  // Child/subagent workspaces keep the backend-assigned agent; their selection
  // is locked, so local changes must never be written back.
  const isCurrentAgentLocked = currentMeta?.parentWorkspaceId != null;

  const workspaceId = props.workspaceId;
  const setAgentId: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      // usePersistedState runs the updater synchronously, so `next` is
      // available right after the call.
      let next: string | null = null;
      let previous: string | null = null;
      setAgentIdRaw((prev) => {
        const explicitPrevAgentId =
          typeof prev === "string" && prev.trim().length > 0 ? prev : globalDefaultAgentId;
        previous = coerceAgentId(isProjectScope ? explicitPrevAgentId : prev);
        next = coerceAgentId(typeof value === "function" ? value(previous) : value);
        return next;
      });

      // Persist workspace mode changes so the selection is remembered
      // per-workspace across clients, not just in this client's localStorage.
      if (!api || !workspaceId || isCurrentAgentLocked || next == null || next === previous) {
        return;
      }
      const nextAgentId: string = next;
      const previousAgentId: string | null = previous;

      // Optimistic local update above; on persistence failure roll the local
      // selection back (unless it changed again meanwhile) so this client
      // cannot silently diverge from the backend-authoritative agent.
      const rollback = () => {
        clearPendingWorkspaceAgentId(workspaceId, nextAgentId);
        if (previousAgentId != null) {
          setAgentIdRaw((current) => (current === nextAgentId ? previousAgentId : current));
        }
      };

      markPendingWorkspaceAgentId(workspaceId, nextAgentId);
      api.workspace
        .updateAgentAISettings({
          workspaceId,
          agentId: nextAgentId,
          aiSettings: null,
          persistSelectedAgentId: true,
        })
        .then((result) => {
          if (result.success) {
            // A no-op write (backend already on this agent) emits no metadata
            // echo, so release the guard deterministically. For changed writes
            // the echo is ordered after any stale broadcast, so releasing on
            // the response cannot strand a stale value.
            clearPendingWorkspaceAgentId(workspaceId, nextAgentId);
            return;
          }
          rollback();
        })
        .catch(rollback);
    },
    [api, globalDefaultAgentId, isCurrentAgentLocked, isProjectScope, setAgentIdRaw, workspaceId]
  );

  const [agents, setAgents] = useState<AgentDefinitionDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [refreshing, setRefreshing] = useState(false);

  const fetchParamsRef = useRef({
    projectPath: props.projectPath,
    workspaceId: props.workspaceId,
    disableWorkspaceAgents,
  });

  const fetchAgents = useCallback(
    async (
      projectPath: string | undefined,
      workspaceId: string | undefined,
      workspaceAgentsDisabled: boolean
    ) => {
      fetchParamsRef.current = {
        projectPath,
        workspaceId,
        disableWorkspaceAgents: workspaceAgentsDisabled,
      };

      if (!api || (!projectPath && !workspaceId)) {
        if (isMountedRef.current) {
          setAgents([]);
          setLoaded(true);
          setLoadFailed(false);
        }
        return;
      }

      try {
        const result = await api.agents.list({
          projectPath,
          workspaceId,
          disableWorkspaceAgents: workspaceAgentsDisabled || undefined,
        });
        const current = fetchParamsRef.current;
        if (
          current.projectPath === projectPath &&
          current.workspaceId === workspaceId &&
          current.disableWorkspaceAgents === workspaceAgentsDisabled &&
          isMountedRef.current
        ) {
          setAgents(result);
          setLoadFailed(false);
          setLoaded(true);
        }
      } catch {
        const current = fetchParamsRef.current;
        if (
          current.projectPath === projectPath &&
          current.workspaceId === workspaceId &&
          current.disableWorkspaceAgents === workspaceAgentsDisabled &&
          isMountedRef.current
        ) {
          setAgents([]);
          setLoadFailed(true);
          setLoaded(true);
        }
      }
    },
    [api]
  );

  useEffect(() => {
    setAgents([]);
    setLoaded(false);
    setLoadFailed(false);
    void fetchAgents(props.projectPath, props.workspaceId, disableWorkspaceAgents);
  }, [fetchAgents, props.projectPath, props.workspaceId, disableWorkspaceAgents]);

  const refresh = useCallback(async () => {
    if (!props.projectPath && !props.workspaceId) return;
    if (!isMountedRef.current) return;

    setRefreshing(true);
    try {
      await fetchAgents(props.projectPath, props.workspaceId, disableWorkspaceAgents);
    } finally {
      if (isMountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [fetchAgents, props.projectPath, props.workspaceId, disableWorkspaceAgents]);

  // Project-scoped providers inherit the global default agent until a
  // project-scoped preference is explicitly set.
  // For locked workspaces, use the backend-assigned agent — persisted localStorage
  // may contain a stale selection from before locking, and the picker is disabled
  // so there's no in-UI recovery path.
  const normalizedAgentId =
    isCurrentAgentLocked && currentMeta?.agentId
      ? currentMeta.agentId
      : coerceAgentId(
          isProjectScope ? (explicitScopedAgentId ?? globalDefaultAgentId) : scopedAgentId
        );
  const canResolveRemovedBuiltinAgentId = loaded && !loadFailed;
  const effectiveAgentId = canResolveRemovedBuiltinAgentId
    ? resolveRemovedBuiltinAgentId(
        normalizedAgentId,
        agents.map((agent) => agent.id),
        WORKSPACE_DEFAULTS.agentId
      )
    : normalizedAgentId;
  const currentAgent = loaded ? agents.find((a) => a.id === effectiveAgentId) : undefined;

  useEffect(() => {
    if (
      !canResolveRemovedBuiltinAgentId ||
      effectiveAgentId === normalizedAgentId ||
      (isProjectScope && explicitScopedAgentId == null)
    ) {
      return;
    }

    setAgentIdRaw(effectiveAgentId);
  }, [
    canResolveRemovedBuiltinAgentId,
    effectiveAgentId,
    isProjectScope,
    normalizedAgentId,
    explicitScopedAgentId,
    setAgentIdRaw,
  ]);

  const selectableAgents = useMemo(
    () => sortAgentsStable(agents.filter((a) => a.uiSelectable)),
    [agents]
  );

  const cycleToNextAgent = useCallback(() => {
    if (isCurrentAgentLocked) {
      return;
    }

    const activeAgentId = effectiveAgentId;
    if (selectableAgents.length === 0) return;

    if (selectableAgents.length < 2) return;

    const currentIndex = selectableAgents.findIndex((a) => a.id === activeAgentId);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % selectableAgents.length;
    const nextAgent = selectableAgents[nextIndex];
    if (nextAgent) {
      setAgentId(nextAgent.id);
    }
  }, [effectiveAgentId, isCurrentAgentLocked, selectableAgents, setAgentId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_AGENT)) {
        e.preventDefault();
        if (!isCurrentAgentLocked) {
          window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));
        }
        return;
      }

      if (matchesKeybind(e, KEYBINDS.CYCLE_AGENT)) {
        e.preventDefault();
        cycleToNextAgent();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cycleToNextAgent, isCurrentAgentLocked]);

  useEffect(() => {
    const handleRefreshRequested = () => {
      void refresh();
    };

    window.addEventListener(CUSTOM_EVENTS.AGENTS_REFRESH_REQUESTED, handleRefreshRequested);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.AGENTS_REFRESH_REQUESTED, handleRefreshRequested);
  }, [refresh]);

  const agentContextValue = useMemo(
    () => ({
      agentId: effectiveAgentId,
      setAgentId,
      currentAgent,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
      disableWorkspaceAgents,
      setDisableWorkspaceAgents,
      isAgentSelectionLocked: isCurrentAgentLocked,
    }),
    [
      effectiveAgentId,
      setAgentId,
      currentAgent,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
      disableWorkspaceAgents,
      setDisableWorkspaceAgents,
      isCurrentAgentLocked,
    ]
  );

  return <AgentContext.Provider value={agentContextValue}>{props.children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error("useAgent must be used within an AgentProvider");
  }
  return ctx;
}
