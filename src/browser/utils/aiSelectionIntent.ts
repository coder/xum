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
 * next to the latest workspace AI metadata, so a reload drops an unsent pick. An unsent
 * agent pick lasts until the metadata's agent matches it.
 */
import type { AiSelectionIntent } from "@/common/types/agentAiSettings";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import { normalizeAgentId, resolvePersistedAgentId } from "@/common/utils/agentIds";
import assert from "@/common/utils/assert";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getUserPreferences } from "@/browser/stores/AppConfigStore";

export type AiSelectionField = keyof AiSelectionIntent;
export type AutoRoutingDimension = "model" | "thinkingLevel";
export const AUTO_ROUTING_FLAG = {
  model: "autoModelRouting",
  thinkingLevel: "autoThinkingLevel",
} as const satisfies Record<AutoRoutingDimension, string>;
export type AiSelectionTokens = Partial<Record<AiSelectionField, number>>;

interface PendingSelection {
  value: string;
  token: number;
}

export type WorkspaceAiMetadata = Pick<
  FrontendWorkspaceMetadata,
  "aiSettings" | "aiSettingsByAgent"
> &
  Partial<
    Pick<FrontendWorkspaceMetadata, "projectPath" | "agentId" | "agentType" | "parentWorkspaceId">
  >;

const pendingByScope = new Map<string, Partial<Record<AiSelectionField, PendingSelection>>>();
const pendingAgentByWorkspace = new Map<string, string>();
const pendingAutoRoutingByScope = new Map<string, Partial<Record<AutoRoutingDimension, boolean>>>();
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
  if (pendingAgentByWorkspace.get(workspaceId) === resolvePersistedAgentId(metadata, "")) {
    pendingAgentByWorkspace.delete(workspaceId);
  }
  for (const [agentId, settings] of Object.entries(metadata.aiSettingsByAgent ?? {})) {
    const picks = pendingAutoRoutingByScope.get(scopeKey(workspaceId, agentId));
    if (picks == null) continue;
    for (const dimension of ["model", "thinkingLevel"] as const) {
      if (picks[dimension] === (settings[AUTO_ROUTING_FLAG[dimension]] === true)) {
        delete picks[dimension];
      }
    }
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
  return pendingAgentByWorkspace.get(workspaceId) ?? getSavedWorkspaceAgentId(workspaceId);
}

/** Records an unsent agent pick; picking the saved agent drops the pick. */
export function setWorkspaceAgentPick(workspaceId: string, agentId: string): void {
  const normalized = normalizeAgentId(agentId, WORKSPACE_DEFAULTS.agentId);
  if (normalized === getSavedWorkspaceAgentId(workspaceId)) {
    pendingAgentByWorkspace.delete(workspaceId);
  } else {
    pendingAgentByWorkspace.set(workspaceId, normalized);
  }
  notify();
}

/** An unsent Auto pick lasts until the agent's saved flag matches it. */
export function getAutoRoutingPick(
  scopeId: string,
  agentId: string,
  dimension: AutoRoutingDimension
): boolean | undefined {
  return pendingAutoRoutingByScope.get(scopeKey(scopeId, agentId))?.[dimension];
}

export function setAutoRoutingPick(
  scopeId: string,
  agentId: string,
  dimension: AutoRoutingDimension,
  active: boolean
): void {
  const key = scopeKey(scopeId, agentId);
  pendingAutoRoutingByScope.set(key, {
    ...pendingAutoRoutingByScope.get(key),
    [dimension]: active,
  });
  notify();
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
  const attachedTokens: AiSelectionTokens = {};
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

/** Clears attached picks after a successful send, unless the user re-picked meanwhile. */
export function consumeAiSelectionIntent(
  workspaceId: string,
  agentId: string,
  attachedTokens: AiSelectionTokens
): void {
  const key = scopeKey(workspaceId, agentId);
  const pending = pendingByScope.get(key);
  if (pending == null) return;
  const next = { ...pending };
  for (const field of Object.keys(attachedTokens) as AiSelectionField[]) {
    if (next[field]?.token === attachedTokens[field]) delete next[field];
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
  for (const [key, picks] of [...pendingAutoRoutingByScope]) {
    if (!key.startsWith(sourcePrefix)) continue;
    const destKey = scopeKey(destWorkspaceId, key.slice(sourcePrefix.length));
    pendingAutoRoutingByScope.set(destKey, { ...picks });
  }
  const agentPick = pendingAgentByWorkspace.get(sourceWorkspaceId);
  if (agentPick != null) pendingAgentByWorkspace.set(destWorkspaceId, agentPick);
  notify();
}

/** Test-only: forget all pending picks and metadata. */
export function resetAiSelectionIntentForTests(): void {
  pendingByScope.clear();
  pendingAgentByWorkspace.clear();
  pendingAutoRoutingByScope.clear();
  metadataByWorkspace.clear();
  agentBasesByScope.clear();
  notify();
}
