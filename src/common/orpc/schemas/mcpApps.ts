import { z } from "zod";
import {
  isMcpAppResourceUri,
  MCP_APP_CSP_DOMAINS_MAX,
  MCP_APP_MODEL_CONTEXT_MAX_BYTES,
  MCP_APP_READ_URI_MAX_CHARS,
  MCP_APP_VIEW_DOMAINS_MAX,
  MCP_APP_VIEW_RECORDS_MAX_IDS,
} from "@/common/utils/mcpApps";

/**
 * MCP Apps views in the Artifacts tab (artifacts experiment). The view HTML comes from the
 * server's resources/read; the tool result comes from the host-only side store, never from
 * chat history.
 */

const DomainListSchema = z.array(z.string().max(256)).max(MCP_APP_CSP_DOMAINS_MAX);

/** `_meta.ui.csp` as declared by the view resource (not what the host grants). */
export const McpAppCspDeclarationSchema = z.object({
  connectDomains: DomainListSchema.optional(),
  resourceDomains: DomainListSchema.optional(),
  frameDomains: DomainListSchema.optional(),
  baseUriDomains: DomainListSchema.optional(),
});
export type McpAppCspDeclaration = z.infer<typeof McpAppCspDeclarationSchema>;

export const McpAppViewSchema = z.object({
  html: z.string(),
  csp: McpAppCspDeclarationSchema,
  prefersBorder: z.boolean().nullable(),
  /** False when the side store has no result for this call (older history, oversized result). */
  resultAvailable: z.boolean(),
  /** Raw CallToolResult for ui/notifications/tool-result; null when unavailable. */
  result: z.unknown().nullable(),
  /** Origins the user allowed this view's server to reach in this project (mcpAppViewDomains). */
  approvedDomains: z.array(z.string()).optional(),
  /**
   * The project whose approvals the view's server uses (a multi-project workspace's server
   * project, never the shared `_multi` bucket); null when none can be approved.
   */
  approvalProjectPath: z.string().nullable().optional(),
  /**
   * The tool call the side-store record names: its server, server-local tool name and the
   * sanitized arguments the server received. When present the view is bound to it (toolInfo,
   * tool-input and its own tools/call), never to the card's display values. Null without a
   * record (older history, pruned).
   */
  invocation: z
    .object({
      serverName: z.string().min(1),
      toolName: z.string().min(1),
      arguments: z.unknown(),
    })
    .nullable(),
});
export type McpAppView = z.infer<typeof McpAppViewSchema>;

export const McpAppViewRequestSchema = z.object({
  workspaceId: z.string().min(1),
  toolCallId: z.string().min(1),
  serverName: z.string().min(1),
  resourceUri: z.string().refine(isMcpAppResourceUri, "resourceUri must be a ui:// URI"),
});

/** Tool calls' views, looked up by their result records alone (getViewRecords). */
export const McpAppViewRecordsRequestSchema = z.object({
  workspaceId: z.string().min(1),
  toolCallIds: z.array(z.string().min(1)).min(1).max(MCP_APP_VIEW_RECORDS_MAX_IDS),
});

/**
 * What a restored app tab needs to show a view whose tool call is outside the loaded
 * transcript: the record's server (display form, as cards carry it), the model-facing tool
 * name, the view resource and the arguments. Null when the workspace has no record.
 */
export const McpAppViewRecordSchema = z
  .object({
    serverName: z.string().min(1),
    toolName: z.string().min(1),
    resourceUri: z.string().refine(isMcpAppResourceUri, "resourceUri must be a ui:// URI"),
    arguments: z.unknown(),
  })
  .nullable();
export type McpAppViewRecord = z.infer<typeof McpAppViewRecordSchema>;

/** One entry per requested tool call, in request order. */
export const McpAppViewRecordsSchema = z.array(
  z.object({ toolCallId: z.string(), view: McpAppViewRecordSchema })
);

export const McpAppToolCallRequestSchema = z.object({
  workspaceId: z.string().min(1),
  serverName: z.string().min(1),
  toolName: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()),
  /** The user allowed this call in the confirm strip (required for model-visible tools). */
  consented: z.boolean(),
});

/** Allow a view's server to reach more origins; bound by the view's result record. */
export const McpAppApproveDomainsRequestSchema = z.object({
  workspaceId: z.string().min(1),
  toolCallId: z.string().min(1),
  serverName: z.string().min(1),
  // One strip asks for a view's resource and connect domains together (up to 32 each).
  origins: z.array(z.string().max(256)).min(1).max(MCP_APP_VIEW_DOMAINS_MAX),
});

/** One server's approved view origins in one project (Settings → MCP). */
export const McpAppViewDomainsSchema = z.object({
  projectPath: z.string(),
  serverName: z.string(),
  origins: z.array(z.string()),
});
export type McpAppViewDomains = z.infer<typeof McpAppViewDomainsSchema>;

/** resources/read issued by a view; the server is the view's own (bound) server. */
export const McpAppResourceReadRequestSchema = z.object({
  workspaceId: z.string().min(1),
  serverName: z.string().min(1),
  uri: z.string().min(1).max(MCP_APP_READ_URI_MAX_CHARS),
});

/**
 * ui/update-model-context of a view: `text` replaces the view's previous context (empty
 * clears it). The view is bound by its tool call's result record, like getView.
 */
export const McpAppModelContextRequestSchema = z.object({
  workspaceId: z.string().min(1),
  toolCallId: z.string().min(1),
  serverName: z.string().min(1),
  text: z
    .string()
    .refine(
      (text) => new TextEncoder().encode(text).length <= MCP_APP_MODEL_CONTEXT_MAX_BYTES,
      "The model context is too large"
    ),
});

export const McpAppToolCallResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: z.unknown() }),
  /** The tool is visible to the model too: the user must allow this call first. */
  z.object({ status: z.literal("consent_required") }),
  /** The tool is unknown on this server or its visibility lacks "app". */
  z.object({ status: z.literal("rejected"), reason: z.string() }),
]);
export type McpAppToolCallResult = z.infer<typeof McpAppToolCallResultSchema>;
