import { MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_MAX_BYTES } from "@/common/utils/mcpApps";
import {
  McpAppCspDeclarationSchema,
  type McpAppCspDeclaration,
} from "@/common/orpc/schemas/mcpApps";

export interface McpAppResource {
  html: string;
  csp: McpAppCspDeclaration;
  prefersBorder: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a resources/read result for an MCP Apps view and extract its HTML. Accepts only
 * the content for `uri` whose mimeType is exactly text/html;profile=mcp-app, as `text` or a
 * base64 `blob`, up to MCP_APP_RESOURCE_MAX_BYTES of decoded HTML. Throws with a user-facing
 * reason otherwise. Callers validate that `uri` is a ui:// URI before reading.
 */
export function extractMcpAppResource(result: unknown, uri: string): McpAppResource {
  const contents = isRecord(result) && Array.isArray(result.contents) ? result.contents : [];
  const content = contents.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.uri === uri
  );
  if (content === undefined) {
    throw new Error(`The server returned no content for ${uri}`);
  }
  if (content.mimeType !== MCP_APP_MIME_TYPE) {
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
  return {
    html: bytes.toString("utf8"),
    // A malformed declaration grants nothing rather than failing the whole view.
    csp: csp.success ? csp.data : {},
    prefersBorder: typeof ui.prefersBorder === "boolean" ? ui.prefersBorder : null,
  };
}
