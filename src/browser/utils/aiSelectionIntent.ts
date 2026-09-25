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
 */
import type { AiSelectionIntent } from "@/common/types/agentAiSettings";
import { getAgentIdKey } from "@/common/constants/storage";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import assert from "@/common/utils/assert";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { readPersistedState } from "@/browser/hooks/usePersistedState";

export type AiSelectionField = keyof AiSelectionIntent;
export type AiSelectionTokens = Partial<Record<AiSelectionField, number>>;

interface PendingSelection {
  value: string;
  token: number;
}

const pendingByScope = new Map<string, Partial<Record<AiSelectionField, PendingSelection>>>();
let nextToken = 1;

function normalizeAgent(agentId: string): string {
  return agentId.trim().toLowerCase() || WORKSPACE_DEFAULTS.agentId;
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
  const agentId = readPersistedState<string>(
    getAgentIdKey(workspaceId),
    WORKSPACE_DEFAULTS.agentId
  );
  const key = scopeKey(workspaceId, agentId);
  const normalized = comparable(field, value);
  assert(normalized != null, "markAiSelectionIntent: value must be non-empty");
  const token = nextToken++;
  pendingByScope.set(key, { ...pendingByScope.get(key), [field]: { value: normalized, token } });
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
}

/** Whether a local field value still reflects an unsent deliberate pick (reseed guard). */
export function hasPendingAiSelectionIntent(
  workspaceId: string,
  agentId: string,
  field: AiSelectionField,
  localValue: string | undefined
): boolean {
  const selection = pendingByScope.get(scopeKey(workspaceId, agentId))?.[field];
  return selection != null && comparable(field, localValue) === selection.value;
}

/** Test-only: forget all pending picks. */
export function resetAiSelectionIntentForTests(): void {
  pendingByScope.clear();
}
