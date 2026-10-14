import { describe, expect, test } from "bun:test";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { readOpenAIMcpAuth, readPluginClientSecret, toServerOAuthConfig } from "./openaiMcpAuth";

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

  test("authorization and token endpoint overrides are ignored; discovery supplies them", () => {
    const provided = {
      type: "oauth" as const,
      client: { mode: "provided" as const, clientId: "c" },
    };
    for (const overrides of [
      endpoints,
      // Split origins (the old one-origin case) and a path-scoped tenant are both ignored.
      { authorizationUrl: "https://accounts.example.com/authorize", tokenUrl: endpoints.tokenUrl },
      { ...endpoints, authorizationServerBase: "https://mcp.example.com/tenant-a" },
    ]) {
      const { config, ignored } = toServerOAuthConfig({ ...provided, ...overrides }, { serverUrl });
      expect(ignored).toEqual(["authorizationUrl, tokenUrl (discovery supplies the endpoints)"]);
      expect(config?.clientId).toBe("c");
      expect(JSON.stringify(config)).not.toContain("/authorize");
      expect(JSON.stringify(config)).not.toContain("/token");
    }
  });

  test("a provided private_key_jwt client is dropped so discovery and DCR recover", () => {
    const auth = {
      type: "oauth" as const,
      client: {
        mode: "provided" as const,
        clientId: "c",
        tokenEndpointAuthMethod: "private_key_jwt",
      },
    };
    // Even with a secret source: Xum cannot sign the assertion.
    expect(toServerOAuthConfig(auth, { serverUrl, clientSecretSource: source })).toEqual({
      ignored: ["client (private_key_jwt is not supported)"],
    });
  });

  test("standalone registrationUrl and authorizationServerBase are kept for discovery", () => {
    const dcr = { type: "oauth" as const, client: { mode: "dcr" as const } };
    const registrationUrl = "https://mcp.example.com/register";
    const base = "https://mcp.example.com/tenant";
    expect(toServerOAuthConfig({ ...dcr, registrationUrl }, { serverUrl })).toEqual({
      config: { discovery: { registrationUrl } },
      ignored: [],
    });
    // Checked against the issuer-verified metadata at sign-in, not here.
    expect(
      toServerOAuthConfig({ ...dcr, authorizationServerBase: base, registrationUrl }, { serverUrl })
        .config
    ).toEqual({ discovery: { authorizationServerBase: base, registrationUrl } });
    // A provided client registers nothing: registrationUrl does not apply.
    expect(
      toServerOAuthConfig(
        { type: "oauth", client: { mode: "provided", clientId: "c" }, registrationUrl },
        { serverUrl }
      ).config
    ).toEqual({ clientId: "c" });
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

test("readPluginClientSecret reads wrapped and flat Codex server maps", async () => {
  using tmp = new DisposableTempDir("plugin-secret");
  const pluginRoot = await fs.realpath(tmp.path);
  const mcpConfigPath = path.join(pluginRoot, ".mcp.json");
  const entry = { type: "http", url: "https://x", oauth: { client_id: "c", client_secret: "s1" } };
  for (const doc of [{ mcpServers: { gh: entry } }, { gh: entry }]) {
    await fs.writeFile(mcpConfigPath, JSON.stringify(doc));
    expect(await readPluginClientSecret({ pluginRoot, mcpConfigPath, serverName: "gh" }, "c")).toBe(
      "s1"
    );
  }
});

test("readPluginClientSecret returns no secret once the file names another client (#6297)", async () => {
  using tmp = new DisposableTempDir("plugin-secret");
  const pluginRoot = await fs.realpath(tmp.path);
  const mcpConfigPath = path.join(pluginRoot, ".mcp.json");
  // An edit replaced the client after the flow captured client "c".
  const entry = { type: "http", url: "https://x", oauth: { client_id: "d", client_secret: "s2" } };
  await fs.writeFile(mcpConfigPath, JSON.stringify({ gh: entry }));
  expect(
    await readPluginClientSecret({ pluginRoot, mcpConfigPath, serverName: "gh" }, "c")
  ).toBeUndefined();
});

test("readPluginClientSecret reports malformed JSON without the parser's excerpt (#6297)", async () => {
  using tmp = new DisposableTempDir("plugin-secret");
  const pluginRoot = await fs.realpath(tmp.path);
  const mcpConfigPath = path.join(pluginRoot, ".mcp.json");
  // An unquoted value: the JSON parser quotes it in its error message.
  await fs.writeFile(
    mcpConfigPath,
    '{"gh": {"oauth": {"client_id": "c", "client_secret": s3cr3tValue}}}'
  );
  const error = await readPluginClientSecret(
    { pluginRoot, mcpConfigPath, serverName: "gh" },
    "c"
  ).then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("s3cr3tValue");
});
