import { ORPCError } from "@orpc/server";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { isMultiProject } from "@/common/utils/multiProject";
import { secretsToRecord } from "@/common/types/secrets";
import {
  ALL_WORKSPACES_TARGET,
  MCP_OVERRIDES_READ_TIMEOUT_MS,
  MCP_OVERRIDES_REVISION_UNAVAILABLE,
} from "@/node/services/workspaceMcpOverridesService";
import type { ORPCContext } from "@/node/orpc/context";
import type { MCPWorkspaceRequestOptions } from "@/node/services/mcpServerManager";
import { createRuntimeForWorkspace, resolveWorkspaceRootPath } from "@/node/runtime/runtimeHelpers";
import { isProjectTrusted, isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { buildWorkspaceComposition } from "./composition";
import { discoverWorkspaceAgentPlugins } from "./discovery";
import {
  buildAddedPluginKeyValidator,
  resolveAgentPluginsMcpContext,
  type AgentPluginsMcpContext,
} from "./mcpConfig";
import { collectPluginSlashCommands } from "./slashCommands";

async function resolveWorkspaceAgentPluginsMcpContext(
  context: ORPCContext,
  workspaceId: string | null | undefined,
  projectPath: string | null | undefined
): Promise<AgentPluginsMcpContext | null | undefined> {
  const trimmed = workspaceId?.trim();
  if (!trimmed) return undefined;
  try {
    const result = await context.aiService.getWorkspaceMetadata(trimmed);
    if (!result.success) return undefined;
    const metadata = result.data;
    if (metadata.projectPath !== projectPath?.trim()) {
      log.debug("Ignoring Agent Plugins workspace context for mismatched project", {
        workspaceId: trimmed,
        requestedProjectPath: projectPath,
        workspaceProjectPath: metadata.projectPath,
      });
      return undefined;
    }
    return resolveAgentPluginsMcpContext(
      metadata,
      resolveWorkspaceRootPath(metadata, createRuntimeForWorkspace(metadata))
    );
  } catch (error) {
    log.debug("Failed to resolve Agent Plugins MCP context for workspace", {
      workspaceId: trimmed,
      error,
    });
    return undefined;
  }
}

export async function getWorkspaceMcpOverrides(context: ORPCContext, workspaceId: string) {
  try {
    // Bounded and strict like every other request-path read: an inheriting
    // workspace resolves through its ancestors' documents (remote reads allow
    // minutes per level), and the settings view must either show the
    // established state or report it unavailable — never hang, never guess.
    return await context.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId, {
      mode: "strict",
      timeoutMs: MCP_OVERRIDES_READ_TIMEOUT_MS,
    });
  } catch {
    // The sentinel revision makes the dialog's save a repair of the unreadable
    // document (see writeOverridesLocked) rather than a permanent conflict.
    return { overrides: {}, revision: MCP_OVERRIDES_REVISION_UNAVAILABLE };
  }
}

export function listWorkspaceMcpPrompts(
  context: ORPCContext,
  workspaceId: string,
  callerSignal?: AbortSignal
) {
  return withWorkspaceMcpRequest(context, workspaceId, callerSignal, [], (options, signal) =>
    context.mcpServerManager.getPromptsForWorkspace(options, { signal })
  );
}

/**
 * Start the workspace's MCP servers the way a send does, without prompt discovery: MCP App
 * entry points need the server inventory only, and prompts/list on a stalled server would hold
 * the launcher for its whole timeout.
 */
export async function warmWorkspaceMcpServers(
  context: ORPCContext,
  workspaceId: string,
  callerSignal?: AbortSignal
): Promise<void> {
  await withWorkspaceMcpRequest(context, workspaceId, callerSignal, undefined, (options, signal) =>
    context.mcpServerManager.getToolsForWorkspace(options, { signal })
  );
}

/**
 * Resolve the workspace's MCP request options (runtime, trust, overrides, secrets) under its
 * prompt-discovery admission and run `run` with them. Returns `degraded` when the workspace is
 * being archived or removed, or the caller aborted.
 */
async function withWorkspaceMcpRequest<T, D>(
  context: ORPCContext,
  workspaceId: string,
  callerSignal: AbortSignal | undefined,
  degraded: D,
  run: (options: MCPWorkspaceRequestOptions, signal: AbortSignal) => Promise<T>
): Promise<T | D> {
  // Archive admission pairing (see WorkspaceService.acquireMcpPromptDiscoveryAdmission): held
  // through ensureReady and server startup below, both of which would otherwise re-wake a
  // stopped Coder workspace or start stdio servers inside a checkout the archive is removing.
  // Discovery degrades to an empty catalog instead of erroring, like file completions.
  using admission = context.workspaceService.acquireMcpPromptDiscoveryAdmission(workspaceId);
  if (admission === undefined) return degraded;
  // A removal aborts discoveries admitted before it and waits for them to settle (#4805).
  const signal =
    callerSignal !== undefined
      ? AbortSignal.any([callerSignal, admission.signal])
      : admission.signal;
  const options = await resolveWorkspaceMcpRequestOptions(context, workspaceId, signal);
  if (options === null) return degraded;
  // `return await`, not `return`: `using` disposes at block exit, and a bare returned promise
  // would release the admission before server startup settles.
  try {
    return await run(options, signal);
  } catch (error) {
    // An abort (a removal's, #4805, or the caller's) degrades like the checks above.
    if (signal.aborted) return degraded;
    throw error;
  }
}

/** The workspace's MCP request options, or null once `signal` aborted. */
async function resolveWorkspaceMcpRequestOptions(
  context: ORPCContext,
  workspaceId: string,
  signal: AbortSignal
): Promise<MCPWorkspaceRequestOptions | null> {
  const ready = await readyWorkspaceRuntime(context, workspaceId, signal);
  if (ready === null) return null;
  const { metadata, runtime, workspacePath, hostCheckoutRoot } = ready;
  // Forward the authority too: a snapshot the service could not establish
  // must make the manager re-read disk (and fail closed), not start servers.
  // Bounded and cancellable like the send path: an inheriting child's
  // resolution reads through an SSH/Docker parent (minutes per remote op),
  // and discovery holds its archive admission for the duration.
  const overridesReadStartedAt = Date.now();
  const { overrides, authoritative } =
    await context.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId, {
      timeoutMs: MCP_OVERRIDES_READ_TIMEOUT_MS,
      signal,
    });
  if (signal.aborted) return null;
  const projectSecrets = await secretsToRecord(
    isMultiProject(metadata)
      ? mergeMultiProjectSecrets(metadata, context.secretsStore)
      : context.secretsStore.getEffectiveSecrets(metadata.projectPath)
  );
  if (signal.aborted) return null;
  return {
    workspaceId,
    projectPath: metadata.projectPath,
    runtime,
    workspacePath,
    trusted: isWorkspaceProjectTrusted(context.config, metadata),
    overrides,
    overridesAuthoritative: authoritative,
    // Like the send path: a non-authoritative read that exhausted its
    // budget must not be followed by a second full-length attempt inside
    // the manager while discovery holds its archive admission.
    ...(authoritative
      ? {}
      : { overridesReadDeadlineAt: overridesReadStartedAt + MCP_OVERRIDES_READ_TIMEOUT_MS }),
    projectSecrets,
    agentPlugins: hostCheckoutRoot
      ? resolveAgentPluginsMcpContext(metadata, hostCheckoutRoot)
      : null,
  };
}

/** Wait for the workspace's init and ready its runtime; null once `signal` aborted. */
async function readyWorkspaceRuntime(
  context: ORPCContext,
  workspaceId: string,
  signal: AbortSignal
) {
  await context.initStateManager.waitForInit(workspaceId, signal);
  if (signal.aborted) return null;
  // A checkout whose launch sanitize failed (recorded before its init completed, #4674): refuse
  // with a typed error, unlike the archive degrade above, and never start MCP in it.
  const unsanitized = context.initStateManager.getUnsanitizedCheckoutError(workspaceId);
  if (unsanitized) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: unsanitized.message,
      data: { code: unsanitized.code },
    });
  }
  const metadataResult = await context.aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) throw new Error(metadataResult.error);
  const metadata = metadataResult.data;
  const runtimeResult = context.aiService.createWorkspaceRuntimeContext(workspaceId, metadata);
  if (!runtimeResult.success) throw new Error(formatSendMessageError(runtimeResult.error).message);
  const ready = await runtimeResult.data.runtime.ensureReady({ signal });
  // A runtime aborted mid-readiness reports not-ready ("Aborted"): degrade, like the other
  // abort points, instead of failing the RPC.
  if (signal.aborted) return null;
  if (!ready.ready) throw new Error(ready.error);
  return { metadata, ...runtimeResult.data };
}

export async function setWorkspaceMcpOverrides(
  context: ORPCContext,
  input: {
    workspaceId: string;
    overrides: Parameters<
      ORPCContext["workspaceMcpOverridesService"]["setOverridesForWorkspace"]
    >[1];
    expectedRevision: string;
  }
) {
  try {
    await context.workspaceMcpOverridesService.setOverridesForWorkspace(
      input.workspaceId,
      input.overrides,
      {
        expectedRevision: input.expectedRevision,
        validateAgainstCurrent: buildAddedPluginKeyValidator(async () => {
          const metadataResult = await context.aiService.getWorkspaceMetadata(input.workspaceId);
          if (!metadataResult.success) throw new Error(metadataResult.error);
          const projectPath = metadataResult.data.projectPath;
          const servers = await context.mcpConfigService.listServers(
            projectPath,
            isProjectTrusted(context.config, projectPath),
            {
              agentPlugins: await resolveWorkspaceAgentPluginsMcpContext(
                context,
                input.workspaceId,
                projectPath
              ),
            }
          );
          return new Set(Object.keys(servers).filter((key) => key.startsWith("plugin:")));
        }),
        // `target` differs from input.workspaceId for affected sharers/descendants;
        // null = state not establishable, drop the cache instead of guessing.
        publish: (persisted, target) =>
          persisted === null
            ? Promise.resolve(
                target === ALL_WORKSPACES_TARGET
                  ? context.mcpServerManager.forgetAllWorkspaceOverrides()
                  : context.mcpServerManager.forgetWorkspaceOverrides(target)
              )
            : context.mcpServerManager.applyWorkspaceOverrides(target, persisted),
      }
    );
    return { success: true as const, data: undefined };
  } catch (error) {
    return { success: false as const, error: getErrorMessage(error) };
  }
}

export async function listWorkspacePluginSlashCommands(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
) {
  await context.initStateManager.waitForInit(workspaceId, signal);
  const metadataResult = await context.aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) throw new Error(metadataResult.error);
  const metadata = metadataResult.data;
  const runtimeResult = context.aiService.createWorkspaceRuntimeContext(workspaceId, metadata);
  if (!runtimeResult.success) throw new Error(formatSendMessageError(runtimeResult.error).message);
  const { hostCheckoutRoot } = runtimeResult.data;
  if (!hostCheckoutRoot) return [];
  const { plugins } = await discoverWorkspaceAgentPlugins({
    workspacePath: hostCheckoutRoot,
    xumHome: context.config.rootDir,
    projectTrusted: isWorkspaceProjectTrusted(context.config, metadata),
  });
  return collectPluginSlashCommands(plugins);
}

export async function getWorkspacePluginComposition(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
) {
  await context.initStateManager.waitForInit(workspaceId, signal);
  const metadataResult = await context.aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) throw new Error(metadataResult.error);
  const metadata = metadataResult.data;
  const runtimeResult = context.aiService.createWorkspaceRuntimeContext(workspaceId, metadata);
  if (!runtimeResult.success) throw new Error(formatSendMessageError(runtimeResult.error).message);
  const { runtime, workspacePath, hostCheckoutRoot } = runtimeResult.data;
  const projectTrusted = isWorkspaceProjectTrusted(context.config, metadata);
  const agentPlugins = hostCheckoutRoot
    ? resolveAgentPluginsMcpContext(metadata, hostCheckoutRoot)
    : null;
  return buildWorkspaceComposition({
    runtime,
    workspacePath,
    hostCheckoutRoot,
    xumHome: context.config.rootDir,
    projectTrusted,
    listMcpServerLayers: () =>
      context.mcpConfigService.listServerLayers(metadata.projectPath, projectTrusted, {
        agentPlugins,
      }),
  });
}
