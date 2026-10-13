import type { ProvidersConfigStore } from "@/node/config";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  CODEX_OAUTH_BROWSER_REDIRECT_URI,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_DEVICE_TOKEN_POLL_URL,
  CODEX_OAUTH_DEVICE_USERCODE_URL,
  CODEX_OAUTH_DEVICE_VERIFY_URL,
  CODEX_OAUTH_TOKEN_URL,
} from "@/common/constants/codexOAuth";
import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import type { ProvidersConfig } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import type { CodexOauthAuth } from "@/node/utils/codexOauthAuth";
import { CodexOauthService } from "./codexOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a claims object into a fake JWT (header.payload.signature). */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

/** Build a valid CodexOauthAuth that expires far in the future. */
function validAuth(overrides?: Partial<CodexOauthAuth>): CodexOauthAuth {
  return {
    type: "oauth",
    access: fakeJwt({ sub: "user" }),
    refresh: "rt_test",
    expires: Date.now() + 3_600_000, // 1h from now
    ...overrides,
  };
}

/** Build a CodexOauthAuth that is already expired. */
function expiredAuth(overrides?: Partial<CodexOauthAuth>): CodexOauthAuth {
  return validAuth({ expires: Date.now() - 60_000, ...overrides });
}

/** Build a mock fetch Response for token refresh. */
function mockRefreshResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

interface MockDeps {
  providersConfig: ProvidersConfig;
  setConfigValueCalls: Array<{ provider: string; keyPath: string[]; value: unknown }>;
  focusCalls: number;
}

function createMockDeps(): MockDeps {
  return {
    providersConfig: {},
    setConfigValueCalls: [],
    focusCalls: 0,
  };
}

function createMockProvidersConfigStore(
  deps: MockDeps
): Pick<ProvidersConfigStore, "loadProvidersConfig"> {
  return {
    loadProvidersConfig: () => deps.providersConfig,
  };
}

function createMockProviderService(deps: MockDeps): Pick<ProviderService, "setConfigValue"> {
  return {
    setConfigValue: (
      provider: string,
      keyPath: string[],
      value: unknown
    ): Promise<Result<void, string>> => {
      deps.setConfigValueCalls.push({ provider, keyPath, value });
      // Also update the in-memory config so readStoredAuth() sees the write
      if (provider === "openai" && keyPath[0] === "codexOauth") {
        if (value === undefined) {
          const openai = deps.providersConfig.openai;
          if (openai) {
            delete openai.codexOauth;
          }
        } else {
          deps.providersConfig.openai ??= {};
          deps.providersConfig.openai.codexOauth = value;
        }
      }
      return Promise.resolve(Ok(undefined));
    },
  };
}

function createMockWindowService(deps: MockDeps): Pick<WindowService, "focusMainWindow"> {
  return {
    focusMainWindow: () => {
      deps.focusCalls++;
    },
  };
}

function createService(deps: MockDeps): CodexOauthService {
  return new CodexOauthService(
    createMockProvidersConfigStore(deps) as ProvidersConfigStore,
    createMockProviderService(deps) as ProviderService,
    createMockWindowService(deps) as WindowService
  );
}

// Helper to mock globalThis.fetch without needing the `preconnect` property.
function mockFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: (_url: string | URL) => {
      // no-op in tests
    },
  }) as typeof fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

// The service sends JSON strings or URLSearchParams form bodies.
function requestBodyText(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("unexpected request body type");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexOauthService", () => {
  let deps: MockDeps;
  let service: CodexOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = createMockDeps();
    service = createService(deps);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await service.dispose();
  });

  // -------------------------------------------------------------------------
  // getValidAuth - basic
  // -------------------------------------------------------------------------

  describe("getValidAuth", () => {
    it("returns error when no auth is stored", async () => {
      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not configured");
      }
    });

    it("returns stored auth when token is not expired", async () => {
      const auth = validAuth();
      deps.providersConfig = { openai: { codexOauth: auth } };

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe(auth.access);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh coalescing (AsyncMutex)
  // -------------------------------------------------------------------------

  describe("token refresh coalescing", () => {
    it("only triggers one refresh for concurrent getValidAuth calls with expired tokens", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      let fetchCallCount = 0;
      const newAccessToken = fakeJwt({ sub: "refreshed" });

      mockFetch(async () => {
        fetchCallCount++;
        // Simulate a small delay so both callers are waiting
        await new Promise((resolve) => setTimeout(resolve, 10));
        return mockRefreshResponse({
          access_token: newAccessToken,
          refresh_token: "rt_new",
          expires_in: 3600,
        });
      });

      // Fire 3 concurrent calls
      const results = await Promise.all([
        service.getValidAuth(),
        service.getValidAuth(),
        service.getValidAuth(),
      ]);

      // Only ONE fetch should have happened thanks to AsyncMutex
      expect(fetchCallCount).toBe(1);

      // All three results should be successful with the refreshed token
      for (const result of results) {
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.access).toBe(newAccessToken);
        }
      }
    });

    it("after refresh, all callers get the updated token", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      const newAccessToken = fakeJwt({ sub: "refreshed_user" });

      mockFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: newAccessToken,
            refresh_token: "rt_updated",
            expires_in: 7200,
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe(newAccessToken);
        expect(result.data.refresh).toBe("rt_updated");
      }

      // Verify the auth was persisted
      const persistCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "openai" && c.keyPath[0] === "codexOauth" && c.value !== undefined
      );
      expect(persistCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Invalid grant cleanup
  // -------------------------------------------------------------------------

  describe("invalid grant cleanup", () => {
    it("calls disconnect + clears stored auth on invalid_grant response", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);

      // Should have called setConfigValue to clear auth (disconnect)
      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "openai" && c.keyPath[0] === "codexOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();
    });

    it("clears auth when error text contains 'revoked'", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          new Response("Token has been revoked", {
            status: 401,
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "openai" && c.keyPath[0] === "codexOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();
    });

    it("subsequent getValidAuth returns error after invalid_grant cleanup", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      // First call triggers disconnect
      await service.getValidAuth();

      // Second call should see no stored auth
      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not configured");
      }
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  describe("disconnect", () => {
    it("clears stored codexOauth via providerService.setConfigValue", async () => {
      const result = await service.disconnect();
      expect(result.success).toBe(true);
      expect(deps.setConfigValueCalls).toHaveLength(1);
      expect(deps.setConfigValueCalls[0]).toEqual({
        provider: "openai",
        keyPath: ["codexOauth"],
        value: undefined,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Desktop flow basics
  // -------------------------------------------------------------------------

  describe("startDesktopFlow", () => {
    it("starts HTTP server and returns flowId + authorizeUrl", async () => {
      const result = await service.startDesktopFlow();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.flowId).toBeTruthy();
        expect(result.data.authorizeUrl).toContain("https://auth.openai.com/oauth/authorize");
        expect(result.data.authorizeUrl).toContain("state=");
        expect(result.data.authorizeUrl).toContain("code_challenge=");
        expect(result.data.authorizeUrl).toContain("code_challenge_method=S256");
      }
    });

    it("authorize URL contains correct parameters", async () => {
      const result = await service.startDesktopFlow();
      expect(result.success).toBe(true);
      if (result.success) {
        const url = new URL(result.data.authorizeUrl);
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
        expect(url.searchParams.get("state")).toBe(result.data.flowId);
        expect(url.searchParams.get("originator")).toBe("mux");
      }
    });

    it("each flow gets a unique flowId", async () => {
      const first = await service.startDesktopFlow();
      expect(first.success).toBe(true);
      // Clean up the first server so the second can use port 1455
      if (first.success) {
        await service.cancelDesktopFlow(first.data.flowId);
      }

      const second = await service.startDesktopFlow();
      expect(second.success).toBe(true);
      if (first.success && second.success) {
        expect(first.data.flowId).not.toBe(second.data.flowId);
      }
    });
  });

  describe("cancelDesktopFlow", () => {
    it("resolves waitForDesktopFlow with cancellation error", async () => {
      const startResult = await service.startDesktopFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;

      // Start waiting (don't await yet)
      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });

      // Cancel the flow
      await service.cancelDesktopFlow(flowId);

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cancelled");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh preserves accountId
  // -------------------------------------------------------------------------

  describe("refresh preserves accountId", () => {
    it("keeps previous accountId when refreshed token has no account info", async () => {
      const expired = expiredAuth({ accountId: "acct_original" });
      deps.providersConfig = { openai: { codexOauth: expired } };

      // Refreshed token has no account id in JWT claims
      const newAccessToken = fakeJwt({ sub: "user" });

      mockFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: newAccessToken,
            refresh_token: "rt_new",
            expires_in: 3600,
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.accountId).toBe("acct_original");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Refresh keeps old refresh token when server doesn't rotate it
  // -------------------------------------------------------------------------

  describe("refresh token rotation", () => {
    it("keeps old refresh token when server does not return a new one", async () => {
      const expired = expiredAuth({ refresh: "rt_keep_me" });
      deps.providersConfig = { openai: { codexOauth: expired } };

      mockFetch(() =>
        Promise.resolve(
          mockRefreshResponse({
            access_token: fakeJwt({ sub: "user" }),
            expires_in: 3600,
            // No refresh_token in response
          })
        )
      );

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.refresh).toBe("rt_keep_me");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Desktop flow: loopback callback -> code exchange
  // -------------------------------------------------------------------------

  describe("desktop flow callback", () => {
    // Routes the token endpoint to `tokenResponse` and every other URL (the
    // loopback callback the test itself hits) to the real fetch.
    function mockTokenEndpoint(tokenResponse: () => Response): URLSearchParams[] {
      const bodies: URLSearchParams[] = [];
      mockFetch((input, init) => {
        if (requestUrl(input) === CODEX_OAUTH_TOKEN_URL) {
          bodies.push(new URLSearchParams(requestBodyText(init)));
          return Promise.resolve(tokenResponse());
        }
        return originalFetch(input, init);
      });
      return bodies;
    }

    async function startFlowAndCallback(): Promise<{
      result: Result<void, string>;
      status: number;
    }> {
      const start = await service.startDesktopFlow();
      if (!start.success) throw new Error(start.error);
      const callback = await originalFetch(
        `${CODEX_OAUTH_BROWSER_REDIRECT_URI}?state=${start.data.flowId}&code=code_from_browser`
      );
      const result = await service.waitForDesktopFlow(start.data.flowId, { timeoutMs: 5000 });
      return { result, status: callback.status };
    }

    it("exchanges the callback code, persists the tokens and focuses the window", async () => {
      const bodies = mockTokenEndpoint(() =>
        mockRefreshResponse({
          access_token: "at_desktop",
          refresh_token: "rt_desktop",
          expires_in: 3600,
          id_token: fakeJwt({ chatgpt_account_id: "acct_desktop" }),
        })
      );

      const before = Date.now();
      const { result, status } = await startFlowAndCallback();

      expect(result).toEqual(Ok(undefined));
      expect(status).toBe(200);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].get("code")).toBe("code_from_browser");
      expect(bodies[0].get("redirect_uri")).toBe(CODEX_OAUTH_BROWSER_REDIRECT_URI);
      expect(bodies[0].get("code_verifier")).toBeTruthy();
      const stored = deps.providersConfig.openai?.codexOauth as CodexOauthAuth;
      expect(stored).toMatchObject({
        access: "at_desktop",
        refresh: "rt_desktop",
        accountId: "acct_desktop",
      });
      expect(stored.expires).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(deps.focusCalls).toBe(1);
    });

    it("fails the flow and the browser page when the token exchange is rejected", async () => {
      mockTokenEndpoint(() => new Response("bad code", { status: 400 }));

      const { result, status } = await startFlowAndCallback();

      expect(result).toEqual({
        success: false,
        error: "Codex OAuth exchange failed (400): bad code",
      });
      expect(status).toBe(400);
      expect(deps.setConfigValueCalls).toHaveLength(0);
      expect(deps.focusCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Device flow
  // -------------------------------------------------------------------------

  describe("device flow", () => {
    interface DeviceEndpoints {
      userCode?: () => Response;
      poll?: () => Response;
      token?: () => Response;
    }

    // Every endpoint the device flow calls, with a successful default reply.
    // Records request bodies per endpoint so tests can check what was sent.
    function mockDeviceEndpoints(endpoints: DeviceEndpoints = {}): Record<string, string[]> {
      const calls: Record<string, string[]> = { userCode: [], poll: [], token: [] };
      mockFetch((input, init) => {
        const url = requestUrl(input);
        const body = requestBodyText(init);
        if (url === CODEX_OAUTH_DEVICE_USERCODE_URL) {
          calls.userCode.push(body);
          return Promise.resolve(
            endpoints.userCode?.() ??
              mockRefreshResponse({
                device_auth_id: "dev_auth_1",
                user_code: "ABCD-EFGH",
                interval: 1,
                expires_in: 600,
              })
          );
        }
        if (url === CODEX_OAUTH_DEVICE_TOKEN_POLL_URL) {
          calls.poll.push(body);
          return Promise.resolve(
            endpoints.poll?.() ??
              mockRefreshResponse({ authorization_code: "dev_code", code_verifier: "dev_verifier" })
          );
        }
        if (url === CODEX_OAUTH_TOKEN_URL) {
          calls.token.push(body);
          return Promise.resolve(
            endpoints.token?.() ??
              mockRefreshResponse({
                access_token: fakeJwt({ chatgpt_account_id: "acct_device" }),
                refresh_token: "rt_device",
                expires_in: "7200",
              })
          );
        }
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      });
      return calls;
    }

    async function runDeviceFlow(opts?: { timeoutMs?: number }): Promise<Result<void, string>> {
      const start = await service.startDeviceFlow();
      if (!start.success) throw new Error(start.error);
      return service.waitForDeviceFlow(start.data.flowId, opts);
    }

    async function startError(): Promise<string> {
      const start = await service.startDeviceFlow();
      if (start.success) throw new Error("expected startDeviceFlow to fail");
      return start.error;
    }

    it("returns the user code and verify URL, and normalizes the poll interval", async () => {
      const calls = mockDeviceEndpoints({
        userCode: () =>
          mockRefreshResponse({ device_auth_id: "d", user_code: "WXYZ", interval: "2.7" }),
      });

      const start = await service.startDeviceFlow();

      expect(start.success).toBe(true);
      if (!start.success) return;
      expect(start.data).toMatchObject({
        userCode: "WXYZ",
        verifyUrl: CODEX_OAUTH_DEVICE_VERIFY_URL,
        intervalSeconds: 2,
      });
      expect(JSON.parse(calls.userCode[0])).toEqual({ client_id: CODEX_OAUTH_CLIENT_ID });
    });

    it("clamps a sub-second interval to 1 and defaults a missing interval and lifetime", async () => {
      mockDeviceEndpoints({
        userCode: () => mockRefreshResponse({ device_auth_id: "d", user_code: "U", interval: 0 }),
      });
      const clamped = await service.startDeviceFlow();
      expect(clamped.success && clamped.data.intervalSeconds).toBe(1);

      mockDeviceEndpoints({
        userCode: () => mockRefreshResponse({ device_auth_id: "d", user_code: "U" }),
      });
      const defaulted = await service.startDeviceFlow();
      expect(defaulted.success && defaulted.data.intervalSeconds).toBe(5);
      // A missing expires_in falls back to the default lifetime, so the flow
      // is still alive to poll and complete.
      if (!defaulted.success) return;
      expect(await service.waitForDeviceFlow(defaulted.data.flowId)).toEqual(Ok(undefined));
    });

    it("reports user-code request failures", async () => {
      mockDeviceEndpoints({ userCode: () => new Response("boom", { status: 500 }) });
      expect(await startError()).toBe("Codex OAuth device auth request failed (500): boom");

      mockDeviceEndpoints({ userCode: () => new Response("", { status: 503 }) });
      expect(await startError()).toBe("Codex OAuth device auth request failed (503)");

      mockDeviceEndpoints({ userCode: () => mockRefreshResponse({ device_auth_id: "d" }) });
      expect(await startError()).toContain("missing required fields");

      mockDeviceEndpoints({ userCode: () => new Response("[1]", { status: 200 }) });
      expect(await startError()).toContain("invalid JSON payload");

      mockFetch(() => Promise.reject(new Error("network down")));
      expect(await startError()).toBe("Codex OAuth device auth request failed: network down");
    });

    it("returns an error when waiting for an unknown flow", async () => {
      expect(await service.waitForDeviceFlow("missing")).toEqual({
        success: false,
        error: "OAuth flow not found",
      });
    });

    it("polls with the device code, exchanges it and persists the tokens", async () => {
      const calls = mockDeviceEndpoints();

      const before = Date.now();
      const result = await runDeviceFlow();

      expect(result).toEqual(Ok(undefined));
      expect(JSON.parse(calls.poll[0])).toEqual({
        device_auth_id: "dev_auth_1",
        user_code: "ABCD-EFGH",
      });
      const exchange = new URLSearchParams(calls.token[0]);
      expect(exchange.get("code")).toBe("dev_code");
      expect(exchange.get("code_verifier")).toBe("dev_verifier");
      expect(exchange.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
      const stored = deps.providersConfig.openai?.codexOauth as CodexOauthAuth;
      expect(stored).toMatchObject({ refresh: "rt_device", accountId: "acct_device" });
      expect(stored.expires).toBeGreaterThanOrEqual(before + 7_200_000);
      expect(deps.focusCalls).toBe(1);
    });

    it("fails the flow without persisting when polling or the exchange fails", async () => {
      const cases: Array<{ endpoints: DeviceEndpoints; error: string }> = [
        {
          endpoints: { poll: () => new Response("nope", { status: 500 }) },
          error: "Codex OAuth device token poll failed (500): nope",
        },
        {
          endpoints: { poll: () => new Response("not json", { status: 200 }) },
          error: "Codex OAuth device token poll returned invalid JSON",
        },
        {
          endpoints: { poll: () => mockRefreshResponse({ authorization_code: "c" }) },
          error: "Codex OAuth device token poll response missing required fields",
        },
        {
          endpoints: { token: () => new Response("", { status: 401 }) },
          error: "Codex OAuth exchange failed (401)",
        },
        {
          endpoints: { token: () => new Response("[]", { status: 200 }) },
          error: "Codex OAuth exchange returned an invalid JSON payload",
        },
        {
          endpoints: { token: () => new Response("{", { status: 200 }) },
          error: "Codex OAuth exchange failed: ",
        },
        {
          endpoints: { token: () => mockRefreshResponse({ refresh_token: "r", expires_in: 1 }) },
          error: "Codex OAuth exchange response missing access_token",
        },
        {
          endpoints: { token: () => mockRefreshResponse({ access_token: "a", expires_in: 1 }) },
          error: "Codex OAuth exchange response missing refresh_token",
        },
        {
          endpoints: {
            token: () => mockRefreshResponse({ access_token: "a", refresh_token: "r" }),
          },
          error: "Codex OAuth exchange response missing expires_in",
        },
      ];

      for (const testCase of cases) {
        mockDeviceEndpoints(testCase.endpoints);
        const result = await runDeviceFlow();
        expect(result.success).toBe(false);
        if (!result.success) {
          // The JSON-parse case carries the runtime's parser message after the prefix.
          expect(result.error.startsWith(testCase.error)).toBe(true);
        }
      }
      expect(deps.setConfigValueCalls).toHaveLength(0);
      expect(deps.focusCalls).toBe(0);
    });

    it("reports a poll request that throws", async () => {
      mockFetch((input) => {
        if (requestUrl(input) === CODEX_OAUTH_DEVICE_TOKEN_POLL_URL) {
          return Promise.reject(new Error("socket hang up"));
        }
        return Promise.resolve(
          mockRefreshResponse({ device_auth_id: "d", user_code: "U", expires_in: 600 })
        );
      });

      expect(await runDeviceFlow()).toEqual({
        success: false,
        error: "Device authorization failed: socket hang up",
      });
    });

    it("keeps polling while authorization is pending until the flow is cancelled", async () => {
      // 403 and 404 both mean "user has not approved yet".
      for (const status of [403, 404]) {
        const calls = mockDeviceEndpoints({ poll: () => new Response("", { status }) });
        const start = await service.startDeviceFlow();
        if (!start.success) throw new Error(start.error);

        const wait = service.waitForDeviceFlow(start.data.flowId);
        // Let the first poll land, then cancel while the loop sleeps.
        while (calls.poll.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await service.cancelDeviceFlow(start.data.flowId);

        expect(await wait).toEqual({ success: false, error: "OAuth flow cancelled" });
        expect(calls.poll).toHaveLength(1);
        expect(calls.token).toHaveLength(0);
      }
    });

    it("times out the wait while authorization is still pending", async () => {
      mockDeviceEndpoints({ poll: () => new Response("", { status: 404 }) });

      expect(await runDeviceFlow({ timeoutMs: 20 })).toEqual({
        success: false,
        error: "Timed out waiting for device authorization",
      });
    });

    it("expires the flow when the device code has no lifetime left", async () => {
      const calls = mockDeviceEndpoints({
        userCode: () => mockRefreshResponse({ device_auth_id: "d", user_code: "U", expires_in: 0 }),
      });

      expect(await runDeviceFlow()).toEqual({ success: false, error: "Device code expired" });
      expect(calls.token).toHaveLength(0);
    });
  });
});
