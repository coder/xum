import * as crypto from "crypto";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildAuthorizeUrl,
  buildExchangeBody,
  MUX_GATEWAY_EXCHANGE_URL,
  MUX_GATEWAY_ORIGIN,
  MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
} from "@/common/constants/muxGatewayOAuth";
import type { ProvidersConfigStore } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { createDeferred, renderOAuthCallbackHtml } from "@/node/utils/oauthUtils";
import { startLoopbackServer } from "@/node/utils/oauthLoopbackServer";
import { OAuthFlowManager } from "@/node/utils/oauthFlowManager";
import { getErrorMessage } from "@/common/utils/errors";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 10 * 60 * 1000;

interface ServerFlow {
  state: string;
  expiresAtMs: number;
}

export class MuxGatewayOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly serverFlows = new Map<string, ServerFlow>();

  constructor(
    private readonly providersConfigStore: Pick<ProvidersConfigStore, "loadProvidersConfig">,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async getAccountStatus(): Promise<
    Result<
      {
        remaining_microdollars: number;
        ai_gateway_concurrent_requests_per_user: number;
      },
      string
    >
  > {
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const muxConfig = (providersConfig["mux-gateway"] ?? {}) as Record<string, unknown>;
    const creds = resolveProviderCredentials("mux-gateway", {
      couponCode: typeof muxConfig.couponCode === "string" ? muxConfig.couponCode : undefined,
      voucher: typeof muxConfig.voucher === "string" ? muxConfig.voucher : undefined,
    });

    if (!creds.isConfigured || !creds.couponCode) {
      return Err("Xum Gateway is not logged in");
    }

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${MUX_GATEWAY_ORIGIN}/api/v1/balance`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${creds.couponCode}`,
        },
      });
    } catch (error) {
      return Err(`Xum Gateway balance request failed: ${getErrorMessage(error)}`);
    }

    if (response.status === 401) {
      try {
        await this.providerService.setConfig("mux-gateway", ["couponCode"], "");
        await this.providerService.setConfig("mux-gateway", ["voucher"], "");
      } catch {
        // Credential clearing is best-effort; session expiry still reaches the caller.
      }

      return Err(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE);
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        // Preserve the HTTP status fallback when the response body is unreadable.
      }
      const prefix = body.trim().slice(0, 200);
      return Err(
        `Xum Gateway balance request failed (HTTP ${response.status}): ${
          prefix || response.statusText
        }`
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      return Err(`Xum Gateway balance response was not valid JSON: ${getErrorMessage(error)}`);
    }

    const payload = json as {
      remaining_microdollars?: unknown;
      ai_gateway_concurrent_requests_per_user?: unknown;
    };
    const remaining = payload.remaining_microdollars;
    const concurrency = payload.ai_gateway_concurrent_requests_per_user;

    if (
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      !Number.isInteger(remaining) ||
      remaining < 0 ||
      typeof concurrency !== "number" ||
      !Number.isFinite(concurrency) ||
      !Number.isInteger(concurrency) ||
      concurrency < 0
    ) {
      return Err("Xum Gateway returned an invalid balance payload");
    }

    return Ok({
      remaining_microdollars: remaining,
      ai_gateway_concurrent_requests_per_user: concurrency,
    });
  }

  async startDesktopFlow(): Promise<
    Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>
  > {
    const flowId = crypto.randomUUID();
    const resultDeferred = createDeferred<Result<void, string>>();

    let loopback;
    try {
      loopback = await startLoopbackServer({
        expectedState: flowId,
        deferSuccessResponse: true,
        renderHtml: (r) =>
          renderOAuthCallbackHtml({
            title: r.success ? "Login complete" : "Login failed",
            message: r.success
              ? "You can return to Xum. You may now close this tab."
              : (r.error ?? "Unknown error"),
            success: r.success,
            extraHead:
              '<meta name="theme-color" content="#0e0e0e" />\n    <link rel="stylesheet" href="https://gateway.mux.coder.com/static/css/site.css" />',
          }),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to start OAuth callback listener: ${message}`);
    }

    const authorizeUrl = buildAuthorizeUrl({ redirectUri: loopback.redirectUri, state: flowId });

    this.desktopFlows.register(flowId, {
      server: loopback.server,
      resultDeferred,
      // Keep server-side timeout tied to flow lifetime so abandoned flows
      // (e.g. callers that never invoke waitForDesktopFlow) still self-clean.
      timeoutHandle: setTimeout(() => {
        void this.desktopFlows.finish(flowId, Err("Timed out waiting for OAuth callback"));
      }, DEFAULT_DESKTOP_TIMEOUT_MS),
    });

    // Background task: await loopback callback, do token exchange, finish flow.
    // Race against resultDeferred so that if the flow is cancelled/timed out
    // externally, this task exits cleanly instead of dangling on loopback.result.
    void (async () => {
      const callbackOrDone = await Promise.race([
        loopback.result,
        resultDeferred.promise.then((): null => null),
      ]);

      // Flow was already finished externally (timeout or cancel).
      if (callbackOrDone === null) return;

      log.debug(`Xum Gateway OAuth callback received (flowId=${flowId})`);

      let result: Result<void, string>;
      if (callbackOrDone.success) {
        result = await this.handleCallbackAndExchange({
          state: callbackOrDone.data.state,
          code: callbackOrDone.data.code,
          error: null,
        });

        if (result.success) {
          loopback.sendSuccessResponse();
        } else {
          loopback.sendFailureResponse(result.error);
        }
      } else {
        result = Err(`Xum Gateway OAuth error: ${callbackOrDone.error}`);
      }

      await this.desktopFlows.finish(flowId, result);
    })();

    log.debug(`Xum Gateway OAuth desktop flow started (flowId=${flowId})`);

    return Ok({ flowId, authorizeUrl, redirectUri: loopback.redirectUri });
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    return this.desktopFlows.waitFor(flowId, opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS);
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    if (!this.desktopFlows.has(flowId)) return;
    log.debug(`Xum Gateway OAuth desktop flow cancelled (flowId=${flowId})`);
    await this.desktopFlows.cancel(flowId);
  }

  startServerFlow(input: { redirectUri: string }): { authorizeUrl: string; state: string } {
    const state = crypto.randomUUID();
    // Prune expired flows (best-effort; avoids unbounded growth if callbacks never arrive).
    const now = Date.now();
    for (const [key, flow] of this.serverFlows) {
      if (flow.expiresAtMs <= now) {
        this.serverFlows.delete(key);
      }
    }

    const authorizeUrl = buildAuthorizeUrl({ redirectUri: input.redirectUri, state });

    this.serverFlows.set(state, {
      state,
      expiresAtMs: Date.now() + DEFAULT_SERVER_TIMEOUT_MS,
    });

    log.debug(`Xum Gateway OAuth server flow started (state=${state})`);

    return { authorizeUrl, state };
  }

  async handleServerCallbackAndExchange(input: {
    state: string | null;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    const state = input.state;
    if (!state) {
      return Err("Missing OAuth state");
    }

    const flow = this.serverFlows.get(state);
    if (!flow) {
      return Err("Unknown OAuth state");
    }

    if (Date.now() > flow.expiresAtMs) {
      this.serverFlows.delete(state);
      return Err("OAuth flow expired");
    }

    // Regardless of outcome, this flow should not be reused.
    this.serverFlows.delete(state);

    return this.handleCallbackAndExchange({
      state,
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });
  }

  async dispose(): Promise<void> {
    await this.desktopFlows.shutdownAll();
    this.serverFlows.clear();
  }

  private async handleCallbackAndExchange(input: {
    state: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    if (input.error) {
      const message = input.errorDescription
        ? `${input.error}: ${input.errorDescription}`
        : input.error;
      return Err(`Xum Gateway OAuth error: ${message}`);
    }

    if (!input.code) {
      return Err("Missing OAuth code");
    }

    const tokenResult = await this.exchangeCodeForToken(input.code);
    if (!tokenResult.success) {
      return Err(tokenResult.error);
    }

    const persistResult = await this.providerService.setConfig(
      "mux-gateway",
      ["couponCode"],
      tokenResult.data
    );
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    log.debug(`Xum Gateway OAuth exchange completed (state=${input.state})`);

    this.windowService?.focusMainWindow();

    return Ok(undefined);
  }

  private async exchangeCodeForToken(code: string): Promise<Result<string, string>> {
    try {
      const response = await fetch(MUX_GATEWAY_EXCHANGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: buildExchangeBody({ code }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Xum Gateway exchange failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as { access_token?: unknown };
      const token = typeof json.access_token === "string" ? json.access_token : null;
      if (!token) {
        return Err("Xum Gateway exchange response missing access_token");
      }

      return Ok(token);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Xum Gateway exchange failed: ${message}`);
    }
  }
}
