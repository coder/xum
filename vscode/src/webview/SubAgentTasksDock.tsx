import { useRef } from "react";

import {
  SubAgentTasksContent,
  collectDescendantAgents,
  mergeActiveWorkflowGroups,
  type DescendantActivityHints,
  type ObservedWorkflowRunInfo,
} from "xum/browser/components/SubAgentTasksDecoration/SubAgentTasksDecoration";
import { usePersistedState } from "xum/browser/hooks/usePersistedState";
import { getSubAgentTasksExpandedKey } from "xum/common/constants/storage";
import type { UiWorkspace, UiWorkspaceActivity } from "./protocol";

/**
 * The desktop sub-agent tasks strip in the webview dock (#5109), fed by the host's live workspace
 * list and the selected workspace's activity map instead of WorkspaceContext/WorkspaceStore.
 */
export function SubAgentTasksDock(props: {
  workspaces: readonly UiWorkspace[];
  workspaceId: string;
  activity: Readonly<Record<string, UiWorkspaceActivity>>;
  onSelect: (workspaceId: string) => void;
}) {
  const [expanded, setExpanded] = usePersistedState(
    getSubAgentTasksExpandedKey(props.workspaceId),
    false
  );
  const observedRef = useRef(new Map<string, ObservedWorkflowRunInfo>());
  const { subAgents, workflowGroups: liveGroups, descendantWorkspaceIds } =
    collectDescendantAgents(
      props.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.workspaceName,
        parentWorkspaceId: workspace.ai?.parentWorkspaceId,
        unarchivedAt: workspace.unarchivedAt,
        ...workspace.task,
      })),
      props.workspaceId
    );
  const ownerIds = [props.workspaceId, ...descendantWorkspaceIds];
  const activeRunIds = new Set(
    ownerIds.flatMap((id) => props.activity[id]?.activeWorkflowRunIds ?? [])
  );
  // Nested runs never appear in activity, and their gap discovery (workflows.*) is not bridged:
  // once their workers are gone they drop out. Their enclosing top-level run still shows from
  // activity, so the strip never reads as idle while a workflow runs.
  const workflowGroups = mergeActiveWorkflowGroups(
    liveGroups,
    [...activeRunIds],
    observedRef.current,
    () => true
  );
  const descendantActivity = new Map<string, DescendantActivityHints>(
    descendantWorkspaceIds.map((id) => {
      const activity = props.activity[id];
      const monitors = activity?.activeBashMonitorCount ?? 0;
      return [
        id,
        {
          hasActiveBashMonitor: monitors > 0,
          // The desktop sidebar's "working" signal, from what activity carries.
          isLiveActive:
            activity != null &&
            (activity.streaming || activity.activeWorkflowRunIds.length > 0 || monitors > 0),
        },
      ];
    })
  );
  return (
    <SubAgentTasksContent
      subAgents={subAgents}
      workflowGroups={workflowGroups}
      descendantActivity={descendantActivity}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      onNavigate={props.onSelect}
    />
  );
}
