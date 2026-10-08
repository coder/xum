import { useEffect, useRef } from "react";
import { useAgent } from "@/browser/contexts/AgentContext";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useAgentAiDefaults } from "@/browser/stores/AppConfigStore";
import {
  getAutoRoutingChoiceByAgentKey,
  getReasoningModeKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { applyAutoRoutingOutcome, recordWorkspaceModelChange } from "@/browser/utils/modelChange";
import {
  resolveAutoRoutingForAgent,
  resolveWorkspaceAiSettingsForAgent,
  type AutoRoutingChoiceByAgent,
  type WorkspaceAISettingsCache,
} from "@/browser/utils/workspaceModeAi";
import { getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { OpenAIReasoningMode } from "@/common/types/thinking";
import { normalizeAgentId } from "@/common/utils/agentIds";

export function WorkspaceModeAISync(props: { workspaceId: string }): null {
  const workspaceId = props.workspaceId;
  const { agentId, agents } = useAgent();
  const autoRoutingEnabled = useExperimentValue(EXPERIMENT_IDS.AUTO_MODEL_ROUTING);

  const agentAiDefaults = useAgentAiDefaults();

  // User request: this effect runs on mount and during background sync (defaults/config).
  // Only treat *real* agentId changes as explicit (origin "agent"); everything else is "sync"
  // so we don't show context-switch warnings on workspace entry.
  const prevAgentIdRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    const fallbackModel = getDefaultModel();

    const normalizedAgentId = normalizeAgentId(agentId, "exec");
    const previousAgentId = prevAgentIdRef.current;

    const isExplicitAgentSwitch =
      previousAgentId !== null &&
      prevWorkspaceIdRef.current === workspaceId &&
      previousAgentId !== normalizedAgentId;

    // Update refs for the next run (even if no model changes).
    prevAgentIdRef.current = normalizedAgentId;
    prevWorkspaceIdRef.current = workspaceId;

    // Read at call time rather than subscribing: this cache only feeds explicit agent
    // switches, yet every model/thinking/pro-mode change rewrites it, so a subscription
    // would re-run this effect and re-apply the mode default over the user's own pick.
    const workspaceByAgent = readPersistedState<WorkspaceAISettingsCache>(
      getWorkspaceAISettingsByAgentKey(workspaceId),
      {}
    );

    const reasoningKey = getReasoningModeKey(workspaceId);
    const existingReasoning = readPersistedState<OpenAIReasoningMode>(reasoningKey, "standard");

    const agentBaseById = new Map(agents.map((agent) => [agent.id, agent.base]));
    const selection = getWorkspaceAiSelection(workspaceId, normalizedAgentId, agentBaseById);
    if (isExplicitAgentSwitch) {
      // Each agent resolves its own model, so the switch itself is the explicit model change.
      recordWorkspaceModelChange(
        workspaceId,
        selection.model,
        "agent",
        getWorkspaceAiSelection(workspaceId, previousAgentId, agentBaseById).model
      );
    }

    // The resolver owns model and thinking; only reasoning comes from here.
    const { resolvedReasoningMode } = resolveWorkspaceAiSettingsForAgent({
      agentId: normalizedAgentId,
      agentAiDefaults,
      // Keep deterministic handoff behavior: background sync should trust the
      // currently active workspace settings, but explicit mode switches should
      // restore the selected agent's per-workspace override (if any).
      workspaceByAgent,
      useWorkspaceByAgentFallback: isExplicitAgentSwitch,
      fallbackModel,
      existingModel: selection.model,
      existingThinking: selection.thinkingLevel,
      existingReasoningMode: existingReasoning,
      agentBaseById,
    });
    const autoRoutingOutcome = resolveAutoRoutingForAgent({
      agentId: normalizedAgentId,
      agentAiDefaults,
      agentBaseById,
      explicitSwitch: isExplicitAgentSwitch,
      experimentEnabled: autoRoutingEnabled,
      routingChoices: readPersistedState<AutoRoutingChoiceByAgent>(
        getAutoRoutingChoiceByAgentKey(workspaceId),
        {}
      ),
      workspaceByAgent,
    });

    if (existingReasoning !== resolvedReasoningMode) {
      updatePersistedState(reasoningKey, resolvedReasoningMode);
    }

    applyAutoRoutingOutcome(workspaceId, autoRoutingOutcome);
  }, [agentAiDefaults, agentId, agents, autoRoutingEnabled, workspaceId]);

  return null;
}
