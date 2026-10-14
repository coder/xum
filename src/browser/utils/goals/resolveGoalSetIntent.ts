import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";
import type { APIClient } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  mergeGoalDefaults,
  resolveGoalSetIntent,
  type WorkspaceGoalDefaultsOverride,
} from "@/common/utils/goals/resolveGoalSetIntent";

export { mergeGoalDefaults, resolveGoalSetIntent, type WorkspaceGoalDefaultsOverride };

/**
 * Load *effective* goal defaults via the API client.
 *
 * When `workspaceId` is provided, the per-workspace override (if any) is
 * layered on top of the global defaults, so callers (slash command, command
 * palette, GoalTab create form) all see the same effective values. When
 * omitted, only the global defaults are returned — this keeps the helper
 * usable from contexts that don't yet know which workspace they're acting
 * against (rare today; mainly tests and the global Settings UI).
 *
 * Falls back to `DEFAULT_GOAL_DEFAULTS` on any error so a missing or
 * disconnected config never blocks goal creation. Errors loading the
 * workspace override are also swallowed — global defaults still apply.
 */
export function loadGoalDefaults(api: APIClient, workspaceId?: string): Promise<GoalDefaults> {
  return fetchGoalDefaults(api, workspaceId, false);
}

/**
 * Like `loadGoalDefaults`, but an aborted read (a lost connection) rejects instead of falling
 * back. For a form that shows the defaults: it keeps what it shows, and the next client reads
 * again. A fallback would replace the shown values with the canonical defaults.
 */
export function loadShownGoalDefaults(api: APIClient, workspaceId?: string): Promise<GoalDefaults> {
  return fetchGoalDefaults(api, workspaceId, true);
}

/** Decides what a failed read gives: the fallback, or (an abort, when asked) a rejection. */
type FallBack = <T>(error: unknown, fallback: T) => T;

async function fetchGoalDefaults(
  api: APIClient,
  workspaceId: string | undefined,
  rejectOnAbort: boolean
): Promise<GoalDefaults> {
  const fallBack: FallBack = (error, fallback) => {
    if (rejectOnAbort && isAbortError(error)) throw error;
    return fallback;
  };
  const globalDefaults = await readGlobalGoalDefaults(api, fallBack);
  if (!workspaceId) {
    return globalDefaults;
  }
  return mergeGoalDefaults(globalDefaults, await readGoalOverride(api, workspaceId, fallBack));
}

async function readGlobalGoalDefaults(api: APIClient, fallBack: FallBack): Promise<GoalDefaults> {
  try {
    const config = await api.config?.getConfig?.();
    return normalizeGoalDefaults(config?.goalDefaults ?? DEFAULT_GOAL_DEFAULTS);
  } catch (error) {
    return fallBack(error, { ...DEFAULT_GOAL_DEFAULTS });
  }
}

async function readGoalOverride(
  api: APIClient,
  workspaceId: string,
  fallBack: FallBack
): Promise<WorkspaceGoalDefaultsOverride | null> {
  try {
    return (await api.workspace?.goalDefaults?.get?.({ workspaceId })) ?? null;
  } catch (error) {
    return fallBack(error, null);
  }
}
