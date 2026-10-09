import type { ReactNode } from "react";
import React, { createContext, useCallback, useContext, useEffect } from "react";
import {
  THINKING_LEVEL_OFF,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { getProjectScopeId, GLOBAL_SCOPE_ID } from "@/common/constants/storage";
import { useDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import { enforceThinkingPolicy, getAvailableThinkingLevels } from "@/common/utils/thinking/policy";
import { useMinThinkingLevels } from "@/browser/hooks/useMinThinkingLevels";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useAPI } from "@/browser/contexts/API";
import { requestActiveTurnThinkingLevel } from "@/browser/utils/activeTurnThinking";
import {
  getWorkspaceAiSelection,
  useWorkspaceAiSelection,
} from "@/browser/utils/workspaceAiSettingsSync";
import { useOptionalAgent } from "@/browser/contexts/AgentContext";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { markAiSelectionIntent } from "@/browser/utils/aiSelectionIntent";
import { setAutoRoutingChoice } from "@/browser/utils/modelChange";
import { useScopedAiDefault, writeScopedAiDefault } from "@/browser/utils/scopedAiDefaults";

interface ThinkingContextType {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  /** OpenAI pro reasoning-mode toggle; sibling of thinkingLevel (orthogonal on the wire). */
  reasoningMode: OpenAIReasoningMode;
  setReasoningMode: (mode: OpenAIReasoningMode) => void;
}

const ThinkingContext = createContext<ThinkingContextType | undefined>(undefined);

interface ThinkingProviderProps {
  workspaceId?: string; // Workspace-scoped storage (highest priority)
  projectPath?: string; // Project-scoped storage (fallback if no workspaceId)
  children: ReactNode;
}

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const { getMinimum } = useMinThinkingLevels();
  // Resolve mapped aliases so keybind stepping walks the target model's ladder.
  const { config: providersConfig } = useProvidersConfig();
  const workspaceId = props.workspaceId;
  const defaultModel = useDefaultModel();
  const scopeId = getScopeId(workspaceId, props.projectPath);
  // Hooks run unconditionally; a workspace mount reads the resolver instead of scope defaults.
  const defaultsScopeId = workspaceId != null ? GLOBAL_SCOPE_ID : scopeId;
  const agentContext = useOptionalAgent();
  const selection = useWorkspaceAiSelection(
    workspaceId ?? "",
    agentContext?.agentId,
    agentContext && new Map(agentContext.agents.map((agent) => [agent.id, agent.base]))
  );
  const scopedModel = useScopedAiDefault(defaultsScopeId, "model");
  const scopedThinkingLevel = useScopedAiDefault(defaultsScopeId, "thinkingLevel");

  // normalizeSelectedModel (not normalizeToCanonical): explicit gateway identities must
  // survive; thinking policy lookups resolve gateway-scoped strings themselves.
  const model =
    workspaceId != null ? selection.model : normalizeSelectedModel(scopedModel ?? defaultModel);
  const thinkingLevel =
    workspaceId != null ? selection.thinkingLevel : (scopedThinkingLevel ?? THINKING_LEVEL_OFF);
  // useWorkspaceAiSelection re-renders this provider when a creation scope's pick changes.
  const reasoningMode =
    workspaceId != null ? selection.reasoningMode : getWorkspaceAiSelection(scopeId).reasoningMode;

  // A workspace pick stays in memory until a user message sends it.
  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      if (workspaceId != null) {
        // Deliberate pick: pins thinking on a sub-agent once a message sends it.
        markAiSelectionIntent(workspaceId, "thinkingLevel", level);
      } else {
        writeScopedAiDefault(scopeId, "thinkingLevel", level);
      }
      // A concrete pick (selector row or keybind step) leaves thinking Auto,
      // mirroring setWorkspaceModelWithOrigin for the model dimension.
      setAutoRoutingChoice(scopeId, "thinkingLevel", false);
      // Mid-turn change: also request the new level for the active turn's next model step.
      if (workspaceId != null) {
        requestActiveTurnThinkingLevel(api, workspaceId, level);
      }
    },
    [api, scopeId, workspaceId]
  );

  const setReasoningMode = (mode: OpenAIReasoningMode) => {
    markAiSelectionIntent(scopeId, "reasoningMode", mode);
  };

  // Global keybinds for adjusting the thinking level.
  // Implemented at the ThinkingProvider level so they work in both the workspace view
  // and the "New Workspace" creation screen (which doesn't mount AIView).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isIncrease = matchesKeybind(e, KEYBINDS.INCREASE_THINKING);
      const isDecrease = matchesKeybind(e, KEYBINDS.DECREASE_THINKING);
      // TOGGLE_THINKING is deprecated but still honored for muscle memory.
      const isCycle = matchesKeybind(e, KEYBINDS.TOGGLE_THINKING);
      if (!isIncrease && !isDecrease && !isCycle) {
        return;
      }

      e.preventDefault();

      // Step only within levels at or above the model's minimum floor.
      const minimum = getMinimum(model);
      const allowed = getAvailableThinkingLevels(model, minimum, providersConfig);
      if (allowed.length <= 1) {
        return;
      }

      const effectiveThinkingLevel = enforceThinkingPolicy(
        model,
        thinkingLevel,
        minimum,
        providersConfig
      );
      const currentIndex = allowed.indexOf(effectiveThinkingLevel);

      // Increase/decrease are directional: clamp at the ends instead of wrapping,
      // since stepping past "max"/"off" and looping around is surprising. The
      // legacy cycle keybind keeps its wrap-around behavior.
      const nextIndex = isCycle
        ? (currentIndex + 1) % allowed.length
        : Math.min(allowed.length - 1, Math.max(0, currentIndex + (isIncrease ? 1 : -1)));

      if (nextIndex !== currentIndex) {
        setThinkingLevel(allowed[nextIndex]);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [getMinimum, model, providersConfig, thinkingLevel, setThinkingLevel]);

  return (
    <ThinkingContext.Provider
      value={{ thinkingLevel, setThinkingLevel, reasoningMode, setReasoningMode }}
    >
      {props.children}
    </ThinkingContext.Provider>
  );
};

export const useThinking = () => {
  const context = useContext(ThinkingContext);
  if (!context) {
    throw new Error("useThinking must be used within a ThinkingProvider");
  }
  return context;
};
