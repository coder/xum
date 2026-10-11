import { z } from "zod";
import {
  MCP_APP_CSP_DOMAINS_MAX,
  MCP_APP_MIME_TYPE,
  MCP_APP_RESOURCE_MAX_BYTES,
  MCP_APP_SKYBRIDGE_MIME_TYPE,
} from "@/common/utils/mcpApps";
import {
  McpAppCspDeclarationSchema,
  type McpAppCspDeclaration,
} from "@/common/orpc/schemas/mcpApps";

export interface McpAppResource {
  html: string;
  csp: McpAppCspDeclaration;
  prefersBorder: boolean | null;
}

/**
 * ChatGPT's legacy `_meta["openai/widgetCSP"]` (snake_case), read next to `_meta.ui.csp`.
 * `redirect_domains` is ignored: it lists window.openai.openExternal redirect targets, not
 * origins the view fetches from or loads, so it maps to no CSP directive.
 */
const DomainList = z.array(z.string().max(256)).max(MCP_APP_CSP_DOMAINS_MAX).optional();
const McpAppWidgetCspSchema = z.object({
  connect_domains: DomainList,
  resource_domains: DomainList,
  frame_domains: DomainList,
});

function mergeCsp(
  ui: McpAppCspDeclaration,
  alias: z.infer<typeof McpAppWidgetCspSchema>
): McpAppCspDeclaration {
  // Capped like each source list, so the merged view still fits McpAppCspDeclarationSchema.
  const union = (a: string[] | undefined, b: string[] | undefined) =>
    a === undefined && b === undefined
      ? undefined
      : [...new Set([...(a ?? []), ...(b ?? [])])].slice(0, MCP_APP_CSP_DOMAINS_MAX);
  const merged: McpAppCspDeclaration = {
    ...ui,
    connectDomains: union(ui.connectDomains, alias.connect_domains),
    resourceDomains: union(ui.resourceDomains, alias.resource_domains),
    frameDomains: union(ui.frameDomains, alias.frame_domains),
  };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a resources/read result for an MCP Apps view and extract its HTML. Accepts only
 * the content for `uri` whose mimeType is exactly MCP_APP_MIME_TYPE or ChatGPT's
 * MCP_APP_SKYBRIDGE_MIME_TYPE, as `text` or a base64 `blob`, up to MCP_APP_RESOURCE_MAX_BYTES
 * of decoded HTML. Throws with a user-facing reason otherwise. Callers validate that `uri` is a
 * ui:// URI before reading.
 *
 * Skybridge is accepted for every view, not only for one reached through
 * `openai/outputTemplate`: the alias is resolved into a plain resourceUri at tool discovery, so
 * this reader cannot tell which key named the view, and carrying that through would add a field
 * to tool metadata, display snapshots and result records. Both types are HTML rendered in the
 * same sandbox, so accepting either grants nothing extra. The declared CSP is `_meta.ui.csp`
 * merged with ChatGPT's `openai/widgetCSP` alias (mergeCsp). Either way a declared domain is
 * granted only after the user approves it for the server (mcpAppCsp.ts).
 */
export function extractMcpAppResource(result: unknown, uri: string): McpAppResource {
  const contents = isRecord(result) && Array.isArray(result.contents) ? result.contents : [];
  const content = contents.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.uri === uri
  );
  if (content === undefined) {
    throw new Error(`The server returned no content for ${uri}`);
  }
  if (content.mimeType !== MCP_APP_MIME_TYPE && content.mimeType !== MCP_APP_SKYBRIDGE_MIME_TYPE) {
    throw new Error(
      `View resource has mime type ${String(content.mimeType)}; expected ${MCP_APP_MIME_TYPE}`
    );
  }
  let bytes: Buffer;
  if (typeof content.text === "string") {
    bytes = Buffer.from(content.text, "utf8");
  } else if (typeof content.blob === "string") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content.blob)) {
      throw new Error("View resource blob is not valid base64");
    }
    bytes = Buffer.from(content.blob, "base64");
  } else {
    throw new Error("View resource has neither text nor blob content");
  }
  if (bytes.byteLength > MCP_APP_RESOURCE_MAX_BYTES) {
    throw new Error(
      `View resource is ${bytes.byteLength} bytes; the limit is ${MCP_APP_RESOURCE_MAX_BYTES}`
    );
  }
  const ui = isRecord(content._meta) && isRecord(content._meta.ui) ? content._meta.ui : {};
  const csp = McpAppCspDeclarationSchema.safeParse(ui.csp ?? {});
  const alias = McpAppWidgetCspSchema.safeParse(
    (isRecord(content._meta) ? content._meta["openai/widgetCSP"] : undefined) ?? {}
  );
  return {
    html: bytes.toString("utf8"),
    // A malformed declaration grants nothing rather than failing the whole view.
    csp: mergeCsp(csp.success ? csp.data : {}, alias.success ? alias.data : {}),
    prefersBorder: typeof ui.prefersBorder === "boolean" ? ui.prefersBorder : null,
  };
}
