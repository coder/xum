/**
 * MCP Apps route operations (artifacts experiment): open a view (resources/read + host-only
 * tool result), proxy tools/call and resources/read issued by a view to its own server, and
 * store a view's ui/update-model-context.
 */
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  McpAppModelContextRequestSchema,
  McpAppResourceReadRequestSchema,
  McpAppToolCallRequestSchema,
  McpAppToolCallResult,
  McpAppView,
  McpAppViewRecord,
  McpAppViewRecordsRequestSchema,
  McpAppViewRequestSchema,
} from "@/common/orpc/schemas/mcpApps";
import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type { ORPCContext } from "@/node/orpc/context";
import { buildMcpToolName } from "@/common/utils/tools/mcpToolName";
import type { McpAppResultRecord } from "./mcpAppResultStore";
import { displayConnectionKey } from "./mcpServerIdentity";

type McpAppsContext = Pick<ORPCContext, "experimentsService" | "mcpServerManager">;

/** Largest view-initiated tools/call or resources/read result returned to a view. */
export const MCP_APP_TOOL_RESULT_MAX_BYTES = 2 * 1024 * 1024;

function assertMcpAppsEnabled(context: McpAppsContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS)) {
    throw new ORPCError("BAD_REQUEST", { message: "MCP Apps views are disabled" });
  }
}

export async function getMcpAppView(
  context: McpAppsContext,
  input: z.infer<typeof McpAppViewRequestSchema>,
  signal: AbortSignal | undefined,
  /**
   * Starts the workspace's MCP servers the way prompt discovery does (resolving runtime, trust,
   * overrides and secrets). Needed when no send or discovery ran since the backend started, e.g.
   * reopening a persisted view after a restart: the manager has no request options to start
   * servers from and every read would fail with "not connected".
   */
  warmServers: (workspaceId: string, signal: AbortSignal | undefined) => Promise<unknown>
): Promise<Result<McpAppView, string>> {
  assertMcpAppsEnabled(context);
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
      await warmServers(input.workspaceId, signal);
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
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * The views of tool calls by their result records alone, one entry per distinct requested ID. A restored
 * app tab knows only the tool call ID; when that call is outside the loaded transcript (before a
 * compaction boundary, or older than the first history page) this is how the tab still finds its
 * view. One request covers every tab restored at once. Records are read from the asking
 * workspace only, and each view is then opened with getView, which checks the same record.
 */
export async function getMcpAppViewRecords(
  context: McpAppsContext,
  input: z.infer<typeof McpAppViewRecordsRequestSchema>
): Promise<Result<Array<{ toolCallId: string; view: McpAppViewRecord }>, string>> {
  assertMcpAppsEnabled(context);
  // One entry per distinct ID: a repeated ID is answered once (the schema caps the list and
  // refuses an empty one).
  const data = await Promise.all(
    [...new Set(input.toolCallIds)].map(async (toolCallId) => {
      const record = await context.mcpServerManager.getMcpAppResult(input.workspaceId, toolCallId);
      return { toolCallId, view: record === null ? null : viewOfRecord(record) };
    })
  );
  return { success: true, data };
}

/** Only the view's binding, never the stored tool result. */
function viewOfRecord(record: McpAppResultRecord): NonNullable<McpAppViewRecord> {
  // The record keeps the server-local tool name; cards show the model-facing one. Without the
  // catalog the collision suffix is unknown, so this is the unsuffixed name.
  const modelFacing = buildMcpToolName({
    serverName: record.serverName,
    toolName: record.toolName,
    usedNames: new Set(),
  });
  return {
    serverName: displayConnectionKey(record.serverName),
    toolName: modelFacing?.toolName ?? record.toolName,
    resourceUri: record.resourceUri,
    arguments: record.arguments,
  };
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

/**
 * resources/read issued by a view. The frame passes the view's bound server (the same binding as
 * its tools/call), so a view can only read from the server that produced it.
 */
export async function readMcpAppServerResource(
  context: McpAppsContext,
  input: z.infer<typeof McpAppResourceReadRequestSchema>,
  signal?: AbortSignal
): Promise<Result<unknown, string>> {
  assertMcpAppsEnabled(context);
  try {
    const result = await context.mcpServerManager.readMcpAppServerResource(
      input.workspaceId,
      input.serverName,
      input.uri,
      signal !== undefined ? { signal } : undefined
    );
    if (Buffer.byteLength(JSON.stringify(result) ?? "", "utf8") > MCP_APP_TOOL_RESULT_MAX_BYTES) {
      return { success: false, error: "The resource is too large to return to the view" };
    }
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * ui/update-model-context of a view. Only a view with a result record may write: the record
 * names the server that produced it, so the context is attributed to that server (never to
 * the card's display values), and a request naming another server is refused. Whether that
 * server is still enabled is checked when a request uses the context (turnRequestBuilder).
 */
export async function updateMcpAppModelContext(
  context: McpAppsContext,
  input: z.infer<typeof McpAppModelContextRequestSchema>
): Promise<Result<Record<string, never>, string>> {
  assertMcpAppsEnabled(context);
  const record = await context.mcpServerManager.getMcpAppResult(
    input.workspaceId,
    input.toolCallId
  );
  if (
    record === null ||
    (input.serverName !== record.serverName &&
      input.serverName !== displayConnectionKey(record.serverName))
  ) {
    return { success: false, error: "This view cannot update the model context" };
  }
  try {
    await context.mcpServerManager.setMcpAppModelContext(input.workspaceId, record, input.text);
    return { success: true, data: {} };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}
