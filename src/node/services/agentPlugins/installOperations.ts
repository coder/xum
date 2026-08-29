import type { ORPCContext } from "@/node/orpc/context";
import { getErrorMessage } from "@/common/utils/errors";

async function captureInstallResult<T>(operation: () => Promise<T>) {
  try {
    return { success: true as const, data: await operation() };
  } catch (error) {
    return { success: false as const, error: getErrorMessage(error) };
  }
}

export function previewAgentPlugin(
  context: ORPCContext,
  input: { input: string; ref?: string | null; subpath?: string | null }
) {
  return captureInstallResult(() =>
    context.agentPluginInstallService.preview({
      input: input.input,
      ref: input.ref ?? undefined,
      subpath: input.subpath ?? undefined,
    })
  );
}

export function installAgentPlugin(
  context: ORPCContext,
  input: Parameters<ORPCContext["agentPluginInstallService"]["install"]>[0]
) {
  return captureInstallResult(() => context.agentPluginInstallService.install(input));
}

export function listAgentPlugins(context: ORPCContext) {
  return captureInstallResult(() => context.agentPluginInstallService.list());
}

export async function uninstallAgentPlugin(
  context: ORPCContext,
  input: Parameters<ORPCContext["agentPluginInstallService"]["uninstall"]>[0]
) {
  const result = await captureInstallResult(() =>
    context.agentPluginInstallService.uninstall(input)
  );
  return result.success ? { success: true as const, data: undefined } : result;
}

export function checkAgentPluginUpdates(context: ORPCContext) {
  return captureInstallResult(() => context.agentPluginInstallService.checkUpdates());
}

export function updateAgentPlugin(
  context: ORPCContext,
  input: Parameters<ORPCContext["agentPluginInstallService"]["update"]>[0]
) {
  return captureInstallResult(() => context.agentPluginInstallService.update(input));
}
