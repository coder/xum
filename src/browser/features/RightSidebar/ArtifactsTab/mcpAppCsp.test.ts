import { describe, expect, test } from "bun:test";
import { buildMcpAppCsp, grantMcpAppCsp } from "./mcpAppCsp";

describe("MCP Apps view CSP", () => {
  test("without declarations it is the spec default minus 'self'", () => {
    const { granted, notGranted } = grantMcpAppCsp({}, { allowCdn: true });
    expect(notGranted).toEqual([]);
    expect(buildMcpAppCsp(granted)).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    );
  });

  test("grants only declared https origins that the CDN allowlist also allows", () => {
    const { granted, notGranted } = grantMcpAppCsp(
      {
        resourceDomains: [
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
          "https://evil.example",
          "http://unpkg.com",
          "https://*.unpkg.com",
          "https://unpkg.com/some/path",
        ],
        connectDomains: ["https://api.example.com"],
        frameDomains: ["https://unpkg.com"],
        baseUriDomains: ["https://unpkg.com"],
      },
      { allowCdn: true }
    );
    // jsDelivr narrows to the allowlist's /npm/ path; undeclared CDNs never appear.
    expect(granted).toEqual({
      resourceDomains: ["https://cdn.jsdelivr.net/npm/", "https://unpkg.com"],
      connectDomains: [],
    });
    expect(notGranted).toEqual([
      "https://evil.example",
      "http://unpkg.com",
      "https://*.unpkg.com",
      "https://unpkg.com/some/path",
      "https://api.example.com",
      "https://unpkg.com",
    ]);
    const csp = buildMcpAppCsp(granted);
    expect(csp).toContain(
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ https://unpkg.com;"
    );
    expect(csp).toContain("font-src https://cdn.jsdelivr.net/npm/ https://unpkg.com;");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain("cdnjs");
  });

  test("grants nothing when CDN scripts are off", () => {
    const { granted, notGranted } = grantMcpAppCsp(
      { resourceDomains: ["https://unpkg.com"], connectDomains: ["https://unpkg.com"] },
      { allowCdn: false }
    );
    expect(granted).toEqual({ resourceDomains: [], connectDomains: [] });
    expect(notGranted).toEqual(["https://unpkg.com"]);
  });
});
