import { useEffect, useRef } from "react";
import { useAgent } from "@/browser/contexts/AgentContext";
import { recordWorkspaceModelChange } from "@/browser/utils/modelChange";
import { getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
import { normalizeAgentId } from "@/common/utils/agentIds";

export function WorkspaceModeAISync(props: { workspaceId: string }): null {
  const workspaceId = props.workspaceId;
  const { agentId, agents } = useAgent();

  // User request: this effect runs on mount and during background sync (defaults/config).
  // Only treat *real* agentId changes as explicit (origin "agent"); everything else is "sync"
  // so we don't show context-switch warnings on workspace entry.
  const prevAgentIdRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    const normalizedAgentId = normalizeAgentId(agentId, "exec");
    const previousAgentId = prevAgentIdRef.current;

    const isExplicitAgentSwitch =
      previousAgentId !== null &&
      prevWorkspaceIdRef.current === workspaceId &&
      previousAgentId !== normalizedAgentId;

    // Update refs for the next run (even if no model changes).
    prevAgentIdRef.current = normalizedAgentId;
    prevWorkspaceIdRef.current = workspaceId;

    const agentBaseById = new Map(agents.map((agent) => [agent.id, agent.base]));
    if (isExplicitAgentSwitch) {
      // Each agent resolves its own model, so the switch itself is the explicit model change.
      recordWorkspaceModelChange(
        workspaceId,
        getWorkspaceAiSelection(workspaceId, normalizedAgentId, agentBaseById).model,
        "agent",
        getWorkspaceAiSelection(workspaceId, previousAgentId, agentBaseById).model
      );
    }
  }, [agentId, agents, workspaceId]);

  return null;
}
