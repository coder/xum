import {
  getUserPreferences,
  updateUserPreferences,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/** The project's chosen review base; workspaces without their own diff base fall back to it. */
export function useReviewDefaultBase(projectPath: string): string {
  return (
    useUserPreferences((preferences) => preferences.review?.defaultBaseByProject?.[projectPath]) ??
    WORKSPACE_DEFAULTS.reviewBase
  );
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
