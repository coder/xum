/**
 * MCP Apps route operations (artifacts experiment): open a view (resources/read + host-only
 * tool result) and proxy tools/call issued by a view to its own server.
 */
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  McpAppPluginView,
  McpAppToolCallRequestSchema,
  McpAppToolCallResult,
  McpAppView,
  McpAppViewRequestSchema,
} from "@/common/orpc/schemas/mcpApps";
import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type { ORPCContext } from "@/node/orpc/context";
import type { PluginViewEntry } from "./agentPlugins/pluginViews";
import { displayConnectionKey } from "./mcpServerIdentity";

type McpAppsContext = Pick<ORPCContext, "experimentsService" | "mcpServerManager">;

/** Largest view-initiated tools/call result returned to a view. */
export const MCP_APP_TOOL_RESULT_MAX_BYTES = 2 * 1024 * 1024;

function assertMcpAppsEnabled(context: McpAppsContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS)) {
    throw new ORPCError("BAD_REQUEST", { message: "MCP Apps views are disabled" });
  }
}

/** Resolves a workspace's plugin views from a fresh discovery (listWorkspacePluginViews). */
export type ListPluginViews = (
  workspaceId: string,
  signal: AbortSignal | undefined
) => Promise<PluginViewEntry[]>;

export interface McpAppViewDeps {
  /**
   * Starts the workspace's MCP servers the way prompt discovery does (resolving runtime, trust,
   * overrides and secrets). Needed when no send or discovery ran since the backend started, e.g.
   * reopening a persisted view after a restart: the manager has no request options to start
   * servers from and every read would fail with "not connected".
   */
  warmServers: (workspaceId: string, signal: AbortSignal | undefined) => Promise<unknown>;
  listPluginViews: ListPluginViews;
}

export async function listMcpAppPluginViews(
  context: McpAppsContext,
  input: { workspaceId: string },
  signal: AbortSignal | undefined,
  listPluginViews: ListPluginViews
): Promise<Result<McpAppPluginView[], string>> {
  assertMcpAppsEnabled(context);
  try {
    const views = await listPluginViews(input.workspaceId, signal);
    return {
      success: true,
      // The resource URI stays in the backend: the renderer opens a view by its ID only.
      data: views.map((view) => ({
        pluginViewId: view.pluginViewId,
        title: view.title,
        pluginName: view.pluginName,
        serverName: view.serverName,
        serverKey: view.serverKey,
        enabled: view.enabled,
      })),
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/** The message a disabled plugin view server shows in the view's frame. */
export function pluginViewServerDisabledError(serverName: string): string {
  return `Enable the ${serverName} server for this workspace to open this view (Workspace MCP settings).`;
}

async function getPluginAppView(
  context: McpAppsContext,
  input: Extract<z.infer<typeof McpAppViewRequestSchema>, { kind: "plugin" }>,
  signal: AbortSignal | undefined,
  deps: McpAppViewDeps
): Promise<Result<McpAppView, string>> {
  try {
    // Exact match against a fresh discovery: an unknown ID, another workspace's plugin, or a
    // view whose server the plugin no longer has is refused before any server is contacted.
    const view = (await deps.listPluginViews(input.workspaceId, signal)).find(
      (candidate) => candidate.pluginViewId === input.pluginViewId
    );
    if (view === undefined) {
      return { success: false, error: "This plugin view is not available in this workspace" };
    }
    if (!view.enabled) {
      return { success: false, error: pluginViewServerDisabledError(view.serverName) };
    }
    if (!context.mcpServerManager.hasWorkspaceRequestOptions(input.workspaceId)) {
      await deps.warmServers(input.workspaceId, signal);
    }
    const resource = await context.mcpServerManager.readMcpAppResource(
      input.workspaceId,
      view.serverKey,
      view.resourceUri,
      signal !== undefined ? { signal } : undefined
    );
    // No tool call opened this view, so there is no result or invocation to bind to; the
    // frame binds its tools/call to the server key it was read from.
    return {
      success: true,
      data: {
        ...resource,
        resultAvailable: false,
        result: null,
        invocation: null,
        pluginServerKey: view.serverKey,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getMcpAppView(
  context: McpAppsContext,
  input: z.infer<typeof McpAppViewRequestSchema>,
  signal: AbortSignal | undefined,
  deps: McpAppViewDeps
): Promise<Result<McpAppView, string>> {
  assertMcpAppsEnabled(context);
  if (input.kind === "plugin") return getPluginAppView(context, input, signal, deps);
  const record = await context.mcpServerManager.getMcpAppResult(
    input.workspaceId,
    input.toolCallId
  );
  // The record is the authoritative binding of this tool call: a request naming another
  // server or view (a stale or forged card) is refused, so one server's result can never be
  // paired with another server's view, and the view's own tool calls go to the record's server.
  // Cards carry only the display form of the server key (whitespace-collapsed, length-capped),
  // so a card naming the record's server by that form matches; the record's raw key is then the
  // operational name.
  if (
    record !== null &&
    ((input.serverName !== record.serverName &&
      input.serverName !== displayConnectionKey(record.serverName)) ||
      record.resourceUri !== input.resourceUri)
  ) {
    return {
      success: false,
      error: "This view does not belong to the server and resource that produced the result",
    };
  }
  try {
    if (!context.mcpServerManager.hasWorkspaceRequestOptions(input.workspaceId)) {
      await deps.warmServers(input.workspaceId, signal);
    }
    const resource = await context.mcpServerManager.readMcpAppResource(
      input.workspaceId,
      record?.serverName ?? input.serverName,
      input.resourceUri,
      signal !== undefined ? { signal } : undefined
    );
    const result = record?.result ?? null;
    return {
      success: true,
      data: {
        ...resource,
        resultAvailable: result !== null,
        result,
        invocation:
          record !== null
            ? {
                serverName: record.serverName,
                toolName: record.toolName,
                arguments: record.arguments,
              }
            : null,
        pluginServerKey: null,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function callMcpAppTool(
  context: McpAppsContext,
  input: z.infer<typeof McpAppToolCallRequestSchema>,
  signal?: AbortSignal
): Promise<Result<McpAppToolCallResult, string>> {
  assertMcpAppsEnabled(context);
  try {
    const outcome = await context.mcpServerManager.callMcpAppTool(
      input.workspaceId,
      input.serverName,
      input.toolName,
      input.arguments,
      { consented: input.consented, ...(signal !== undefined ? { signal } : {}) }
    );
    if (
      outcome.status === "ok" &&
      Buffer.byteLength(JSON.stringify(outcome.result) ?? "", "utf8") >
        MCP_APP_TOOL_RESULT_MAX_BYTES
    ) {
      return { success: false, error: "The tool result is too large to return to the view" };
    }
    return { success: true, data: outcome };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}
