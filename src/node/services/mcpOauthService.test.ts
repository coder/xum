import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "http";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { MCPConfigService } from "./mcpConfigService";
import { log } from "./log";
import {
  McpOauthService,
  parseBearerWwwAuthenticate,
  probeServerForBearerChallenge,
  resolveOAuthScope,
} from "./mcpOauthService";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { Ok } from "@/common/types/result";
import type { MCPServerOAuthConfig } from "@/common/types/mcp";
import type {
  MCPOAuthClientInformation,
  MCPOAuthStoredCredentials,
  MCPOAuthTokens,
} from "@/common/types/mcpOauth";

interface StoreSnapshot {
  version: 2;
  entries: Record<string, MCPOAuthStoredCredentials>;
}

function getStoreFilePath(xumHome: string): string {
  return path.join(xumHome, "mcp-oauth.json");
}

describe("McpOauthService store", () => {
  let xumHome: string;
  let projectPath: string;
  let config: Config;
  let mcpConfigService: MCPConfigService;
  let service: McpOauthService;

  const serverName = "test-server";
  const serverUrl = "https://example.com";
  const authorizationServerUrl = "https://auth.example.com/";
  const tokenEndpoint = "https://auth.example.com/token";
  const discoveryState: OAuthDiscoveryState = {
    authorizationServerUrl,
    authorizationServerMetadata: {
      issuer: authorizationServerUrl,
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: tokenEndpoint,
      response_types_supported: ["code"],
    },
  };

  beforeEach(async () => {
    xumHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-home-"));
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-project-"));

    config = new Config(xumHome);
    mcpConfigService = new MCPConfigService(config);
    service = new McpOauthService(config, mcpConfigService);

    const addResult = await mcpConfigService.addServer(serverName, {
      transport: "http",
      url: serverUrl,
    });
    expect(addResult).toEqual({ success: true, data: undefined });
  });

  afterEach(async () => {
    await service.dispose();
    await fs.rm(xumHome, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  async function readStoreFile(): Promise<StoreSnapshot> {
    const raw = await fs.readFile(getStoreFilePath(xumHome), "utf-8");
    return JSON.parse(raw) as StoreSnapshot;
  }

  async function seedStoredCredentials(input: {
    clientInformation: MCPOAuthClientInformation;
    tokens: MCPOAuthTokens;
  }): Promise<void> {
    await fs.writeFile(
      getStoreFilePath(xumHome),
      JSON.stringify({
        version: 2,
        entries: {
          "https://example.com/": {
            serverUrl,
            updatedAtMs: Date.now(),
            clientInformation: input.clientInformation,
            tokens: input.tokens,
          },
        },
      }),
      "utf-8"
    );
  }

  test("a server name that is an Object.prototype key is not a configured server (#5740)", async () => {
    // Without the fix these lookups read Object.prototype.toString as a server with no URL.
    for (const name of ["toString", "constructor"]) {
      expect(await service.getProjectAuthStatus({ projectPath, serverName: name })).toEqual({
        isLoggedIn: false,
        hasRefreshToken: false,
      });
      expect(await service.logoutProjectServer({ projectPath, serverName: name })).toEqual(
        Ok(undefined)
      );
      expect(await service.startDesktopFlow({ projectPath, serverName: name })).toEqual({
        success: false,
        error: "MCP server not found",
      });
    }
  });

  test("reading corrupt JSON store self-heals to empty", async () => {
    await fs.writeFile(getStoreFilePath(xumHome), "{ definitely not valid json", "utf-8");

    const status = await service.getAuthStatus({ serverUrl });
    expect(status).toEqual({
      serverUrl: "https://example.com/",
      isLoggedIn: false,
      hasRefreshToken: false,
      scope: undefined,
      updatedAtMs: undefined,
    });

    // The invalid store file should be overwritten with a minimal empty store.
    expect(await readStoreFile()).toEqual({ version: 2, entries: {} });
  });

  test("migrates v1 store to v2 (dedupes by updatedAtMs)", async () => {
    const otherProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-project2-"));

    try {
      const v1Store = {
        version: 1,
        entries: {
          [projectPath]: {
            // Older duplicate for the same server URL.
            [serverName]: {
              serverUrl,
              updatedAtMs: 1_000,
              clientInformation: {
                client_id: "client-id-old",
              },
              tokens: {
                access_token: "access-token-old",
                token_type: "Bearer",
                refresh_token: "refresh-token-old",
              },
            },
            // Newer duplicate for the same server URL.
            duplicate: {
              serverUrl,
              updatedAtMs: 2_000,
              clientInformation: {
                client_id: "client-id-new",
              },
              tokens: {
                access_token: "access-token-new",
                token_type: "Bearer",
                refresh_token: "refresh-token-new",
              },
            },
          },
          [otherProjectPath]: {
            other: {
              serverUrl: "https://other.example.com/mcp/",
              updatedAtMs: 1_500,
              clientInformation: {
                client_id: "client-id-other",
              },
              tokens: {
                access_token: "access-token-other",
                token_type: "Bearer",
              },
            },
          },
        },
      };

      await fs.writeFile(getStoreFilePath(xumHome), JSON.stringify(v1Store), "utf-8");

      // Trigger store load + migration.
      await service.getAuthStatus({ serverUrl });

      expect(await readStoreFile()).toEqual({
        version: 2,
        entries: {
          "https://example.com/": {
            serverUrl: "https://example.com/",
            updatedAtMs: 2_000,
            clientInformation: {
              client_id: "client-id-new",
            },
            tokens: {
              access_token: "access-token-new",
              token_type: "Bearer",
              refresh_token: "refresh-token-new",
            },
          },
          "https://other.example.com/mcp": {
            serverUrl: "https://other.example.com/mcp",
            updatedAtMs: 1_500,
            clientInformation: {
              client_id: "client-id-other",
            },
            tokens: {
              access_token: "access-token-other",
              token_type: "Bearer",
            },
          },
        },
      });
    } finally {
      await fs.rm(otherProjectPath, { recursive: true, force: true });
    }
  });

  test("set/get/clear works via hasAuthTokens + logout", async () => {
    const populatedStore = {
      version: 2,
      entries: {
        "https://example.com/": {
          serverUrl,
          updatedAtMs: Date.now(),
          clientInformation: {
            client_id: "client-id",
          },
          tokens: {
            access_token: "access-token",
            token_type: "Bearer",
            refresh_token: "refresh-token",
            scope: "mcp.read",
          },
        },
      },
    };
    await fs.writeFile(getStoreFilePath(xumHome), JSON.stringify(populatedStore), "utf-8");

    expect(
      await service.hasAuthTokens({
        serverUrl,
      })
    ).toBe(true);

    const status = await service.getAuthStatus({ serverUrl });
    expect(typeof status.updatedAtMs).toBe("number");
    expect(status).toEqual({
      serverUrl: "https://example.com/",
      isLoggedIn: true,
      hasRefreshToken: true,
      scope: "mcp.read",
      updatedAtMs: status.updatedAtMs,
    });

    const logoutResult = await service.logout({ serverUrl });
    expect(logoutResult).toEqual({ success: true, data: undefined });

    expect(
      await service.hasAuthTokens({
        serverUrl,
      })
    ).toBe(false);

    expect(await readStoreFile()).toEqual({ version: 2, entries: {} });
  });

  // Regression test: the legacy @ai-sdk/mcp auth() only used a stored
  // refresh_token when the persisted tokens/clientInformation retained the
  // authorization_server + token_endpoint binding it saved. Stripping them
  // during store parsing made auth() invalidate the tokens and demand
  // interactive re-login after every app restart. The official SDK v2 ignores
  // these fields (it stamps `issuer` instead), but the store must keep
  // round-tripping them so downgrading Xum does not break token refresh.
  test("authorization server binding survives store round-trip", async () => {
    const populatedStore = {
      version: 2,
      entries: {
        "https://example.com/": {
          serverUrl,
          updatedAtMs: Date.now(),
          clientInformation: {
            client_id: "client-id",
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
          },
          tokens: {
            access_token: "access-token",
            token_type: "Bearer",
            refresh_token: "refresh-token",
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
          },
        },
      },
    };
    await fs.writeFile(getStoreFilePath(xumHome), JSON.stringify(populatedStore), "utf-8");

    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(provider).toBeDefined();

    // The SDK types no longer carry the legacy binding fields; read them via
    // Xum's storage type, which is what the provider actually returns.
    const tokens = (await provider!.tokens()) as MCPOAuthTokens | undefined;
    expect(tokens?.refresh_token).toBe("refresh-token");
    expect(tokens?.authorization_server).toBe("https://auth.example.com/");
    expect(tokens?.token_endpoint).toBe("https://auth.example.com/token");

    const clientInformation = (await provider!.clientInformation()) as
      | MCPOAuthClientInformation
      | undefined;
    expect(clientInformation?.authorization_server).toBe("https://auth.example.com/");
    expect(clientInformation?.token_endpoint).toBe("https://auth.example.com/token");
  });

  test("saveTokens stamps the legacy binding from discovery state", async () => {
    await seedStoredCredentials({
      clientInformation: { client_id: "client-id", issuer: authorizationServerUrl },
      tokens: {
        access_token: "access-token",
        token_type: "Bearer",
        refresh_token: "refresh-token",
        issuer: authorizationServerUrl,
      },
    });

    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(provider).toBeDefined();

    await provider!.saveDiscoveryState?.(discoveryState);
    await provider!.saveTokens({
      access_token: "new-access-token",
      token_type: "Bearer",
      refresh_token: "new-refresh-token",
      issuer: authorizationServerUrl,
    });

    const stored = (await readStoreFile()).entries["https://example.com/"];
    expect(stored.tokens).toEqual({
      access_token: "new-access-token",
      token_type: "Bearer",
      refresh_token: "new-refresh-token",
      issuer: authorizationServerUrl,
      authorization_server: authorizationServerUrl,
      token_endpoint: tokenEndpoint,
    });
  });

  test("saveTokens preserves the legacy binding without discovery state", async () => {
    await seedStoredCredentials({
      clientInformation: { client_id: "client-id" },
      tokens: {
        access_token: "access-token",
        token_type: "Bearer",
        refresh_token: "refresh-token",
        authorization_server: authorizationServerUrl,
        token_endpoint: tokenEndpoint,
      },
    });

    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(provider).toBeDefined();

    await provider!.saveTokens({
      access_token: "new-access-token",
      token_type: "Bearer",
      refresh_token: "new-refresh-token",
      issuer: authorizationServerUrl,
    });

    const stored = (await readStoreFile()).entries["https://example.com/"];
    expect(stored.tokens).toEqual({
      access_token: "new-access-token",
      token_type: "Bearer",
      refresh_token: "new-refresh-token",
      issuer: authorizationServerUrl,
      authorization_server: authorizationServerUrl,
      token_endpoint: tokenEndpoint,
    });
  });

  test("saveClientInformation stamps the legacy binding from discovery state", async () => {
    await seedStoredCredentials({
      clientInformation: { client_id: "client-id", issuer: authorizationServerUrl },
      tokens: {
        access_token: "access-token",
        token_type: "Bearer",
        refresh_token: "refresh-token",
        issuer: authorizationServerUrl,
      },
    });

    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(provider).toBeDefined();

    await provider!.saveDiscoveryState?.(discoveryState);
    await provider!.saveClientInformation?.({ client_id: "new-client-id" });

    const stored = (await readStoreFile()).entries["https://example.com/"];
    expect(stored.clientInformation).toEqual({
      client_id: "new-client-id",
      authorization_server: authorizationServerUrl,
      token_endpoint: tokenEndpoint,
    });
  });

  test.each([true, false])(
    "partial discovery preserves only an existing complete binding (existing: %s)",
    async (hasExistingBinding) => {
      const existingBinding = hasExistingBinding
        ? {
            authorization_server: authorizationServerUrl,
            token_endpoint: tokenEndpoint,
          }
        : {};
      await seedStoredCredentials({
        clientInformation: { client_id: "client-id" },
        tokens: {
          access_token: "access-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
          ...existingBinding,
        },
      });

      const provider = await service.getAuthProviderForServer({ serverUrl });
      expect(provider).toBeDefined();

      await provider!.saveDiscoveryState?.({ authorizationServerUrl });
      await provider!.saveTokens({
        access_token: "new-access-token",
        token_type: "Bearer",
        refresh_token: "new-refresh-token",
        issuer: authorizationServerUrl,
      });

      const stored = (await readStoreFile()).entries["https://example.com/"];
      expect(stored.tokens).toEqual({
        access_token: "new-access-token",
        token_type: "Bearer",
        refresh_token: "new-refresh-token",
        issuer: authorizationServerUrl,
        ...existingBinding,
      });
    }
  );

  test.each([
    // Corrupted: not a parseable URL.
    "not a url",
    // Parseable but rejected by the MCP SDK's SafeUrlSchema; must be dropped
    // for self-healing rather than surfacing as a metadata mismatch in auth().
    "javascript:alert(1)",
    "data:text/plain,x",
    "vbscript:x",
    // Parseable non-http(s) scheme: OAuth endpoints are always http(s).
    "ftp://auth.example.com/",
  ])("invalid authorization server binding %j is dropped as a pair", async (badUrl) => {
    const populatedStore = {
      version: 2,
      entries: {
        "https://example.com/": {
          serverUrl,
          updatedAtMs: Date.now(),
          clientInformation: { client_id: "client-id" },
          tokens: {
            access_token: "access-token",
            token_type: "Bearer",
            refresh_token: "refresh-token",
            authorization_server: badUrl,
            token_endpoint: "https://auth.example.com/token",
          },
        },
      },
    };
    await fs.writeFile(getStoreFilePath(xumHome), JSON.stringify(populatedStore), "utf-8");

    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(provider).toBeDefined();

    const tokens = (await provider!.tokens()) as MCPOAuthTokens | undefined;
    expect(tokens?.refresh_token).toBe("refresh-token");
    expect(tokens?.authorization_server).toBeUndefined();
    expect(tokens?.token_endpoint).toBeUndefined();
  });
});

describe("parseBearerWwwAuthenticate", () => {
  test("extracts scope and resource_metadata", () => {
    const header =
      'Bearer realm="example", scope="mcp.read mcp.write", resource_metadata="https://example.com/.well-known/oauth-protected-resource"';

    const challenge = parseBearerWwwAuthenticate(header);
    expect(challenge).not.toBeNull();
    expect(challenge?.scope).toBe("mcp.read mcp.write");
    expect(challenge?.resourceMetadataUrl?.toString()).toBe(
      "https://example.com/.well-known/oauth-protected-resource"
    );
  });

  test("extracts unquoted scope and resource_metadata", () => {
    const header =
      "Bearer scope=mcp.read resource_metadata=http://example.com/.well-known/oauth-protected-resource";

    const challenge = parseBearerWwwAuthenticate(header);
    expect(challenge).not.toBeNull();
    expect(challenge?.scope).toBe("mcp.read");
    expect(challenge?.resourceMetadataUrl?.toString()).toBe(
      "http://example.com/.well-known/oauth-protected-resource"
    );
  });

  test("returns null for non-bearer challenges", () => {
    expect(parseBearerWwwAuthenticate('Basic realm="example"')).toBeNull();
  });

  test("ignores invalid resource_metadata URLs", () => {
    const header = 'Bearer scope="mcp.read" resource_metadata="not a url"';

    const challenge = parseBearerWwwAuthenticate(header);
    expect(challenge).not.toBeNull();
    expect(challenge?.scope).toBe("mcp.read");
    expect(challenge?.resourceMetadataUrl).toBeUndefined();
  });
});

describe("probeServerForBearerChallenge", () => {
  test("prefers POST for http servers that reject GET", async () => {
    let resourceMetadataUrl = "";
    const seenMethods: string[] = [];

    const server = createServer((req, res) => {
      seenMethods.push(req.method ?? "UNKNOWN");
      res.statusCode = req.method === "POST" ? 401 : 405;
      if (req.method === "POST") {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
        );
      }
      res.end(req.method === "POST" ? "Unauthorized" : "Method Not Allowed");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind probe test server");
      }

      const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

      const challenge = await probeServerForBearerChallenge({
        serverUrl: baseUrl,
        transport: "http",
      });

      expect(challenge).toMatchObject({
        raw: `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`,
        scope: "mcp.read",
      });
      expect(challenge?.resourceMetadataUrl?.toString()).toBe(resourceMetadataUrl);
      expect(seenMethods).toEqual(["POST"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("falls back to GET for auto servers when POST has no challenge", async () => {
    let resourceMetadataUrl = "";
    const seenMethods: string[] = [];

    const server = createServer((req, res) => {
      seenMethods.push(req.method ?? "UNKNOWN");
      if (req.method === "POST") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      res.statusCode = 401;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
      );
      res.end("Unauthorized");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind auto probe test server");
      }

      const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

      const challenge = await probeServerForBearerChallenge({
        serverUrl: baseUrl,
        transport: "auto",
      });

      expect(challenge).toMatchObject({
        raw: `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`,
        scope: "mcp.read",
      });
      expect(challenge?.resourceMetadataUrl?.toString()).toBe(resourceMetadataUrl);
      expect(seenMethods).toEqual(["POST", "GET"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** RFC 8414 metadata of a test authorization server at `issuer`. */
function authServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** A local MCP server (401 at /mcp) that is its own authorization server. */
async function withAuthServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "flow-token", token_type: "Bearer" }));
      return;
    }
    if (pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(authServerMetadata(`http://${req.headers.host ?? ""}`)));
      return;
    }
    res.statusCode = pathname === "/mcp" ? 401 : 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("McpOauthService OAuth flows", () => {
  let xumHome: string;
  let projectPath: string;
  let config: Config;
  let mcpConfigService: MCPConfigService;
  let service: McpOauthService;

  beforeEach(async () => {
    xumHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-home-"));
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-project-"));

    config = new Config(xumHome);
    mcpConfigService = new MCPConfigService(config);
    service = new McpOauthService(config, mcpConfigService);
  });

  afterEach(async () => {
    await service.dispose();
    await fs.rm(xumHome, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  test("API helpers default global scope and derive callback origins", async () => {
    const flow = { flowId: "id", authorizeUrl: "https://auth", redirectUri: "https://callback" };
    const startServerFlow = spyOn(service, "startServerFlow").mockResolvedValue(Ok(flow));

    await service.startServerFlowForApi(
      { serverName: "server" },
      { origin: "https://app.example.com/settings" }
    );
    expect(startServerFlow).toHaveBeenCalledWith({
      projectPath: xumHome,
      serverName: "server",
      redirectUri: "https://app.example.com/auth/mcp-oauth/callback",
    });

    await service.startServerFlowForApi(
      { projectPath, serverName: "server" },
      { "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "https" }
    );
    expect(startServerFlow).toHaveBeenLastCalledWith(
      expect.objectContaining({ redirectUri: "https://proxy.example.com/auth/mcp-oauth/callback" })
    );
  });

  test("generates an authorizeUrl with PKCE S256 + RFC 8707 resource", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";

    const server = createServer((req, res) => {
      void (async () => {
        const pathname = (req.url ?? "/").split("?")[0];

        if (pathname === "/.well-known/oauth-protected-resource") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              resource: baseUrl,
              authorization_servers: [baseUrl],
            })
          );
          return;
        }

        if (pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              // RFC 8414 canonical issuer: no trailing slash at the root.
              // The MCP SDK strictly validates metadata issuer identity.
              issuer: new URL(baseUrl).origin,
              authorization_endpoint: `${baseUrl}authorize`,
              token_endpoint: `${baseUrl}token`,
              registration_endpoint: `${baseUrl}register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            })
          );
          return;
        }

        if (pathname === "/register") {
          let raw = "";
          for await (const chunk of req) {
            raw += Buffer.from(chunk as Uint8Array).toString("utf-8");
          }

          const clientMetadata = JSON.parse(raw) as Record<string, unknown>;

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...clientMetadata,
              client_id: "test-client-id",
            })
          );
          return;
        }

        // Default: act like an MCP server requiring OAuth.
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
        );
        res.end("Unauthorized");
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind OAuth test server");
      }

      baseUrl = `http://127.0.0.1:${address.port}/`;
      resourceMetadataUrl = `${baseUrl}.well-known/oauth-protected-resource`;

      const serverName = "oauth-server";

      const addResult = await mcpConfigService.addServer(serverName, {
        transport: "http",
        url: baseUrl,
      });
      expect(addResult).toEqual({ success: true, data: undefined });

      const startResult = await service.startDesktopFlow({ projectPath, serverName });
      expect(startResult.success).toBe(true);
      if (!startResult.success) {
        throw new Error(startResult.error);
      }

      const authorizeUrl = new URL(startResult.data.authorizeUrl);
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      // The SDK sends the canonicalized server URL as the RFC 8707 resource
      // (the legacy @ai-sdk/mcp collapsed root URLs to their origin instead;
      // both name the same resource). Base-path URLs are covered below.
      expect(authorizeUrl.searchParams.get("resource")).toBe(new URL(baseUrl).toString());

      // Clean up the loopback listener (no callback will occur during this test).
      await service.cancelDesktopFlow(startResult.data.flowId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("logout cancels a sign-in flow already running for that server", async () => {
    await withAuthServer(async (base) => {
      spyOn(mcpConfigService, "listServers").mockResolvedValue({
        docs: { transport: "http", url: `${base}/mcp`, disabled: true, oauth: { clientId: "c" } },
      });
      const start = await service.startServerFlow({
        projectPath,
        serverName: "docs",
        redirectUri: "https://x/cb",
      });
      if (!start.success) throw new Error(start.error);
      await service.logout({ serverUrl: `${base}/mcp/` });
      expect(await service.waitForServerFlow(start.data.flowId)).toEqual({
        success: false,
        error: "Signed out",
      });
    });
  });

  test("a token exchange in flight when the user signs out saves nothing", async () => {
    let tokenRequested!: () => void;
    const requested = new Promise<void>((resolve) => (tokenRequested = resolve));
    let releaseToken!: () => void;
    const release = new Promise<void>((resolve) => (releaseToken = resolve));
    const server = createServer((req, res) => {
      void (async () => {
        for await (const _chunk of req) {
          // Drain the body.
        }
        if ((req.url ?? "").startsWith("/token")) {
          tokenRequested();
          await release;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "late", token_type: "Bearer" }));
          return;
        }
        if ((req.url ?? "").startsWith("/.well-known/oauth-authorization-server")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(authServerMetadata(`http://${req.headers.host ?? ""}`)));
          return;
        }
        res.statusCode = (req.url ?? "").startsWith("/mcp") ? 401 : 404;
        res.end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Failed to bind");
      const base = `http://127.0.0.1:${address.port}`;
      spyOn(mcpConfigService, "listServers").mockResolvedValue({
        docs: {
          transport: "http",
          url: `${base}/mcp`,
          disabled: true,
          oauth: { clientId: "c" },
        },
      });
      const start = await service.startServerFlow({
        projectPath,
        serverName: "docs",
        redirectUri: "https://x/cb",
      });
      if (!start.success) throw new Error(start.error);
      // The callback passed its settled check and is waiting on the token endpoint.
      const exchange = service.handleServerCallbackAndExchange({
        state: start.data.flowId,
        code: "the-code",
        iss: null,
        error: null,
      });
      await requested;
      await service.logout({ serverUrl: `${base}/mcp` });
      releaseToken();
      await exchange;
      // No tokens at all (hasAuthTokens would also need the deleted client record).
      expect((await service.getAuthStatus({ serverUrl: `${base}/mcp` })).isLoggedIn).toBe(false);
      // A flow started after the sign-out saves again.
      const again = await service.startServerFlow({
        projectPath,
        serverName: "docs",
        redirectUri: "https://x/cb",
      });
      if (!again.success) throw new Error(again.error);
      await service.handleServerCallbackAndExchange({
        state: again.data.flowId,
        code: "the-code",
        iss: null,
        error: null,
      });
      expect(await service.hasAuthTokens({ serverUrl: `${base}/mcp` })).toBe(true);
    } finally {
      releaseToken();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a registered client's token endpoint auth method survives a restart", async () => {
    const serverUrl = "https://example.com/mcp";
    await fs.writeFile(
      getStoreFilePath(xumHome),
      JSON.stringify({
        version: 2,
        entries: {
          [serverUrl]: {
            serverUrl,
            updatedAtMs: Date.now(),
            clientInformation: {
              client_id: "dcr-client",
              client_secret: "dcr-secret",
              token_endpoint_auth_method: "client_secret_post",
            },
            tokens: { access_token: "at", token_type: "Bearer", refresh_token: "rt" },
          },
        },
      })
    );
    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(await provider?.clientInformation()).toMatchObject({
      client_id: "dcr-client",
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  test("standalone registrationUrl and authorizationServerBase merge with discovery", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0];
      paths.push(pathname);
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const metadata = (issuer: string) => ({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
      if (pathname === "/.well-known/oauth-protected-resource/mcp")
        return json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (pathname === "/.well-known/oauth-authorization-server") return json(metadata(base));
      if (pathname === "/.well-known/oauth-authorization-server/tenant")
        return json(metadata(`${base}/tenant`));
      // Tenant A's metadata claims to be tenant B on the same origin.
      if (pathname === "/.well-known/oauth-authorization-server/tenant-a")
        return json(metadata(`${base}/tenant-b`));
      if (pathname.endsWith("register")) {
        void (async () => {
          let raw = "";
          for await (const chunk of req) raw += Buffer.from(chunk as Uint8Array).toString("utf-8");
          json({ ...(JSON.parse(raw) as object), client_id: "registered" });
        })();
        return;
      }
      res.statusCode = pathname === "/mcp" ? 401 : 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Failed to bind");
      const base = `http://127.0.0.1:${address.port}`;
      const signIn = async (discovery: {
        authorizationServerBase?: string;
        registrationUrl?: string;
      }) => {
        paths.length = 0;
        const listServers = spyOn(mcpConfigService, "listServers").mockResolvedValue({
          docs: { transport: "http", url: `${base}/mcp`, disabled: true, oauth: { discovery } },
        });
        const start = await service.startServerFlow({
          projectPath,
          serverName: "docs",
          redirectUri: "https://x/cb",
        });
        listServers.mockRestore();
        if (!start.success) return `refused: ${start.error}`;
        await service.cancelServerFlow(start.data.flowId);
        return new URL(start.data.authorizeUrl).pathname;
      };
      // registrationUrl alone: discovery supplies the endpoints, registration goes there.
      expect(await signIn({ registrationUrl: `${base}/custom-register` })).toBe("/authorize");
      expect(paths).toContain("/custom-register");
      expect(paths).not.toContain("/register");
      // On a foreign origin (localhost is not 127.0.0.1) it is dropped for the discovered one.
      await signIn({ registrationUrl: `http://localhost:${address.port}/custom-register` });
      expect(paths).toContain("/register");
      expect(paths).not.toContain("/custom-register");
      // authorizationServerBase alone: only where discovery looks changes.
      expect(await signIn({ authorizationServerBase: `${base}/tenant` })).toBe("/tenant/authorize");
      expect(paths).toContain("/tenant/register");

      // Tenants share an origin: the full issuer URL decides, path included.
      // A registrationUrl under another tenant's path is dropped...
      await signIn({
        authorizationServerBase: `${base}/tenant`,
        registrationUrl: `${base}/tenant-b/register`,
      });
      expect(paths).toContain("/tenant/register");
      expect(paths).not.toContain("/tenant-b/register");
      // ...one under the issuer's own path is kept.
      await signIn({
        authorizationServerBase: `${base}/tenant`,
        registrationUrl: `${base}/tenant/custom-register`,
      });
      expect(paths).toContain("/tenant/custom-register");
      expect(paths).not.toContain("/tenant/register");
      // A base whose metadata names another issuer is refused (the SDK's RFC 8414 check).
      expect(await signIn({ authorizationServerBase: `${base}/tenant-a` })).toStartWith("refused:");
      // Also when a registrationUrl makes Xum run that discovery itself.
      expect(
        await signIn({
          authorizationServerBase: `${base}/tenant-a`,
          registrationUrl: `${base}/tenant-b/register`,
        })
      ).toStartWith("refused:");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("stored credentials serve only the issuer that minted them", () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const pinned = (issuer: string): MCPServerOAuthConfig => ({
      clientId: "shared",
      discovery: { authorizationServerBase: issuer },
    });
    const issuerA = "https://a.example.com";
    const seed = async (clientIssuer: string | null = issuerA) =>
      fs.writeFile(
        getStoreFilePath(xumHome),
        JSON.stringify({
          version: 2,
          entries: {
            [serverUrl]: {
              serverUrl,
              updatedAtMs: Date.now(),
              clientInformation: {
                client_id: "shared",
                ...(clientIssuer !== null ? { issuer: clientIssuer } : {}),
              },
              tokens: { access_token: "at-a", token_type: "Bearer", issuer: issuerA },
            },
          },
        })
      );
    const usable = async (oauth: MCPServerOAuthConfig) =>
      (await service.getAuthProviderForServer({ serverUrl, oauth })) !== undefined &&
      (await service.hasAuthTokens({ serverUrl, oauth })) &&
      (await service.getAuthStatus({ serverUrl, oauth })).isLoggedIn;

    test("a server removed and re-added under another issuer, same client, reuses nothing", async () => {
      // Removal resets nothing and the re-add finds no previous entry, so the issuer-A
      // credentials are still stored when the server comes back pinned to issuer B.
      await seed();
      expect(await usable(pinned(issuerA))).toBe(true);
      expect(await usable(pinned("https://b.example.com"))).toBe(false);
      // A standalone authorizationServerBase pins the issuer too (one trailing slash tolerated).
      expect(
        await usable({ clientId: "shared", discovery: { authorizationServerBase: `${issuerA}/` } })
      ).toBe(true);
      expect(
        await usable({
          clientId: "shared",
          discovery: { authorizationServerBase: "https://b.example.com" },
        })
      ).toBe(false);
      // Only the tokens carry the stamp: the unstamped client record is refused for any
      // pinned issuer (A included), so the user signs in again.
      await service.dispose();
      service = new McpOauthService(config, mcpConfigService);
      await seed(null);
      expect(await usable(pinned(issuerA))).toBe(false);
      expect(await usable(pinned("https://b.example.com"))).toBe(false);
    });

    test("unstamped legacy credentials never serve a pinned issuer, and nothing is refreshed there", async () => {
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(`${req.method ?? ""} ${(req.url ?? "/").split("?")[0]}`);
        if ((req.url ?? "").startsWith("/.well-known/oauth-authorization-server")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(authServerMetadata(`http://${req.headers.host ?? ""}`)));
          return;
        }
        if ((req.url ?? "").startsWith("/token")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "stolen", token_type: "Bearer" }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Failed to bind");
        // An update moved authorizationServerBase to the (attacker's) origin.
        const attacker = `http://127.0.0.1:${address.port}`;
        await fs.writeFile(
          getStoreFilePath(xumHome),
          JSON.stringify({
            version: 2,
            entries: {
              [serverUrl]: {
                serverUrl,
                updatedAtMs: Date.now(),
                // Pre-upgrade: no SEP-2352 stamp and no legacy binding.
                clientInformation: { client_id: "shared", client_secret: "registered-secret" },
                tokens: { access_token: "old", token_type: "Bearer", refresh_token: "rt-legacy" },
              },
            },
          })
        );
        const oauth = pinned(attacker);
        expect(await service.getAuthProviderForServer({ serverUrl, oauth })).toBeUndefined();
        expect(await service.hasAuthTokens({ serverUrl, oauth })).toBe(false);
        expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);
        // Without a pinned issuer (non-plugin servers) nothing changes.
        expect(await service.hasAuthTokens({ serverUrl })).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    test("a legacy authorization_server binding to the pinned issuer still serves", async () => {
      await fs.writeFile(
        getStoreFilePath(xumHome),
        JSON.stringify({
          version: 2,
          entries: {
            [serverUrl]: {
              serverUrl,
              updatedAtMs: Date.now(),
              clientInformation: {
                client_id: "shared",
                authorization_server: issuerA,
                token_endpoint: `${issuerA}/token`,
              },
              tokens: {
                access_token: "at",
                token_type: "Bearer",
                authorization_server: issuerA,
                token_endpoint: `${issuerA}/token`,
              },
            },
          },
        })
      );
      expect(await usable(pinned(issuerA))).toBe(true);
      expect(await usable(pinned("https://b.example.com"))).toBe(false);
    });

    test("a background refresh that saves after the sign-out is not used for the new issuer", async () => {
      await seed();
      const provider = await service.getAuthProviderForServer({
        serverUrl,
        oauth: pinned(issuerA),
      });
      if (provider === undefined) throw new Error("expected a provider");
      await service.logout({ serverUrl });
      // The refresh of the old identity lands after the sign-out (the SDK stamps the issuer).
      await provider.saveClientInformation?.({ client_id: "shared", issuer: issuerA } as never);
      await provider.saveTokens({
        access_token: "late",
        token_type: "Bearer",
        issuer: issuerA,
      } as never);
      expect(await usable(pinned(issuerA))).toBe(true);
      expect(await usable(pinned("https://b.example.com"))).toBe(false);
    });

    test("a sign-in whose probe spans a sign-out writes credentials the new issuer never uses", async () => {
      let probing!: () => void;
      const probed = new Promise<void>((resolve) => (probing = resolve));
      let releaseProbe!: () => void;
      const release = new Promise<void>((resolve) => (releaseProbe = resolve));
      const server = createServer((req, res) => {
        void (async () => {
          for await (const _chunk of req) {
            // Drain the body.
          }
          const pathname = (req.url ?? "/").split("?")[0];
          if (pathname === "/token") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ access_token: "late", token_type: "Bearer" }));
            return;
          }
          if (pathname === "/.well-known/oauth-authorization-server") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(authServerMetadata(`http://${req.headers.host ?? ""}`)));
            return;
          }
          if (pathname === "/mcp") {
            probing();
            await release;
            res.statusCode = 401;
            res.end();
            return;
          }
          res.statusCode = 404;
          res.end();
        })();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Failed to bind");
        const url = `http://127.0.0.1:${address.port}/mcp`;
        const configA = pinned(`http://127.0.0.1:${address.port}`);
        // The same server under another origin: another issuer, the same client ID.
        const configB = pinned(`http://localhost:${address.port}`);
        spyOn(mcpConfigService, "listServers").mockResolvedValue({
          docs: { transport: "http", url, disabled: true, oauth: configA },
        });
        const starting = service.startServerFlow({
          projectPath,
          serverName: "docs",
          redirectUri: "https://x/cb",
        });
        await probed;
        // The update's sign-out lands while the flow is still probing.
        await service.logout({ serverUrl: url });
        releaseProbe();
        const start = await starting;
        if (!start.success) throw new Error(start.error);
        await service.handleServerCallbackAndExchange({
          state: start.data.flowId,
          code: "the-code",
          iss: null,
          error: null,
        });
        // The old-identity flow did write; only the issuer it carries keeps it from serving B.
        expect(
          await service.getAuthProviderForServer({ serverUrl: url, oauth: configA })
        ).toBeDefined();
        expect(
          await service.getAuthProviderForServer({ serverUrl: url, oauth: configB })
        ).toBeUndefined();
        expect(await service.hasAuthTokens({ serverUrl: url, oauth: configB })).toBe(false);
      } finally {
        releaseProbe();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  test("interleaved sign-ins of two clients at one URL never store client B with token A", async () => {
    await withAuthServer(async (base) => {
      const serverUrl = `${base}/mcp`;
      await fs.writeFile(
        getStoreFilePath(xumHome),
        JSON.stringify({
          version: 2,
          entries: {
            [serverUrl]: {
              serverUrl,
              updatedAtMs: Date.now(),
              clientInformation: { client_id: "client-a" },
              tokens: { access_token: "at-a", token_type: "Bearer", refresh_token: "rt-a" },
            },
          },
        })
      );
      // Server A's refresh is under way with client A...
      const providerA = await service.getAuthProviderForServer({
        serverUrl,
        oauth: { clientId: "client-a" },
      });
      if (providerA === undefined) throw new Error("expected a provider");
      expect((await providerA.clientInformation())?.client_id).toBe("client-a");
      // ...when server B (same URL, client B) starts signing in and saves client B.
      spyOn(mcpConfigService, "listServers").mockResolvedValue({
        b: { transport: "http", url: serverUrl, disabled: true, oauth: { clientId: "client-b" } },
      });
      const start = await service.startServerFlow({
        projectPath,
        serverName: "b",
        redirectUri: "https://x/cb",
      });
      if (!start.success) throw new Error(start.error);
      // Then A's token lands: it is dropped, never stored next to client B.
      await providerA.saveTokens({ access_token: "at-a-new", token_type: "Bearer" } as never);
      const store = JSON.parse(await fs.readFile(getStoreFilePath(xumHome), "utf-8")) as {
        entries: Record<string, { clientInformation?: { client_id: string }; tokens?: unknown }>;
      };
      expect(store.entries[serverUrl].clientInformation?.client_id).toBe("client-b");
      expect(JSON.stringify(store.entries[serverUrl].tokens ?? null)).not.toContain("at-a");
      await service.cancelServerFlow(start.data.flowId);
    });
  });

  test("an interactive sign-in whose client was replaced meanwhile stores no token", async () => {
    await withAuthServer(async (base) => {
      const serverUrl = `${base}/mcp`;
      const listServers = spyOn(mcpConfigService, "listServers");
      const startFor = async (name: string, clientId: string) => {
        listServers.mockResolvedValue({
          [name]: { transport: "http", url: serverUrl, disabled: true, oauth: { clientId } },
        });
        const start = await service.startServerFlow({
          projectPath,
          serverName: name,
          redirectUri: "https://x/cb",
        });
        if (!start.success) throw new Error(start.error);
        return start.data.flowId;
      };
      // Flow A saves client A, flow B then saves client B, then A's code exchange lands.
      const flowA = await startFor("a", "client-a");
      const flowB = await startFor("b", "client-b");
      await service.handleServerCallbackAndExchange({
        state: flowA,
        code: "code-a",
        iss: null,
        error: null,
      });
      const store = JSON.parse(await fs.readFile(getStoreFilePath(xumHome), "utf-8")) as {
        entries: Record<string, { clientInformation?: { client_id: string }; tokens?: unknown }>;
      };
      expect(store.entries[serverUrl].clientInformation?.client_id).toBe("client-b");
      expect(store.entries[serverUrl].tokens).toBeUndefined();
      await service.cancelServerFlow(flowB);
    });
  });

  test("a late token write after logout leaves no tokens for the next client (#6297)", async () => {
    await withAuthServer(async (base) => {
      const serverUrl = `${base}/mcp`;
      await fs.writeFile(
        getStoreFilePath(xumHome),
        JSON.stringify({
          version: 2,
          entries: {
            [serverUrl]: {
              serverUrl,
              updatedAtMs: Date.now(),
              clientInformation: { client_id: "client-a" },
              tokens: { access_token: "at-a", token_type: "Bearer", refresh_token: "rt-a" },
            },
          },
        })
      );
      // Server A's refresh is under way with client A...
      const providerA = await service.getAuthProviderForServer({
        serverUrl,
        oauth: { clientId: "client-a" },
      });
      if (providerA === undefined) throw new Error("expected a provider");
      expect((await providerA.clientInformation())?.client_id).toBe("client-a");
      // ...the user logs out (the store entry is removed), then A's token lands late.
      await service.logout({ serverUrl });
      await providerA.saveTokens({ access_token: "at-a-late", token_type: "Bearer" } as never);
      // Server B (same URL, client B) then signs in and saves client B.
      spyOn(mcpConfigService, "listServers").mockResolvedValue({
        b: { transport: "http", url: serverUrl, disabled: true, oauth: { clientId: "client-b" } },
      });
      const start = await service.startServerFlow({
        projectPath,
        serverName: "b",
        redirectUri: "https://x/cb",
      });
      if (!start.success) throw new Error(start.error);
      const store = JSON.parse(await fs.readFile(getStoreFilePath(xumHome), "utf-8")) as {
        entries: Record<string, { clientInformation?: { client_id: string }; tokens?: unknown }>;
      };
      expect(store.entries[serverUrl].clientInformation?.client_id).toBe("client-b");
      expect(JSON.stringify(store.entries[serverUrl].tokens ?? null)).not.toContain("at-a");
      await service.cancelServerFlow(start.data.flowId);
    });
  });

  test("a plugin secret reread for a replaced client is withheld, and parse errors are not logged (#6297)", async () => {
    const serverUrl = "https://example.com/mcp";
    await fs.writeFile(
      getStoreFilePath(xumHome),
      JSON.stringify({
        version: 2,
        entries: {
          [serverUrl]: {
            serverUrl,
            updatedAtMs: Date.now(),
            clientInformation: { client_id: "provided-id" },
            tokens: { access_token: "at", token_type: "Bearer", refresh_token: "rt" },
          },
        },
      })
    );
    const pluginRoot = await fs.realpath(projectPath);
    const mcpConfigPath = path.join(pluginRoot, ".mcp.json");
    const writeEntry = (oauthText: string) =>
      fs.writeFile(
        mcpConfigPath,
        `{"github": {"type": "http", "url": "${serverUrl}", "oauth": ${oauthText}}}`
      );
    const oauth: MCPServerOAuthConfig = {
      clientId: "provided-id",
      clientSecretSource: { pluginRoot, mcpConfigPath, serverName: "github" },
    };
    const provider = await service.getAuthProviderForServer({ serverUrl, oauth });
    if (provider === undefined) throw new Error("expected a provider");

    await writeEntry('{"client_id": "provided-id", "client_secret": "current-secret"}');
    expect((await provider.clientInformation())?.client_secret).toBe("current-secret");

    // A plugin edit replaced the client: the stale provider gets no secret at all.
    await writeEntry('{"client_id": "replacement-id", "client_secret": "replacement-secret"}');
    const stale = await provider.clientInformation();
    expect(stale?.client_id).toBe("provided-id");
    expect(stale?.client_secret).toBeUndefined();

    // A malformed file: the parser would quote the unquoted secret, and no log line holds it.
    const logged = [spyOn(log, "warn"), spyOn(log, "debug"), spyOn(log, "info")];
    try {
      await writeEntry('{"client_id": "provided-id", "client_secret": s3cr3tValue}');
      expect((await provider.clientInformation())?.client_secret).toBeUndefined();
      expect(logged[0]).toHaveBeenCalled();
      expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toContain("s3cr3tValue");
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });

  test("stored tokens stay bound to the client they were issued to", async () => {
    const serverUrl = "https://example.com/mcp";
    await fs.writeFile(
      getStoreFilePath(xumHome),
      JSON.stringify({
        version: 2,
        entries: {
          [serverUrl]: {
            serverUrl,
            updatedAtMs: Date.now(),
            clientInformation: { client_id: "client-a" },
            tokens: { access_token: "at-a", token_type: "Bearer", refresh_token: "rt-a" },
          },
        },
      })
    );
    // A second plugin at the same URL with another client is signed out.
    expect(
      await service.getAuthProviderForServer({ serverUrl, oauth: { clientId: "client-b" } })
    ).toBeUndefined();
    const provider = await service.getAuthProviderForServer({
      serverUrl,
      oauth: { clientId: "client-a" },
    });
    expect((await provider?.tokens())?.access_token).toBe("at-a");
    expect((await provider?.clientInformation())?.client_id).toBe("client-a");

    // Status agrees with the connection: client B reads as signed out, everywhere.
    const listServers = spyOn(mcpConfigService, "listServers");
    for (const clientId of ["client-a", "client-b"]) {
      listServers.mockResolvedValue({
        docs: { transport: "http", url: serverUrl, disabled: false, oauth: { clientId } },
      });
      const loggedIn = clientId === "client-a";
      expect(
        (await service.getProjectAuthStatus({ projectPath, serverName: "docs" })).isLoggedIn
      ).toBe(loggedIn);
      expect(
        (await service.getAuthStatusForApi({ serverUrl, serverName: "docs" })).isLoggedIn
      ).toBe(loggedIn);
    }
    // Without a server name only the URL is known (a server without plugin OAuth).
    expect((await service.getAuthStatusForApi({ serverUrl })).isLoggedIn).toBe(true);
    // The manager's cache signature uses the same check (a B sign-in must recycle it).
    expect(await service.hasAuthTokens({ serverUrl, oauth: { clientId: "client-b" } })).toBe(false);
    expect(await service.hasAuthTokens({ serverUrl, oauth: { clientId: "client-a" } })).toBe(true);
  });

  test("a plugin resource that does not cover the server URL is refused at sign-in", async () => {
    await withAuthServer(async (base) => {
      spyOn(mcpConfigService, "listServers").mockResolvedValue({
        docs: {
          transport: "http",
          url: `${base}/mcp`,
          disabled: true,
          oauth: { clientId: "c", resource: "https://evil.example.com" },
        },
      });
      const start = await service.startServerFlow({
        projectPath,
        serverName: "docs",
        redirectUri: "https://x/cb",
      });
      expect(start.success).toBe(false);
      expect(start.success ? "" : start.error).toContain("does not cover");
    });
  });

  test("a plugin's provided client, scopes and resource replace DCR; discovery supplies endpoints", async () => {
    const secret = "native-app-secret-8252";
    const requests: Array<{ path: string; raw: string }> = [];
    const server = createServer((req, res) => {
      void (async () => {
        let body = "";
        for await (const chunk of req) body += Buffer.from(chunk as Uint8Array).toString("utf-8");
        const pathname = (req.url ?? "/").split("?")[0];
        requests.push({
          path: pathname,
          raw: `${req.url ?? ""} ${JSON.stringify(req.headers)} ${body}`,
        });
        if (pathname === "/custom-token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ access_token: "at", token_type: "Bearer", refresh_token: "rt" })
          );
          return;
        }
        // Discovery supplies the endpoints (no registration endpoint is advertised).
        if (pathname === "/.well-known/oauth-authorization-server") {
          const issuer = `http://${req.headers.host ?? ""}`;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              issuer,
              authorization_endpoint: `${issuer}/custom-authorize`,
              token_endpoint: `${issuer}/custom-token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            })
          );
          return;
        }
        res.statusCode = pathname === "/mcp" ? 401 : 404;
        res.end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const logged = [spyOn(log, "warn"), spyOn(log, "debug"), spyOn(log, "info")];
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Failed to bind");
      const base = `http://127.0.0.1:${address.port}`;
      const pluginRoot = await fs.realpath(projectPath);
      const mcpConfigPath = path.join(pluginRoot, ".mcp.json");
      const oauthEntry = { client_id: "provided-id", client_secret: secret };
      await fs.writeFile(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: { github: { type: "http", url: `${base}/mcp`, oauth: oauthEntry } },
        })
      );
      spyOn(mcpConfigService, "listServers").mockResolvedValue({
        github: {
          transport: "http",
          url: `${base}/mcp`,
          disabled: true,
          oauth: {
            clientId: "provided-id",
            tokenEndpointAuthMethod: "client_secret_post",
            baseScopes: ["base"],
            defaultScopes: ["docs:read"],
            // Covers the server URL (the SDK's resource rule).
            resource: base,
            clientSecretSource: { pluginRoot, mcpConfigPath, serverName: "github" },
          },
        },
      });

      const start = await service.startServerFlow({
        projectPath,
        serverName: "github",
        redirectUri: "https://xum.example/callback",
      });
      if (!start.success) throw new Error(start.error);
      const authorizeUrl = new URL(start.data.authorizeUrl);
      expect(authorizeUrl.pathname).toBe("/custom-authorize");
      expect(authorizeUrl.searchParams.get("client_id")).toBe("provided-id");
      expect(authorizeUrl.searchParams.get("scope")).toBe("base docs:read");
      // The configured spelling, exactly: no slash appended (RFC 8707 exact comparison).
      expect(authorizeUrl.searchParams.get("resource")).toBe(base);

      const exchange = await service.handleServerCallbackAndExchange({
        state: start.data.flowId,
        code: "the-code",
        iss: null,
        error: null,
      });
      expect(exchange).toEqual({ success: true, data: undefined });
      // No dynamic registration; the secret reached the token endpoint and nothing else.
      expect(requests.some((request) => request.path.includes("register"))).toBe(false);
      expect(requests.filter((request) => request.raw.includes(secret)).map((r) => r.path)).toEqual(
        ["/custom-token"]
      );
      const store = await fs.readFile(getStoreFilePath(xumHome), "utf-8");
      expect(store).toContain("provided-id");
      expect(store).not.toContain(secret);
      expect(start.data.authorizeUrl).not.toContain(secret);
      expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toContain(secret);
    } finally {
      for (const spy of logged) spy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /**
   * Resource server + separate authorization server fixture. The AS metadata
   * optionally advertises RFC 9207 `authorization_response_iss_parameter_supported`
   * (Linear's shape), which makes the SDK require a matching `iss` on the callback.
   */
  async function withSeparateIssuerServers(
    options: { issParameterSupported: boolean },
    run: (fixture: {
      authorizationServerUrl: string;
      serverName: string;
      getTokenRequest: () => URLSearchParams | undefined;
    }) => Promise<void>
  ): Promise<void> {
    let authorizationServerUrl = "";
    let resourceServerUrl = "";
    let resourceMetadataUrl = "";
    let tokenRequest: URLSearchParams | undefined;

    const authorizationServer = createServer((req, res) => {
      void (async () => {
        const pathname = (req.url ?? "/").split("?")[0];

        if (pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              issuer: authorizationServerUrl,
              authorization_endpoint: `${authorizationServerUrl}/authorize`,
              token_endpoint: `${authorizationServerUrl}/token`,
              registration_endpoint: `${authorizationServerUrl}/register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
              ...(options.issParameterSupported
                ? { authorization_response_iss_parameter_supported: true }
                : {}),
            })
          );
          return;
        }

        if (pathname === "/register") {
          let raw = "";
          for await (const chunk of req) {
            raw += Buffer.from(chunk as Uint8Array).toString("utf-8");
          }

          const clientMetadata = JSON.parse(raw) as Record<string, unknown>;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...clientMetadata, client_id: "test-client-id" }));
          return;
        }

        if (pathname === "/token") {
          let raw = "";
          for await (const chunk of req) {
            raw += Buffer.from(chunk as Uint8Array).toString("utf-8");
          }
          tokenRequest = new URLSearchParams(raw);

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "test-access-token",
              token_type: "Bearer",
              refresh_token: "test-refresh-token",
            })
          );
          return;
        }

        res.statusCode = 404;
        res.end("Not found");
      })();
    });

    const resourceServer = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0];

      if (pathname === "/oauth-resource") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            resource: resourceServerUrl,
            authorization_servers: [authorizationServerUrl],
          })
        );
        return;
      }

      res.statusCode = 401;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
      );
      res.end("Unauthorized");
    });

    await new Promise<void>((resolve) => authorizationServer.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => resourceServer.listen(0, "127.0.0.1", resolve));

    try {
      const authorizationAddress = authorizationServer.address();
      const resourceAddress = resourceServer.address();
      if (
        !authorizationAddress ||
        typeof authorizationAddress === "string" ||
        !resourceAddress ||
        typeof resourceAddress === "string"
      ) {
        throw new Error("Failed to bind OAuth test servers");
      }

      authorizationServerUrl = `http://127.0.0.1:${authorizationAddress.port}`;
      resourceServerUrl = `http://127.0.0.1:${resourceAddress.port}/mcp`;
      resourceMetadataUrl = `http://127.0.0.1:${resourceAddress.port}/oauth-resource`;

      const serverName = "oauth-server-separate-issuer";
      const addResult = await mcpConfigService.addServer(serverName, {
        transport: "http",
        url: resourceServerUrl,
      });
      expect(addResult).toEqual({ success: true, data: undefined });

      await run({ authorizationServerUrl, serverName, getTokenRequest: () => tokenRequest });
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => authorizationServer.close(() => resolve())),
        new Promise<void>((resolve) => resourceServer.close(() => resolve())),
      ]);
    }
  }

  // The first case also proves discovery is reused across start and exchange
  // (separate AS host).
  test.each([
    ["no RFC 9207 support, iss omitted", false, "omit"],
    ["RFC 9207 support, matching iss", true, "match"],
    ["RFC 9207 support, wrong iss", true, "wrong"],
  ] as const)(
    "server callback exchanges the code via the discovered AS (%s)",
    async (_name, issParameterSupported, iss) => {
      await withSeparateIssuerServers(
        { issParameterSupported },
        async ({ authorizationServerUrl, serverName, getTokenRequest }) => {
          const startResult = await service.startServerFlow({
            projectPath,
            serverName,
            redirectUri: "https://xum.example/callback",
          });
          expect(startResult.success).toBe(true);
          if (!startResult.success) {
            throw new Error(startResult.error);
          }

          const callbackResult = await service.handleServerCallbackAndExchange({
            state: startResult.data.flowId,
            code: "test-authorization-code",
            iss:
              iss === "omit"
                ? null
                : iss === "match"
                  ? authorizationServerUrl
                  : "https://attacker.example",
            error: null,
          });

          if (iss === "wrong") {
            expect(callbackResult.success).toBe(false);
            if (callbackResult.success) return;
            expect(callbackResult.error).toContain("Issuer mismatch");
            // The attacker-controlled issuer must never reach the user-visible error.
            expect(callbackResult.error).not.toContain("attacker.example");
            expect(getTokenRequest()).toBeUndefined();
            return;
          }

          expect(callbackResult).toEqual({ success: true, data: undefined });
          expect(getTokenRequest()?.get("code")).toBe("test-authorization-code");
          expect(getTokenRequest()?.get("code_verifier")).toBeTruthy();
        }
      );
    }
  );

  // Callback error fields arrive before the SDK's issuer check, so a mix-up
  // attacker controls them: only standard RFC 6749 codes may reach the UI.
  test.each([
    ["standard code", "access_denied", "MCP OAuth error: access_denied"],
    ["nonstandard code", "<b>call attacker.example</b>", "MCP OAuth error: unknown_error"],
  ] as const)(
    "server callback error shows only a standard error code (%s)",
    async (_name, error, expected) => {
      await withSeparateIssuerServers(
        { issParameterSupported: true },
        async ({ serverName, getTokenRequest }) => {
          const startResult = await service.startServerFlow({
            projectPath,
            serverName,
            redirectUri: "https://xum.example/callback",
          });
          expect(startResult.success).toBe(true);
          if (!startResult.success) {
            throw new Error(startResult.error);
          }

          const callbackResult = await service.handleServerCallbackAndExchange({
            state: startResult.data.flowId,
            code: null,
            iss: "https://attacker.example",
            error,
            errorDescription: "Visit attacker.example to fix your account",
          });

          expect(callbackResult).toEqual({ success: false, error: expected });
          expect(getTokenRequest()).toBeUndefined();
        }
      );
    }
  );

  test("desktop loopback callback forwards RFC 9207 iss to the code exchange", async () => {
    await withSeparateIssuerServers(
      { issParameterSupported: true },
      async ({ authorizationServerUrl, serverName, getTokenRequest }) => {
        const startResult = await service.startDesktopFlow({ projectPath, serverName });
        expect(startResult.success).toBe(true);
        if (!startResult.success) {
          throw new Error(startResult.error);
        }

        const callbackUrl = new URL(startResult.data.redirectUri);
        callbackUrl.searchParams.set("state", startResult.data.flowId);
        callbackUrl.searchParams.set("code", "test-authorization-code");
        callbackUrl.searchParams.set("iss", authorizationServerUrl);
        const response = await fetch(callbackUrl);
        expect(response.status).toBe(200);

        const waitResult = await service.waitForDesktopFlow(startResult.data.flowId, {
          timeoutMs: 5000,
        });
        expect(waitResult).toEqual({ success: true, data: undefined });
        expect(getTokenRequest()?.get("code")).toBe("test-authorization-code");
      }
    );
  });

  test("preserves trailing slashes for OAuth discovery under a base path", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";
    let authorizationServerBaseUrl = "";
    const seenPaths: string[] = [];

    const server = createServer((req, res) => {
      void (async () => {
        const pathname = (req.url ?? "/").split("?")[0];
        seenPaths.push(pathname);

        if (pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              // RFC 8414 canonical issuer: no trailing slash at the root.
              // The MCP SDK strictly validates metadata issuer identity.
              issuer: new URL(authorizationServerBaseUrl).origin,
              authorization_endpoint: `${authorizationServerBaseUrl}authorize`,
              token_endpoint: `${authorizationServerBaseUrl}token`,
              registration_endpoint: `${authorizationServerBaseUrl}register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            })
          );
          return;
        }

        if (pathname === "/register") {
          let raw = "";
          for await (const chunk of req) {
            raw += Buffer.from(chunk as Uint8Array).toString("utf-8");
          }

          const clientMetadata = JSON.parse(raw) as Record<string, unknown>;

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...clientMetadata,
              client_id: "test-client-id",
            })
          );
          return;
        }

        if (pathname === "/mcp/.well-known/oauth-protected-resource") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              resource: baseUrl,
              authorization_servers: [authorizationServerBaseUrl],
            })
          );
          return;
        }

        if (pathname === "/mcp/") {
          // Default: act like an MCP server requiring OAuth.
          res.statusCode = 401;
          res.setHeader(
            "WWW-Authenticate",
            `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
          );
          res.end("Unauthorized");
          return;
        }

        // Anything outside of the configured /mcp/ base path should not be used.
        res.statusCode = 404;
        res.end("Not found");
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind OAuth test server");
      }

      authorizationServerBaseUrl = `http://127.0.0.1:${address.port}/`;
      baseUrl = `${authorizationServerBaseUrl}mcp/`;
      resourceMetadataUrl = `${baseUrl}.well-known/oauth-protected-resource`;

      const serverName = "oauth-server-trailing-slash";

      const addResult = await mcpConfigService.addServer(serverName, {
        transport: "http",
        url: baseUrl,
      });
      expect(addResult).toEqual({ success: true, data: undefined });

      const startResult = await service.startDesktopFlow({ projectPath, serverName });
      expect(startResult.success).toBe(true);
      if (!startResult.success) {
        throw new Error(startResult.error);
      }

      const authorizeUrl = new URL(startResult.data.authorizeUrl);
      expect(authorizeUrl.searchParams.get("resource")).toBe(baseUrl);

      // Ensure we hit the configured /mcp/ path (trailing slash required) and its resource_metadata.
      expect(seenPaths).toContain("/mcp/");
      expect(seenPaths).toContain("/mcp/.well-known/oauth-protected-resource");

      // Stored credentials should continue to use a normalized URL for keying.
      const storeRaw = await fs.readFile(getStoreFilePath(xumHome), "utf-8");
      const serverUrlKey = baseUrl.slice(0, -1);
      expect(JSON.parse(storeRaw)).toMatchObject({
        version: 2,
        entries: {
          [serverUrlKey]: {
            serverUrl: serverUrlKey,
          },
        },
      });

      // Clean up the loopback listener (no callback will occur during this test).
      await service.cancelDesktopFlow(startResult.data.flowId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("resolveOAuthScope", () => {
  async function startMetadataServer(
    body: unknown
  ): Promise<{ url: URL; close: () => Promise<void> }> {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind metadata server");
    }
    return {
      url: new URL(`http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource`),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  test("uses the challenge scope when present", async () => {
    expect(await resolveOAuthScope({ raw: "", scope: "mcp.read" })).toBe("mcp.read");
  });

  test("falls back to all advertised PRM scopes when the challenge omits scope", async () => {
    // Carta advertises read_* and readwrite_* scopes but omits scope= from its
    // 401. Cap-table reads require the readwrite_* scopes, so request every
    // advertised scope rather than dropping readwrite_* as redundant.
    const metadata = await startMetadataServer({
      scopes_supported: ["openid", "cuid", "read_mcp_companies", "readwrite_mcp_companies"],
    });
    try {
      expect(await resolveOAuthScope({ raw: "", resourceMetadataUrl: metadata.url })).toBe(
        "openid cuid read_mcp_companies readwrite_mcp_companies"
      );
    } finally {
      await metadata.close();
    }
  });

  test("returns undefined when PRM advertises no scopes", async () => {
    const metadata = await startMetadataServer({ resource: "https://example.com" });
    try {
      expect(
        await resolveOAuthScope({ raw: "", resourceMetadataUrl: metadata.url })
      ).toBeUndefined();
    } finally {
      await metadata.close();
    }
  });
});
