import { normalizeToCanonical } from "@/common/utils/ai/models";
import { useWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";

/** The workspace's effective model for its selected agent, in canonical form. */
export function useWorkspaceFallbackModel(workspaceId: string): string {
  return normalizeToCanonical(useWorkspaceAiSelection(workspaceId).model);
}
