/**
 * Compaction model preference management
 *
 * resolveCompactionModel priority:
 *   1) /compact -m flag (requestedModel)
 *   2) Settings preference (agentAiDefaults.compact.modelString)
 *   3) undefined → caller falls back to workspace model
 */

import { getAppConfigStore } from "@/browser/stores/AppConfigStore";

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

export function getPreferredCompactionModel(): string | undefined {
  return trimmedOrUndefined(
    getAppConfigStore().getSnapshot()?.agentAiDefaults?.compact?.modelString
  );
}

export function resolveCompactionModel(requestedModel: string | undefined): string | undefined {
  return trimmedOrUndefined(requestedModel) ?? getPreferredCompactionModel();
}
