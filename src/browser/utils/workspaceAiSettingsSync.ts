import { normalizeModelPreference } from "@/browser/utils/messages/buildSendMessageOptions";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  getAgentIdKey,
  getModelKey,
  getReasoningModeKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { normalizeAgentId } from "@/common/utils/agentIds";
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

/**
 * Restore local selection state after the backend issued a typed rejection for
 * an optimistic agent switch (e.g. the budgeted-goal pricing gate).
 *
 * Only typed rejections revert. Transport failures keep the optimistic
 * selection: the next send re-persists it (maybePersistAISettingsFromOptions),
 * whereas a typed rejection cannot self-heal because the same gate refuses
 * subsequent sends before they re-persist settings.
 *
 * The restore target prefers the backend's authoritative agent id over the
 * locally captured pre-switch agent: with chained optimistic switches (A→B→C
 * where both writes are rejected), the last switch's captured "previous" is
 * the also-rejected B while the backend still stores A. Captured pre-switch
 * settings only apply when the restore target IS the captured agent; a
 * different target's agent-id write triggers the normal explicit-switch
 * resolution (WorkspaceModeAISync), which hydrates that agent's own bucket.
 *
 * Only state the rejected switch itself wrote is undone: newer user changes
 * (a different agent, or edited model/thinking/reasoning) always win.
 */
export function revertRejectedAgentSwitch(args: {
  workspaceId: string;
  rejectedAgentId: string;
  applied: { model: string; thinkingLevel: ThinkingLevel; reasoningMode: OpenAIReasoningMode };
  previous: {
    agentId: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    reasoningMode: OpenAIReasoningMode;
  };
  /** Authoritative backend agent id at rejection time, when known. */
  backendAgentId?: string | null;
}): void {
  const agentKey = getAgentIdKey(args.workspaceId);
  const rawCurrent = readPersistedState<string | null>(agentKey, null);
  if (rawCurrent == null) {
    return;
  }
  const currentAgentId = normalizeAgentId(rawCurrent);
  if (currentAgentId !== normalizeAgentId(args.rejectedAgentId)) {
    return;
  }

  const previousAgentId = normalizeAgentId(args.previous.agentId);
  const restoreAgentId =
    typeof args.backendAgentId === "string" && args.backendAgentId.trim().length > 0
      ? normalizeAgentId(args.backendAgentId)
      : previousAgentId;

  // Restore settings before the agent id so explicit-switch resolution runs
  // against pre-switch values instead of the rejected ones.
  if (restoreAgentId === previousAgentId) {
    if (
      readPersistedState<string | null>(getModelKey(args.workspaceId), null) === args.applied.model
    ) {
      setWorkspaceModelWithOrigin(args.workspaceId, args.previous.model, "sync");
    }
    if (
      readPersistedState<ThinkingLevel | null>(getThinkingLevelKey(args.workspaceId), null) ===
      args.applied.thinkingLevel
    ) {
      updatePersistedState(getThinkingLevelKey(args.workspaceId), args.previous.thinkingLevel);
    }
    if (
      readPersistedState<OpenAIReasoningMode | null>(
        getReasoningModeKey(args.workspaceId),
        null
      ) === args.applied.reasoningMode
    ) {
      updatePersistedState(getReasoningModeKey(args.workspaceId), args.previous.reasoningMode);
    }
  }

  if (restoreAgentId !== currentAgentId) {
    updatePersistedState(agentKey, restoreAgentId);
  }
}
