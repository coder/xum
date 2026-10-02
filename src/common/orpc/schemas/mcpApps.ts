import { z } from "zod";
import { isMcpAppResourceUri } from "@/common/utils/mcpApps";

/**
 * MCP Apps views in the Artifacts tab (artifacts experiment). The view HTML comes from the
 * server's resources/read; the tool result comes from the host-only side store, never from
 * chat history.
 */

const DomainListSchema = z.array(z.string().max(256)).max(32);

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

export const McpAppToolCallRequestSchema = z.object({
  workspaceId: z.string().min(1),
  serverName: z.string().min(1),
  toolName: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()),
  /** The user allowed this call in the confirm strip (required for model-visible tools). */
  consented: z.boolean(),
});

export const McpAppToolCallResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: z.unknown() }),
  /** The tool is visible to the model too: the user must allow this call first. */
  z.object({ status: z.literal("consent_required") }),
  /** The tool is unknown on this server or its visibility lacks "app". */
  z.object({ status: z.literal("rejected"), reason: z.string() }),
]);
export type McpAppToolCallResult = z.infer<typeof McpAppToolCallResultSchema>;
