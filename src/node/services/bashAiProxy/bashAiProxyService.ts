/**
 * Bash AI proxy: a loopback HTTP proxy for Anthropic and OpenAI calls made by processes that the
 * bash tool starts (test harnesses, `make bug-bash`, scripts that call the SDKs).
 *
 * Why: those calls bypass the chat stream, so their spend never reached the workspace's Costs
 * tab or Analytics. Xum now gives each bash command a base URL that points here plus a key that
 * names its workspace. The proxy swaps that key for the provider key in the Xum settings,
 * forwards the request, streams the answer back, and records the usage in that workspace.
 *
 * Contract:
 * - Only the Local and Worktree runtimes get the env pair: other runtimes cannot reach the
 *   backend's 127.0.0.1, and Xum adds no tunnel.
 * - A proxy key authorizes only these provider endpoints for one workspace. It is not a Xum API
 *   token. Keys and the port live in memory: after a restart old processes get ECONNREFUSED.
 *   A key stops working when its workspace is removed.
 * - The upstream host comes from the Xum provider config only, never from the request, and the
 *   proxy never follows redirects, so the real key cannot reach another host.
 * - A refused request (unknown key, path not allowed, no Xum key) fails with an error. The proxy
 *   never falls back to a direct call.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { EnvHttpProxyAgent, type Dispatcher } from "undici";

import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import { normalizeAnthropicBaseURL } from "@/common/utils/providers/baseUrl";
import type { RuntimeMode } from "@/common/types/runtime";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";
import { log } from "@/node/services/log";
import {
  resolveProviderCredentials,
  type ProviderConfigRaw,
} from "@/node/utils/providerRequirements";

import { UsageTap, type BashAiProxyProvider } from "./usageExtract";

/** Prefix of every proxy key, so a leaked value is easy to recognize. */
export const BASH_AI_PROXY_KEY_PREFIX = "xum-proxy-";

/** Analytics source: rows land as `tool_name = headless:bash_proxy`. */
export const BASH_AI_PROXY_ANALYTICS_SOURCE = "bash_proxy";

const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

interface ProxyRoute {
  provider: BashAiProxyProvider;
  /** Path prefix on the proxy listener. */
  prefix: string;
  defaultUpstream: string;
  /** Env names a project secret can set; any one of them turns the pair off for this provider. */
  envNames: readonly string[];
  /** Paths that bill tokens: a 2xx answer without usage is logged as uncounted. */
  billable: readonly string[];
  allowed: ReadonlyArray<{ method: string; path: string | RegExp }>;
  env: (origin: string, key: string) => Record<string, string>;
}

const ROUTES: readonly ProxyRoute[] = [
  {
    provider: "anthropic",
    prefix: "/anthropic",
    defaultUpstream: "https://api.anthropic.com/v1",
    envNames: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
    billable: ["/v1/messages"],
    allowed: [
      { method: "POST", path: "/v1/messages" },
      { method: "POST", path: "/v1/messages/count_tokens" },
      { method: "GET", path: /^\/v1\/models(\/[^/]+)?$/ },
    ],
    // No /v1: the official SDK and Claude Code append /v1/..., the AI SDK appends /messages.
    // handle() adds a missing /v1, so both conventions reach the same endpoint.
    env: (origin, key) => ({
      ANTHROPIC_BASE_URL: `${origin}/anthropic`,
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_AUTH_TOKEN: key,
    }),
  },
  {
    provider: "openai",
    prefix: "/openai",
    defaultUpstream: "https://api.openai.com/v1",
    envNames: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"],
    billable: ["/v1/responses", "/v1/chat/completions"],
    allowed: [
      { method: "POST", path: "/v1/responses" },
      { method: "POST", path: "/v1/chat/completions" },
      { method: "GET", path: /^\/v1\/models(\/[^/]+)?$/ },
    ],
    env: (origin, key) => ({ OPENAI_BASE_URL: `${origin}/openai/v1`, OPENAI_API_KEY: key }),
  },
];

// Request headers that never go upstream: hop-by-hop headers, the proxy key, and headers that
// the proxy sets itself from the Xum config.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Clients such as curl can send `Expect: 100-continue` for large bodies. Node already
  // answered it, and undici's fetch rejects the header.
  "expect",
  "content-length",
  "accept-encoding",
  "authorization",
  "x-api-key",
  "cookie",
  "openai-organization",
  "openai-project",
]);

// fetch() decodes compressed bodies, so length and encoding headers no longer describe the bytes.
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

export interface RecordedUsage {
  model: string;
  usage: ChatUsageDisplay;
}

export interface BashAiProxyServiceOptions {
  /** The Settings switch (config bashAiProxyEnabled; absent = off). */
  isEnabled: () => boolean;
  /** A key verifies only while its workspace exists, so removal revokes it. */
  workspaceExists: (workspaceId: string) => boolean;
  /**
   * Whether the workspace may run repo code with provider credentials (shared-execution trust,
   * project automation allowed). Checked per request, so revoking trust also stops commands
   * that already hold a key, like turning the switch off.
   */
  isWorkspaceTrusted: (workspaceId: string) => Promise<boolean>;
  /** Raw providers.jsonc entry for one provider. */
  loadProviderConfig: (provider: BashAiProxyProvider) => ProviderConfigRaw;
  /** Writes priced usage to the workspace ledger and analytics sidecar; undefined = not written. */
  recordUsage: (
    workspaceId: string,
    modelString: string,
    usage: AiSdkUsageLike,
    providerMetadata: Record<string, unknown> | undefined
  ) => Promise<RecordedUsage | undefined>;
  /** Live update for the Costs tab after a successful write. */
  onUsageRecorded: (workspaceId: string, recorded: RecordedUsage) => void;
}

type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

// Same outbound behavior as chat requests (providerModelFactory): honor HTTP(S)_PROXY and never
// time out a long stream. One process-wide agent, like the chat path's.
const outboundDispatcher = new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 });

class ProxyRefusal extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export class BashAiProxyService {
  private readonly keys = new Map<string, string>(); // proxy key -> workspaceId
  private readonly keyByWorkspace = new Map<string, string>();
  private server: http.Server | undefined;
  private startPromise: Promise<number | undefined> | undefined;
  private stopped = false;

  constructor(private readonly options: BashAiProxyServiceOptions) {}

  /**
   * Env vars for one bash command in this workspace: {} when the switch is off, the runtime
   * cannot reach loopback, the listener failed, or Xum has no key for a provider. A provider
   * whose env names appear in `secretKeys` is skipped as a whole, so a command never gets a
   * proxy URL paired with a real key (project secrets override xumEnv in the bash tool).
   */
  async envFor(
    workspaceId: string,
    runtime: RuntimeMode,
    secretKeys: readonly string[]
  ): Promise<Record<string, string>> {
    assert(workspaceId.length > 0, "envFor requires a workspaceId");
    if (!this.options.isEnabled()) return {};
    const port = await this.ensureStarted();
    if (port === undefined) return {};
    const origin = this.originFor(runtime, port);
    if (origin === undefined) return {};
    const env: Record<string, string> = {};
    for (const route of ROUTES) {
      if (route.envNames.some((name) => secretKeys.includes(name))) continue;
      if (this.upstreamFor(route) === undefined) continue; // nothing to pay with
      Object.assign(env, route.env(origin, this.keyFor(workspaceId)));
    }
    return env;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const server = this.server;
    this.server = undefined;
    this.keys.clear();
    this.keyByWorkspace.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Where commands of this workspace reach the proxy, or undefined when they cannot. */
  private originFor(runtime: RuntimeMode, port: number): string | undefined {
    // Other runtimes cannot reach the backend's 127.0.0.1.
    return runtime === "local" || runtime === "worktree" ? `http://127.0.0.1:${port}` : undefined;
  }

  private keyFor(workspaceId: string): string {
    const existing = this.keyByWorkspace.get(workspaceId);
    if (existing !== undefined) return existing;
    const key = `${BASH_AI_PROXY_KEY_PREFIX}${randomBytes(32).toString("hex")}`;
    this.keys.set(key, workspaceId);
    this.keyByWorkspace.set(workspaceId, key);
    return key;
  }

  /** The workspace a request's key names, if the key is known and the workspace still exists. */
  private workspaceForKey(key: string | undefined): string | undefined {
    const workspaceId = key === undefined ? undefined : this.keys.get(key);
    return workspaceId !== undefined && this.options.workspaceExists(workspaceId)
      ? workspaceId
      : undefined;
  }

  /**
   * Starts the listener on the first envFor() call (the first agent turn in a Local or Worktree
   * workspace), so a backend without such turns binds no port.
   * A failed start logs and returns undefined (bash then runs without the pair); the next call
   * tries again.
   */
  private ensureStarted(): Promise<number | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    this.startPromise ??= this.listen().catch((error: unknown) => {
      log.warn("[bash-ai-proxy] listener failed to start; bash AI calls stay uncounted", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.startPromise = undefined;
      return undefined;
    });
    return this.startPromise;
  }

  private async listen(): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        // A client that hangs up aborts the upstream fetch: that is not a proxy failure.
        (res.destroyed ? log.debug : log.warn)("[bash-ai-proxy] request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) sendError(res, 502, "Xum bash AI proxy: upstream request failed.");
        else res.destroy();
      });
    });
    await listenOn(server, 0);
    if (this.stopped) {
      server.close();
      throw new Error("stopped while starting");
    }
    this.server = server;
    const port = (server.address() as AddressInfo).port;
    assert(port > 0, "bash AI proxy listener must have a port");
    log.info("[bash-ai-proxy] listening", { port });
    return port;
  }

  /** Upstream base URL (with /v1) and key from the Xum provider config, or undefined. */
  private upstreamFor(
    route: ProxyRoute
  ):
    | { baseUrl: string; apiKey: string; organization?: string; headers: Record<string, string> }
    | undefined {
    const config = this.options.loadProviderConfig(route.provider);
    if (isProviderDisabledInConfig(config)) return undefined;
    const creds = resolveProviderCredentials(route.provider, config);
    if (!creds.isConfigured || !creds.apiKey) return undefined;
    const configured = creds.baseUrl?.trim();
    const baseUrl =
      route.provider === "anthropic"
        ? normalizeAnthropicBaseURL(configured ?? route.defaultUpstream)
        : (configured ?? route.defaultUpstream);
    return {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: creds.apiKey,
      ...(creds.organization ? { organization: creds.organization } : {}),
      // Custom headers from providers.jsonc (gateways can need them), as chat requests send them.
      headers: readStringRecord((config as { headers?: unknown }).headers),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.forward(req, res);
    } catch (error) {
      if (!(error instanceof ProxyRefusal)) throw error;
      // Drain the unread body so the client sees the answer instead of a reset socket.
      req.resume();
      sendError(res, error.status, error.message);
    }
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Turning the switch off cuts access at once, for processes that already hold a key too.
    if (!this.options.isEnabled()) {
      throw new ProxyRefusal(503, "Xum bash AI proxy is turned off in Settings → Providers.");
    }
    const route = ROUTES.find(
      (r) => url.pathname === r.prefix || url.pathname.startsWith(`${r.prefix}/`)
    );
    if (!route) throw new ProxyRefusal(404, "Xum bash AI proxy: unknown route.");

    const workspaceId = this.workspaceForKey(readProxyKey(req.headers));
    if (workspaceId === undefined) {
      throw new ProxyRefusal(
        401,
        "Xum bash AI proxy: unknown key. The workspace was removed, or the variable holds another key (do not put a real provider key in it)."
      );
    }
    if (!(await this.options.isWorkspaceTrusted(workspaceId))) {
      throw new ProxyRefusal(
        403,
        "Xum bash AI proxy: the workspace's project is not trusted, so its commands cannot call providers through Xum."
      );
    }

    let path = url.pathname.slice(route.prefix.length) || "/";
    if (path !== "/v1" && !path.startsWith("/v1/")) path = `/v1${path}`;
    const method = (req.method ?? "GET").toUpperCase();
    const allowed = route.allowed.some(
      (a) =>
        a.method === method && (typeof a.path === "string" ? a.path === path : a.path.test(path))
    );
    if (!allowed) {
      throw new ProxyRefusal(404, `Xum bash AI proxy: ${method} ${path} is not allowed.`);
    }

    const upstream = this.upstreamFor(route);
    if (!upstream) {
      throw new ProxyRefusal(
        503,
        `Xum bash AI proxy: Xum has no ${route.provider} API key. Add one in Settings → Providers.`
      );
    }

    let body = method === "GET" ? undefined : await readBody(req);
    if (body && route.provider === "openai" && path === "/v1/chat/completions") {
      body = withStreamUsage(body);
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    if (route.provider === "anthropic") {
      headers.set("x-api-key", upstream.apiKey);
    } else {
      headers.set("authorization", `Bearer ${upstream.apiKey}`);
      if (upstream.organization) headers.set("openai-organization", upstream.organization);
    }
    for (const [name, value] of Object.entries(upstream.headers)) headers.set(name, value);
    headers.set("accept-encoding", "identity");

    // A client that hangs up stops the upstream request too.
    const abort = new AbortController();
    res.once("close", () => abort.abort());

    const init: RequestInitWithDispatcher = {
      method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
      redirect: "manual",
      signal: abort.signal,
      dispatcher: outboundDispatcher,
    };
    const response = await fetch(`${upstream.baseUrl}${path.slice(3)}${url.search}`, init);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ProxyRefusal(
        502,
        "Xum bash AI proxy: the provider sent a redirect. Xum does not follow it."
      );
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
    });
    res.writeHead(response.status, responseHeaders);

    const billable = response.ok && route.billable.includes(path);
    const tap = billable
      ? new UsageTap(route.provider, response.headers.get("content-type") ?? undefined)
      : undefined;
    try {
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          tap?.push(value);
          if (!res.write(value)) await waitForDrain(res);
        }
      }
      res.end();
    } finally {
      // Record what the response carried even if the client hung up mid-stream: the provider
      // bills the tokens it already produced.
      if (tap) await this.record(workspaceId, route.provider, path, tap);
    }
  }

  private async record(
    workspaceId: string,
    provider: BashAiProxyProvider,
    path: string,
    tap: UsageTap
  ): Promise<void> {
    const extracted = tap.finish();
    if (!extracted) {
      log.warn("[bash-ai-proxy] response had no usage; not counted", { workspaceId, path });
      return;
    }
    const recorded = await this.options.recordUsage(
      workspaceId,
      `${provider}:${extracted.model ?? "unknown"}`,
      extracted.usage,
      extracted.providerMetadata
    );
    if (recorded) this.options.onUsageRecorded(workspaceId, recorded);
  }
}

function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function readStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) {
    // Never let config headers replace the auth header that the proxy sets.
    if (typeof v === "string" && !DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) out[name] = v;
  }
  return out;
}

function readProxyKey(headers: http.IncomingHttpHeaders): string | undefined {
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.startsWith(BASH_AI_PROXY_KEY_PREFIX)) return apiKey;
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (match?.[1]?.startsWith(BASH_AI_PROXY_KEY_PREFIX)) return match[1];
  }
  return undefined;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new ProxyRefusal(413, "Xum bash AI proxy: request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Streamed Chat Completions carry usage only with stream_options.include_usage. Xum sets it only
 * when the client left it unset: the usage chunk has `choices: []`, and a client that turned it
 * off on purpose may not handle that chunk. Such a stream stays uncounted (logged).
 */
function withStreamUsage(body: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { stream?: unknown }).stream !== true
  ) {
    return body;
  }
  const request = parsed as { stream_options?: Record<string, unknown> };
  if (request.stream_options?.include_usage !== undefined) return body;
  request.stream_options = { ...(request.stream_options ?? {}), include_usage: true };
  return Buffer.from(JSON.stringify(request));
}

function waitForDrain(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Anthropic's error envelope; OpenAI SDKs also read `error.message` from it.
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: status === 401 ? "authentication_error" : "xum_proxy_error", message },
    })
  );
}
