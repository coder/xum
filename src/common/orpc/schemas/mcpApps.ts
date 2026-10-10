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
  /**
   * Plugin views only: the plugin server key the view was read from, which the view's own
   * tools/call must use. Null for tool-call views (they bind to `invocation`).
   */
  pluginServerKey: z.string().min(1).nullable(),
});
export type McpAppView = z.infer<typeof McpAppViewSchema>;

/**
 * Open a view. "tool": the view a tool call declared, bound to that call's result record.
 * "plugin": a view a plugin declares in its manifest (`contributes.views`). The renderer sends
 * only the plugin view ID; the backend maps it to the plugin's own server and ui:// resource,
 * so a plugin view request can never name an arbitrary server or resource. A plugin view has
 * no tool call: its response has resultAvailable false and invocation null.
 */
export const McpAppViewRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    workspaceId: z.string().min(1),
    toolCallId: z.string().min(1),
    serverName: z.string().min(1),
    resourceUri: z.string().refine(isMcpAppResourceUri, "resourceUri must be a ui:// URI"),
  }),
  z.object({
    kind: z.literal("plugin"),
    workspaceId: z.string().min(1),
    /** `<instanceId>/<viewId>` from listPluginViews. */
    pluginViewId: z.string().min(1).max(128),
  }),
]);

/** A plugin view the workspace can open (listPluginViews). */
export const McpAppPluginViewSchema = z.object({
  pluginViewId: z.string().min(1),
  title: z.string(),
  pluginName: z.string(),
  /** The server's name in the plugin's mcp.json (display only). */
  serverName: z.string(),
  /** The view's own server key: its tools/call target. */
  serverKey: z.string().min(1),
  /** Plugin servers start disabled: the view opens only once the workspace enables its server. */
  enabled: z.boolean(),
});
export type McpAppPluginView = z.infer<typeof McpAppPluginViewSchema>;

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
