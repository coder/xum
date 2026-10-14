import { useContext, useEffect, useState } from "react";

import { APIContext } from "@/browser/contexts/API";
import { loadShownGoalDefaults } from "@/browser/utils/goals/resolveGoalSetIntent";
import { isAbortError } from "@/browser/utils/isAbortError";
import { DEFAULT_GOAL_DEFAULTS, type GoalDefaults } from "@/constants/goals";

/**
 * React hook for the in-tab "Set goal" / queue forms that need to pre-fill
 * their inputs with the workspace's effective goal defaults (global config
 * + per-workspace override merged). Encapsulates the load + a `reload()`
 * callback so the "Change defaults" modal can prompt the form to re-read.
 *
 * Always returns a value: while the API call is in flight the hook serves
 * the canonical `DEFAULT_GOAL_DEFAULTS` so callers never have to handle a
 * `null` first render. `isLoading` is exposed so callers that want to
 * disable a Submit button until the defaults arrive can do so cleanly.
 */
export interface UseGoalDefaultsResult {
  defaults: GoalDefaults;
  isLoading: boolean;
  reload: () => void;
}

/**
 * A cancelled load, or an aborted read (a lost connection), keeps the shown values: the next
 * client reads again. Other failures fall back to the canonical defaults.
 */
function keepsShownDefaults(cancelled: boolean, error: unknown): boolean {
  return cancelled || isAbortError(error);
}

export function useGoalDefaults(workspaceId?: string): UseGoalDefaultsResult {
  // Read APIContext directly rather than via `useAPI()` so the hook
  // tolerates being mounted outside an APIProvider — required by
  // storybook stories that render the GoalTab without provisioning the
  // full app shell. When no provider is present, we serve canonical
  // defaults and skip the fetch.
  const context = useContext(APIContext);
  const api = context?.api ?? null;
  const [defaults, setDefaults] = useState<GoalDefaults>({ ...DEFAULT_GOAL_DEFAULTS });
  const [isLoading, setIsLoading] = useState(true);
  // Bump to force a reload after the user changes defaults via the modal.
  // Avoids exposing a separate imperative "refetch" function to callers —
  // they can hold the returned `reload` and call it freely.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setIsLoading(true);
    void loadShownGoalDefaults(api, workspaceId)
      .then((next) => {
        if (cancelled) return;
        setDefaults(next);
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        if (keepsShownDefaults(cancelled, error)) return;
        setDefaults({ ...DEFAULT_GOAL_DEFAULTS });
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  return { defaults, isLoading, reload };
}
