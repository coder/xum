import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getUserPreferences,
  updateUserPreferences,
  useAppConfig,
} from "@/browser/stores/AppConfigStore";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/**
 * The project's chosen review base, or null when it has none. Undefined before the first
 * config snapshot: whether the project has one is unknown until then.
 */
export function useProjectReviewBase(projectPath: string): string | null | undefined {
  return useAppConfig((config) =>
    config.userPreferences === undefined
      ? undefined
      : (config.userPreferences.review?.defaultBaseByProject?.[projectPath] ?? null)
  );
}

/** The project's chosen review base; workspaces without their own diff base fall back to it. */
export function useReviewDefaultBase(projectPath: string): string {
  return useProjectReviewBase(projectPath) ?? WORKSPACE_DEFAULTS.reviewBase;
}

/**
 * A workspace's diff base. The project fallback is read on every render rather than captured
 * as the stored value's initial default, so a project default that loads late still applies.
 */
export function useWorkspaceDiffBase(
  workspaceId: string,
  projectPath: string
): [string, (base: string) => void] {
  const defaultBase = useReviewDefaultBase(projectPath);
  const [ownBase, setOwnBase] = usePersistedState<string | null>(
    STORAGE_KEYS.reviewDiffBase(workspaceId),
    null,
    { listener: true }
  );
  return [ownBase ?? defaultBase, setOwnBase];
}

export function readReviewDefaultBase(projectPath: string): string {
  return (
    getUserPreferences().review?.defaultBaseByProject?.[projectPath] ??
    WORKSPACE_DEFAULTS.reviewBase
  );
}

export function setReviewDefaultBase(projectPath: string, base: string): void {
  updateUserPreferences({ review: { defaultBaseByProject: { [projectPath]: base } } });
}
