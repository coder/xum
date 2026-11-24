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

  const hosts = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `https://${prefix}${i}.example.com`);

  test("an invalid ui.csp grants nothing, and lets no legacy list in", () => {
    const alias = { connect_domains: ["https://stale.example.com"] };
    // Malformed, over the per-list limit, or not an object: the server declared the standard
    // field, so a broken one never falls back to the legacy alias.
    for (const csp of [
      { connectDomains: "https://api.example.com" },
      { connectDomains: hosts("ui", 33) },
      "https://api.example.com",
      null,
    ]) {
      expect(read({ ui: { csp }, "openai/widgetCSP": alias }).csp).toEqual({});
    }
    // Without a ui.csp the alias applies in full.
    expect(read({ "openai/widgetCSP": alias }).csp).toEqual({
      connectDomains: ["https://stale.example.com"],
    });
  });

  test("an alias-only declaration keeps the per-list limit", () => {
    const full = read({ "openai/widgetCSP": { connect_domains: hosts("alias", 32) } });
    expect(full.csp.connectDomains).toEqual(hosts("alias", 32));
    expect(McpAppCspDeclarationSchema.safeParse(full.csp).success).toBe(true);
    // One more is a malformed alias: it grants nothing.
    expect(read({ "openai/widgetCSP": { connect_domains: hosts("alias", 33) } }).csp).toEqual({});
  });
});
