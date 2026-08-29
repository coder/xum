import type { ORPCContext } from "@/node/orpc/context";
import type { Secret } from "@/common/types/secrets";
import { Err, Ok } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import {
  isLayoutPresetsConfigEmpty,
  normalizeLayoutPresetsConfig,
  type LayoutPresetsConfig,
} from "@/common/types/uiLayouts";

function normalizeProjectPath(projectPath: string | null | undefined): string | undefined {
  return typeof projectPath === "string" && projectPath.trim().length > 0 ? projectPath : undefined;
}

export function getSecrets(context: ORPCContext, projectPath: string | null | undefined) {
  const normalizedPath = normalizeProjectPath(projectPath);
  return normalizedPath
    ? context.config.getProjectSecrets(normalizedPath)
    : context.config.getGlobalSecrets();
}

export function getInjectedGlobalSecretKeys(
  context: ORPCContext,
  projectPath: string | null | undefined
): string[] {
  const normalizedPath = normalizeProjectPath(projectPath);
  return normalizedPath
    ? context.config.getInjectedGlobalSecrets(normalizedPath).map((secret) => secret.key)
    : [];
}

export async function updateSecrets(
  context: ORPCContext,
  input: { projectPath?: string | null; secrets: Secret[] }
) {
  try {
    const projectPath = normalizeProjectPath(input.projectPath);
    if (projectPath) {
      await context.config.updateProjectSecrets(projectPath, input.secrets);
    } else {
      await context.config.updateGlobalSecrets(input.secrets);
    }
    return Ok(undefined);
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export function markSplashScreenViewed(context: ORPCContext, splashId: string) {
  return context.config.editConfig((config) => {
    const viewed = config.viewedSplashScreens ?? [];
    if (!viewed.includes(splashId)) {
      viewed.push(splashId);
    }
    return { ...config, viewedSplashScreens: viewed };
  });
}

export function saveLayoutPresets(context: ORPCContext, layoutPresets: LayoutPresetsConfig) {
  return context.config.editConfig((config) => {
    const normalized = normalizeLayoutPresetsConfig(layoutPresets);
    return {
      ...config,
      layoutPresets: isLayoutPresetsConfigEmpty(normalized) ? undefined : normalized,
    };
  });
}

export function updateRoutePreferences(
  context: ORPCContext,
  input: Omit<
    Parameters<ORPCContext["config"]["updateRoutePreferences"]>[0],
    "validateRouteOverrides"
  >
) {
  return context.config.updateRoutePreferences({
    ...input,
    validateRouteOverrides: (overrides) =>
      context.providerService.validateRouteOverrides(overrides),
  });
}
