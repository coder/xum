import { describe, expect, test } from "bun:test";
import { MCP_APP_MIME_TYPE } from "@/common/utils/mcpApps";
import { McpAppCspDeclarationSchema } from "@/common/orpc/schemas/mcpApps";
import { extractMcpAppResource } from "./mcpAppResource";

const URI = "ui://dice/board.html";
const read = (meta: unknown) =>
  extractMcpAppResource(
    { contents: [{ uri: URI, mimeType: MCP_APP_MIME_TYPE, text: "<p>x</p>", _meta: meta }] },
    URI
  );

describe("extractMcpAppResource CSP", () => {
  test("reads ChatGPT's openai/widgetCSP alias for lists ui.csp omits, without redirect_domains", () => {
    const resource = read({
      ui: { csp: { connectDomains: ["https://api.example.com"] } },
      "openai/widgetCSP": {
        connect_domains: ["https://api.example.com", "https://stale.example.com"],
        resource_domains: ["https://cdn.example.com"],
        frame_domains: ["https://frame.example.com"],
        redirect_domains: ["https://redirect.example.com"],
      },
    });
    // ui.csp declares connectDomains, so the stale legacy connect list adds nothing.
    expect(resource.csp).toEqual({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://frame.example.com"],
    });
    expect(read({}).csp).toEqual({});
  });

  test("an empty standard list overrides the legacy list", () => {
    const resource = read({
      ui: { csp: { connectDomains: [] } },
      "openai/widgetCSP": { connect_domains: ["https://stale.example.com"] },
    });
    expect(resource.csp).toEqual({ connectDomains: [] });
    expect(McpAppCspDeclarationSchema.safeParse(resource.csp).success).toBe(true);
  });
});
