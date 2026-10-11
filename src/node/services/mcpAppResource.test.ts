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
  test("reads ChatGPT's openai/widgetCSP alias next to ui.csp, without redirect_domains", () => {
    const resource = read({
      ui: { csp: { connectDomains: ["https://api.example.com"] } },
      "openai/widgetCSP": {
        connect_domains: ["https://api.example.com", "https://alias.example.com"],
        resource_domains: ["https://cdn.example.com"],
        frame_domains: ["https://frame.example.com"],
        redirect_domains: ["https://redirect.example.com"],
      },
    });
    expect(resource.csp).toEqual({
      connectDomains: ["https://api.example.com", "https://alias.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://frame.example.com"],
    });
    expect(read({}).csp).toEqual({});
  });

  test("merged lists stay within the declaration limit the view schema accepts", () => {
    const hosts = (prefix: string) =>
      Array.from({ length: 32 }, (_, i) => `https://${prefix}${i}.example.com`);
    const resource = read({
      ui: { csp: { connectDomains: hosts("ui") } },
      "openai/widgetCSP": { connect_domains: hosts("alias") },
    });
    // _meta.ui.csp comes first and wins the slots.
    expect(resource.csp.connectDomains).toEqual(hosts("ui"));
    expect(McpAppCspDeclarationSchema.safeParse(resource.csp).success).toBe(true);
  });
});
