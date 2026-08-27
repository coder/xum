import { normalizeModelPreference } from "@/browser/utils/messages/buildSendMessageOptions";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  getAgentIdKey,
  getModelKey,
  getReasoningModeKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { normalizeAgentId, resolvePersistedAgentId } from "@/common/utils/agentIds";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { APIClient } from "@/browser/contexts/API";

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

const workspaceAiSettingsWriteChains = new Map<string, Promise<unknown>>();

interface WorkspaceSendApi {
  workspace: Pick<APIClient["workspace"], "sendMessage">;
}

interface WorkspaceAiSettingsUpdateApi {
  workspace: Pick<APIClient["workspace"], "updateAgentAISettings">;
}
type SendMessageInput = Parameters<APIClient["workspace"]["sendMessage"]>[0];
type UpdateAgentAISettingsInput = Parameters<APIClient["workspace"]["updateAgentAISettings"]>[0];

/** Keep browser writes that can persist workspace AI state in initiation order. */
function serializeWorkspaceAiSettingsWrite<T>(
  workspaceId: string,
  write: () => Promise<T>
): Promise<T> {
  const previous = workspaceAiSettingsWriteChains.get(workspaceId) ?? Promise.resolve();
  const result = previous.then(write, write);
  workspaceAiSettingsWriteChains.set(workspaceId, result);

  return result.finally(() => {
    if (workspaceAiSettingsWriteChains.get(workspaceId) === result) {
      workspaceAiSettingsWriteChains.delete(workspaceId);
    }
  });
}

export function updateWorkspaceAgentAISettings(
  api: WorkspaceAiSettingsUpdateApi,
  input: UpdateAgentAISettingsInput
): ReturnType<APIClient["workspace"]["updateAgentAISettings"]> {
  return serializeWorkspaceAiSettingsWrite(input.workspaceId, () =>
    api.workspace.updateAgentAISettings(input)
  );
}

export function sendWorkspaceMessage(
  api: WorkspaceSendApi,
  input: SendMessageInput
): ReturnType<APIClient["workspace"]["sendMessage"]> {
  const send = () => api.workspace.sendMessage(input);
  return input.options.skipAiSettingsPersistence === true
    ? send()
    : serializeWorkspaceAiSettingsWrite(input.workspaceId, send);
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

// Same pending-echo protection as AI settings, but retain the latest selection
// until every overlapping persistence write settles. A matching latest echo
// cannot consume the guard while an older write can still broadcast later.
interface PendingAgentIdState {
  latestAgentId: string;
  pendingCount: number;
  countsByAgentId: Map<string, number>;
}

const pendingAgentIdByWorkspace = new Map<string, PendingAgentIdState>();

export function markPendingWorkspaceAgentId(workspaceId: string, agentId: string): void {
  if (!workspaceId || !agentId) {
    return;
  }
  const pending = pendingAgentIdByWorkspace.get(workspaceId) ?? {
    latestAgentId: agentId,
    pendingCount: 0,
    countsByAgentId: new Map<string, number>(),
  };
  pending.latestAgentId = agentId;
  pending.pendingCount += 1;
  pending.countsByAgentId.set(agentId, (pending.countsByAgentId.get(agentId) ?? 0) + 1);
  pendingAgentIdByWorkspace.set(workspaceId, pending);
}

export function clearPendingWorkspaceAgentId(workspaceId: string, agentId: string): void {
  const pending = pendingAgentIdByWorkspace.get(workspaceId);
  const count = pending?.countsByAgentId.get(agentId) ?? 0;
  if (!pending || count === 0) {
    return;
  }

  if (count === 1) {
    pending.countsByAgentId.delete(agentId);
  } else {
    pending.countsByAgentId.set(agentId, count - 1);
  }
  pending.pendingCount -= 1;
  if (pending.pendingCount === 0) {
    pendingAgentIdByWorkspace.delete(workspaceId);
  }
}

export function shouldApplyWorkspaceAgentIdFromBackend(
  workspaceId: string,
  incomingAgentId: string
): boolean {
  const pending = pendingAgentIdByWorkspace.get(workspaceId);
  return !pending || pending.latestAgentId === incomingAgentId;
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
 * The restore target prefers the backend's authoritative agent id (from
 * fresh workspace metadata read at settle time, resolved through the legacy
 * agentType compat path) over the locally captured pre-switch agent: with
 * chained or overlapping optimistic switches, a captured "previous" can
 * itself be a rejected or superseded agent while the backend stores another.
 * Settings restore from the restore target's own metadata bucket (or the
 * legacy shared blob, matching backend dispatch fallback), else from the
 * captured pre-switch values when the target IS the captured agent.
 *
 * A newer agent selection always wins. When identity reverts, the shared composer
 * must atomically hydrate the restore target; edits made while the rejected agent
 * was active remain in that agent's cache instead of leaking across identities.
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
  /** Fresh workspace metadata at settle time (authoritative backend state). */
  backendMetadata?: FrontendWorkspaceMetadata | null;
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
  const backendResolved = resolvePersistedAgentId(args.backendMetadata ?? undefined, "");
  const restoreAgentId =
    backendResolved.length > 0 ? normalizeAgentId(backendResolved) : previousAgentId;

  // Authoritative settings for the restore target: its modern bucket, else the
  // legacy shared blob (the same fallback backend dispatch resolution uses),
  // else the captured pre-switch values when the target IS the captured agent.
  // This runs even when no agent-id write is needed: the backend may already
  // store the rejected agent id while the rejected SETTINGS came from a
  // divergent carried-over selection.
  const backendBucket =
    args.backendMetadata?.aiSettingsByAgent?.[restoreAgentId] ?? args.backendMetadata?.aiSettings;
  const restore = backendBucket
    ? {
        model: backendBucket.model,
        thinkingLevel: backendBucket.thinkingLevel,
        reasoningMode: backendBucket.reasoningMode ?? ("standard" as const),
      }
    : restoreAgentId === previousAgentId
      ? {
          model: args.previous.model,
          thinkingLevel: args.previous.thinkingLevel,
          reasoningMode: args.previous.reasoningMode,
        }
      : null;

  const isRestoringAnotherAgent = restoreAgentId !== currentAgentId;

  // Restore settings before the agent id so explicit-switch resolution runs
  // against restored values instead of the rejected ones. A cross-agent revert
  // is atomic: every shared composer key must belong to the restored identity.
  // Same-agent repair keeps the per-key guards so newer edits still win.
  if (restore) {
    if (
      isRestoringAnotherAgent ||
      readPersistedState<string | null>(getModelKey(args.workspaceId), null) === args.applied.model
    ) {
      setWorkspaceModelWithOrigin(args.workspaceId, restore.model, "sync");
    }
    if (
      isRestoringAnotherAgent ||
      readPersistedState<ThinkingLevel | null>(getThinkingLevelKey(args.workspaceId), null) ===
        args.applied.thinkingLevel
    ) {
      updatePersistedState(getThinkingLevelKey(args.workspaceId), restore.thinkingLevel);
    }
    if (
      isRestoringAnotherAgent ||
      readPersistedState<OpenAIReasoningMode | null>(
        getReasoningModeKey(args.workspaceId),
        null
      ) === args.applied.reasoningMode
    ) {
      updatePersistedState(getReasoningModeKey(args.workspaceId), restore.reasoningMode);
    }
  }

  if (isRestoringAnotherAgent) {
    updatePersistedState(agentKey, restoreAgentId);
  }
}
