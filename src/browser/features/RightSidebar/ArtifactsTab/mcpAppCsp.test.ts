import { describe, expect, test } from "bun:test";
import { buildMcpAppCsp, grantMcpAppCsp } from "./mcpAppCsp";

const BASE =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

describe("MCP Apps view CSP", () => {
  test("without an approval a view gets the base policy and asks for its https origins", () => {
    const { granted, pending, notGranted } = grantMcpAppCsp(
      {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com/"],
      },
      []
    );
    expect(buildMcpAppCsp(granted)).toBe(BASE);
    expect(pending).toEqual(["https://cdn.example.com", "https://api.example.com"]);
    expect(notGranted).toEqual([]);
  });

  test("an approval grants exactly the declared https origins, per directive", () => {
    const { granted, pending } = grantMcpAppCsp(
      {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      },
      // An approved origin the view does not declare is never added.
      ["https://api.example.com", "https://cdn.example.com", "https://other.example"]
    );
    expect(granted).toEqual({
      resourceDomains: ["https://cdn.example.com"],
      connectDomains: ["https://api.example.com"],
    });
    expect(pending).toEqual([]);
    const csp = buildMcpAppCsp(granted);
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
    expect(csp).toContain("connect-src https://api.example.com;");
    expect(csp).not.toContain("other.example");
  });

  test("a newly declared origin asks again, for that origin only", () => {
    const { granted, pending } = grantMcpAppCsp(
      { connectDomains: ["https://api.example.com", "https://new.example.com"] },
      ["https://api.example.com"]
    );
    expect(granted.connectDomains).toEqual(["https://api.example.com"]);
    expect(pending).toEqual(["https://new.example.com"]);
  });

  test("non-https, wildcard, path, frame and base-uri domains are never granted", () => {
    const declared = {
      connectDomains: [
        "http://api.example.com",
        "wss://api.example.com",
        "https://*.example.com",
        "https://api.example.com/v1",
        "https://user@api.example.com",
      ],
      frameDomains: ["https://frame.example.com"],
      baseUriDomains: ["https://base.example.com"],
    };
    // Even "approved" values grant nothing unless they are bare https origins the view declared.
    const { granted, pending, notGranted } = grantMcpAppCsp(declared, [
      ...declared.connectDomains,
      "https://frame.example.com",
      "https://base.example.com",
    ]);
    expect(granted).toEqual({ resourceDomains: [], connectDomains: [] });
    expect(pending).toEqual([]);
    expect(notGranted).toEqual([
      ...declared.connectDomains,
      ...declared.frameDomains,
      ...declared.baseUriDomains,
    ]);
    expect(buildMcpAppCsp(granted)).toBe(BASE);
  });
});
