import { describe, expect, test } from "bun:test";

import { readOpenAIMcpAuth, toServerOAuthConfig } from "./openaiMcpAuth";

const withAuth = (auth: unknown) => ({ "com.openai": { auth } });

describe("readOpenAIMcpAuth", () => {
  test("discovery-only oauth/mixed/none auth needs no warning", () => {
    for (const auth of [
      { type: "oauth" },
      { type: "mixed", client: { mode: "dcr" } },
      { type: "none" },
    ]) {
      expect(readOpenAIMcpAuth(withAuth(auth))).toMatchObject({ warnings: [], ignored: [] });
    }
    expect(readOpenAIMcpAuth({ "com.example": 1 })).toEqual({ warnings: [], ignored: [] });
  });

  test("parses a provided client and api_key settings, listing them as ignored", () => {
    const oauth = readOpenAIMcpAuth(
      withAuth({
        type: "oauth",
        client: { mode: "provided", clientId: "c", tokenEndpointAuthMethod: "none" },
        resource: "https://example.com",
        defaultScopes: [],
      })
    );
    expect(oauth.warnings).toEqual([]);
    expect(oauth.auth).toEqual({
      type: "oauth",
      client: { mode: "provided", clientId: "c", tokenEndpointAuthMethod: "none" },
      resource: "https://example.com",
      defaultScopes: [],
    });

    const apiKey = readOpenAIMcpAuth(
      withAuth({ type: "api_key", headerScheme: "custom_header", headerName: "X-Key" })
    );
    expect(apiKey.ignored).toEqual([
      "type: api_key (no plugin API key storage)",
      "headerScheme",
      "headerName",
    ]);
  });

  test("names a forbidden client secret without its value; drops malformed fields", () => {
    const result = readOpenAIMcpAuth(
      withAuth({
        type: "oauth",
        clientSecret: "top-secret-1",
        client: { mode: "dcr", clientId: "not-allowed", client_secret: "top-secret-2" },
        tokenUrl: "https://user:pw@example.com/token",
        baseScopes: [" "],
        oops: 1,
      })
    );
    expect(result.ignored).toEqual(["clientSecret", "client.client_secret"]);
    expect(result.auth).toEqual({ type: "oauth", client: { mode: "dcr" } });
    expect(result.warnings).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("pw@");
  });

  test("a provided client without a clientId is dropped with a warning", () => {
    const result = readOpenAIMcpAuth(withAuth({ type: "oauth", client: { mode: "provided" } }));
    expect(result.auth).toEqual({ type: "oauth" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("client.clientId' is required");
  });

  test("an unknown auth type ignores the whole block", () => {
    const result = readOpenAIMcpAuth(withAuth({ type: "magic", clientSecret: "s3cret" }));
    expect(result.auth).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
});

describe("toServerOAuthConfig", () => {
  const serverUrl = "https://mcp.example.com/mcp";
  const endpoints = {
    authorizationUrl: "https://mcp.example.com/authorize",
    tokenUrl: "https://mcp.example.com/token",
  };
  const source = { pluginRoot: "/p", mcpConfigPath: "/p/.mcp.json", serverName: "s" };

  test("a secret method without a secret source falls back to discovery and DCR", () => {
    const auth = {
      type: "oauth" as const,
      client: {
        mode: "provided" as const,
        clientId: "c",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    };
    expect(toServerOAuthConfig(auth, { serverUrl })).toEqual({
      ignored: ["client (client_secret_post needs a client secret)"],
    });
    expect(toServerOAuthConfig(auth, { serverUrl, clientSecretSource: source }).config).toEqual({
      clientId: "c",
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecretSource: source,
    });
  });

  test("endpoint overrides without a provided client need registrationUrl", () => {
    const dcr = { type: "oauth" as const, client: { mode: "dcr" as const }, ...endpoints };
    expect(toServerOAuthConfig(dcr, { serverUrl })).toEqual({
      ignored: ["authorizationUrl, tokenUrl (registration needs registrationUrl)"],
    });
    const registrationUrl = "https://mcp.example.com/register";
    expect(toServerOAuthConfig({ ...dcr, registrationUrl }, { serverUrl }).config).toEqual({
      endpoints: { ...endpoints, registrationUrl },
    });
  });

  test("a resource that does not cover the server URL is dropped", () => {
    expect(
      toServerOAuthConfig({ type: "oauth", resource: "https://evil.example.com" }, { serverUrl })
    ).toEqual({ ignored: ["resource (does not cover the server URL)"] });
    expect(
      toServerOAuthConfig({ type: "oauth", resource: "https://mcp.example.com" }, { serverUrl })
        .config
    ).toEqual({ resource: "https://mcp.example.com" });
  });
});
