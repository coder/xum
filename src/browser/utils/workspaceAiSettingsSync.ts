import { normalizeModelPreference } from "@/browser/utils/messages/buildSendMessageOptions";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface WorkspaceAiSettingsSnapshot {
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Optional: legacy settings (and non-OpenAI workflows) omit it. */
  reasoningMode?: OpenAIReasoningMode;
}

export function getWorkspaceAiSettingsFromMetadata(
  metadata: FrontendWorkspaceMetadata | undefined,
  agentId: string | undefined
): {
  model: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  reasoningMode: OpenAIReasoningMode | undefined;
} {
  const settings =
    (agentId ? metadata?.aiSettingsByAgent?.[agentId] : undefined) ?? metadata?.aiSettings;
  return {
    model: settings?.model,
    thinkingLevel: settings?.thinkingLevel,
    reasoningMode: settings?.reasoningMode,
  };
}

export function resolveEffectiveComposerModel(
  preferredModel: unknown,
  metadata: FrontendWorkspaceMetadata | undefined,
  agentId: string | undefined,
  defaultModel: string
): string {
  const metadataModel = getWorkspaceAiSettingsFromMetadata(metadata, agentId).model;
  // Match ChatInput precedence so shortcuts and palette actions gate on the model users see.
  return normalizeModelPreference(preferredModel, metadataModel ?? defaultModel);
}

const pendingAiSettingsByWorkspace = new Map<string, WorkspaceAiSettingsSnapshot>();

function getPendingKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}:${agentId}`;
}

export function markPendingWorkspaceAiSettings(
  workspaceId: string,
  agentId: string,
  settings: WorkspaceAiSettingsSnapshot
): void {
  if (!workspaceId || !agentId) {
    return;
  }
  pendingAiSettingsByWorkspace.set(getPendingKey(workspaceId, agentId), settings);
}

export function clearPendingWorkspaceAiSettings(workspaceId: string, agentId: string): void {
  if (!workspaceId || !agentId) {
    return;
  }
  pendingAiSettingsByWorkspace.delete(getPendingKey(workspaceId, agentId));
}

export function shouldApplyWorkspaceAiSettingsFromBackend(
  workspaceId: string,
  agentId: string,
  incoming: WorkspaceAiSettingsSnapshot
): boolean {
  if (!workspaceId || !agentId) {
    return true;
  }

  const key = getPendingKey(workspaceId, agentId);
  const pending = pendingAiSettingsByWorkspace.get(key);
  if (!pending) {
    return true;
  }

  const matches =
    pending.model === incoming.model &&
    pending.thinkingLevel === incoming.thinkingLevel &&
    // Absent reasoningMode is semantically "standard" on both sides.
    (pending.reasoningMode ?? "standard") === (incoming.reasoningMode ?? "standard");
  if (matches) {
    pendingAiSettingsByWorkspace.delete(key);
    return true;
  }

  return false;
}

// Same pending-echo protection as AI settings, but for the workspace's active
// agent selection: a local mode switch must not be reverted by a stale
// metadata broadcast that raced the persistence write.
const pendingAgentIdByWorkspace = new Map<string, string>();

export function markPendingWorkspaceAgentId(workspaceId: string, agentId: string): void {
  if (!workspaceId || !agentId) {
    return;
  }
  pendingAgentIdByWorkspace.set(workspaceId, agentId);
}

export function clearPendingWorkspaceAgentId(workspaceId: string, agentId: string): void {
  // Clear only the matching entry so a failed write cannot wipe a newer
  // pending selection from a rapid follow-up switch.
  if (pendingAgentIdByWorkspace.get(workspaceId) === agentId) {
    pendingAgentIdByWorkspace.delete(workspaceId);
  }
}

export function shouldApplyWorkspaceAgentIdFromBackend(
  workspaceId: string,
  incomingAgentId: string
): boolean {
  const pending = pendingAgentIdByWorkspace.get(workspaceId);
  if (!pending) {
    return true;
  }
  if (pending === incomingAgentId) {
    pendingAgentIdByWorkspace.delete(workspaceId);
    return true;
  }
  return false;
}
