/**
 * MCP Apps route operations (artifacts experiment): open a view (resources/read + host-only
 * tool result) and proxy tools/call issued by a view to its own server.
 */
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  McpAppToolCallRequestSchema,
  McpAppToolCallResult,
  McpAppView,
  McpAppViewRequestSchema,
} from "@/common/orpc/schemas/mcpApps";
import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type { ORPCContext } from "@/node/orpc/context";
import { displayConnectionKey } from "./mcpServerIdentity";

type McpAppsContext = Pick<ORPCContext, "experimentsService" | "mcpServerManager">;

/** Largest view-initiated tools/call result returned to a view. */
export const MCP_APP_TOOL_RESULT_MAX_BYTES = 2 * 1024 * 1024;

function assertMcpAppsEnabled(context: McpAppsContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS)) {
    throw new ORPCError("BAD_REQUEST", { message: "MCP Apps views are disabled" });
  }
}

export async function getMcpAppView(
  context: McpAppsContext,
  input: z.infer<typeof McpAppViewRequestSchema>,
  signal?: AbortSignal
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
