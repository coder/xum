import { describe, expect, test } from "bun:test";

import { readOpenAIMcpAuth } from "./openaiMcpAuth";

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

  test("an http endpoint override is kept only for a loopback host", () => {
    const result = readOpenAIMcpAuth(
      withAuth({
        type: "oauth",
        authorizationUrl: "http://127.0.0.1:8080/authorize",
        tokenUrl: "http://localhost:8080/token",
        registrationUrl: "http://[::1]:8080/register",
        authorizationServerBase: "http://auth.example.com",
      })
    );
    expect(result.auth).toEqual({
      type: "oauth",
      authorizationUrl: "http://127.0.0.1:8080/authorize",
      tokenUrl: "http://localhost:8080/token",
      registrationUrl: "http://[::1]:8080/register",
    });
    // A network http endpoint would expose the code and the secret: still dropped.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("authorizationServerBase");
  });

  test("an unknown auth type ignores the whole block", () => {
    const result = readOpenAIMcpAuth(withAuth({ type: "magic", clientSecret: "s3cret" }));
    expect(result.auth).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
});
