import { z } from "zod";
import type { DaytonaErrorKind } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Thin typed fetch client for the Daytona control plane (public OpenAPI spec at
 * `<apiUrl>-json`). We deliberately do not depend on `@daytona/sdk`: it is 2 MB unpacked and
 * pulls in aws-sdk, OpenTelemetry, axios and socket.io for the dozen calls Xum needs.
 *
 * Security: the API key and SSH tokens never appear in errors or logs. Error messages name the
 * method and path only, never the query string (revoke passes the token there).
 */

export const DAYTONA_REQUEST_TIMEOUT_MS = 15_000;

export class DaytonaApiError extends Error {
  readonly kind: DaytonaErrorKind;
  readonly status?: number;
  readonly serverMessage?: string;

  constructor(kind: DaytonaErrorKind, message: string, status?: number, serverMessage?: string) {
    super(message);
    this.name = "DaytonaApiError";
    this.kind = kind;
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

export function isDaytonaNotFound(error: unknown): boolean {
  return error instanceof DaytonaApiError && error.kind === "not_found";
}

const GatewayConfigSchema = z.object({
  sshGatewayHost: z.string().optional(),
  sshGatewayPort: z.number().optional(),
  sshGatewayHostKeys: z.array(z.string()).optional(),
  defaultSnapshot: z.string().optional(),
});

export interface DaytonaGatewayConfig {
  sshGatewayHost: string;
  sshGatewayPort: number;
  sshGatewayHostKeys: string[];
  defaultSnapshot?: string;
}

const SandboxSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  state: z.string().optional(),
  cpu: z.number().optional(),
  memory: z.number().optional(),
  disk: z.number().optional(),
  snapshot: z.string().nullish(),
  target: z.string().nullish(),
  labels: z.record(z.string(), z.string()).nullish(),
  lastActivityAt: z.string().nullish(),
  errorReason: z.string().nullish(),
});

export type DaytonaSandbox = z.infer<typeof SandboxSchema>;

const SandboxPageSchema = z.object({
  items: z.array(SandboxSchema),
  nextCursor: z.string().nullish(),
});

const SnapshotPageSchema = z.object({
  items: z.array(z.object({ name: z.string() })),
  page: z.number().optional(),
  totalPages: z.number().optional(),
});

const SshAccessSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
});

export interface DaytonaSshAccess {
  token: string;
  expiresAt: string;
}

export interface DaytonaCreateSandboxRequest {
  name?: string;
  snapshot?: string;
  labels?: Record<string, string>;
  target?: string;
  cpu?: number;
  /** GiB */
  memory?: number;
  /** GiB */
  disk?: number;
  /** Minutes; 0 disables. */
  autoStopInterval?: number;
  /** Minutes. */
  autoArchiveInterval?: number;
  /** Minutes; negative disables. */
  autoDeleteInterval?: number;
  env?: Record<string, string>;
}

export interface DaytonaResizeRequest {
  cpu?: number;
  memory?: number;
  disk?: number;
}

export interface DaytonaClientOptions {
  apiUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
}

// Pagination guard: a control plane that keeps returning a cursor must not loop forever.
const MAX_PAGES = 50;
const PAGE_LIMIT = 100;

function extractServerMessage(bodyText: string): string | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      const message = (parsed as { message: unknown }).message;
      if (typeof message === "string") return message;
      if (Array.isArray(message)) return message.filter((m) => typeof m === "string").join("; ");
    }
  } catch {
    // Not JSON (proxy error page etc.): keep a short plain-text excerpt instead.
    return bodyText.slice(0, 200);
  }
  return undefined;
}

function kindForStatus(status: number): DaytonaErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 400) return "bad_request";
  return "server";
}

function describeStatus(kind: DaytonaErrorKind, status: number): string {
  switch (kind) {
    case "unauthorized":
      return `Daytona rejected the API key (HTTP ${status})`;
    case "not_found":
      return "Daytona resource not found (HTTP 404)";
    case "bad_request":
      return "Daytona rejected the request (HTTP 400)";
    default:
      return `Daytona request failed (HTTP ${status})`;
  }
}

export class DaytonaClient {
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DaytonaClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DAYTONA_REQUEST_TIMEOUT_MS;
  }

  private async request(
    method: string,
    pathName: string,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const url = new URL(`${this.apiUrl}${pathName}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.auth !== false) {
      if (!this.apiKey) {
        throw new DaytonaApiError("not_configured", "Daytona API key is not set");
      }
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    // An explicit timer instead of AbortSignal.timeout/any: under Bun an AbortSignal.timeout
    // held only by a hung request's promise chain was seen never to fire. The pending timer
    // keeps the controller reachable, so a hung request is always aborted.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const label = `${method} ${pathName}`;

    let response: Response;
    let bodyText: string;
    try {
      if (options.signal?.aborted) controller.abort();
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      bodyText = await response.text();
    } catch (error) {
      if (timedOut) {
        throw new DaytonaApiError(
          "timeout",
          `Daytona did not answer ${label} within ${Math.round(this.timeoutMs / 1000)}s`
        );
      }
      if (options.signal?.aborted) {
        throw new DaytonaApiError("timeout", `Daytona request ${label} was cancelled`);
      }
      throw new DaytonaApiError(
        "unreachable",
        `Could not reach Daytona at ${url.origin} (${getErrorMessage(error)})`
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }

    if (!response.ok) {
      const kind = kindForStatus(response.status);
      const serverMessage = extractServerMessage(bodyText);
      const base = `${describeStatus(kind, response.status)} for ${label}`;
      throw new DaytonaApiError(
        kind,
        serverMessage ? `${base}: ${serverMessage}` : base,
        response.status,
        serverMessage
      );
    }

    if (!bodyText) return undefined;
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw new DaytonaApiError("server", `Daytona returned invalid JSON for ${label}`);
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new DaytonaApiError("server", `Daytona returned an unexpected response for ${label}`);
    }
    return result.data;
  }

  /** Public (no auth): SSH gateway host, port and host keys for the known_hosts file. */
  async getConfig(signal?: AbortSignal): Promise<DaytonaGatewayConfig> {
    const raw = await this.request("GET", "/config", { auth: false, signal });
    const parsed = this.parse(GatewayConfigSchema, raw, "GET /config");
    if (!parsed.sshGatewayHost || !parsed.sshGatewayHostKeys?.length) {
      throw new DaytonaApiError(
        "server",
        "This Daytona deployment does not advertise an SSH gateway (sshGatewayHost)"
      );
    }
    return {
      sshGatewayHost: parsed.sshGatewayHost,
      sshGatewayPort: parsed.sshGatewayPort ?? 22,
      sshGatewayHostKeys: parsed.sshGatewayHostKeys,
      ...(parsed.defaultSnapshot ? { defaultSnapshot: parsed.defaultSnapshot } : {}),
    };
  }

  async createSandbox(
    body: DaytonaCreateSandboxRequest,
    signal?: AbortSignal
  ): Promise<DaytonaSandbox> {
    const raw = await this.request("POST", "/sandbox", { body, signal });
    return this.parse(SandboxSchema, raw, "POST /sandbox");
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<DaytonaSandbox> {
    const raw = await this.request("GET", `/sandbox/${encodeURIComponent(id)}`, { signal });
    return this.parse(SandboxSchema, raw, "GET /sandbox/{id}");
  }

  /** Every sandbox matching `labels` (all pages); no labels lists the whole organization. */
  async listSandboxes(
    labels?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<DaytonaSandbox[]> {
    const sandboxes: DaytonaSandbox[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await this.request("GET", "/sandbox", {
        query: {
          labels: labels ? JSON.stringify(labels) : undefined,
          limit: PAGE_LIMIT,
          cursor,
        },
        signal,
      });
      const parsed = this.parse(SandboxPageSchema, raw, "GET /sandbox");
      sandboxes.push(...parsed.items);
      if (!parsed.nextCursor) return sandboxes;
      cursor = parsed.nextCursor;
    }
    throw new DaytonaApiError("server", "Daytona sandbox list did not end after many pages");
  }

  /** One cheap authenticated call, for "Test connection". */
  async verifyAuth(signal?: AbortSignal): Promise<void> {
    await this.request("GET", "/sandbox", { query: { limit: 1 }, signal });
  }

  async startSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sandbox/${encodeURIComponent(id)}/start`, { signal });
  }

  async stopSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sandbox/${encodeURIComponent(id)}/stop`, { signal });
  }

  async archiveSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sandbox/${encodeURIComponent(id)}/archive`, { signal });
  }

  async deleteSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/sandbox/${encodeURIComponent(id)}`, { signal });
  }

  /** Disk only grows; a running sandbox only grows cpu/memory (shrinking needs it stopped). */
  async resizeSandbox(
    id: string,
    body: DaytonaResizeRequest,
    signal?: AbortSignal
  ): Promise<DaytonaSandbox> {
    const raw = await this.request("POST", `/sandbox/${encodeURIComponent(id)}/resize`, {
      body,
      signal,
    });
    return this.parse(SandboxSchema, raw, "POST /sandbox/{id}/resize");
  }

  /** SSH login is `ssh <token>@<gateway host> -p <port>`: the token is the username. */
  async createSshAccess(
    id: string,
    expiresInMinutes: number,
    signal?: AbortSignal
  ): Promise<DaytonaSshAccess> {
    const raw = await this.request("POST", `/sandbox/${encodeURIComponent(id)}/ssh-access`, {
      query: { expiresInMinutes },
      signal,
    });
    const parsed = this.parse(SshAccessSchema, raw, "POST /sandbox/{id}/ssh-access");
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  }

  async revokeSshAccess(id: string, token: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/sandbox/${encodeURIComponent(id)}/ssh-access`, {
      query: { token },
      signal,
    });
  }

  /** Daytona counts only SSH and API traffic as activity; this keeps a busy box from stopping. */
  async refreshActivity(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sandbox/${encodeURIComponent(id)}/last-activity`, { signal });
  }

  async listSnapshots(signal?: AbortSignal): Promise<Array<{ name: string }>> {
    const snapshots: Array<{ name: string }> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = await this.request("GET", "/snapshots", {
        query: { page, limit: PAGE_LIMIT },
        signal,
      });
      const parsed = this.parse(SnapshotPageSchema, raw, "GET /snapshots");
      snapshots.push(...parsed.items.map((item) => ({ name: item.name })));
      if (parsed.items.length === 0 || parsed.totalPages === undefined) return snapshots;
      if (page >= parsed.totalPages) return snapshots;
    }
    return snapshots;
  }
}
