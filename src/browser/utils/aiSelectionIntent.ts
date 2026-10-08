/**
 * Renderer-local record of deliberate AI picks (model / thinking / reasoning) made in a
 * workspace's composer before the next send. Picker changes stay local until a message
 * is sent, and every send rewrites the per-agent settings bucket, so a sub-agent cannot
 * tell a deliberate pick from a reseeded or unchanged value by comparing values. The
 * send attaches explicit per-field intent instead; the backend pins those fields on
 * agent-task workspaces so a later reawakening does not override the user's choice.
 *
 * Intentionally in memory only (per window) and scoped by workspace + agent: a Plan
 * pick never applies to Exec after a plan→exec handoff. Each pick gets a fresh token so
 * a re-pick made while an earlier send is outstanding survives that send's consume.
 * Pending picks are also the composer's unsent values (see resolveWorkspaceAiSelection),
 * next to the latest workspace AI metadata, so a reload drops an unsent pick. The agent pick
 * follows the same token lifecycle as the field picks.
 */
import type { AiSelectionIntent } from "@/common/types/agentAiSettings";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import { normalizeAgentId, resolvePersistedAgentId } from "@/common/utils/agentIds";
import assert from "@/common/utils/assert";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getUserPreferences } from "@/browser/stores/AppConfigStore";

export type AiSelectionField = keyof AiSelectionIntent;
export type AiSelectionTokens = Partial<Record<AiSelectionField | "agentId", number>>;

interface PendingSelection {
  value: string;
  token: number;
  /** A successful send carried it: it ends once the agent's saved bucket holds it. */
  sent?: true;
}

export type WorkspaceAiMetadata = Pick<
  FrontendWorkspaceMetadata,
  "aiSettings" | "aiSettingsByAgent"
> &
  Partial<
    Pick<FrontendWorkspaceMetadata, "projectPath" | "agentId" | "agentType" | "parentWorkspaceId">
  >;

const pendingByScope = new Map<string, Partial<Record<AiSelectionField, PendingSelection>>>();
const pendingAgentByWorkspace = new Map<string, PendingSelection>();
const metadataByWorkspace = new Map<string, WorkspaceAiMetadata>();
const agentBasesByScope = new Map<string, ReadonlyMap<string, string | undefined>>();
const listeners = new Set<() => void>();
let nextToken = 1;
let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribeAiSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAiSelectionVersion(): number {
  return version;
}

export function setWorkspaceAiMetadata(workspaceId: string, source: WorkspaceAiMetadata): void {
  const metadata: WorkspaceAiMetadata = {
    projectPath: source.projectPath,
    agentId: source.agentId,
    agentType: source.agentType,
    parentWorkspaceId: source.parentWorkspaceId,
    aiSettings: source.aiSettings,
    aiSettingsByAgent: source.aiSettingsByAgent,
  };
  const previous = metadataByWorkspace.get(workspaceId);
  if (JSON.stringify(previous) === JSON.stringify(metadata)) return;
  metadataByWorkspace.set(workspaceId, metadata);
  const agentPick = pendingAgentByWorkspace.get(workspaceId);
  if (agentPick?.sent === true && agentPick.value === resolvePersistedAgentId(metadata, "")) {
    pendingAgentByWorkspace.delete(workspaceId);
  }
  for (const agentId of Object.keys(metadata.aiSettingsByAgent ?? {})) {
    const key = scopeKey(workspaceId, agentId);
    const pending = pendingByScope.get(key);
    if (pending == null) continue;
    for (const field of Object.keys(pending) as AiSelectionField[]) {
      const selection = pending[field];
      // An unsent pick stays the composer's value even when it equals the saved one.
      if (selection?.sent === true && isSavedPick(workspaceId, agentId, field, selection.value)) {
        delete pending[field];
      }
    }
    if (Object.keys(pending).length === 0) pendingByScope.delete(key);
  }
  notify();
}

export function getWorkspaceAiMetadata(workspaceId: string): WorkspaceAiMetadata | undefined {
  return metadataByWorkspace.get(workspaceId);
}

/**
 * Agent id -> base id of the agents loaded for a workspace or creation scope, so readers outside
 * the agent context still resolve a custom agent's inherited defaults.
 */
export function setAgentBases(
  scopeId: string,
  agents: ReadonlyArray<{ id: string; base?: string }>
): void {
  const bases = new Map(agents.map((agent) => [agent.id, agent.base]));
  const previous = agentBasesByScope.get(scopeId);
  if (previous != null && JSON.stringify([...previous]) === JSON.stringify([...bases])) return;
  agentBasesByScope.set(scopeId, bases);
  notify();
}

export function getAgentBases(
  scopeId: string
): ReadonlyMap<string, string | undefined> | undefined {
  return agentBasesByScope.get(scopeId);
}

function normalizeAgent(agentId: string): string {
  return agentId.trim().toLowerCase() || WORKSPACE_DEFAULTS.agentId;
}

/** The workspace's agent without an unsent pick: metadata, then project and global defaults. */
function getSavedWorkspaceAgentId(workspaceId: string): string {
  const metadata = metadataByWorkspace.get(workspaceId);
  const ai = getUserPreferences().ai;
  const projectAgentId =
    metadata?.projectPath != null
      ? ai?.projectDefaults?.[metadata.projectPath]?.agentId
      : undefined;
  return (
    resolvePersistedAgentId(metadata, "") ||
    normalizeAgentId(projectAgentId, "") ||
    normalizeAgentId(ai?.globalDefaults?.agentId, WORKSPACE_DEFAULTS.agentId)
  );
}

export function getWorkspaceAgentId(workspaceId: string): string {
  return pendingAgentByWorkspace.get(workspaceId)?.value ?? getSavedWorkspaceAgentId(workspaceId);
}

/**
 * Records an unsent agent pick. Picking the saved agent still records one: while a send of
 * another agent is in flight, the saved agent is stale.
 */
export function setWorkspaceAgentPick(workspaceId: string, agentId: string): void {
  const value = normalizeAgentId(agentId, WORKSPACE_DEFAULTS.agentId);
  pendingAgentByWorkspace.set(workspaceId, { value, token: nextToken++ });
  notify();
}

/** The workspace's saved settings for an agent; a legacy workspace has only `aiSettings`. */
export function getSavedAiSettings(
  workspaceId: string,
  agentId: string
): WorkspaceAiMetadata["aiSettings"] {
  const metadata = metadataByWorkspace.get(workspaceId);
  return metadata?.aiSettingsByAgent?.[normalizeAgent(agentId)] ?? metadata?.aiSettings;
}

function isSavedPick(
  workspaceId: string,
  agentId: string,
  field: AiSelectionField,
  value: string
): boolean {
  const saved = metadataByWorkspace.get(workspaceId)?.aiSettingsByAgent?.[normalizeAgent(agentId)];
  return saved != null && comparable(field, saved[field]) === value;
}

function scopeKey(workspaceId: string, agentId: string): string {
  assert(workspaceId.length > 0, "aiSelectionIntent: workspaceId must be non-empty");
  return `${workspaceId}\u0000${normalizeAgent(agentId)}`;
}

/** Comparable form of a field value; models compare gateway-preserving normalized. */
function comparable(field: AiSelectionField, value: string | undefined): string | undefined {
  if (field === "model") {
    return value != null && value.trim().length > 0 ? normalizeSelectedModel(value) : undefined;
  }
  // An absent reasoning mode is standard (see WorkspaceAISettingsSchema).
  if (field === "reasoningMode") return value ?? "standard";
  return value;
}

/** Records a deliberate user pick for the workspace's currently active agent. */
export function markAiSelectionIntent(
  workspaceId: string,
  field: AiSelectionField,
  value: string
): void {
  const key = scopeKey(workspaceId, getWorkspaceAgentId(workspaceId));
  const normalized = comparable(field, value);
  assert(normalized != null, "markAiSelectionIntent: value must be non-empty");
  const token = nextToken++;
  pendingByScope.set(key, { ...pendingByScope.get(key), [field]: { value: normalized, token } });
  notify();
}

export function getPendingAiSelection(
  workspaceId: string,
  agentId: string,
  field: AiSelectionField
): string | undefined {
  return pendingByScope.get(`${workspaceId}\u0000${normalizeAgent(agentId)}`)?.[field]?.value;
}

/**
 * Intent to attach to a send: only fields whose sent value still equals the picked value
 * (a stale pick that the user moved away from is dropped, a same-value pick is kept).
 */
export function getAiSelectionIntentForSend(
  workspaceId: string,
  agentId: string,
  sent: { model?: string; thinkingLevel?: string; reasoningMode?: string }
): { intent: AiSelectionIntent | undefined; attachedTokens: AiSelectionTokens } {
  const pending = pendingByScope.get(scopeKey(workspaceId, agentId));
  const intent: AiSelectionIntent = {};
  const attachedTokens: AiSelectionTokens = {};
  const agentPick = pendingAgentByWorkspace.get(workspaceId);
  if (agentPick?.value === normalizeAgentId(agentId, WORKSPACE_DEFAULTS.agentId)) {
    attachedTokens.agentId = agentPick.token;
  }
  if (pending != null) {
    for (const field of ["model", "thinkingLevel", "reasoningMode"] as const) {
      const selection = pending[field];
      if (selection == null || comparable(field, sent[field]) !== selection.value) continue;
      intent[field] = true;
      attachedTokens[field] = selection.token;
    }
  }
  return {
    intent: Object.keys(intent).length > 0 ? intent : undefined,
    attachedTokens,
  };
}

/**
 * Send-path wrapper: one-shot sends (skipAiSettingsPersistence) persist nothing and so
 * pin nothing, and an Auto-routed dimension was not deliberately picked for this send.
 * Returns the tokens to consume only for the fields actually attached.
 */
export function getAiSelectionIntentForSendOptions(
  workspaceId: string,
  agentId: string,
  options: {
    model?: string;
    thinkingLevel?: string;
    reasoningMode?: string;
    skipAiSettingsPersistence?: boolean;
    autoModelRouting?: boolean;
    autoThinkingLevel?: boolean;
  }
): { intent: AiSelectionIntent | undefined; attachedTokens: AiSelectionTokens } {
  if (options.skipAiSettingsPersistence === true) {
    return { intent: undefined, attachedTokens: {} };
  }
  const candidate = getAiSelectionIntentForSend(workspaceId, agentId, options);
  const intent: AiSelectionIntent = {};
  const attachedTokens: AiSelectionTokens = { agentId: candidate.attachedTokens.agentId };
  const keep = (field: AiSelectionField, allowed: boolean) => {
    if (!allowed || candidate.intent?.[field] !== true) return;
    intent[field] = true;
    attachedTokens[field] = candidate.attachedTokens[field];
  };
  keep("model", options.autoModelRouting !== true);
  keep("thinkingLevel", options.autoThinkingLevel !== true);
  keep("reasoningMode", true);
  return {
    intent: Object.keys(intent).length > 0 ? intent : undefined,
    attachedTokens,
  };
}

/**
 * After a successful send: an attached pick ends once the saved bucket (or agent) holds it, so
 * a save still in flight or failed keeps it. A re-pick made meanwhile has a new token and survives.
 */
export function consumeAiSelectionIntent(
  workspaceId: string,
  agentId: string,
  attachedTokens: AiSelectionTokens
): void {
  const agentPick = pendingAgentByWorkspace.get(workspaceId);
  if (agentPick != null && agentPick.token === attachedTokens.agentId) {
    const savedAgentId = resolvePersistedAgentId(metadataByWorkspace.get(workspaceId), "");
    if (agentPick.value === savedAgentId) {
      pendingAgentByWorkspace.delete(workspaceId);
    } else {
      pendingAgentByWorkspace.set(workspaceId, { ...agentPick, sent: true });
    }
  }
  const key = scopeKey(workspaceId, agentId);
  const pending = pendingByScope.get(key);
  if (pending == null) {
    notify();
    return;
  }
  const next = { ...pending };
  for (const field of ["model", "thinkingLevel", "reasoningMode"] as const) {
    const selection = next[field];
    if (selection == null || selection.token !== attachedTokens[field]) continue;
    if (isSavedPick(workspaceId, agentId, field, selection.value)) {
      delete next[field];
    } else {
      next[field] = { ...selection, sent: true };
    }
  }
  if (Object.keys(next).length === 0) {
    pendingByScope.delete(key);
  } else {
    pendingByScope.set(key, next);
  }
  notify();
}

/** A removed provider's pending model picks would otherwise outrank the repaired settings. */
export function dropPendingModelPicks(shouldDrop: (model: string) => boolean): void {
  for (const pending of pendingByScope.values()) {
    if (pending.model != null && shouldDrop(pending.model.value)) delete pending.model;
  }
  notify();
}

/** A fork starts from what the source composer shows, including its unsent picks. */
export function copyPendingAiSelection(sourceWorkspaceId: string, destWorkspaceId: string): void {
  const sourcePrefix = `${sourceWorkspaceId}\u0000`;
  for (const [key, pending] of [...pendingByScope]) {
    if (!key.startsWith(sourcePrefix)) continue;
    pendingByScope.set(scopeKey(destWorkspaceId, key.slice(sourcePrefix.length)), { ...pending });
  }
  const agentPick = pendingAgentByWorkspace.get(sourceWorkspaceId);
  if (agentPick != null) pendingAgentByWorkspace.set(destWorkspaceId, agentPick);
  notify();
}

/** Forgets all pending picks and metadata: another server can reuse a workspace ID. */
export function clearAiSelectionState(): void {
  pendingByScope.clear();
  pendingAgentByWorkspace.clear();
  metadataByWorkspace.clear();
  agentBasesByScope.clear();
  notify();
}

export const resetAiSelectionIntentForTests = clearAiSelectionState;
