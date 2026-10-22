import { z } from "zod";
import type { DaytonaErrorKind } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DAYTONA_TOKEN_PLACEHOLDER,
  redactDaytonaTokens,
} from "@/node/runtime/daytonaTokenRedaction";
import { linkAbortSignal } from "@/node/utils/abort";

/**
 * Thin typed fetch client for the Daytona control plane (public OpenAPI spec at
 * `<apiUrl>-json`). We deliberately do not depend on `@daytona/sdk`: it is 2 MB unpacked and
 * pulls in aws-sdk, OpenTelemetry, axios and socket.io for the dozen calls Xum needs.
 *
 * Security: the API key and SSH tokens never appear in errors or logs. Error messages name the
 * method and path only, never the query string (revoke passes the token there). A control plane
 * or proxy may echo the request (its URI, its Authorization header) in an error body or a fetch
 * error: every diagnostic kept from a failed request goes through that request's redactor.
 */

const DAYTONA_REQUEST_TIMEOUT_MS = 15_000;

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
  /** "linux-vm", "container" or "windows"; older control planes omit it. */
  sandboxClass: z.string().nullish(),
  /** GPU units; positive on a GPU sandbox (no sandboxClass marks one). */
  gpu: z.number().nullish(),
});

export type DaytonaSandbox = z.infer<typeof SandboxSchema>;

const SandboxPageSchema = z.object({
  items: z.array(SandboxSchema),
  nextCursor: z.string().nullish(),
});

const SnapshotSchema = z.object({
  name: z.string(),
  /** The class of the sandboxes the snapshot creates, as on a sandbox. */
  sandboxClass: z.string().nullish(),
  /** GPU units of the sandboxes it creates, as on a sandbox. */
  gpu: z.number().nullish(),
});

export interface DaytonaSnapshot {
  name: string;
  sandboxClass?: string;
  gpu?: number;
}

function toSnapshot(item: z.infer<typeof SnapshotSchema>): DaytonaSnapshot {
  return {
    name: item.name,
    ...(item.sandboxClass ? { sandboxClass: item.sandboxClass } : {}),
    ...(item.gpu ? { gpu: item.gpu } : {}),
  };
}

const SnapshotPageSchema = z.object({
  items: z.array(SnapshotSchema),
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
  /** Values this request sends that are secrets (in the query or the body), besides the key. */
  secrets?: string[];
}

const DAYTONA_API_KEY_PLACEHOLDER = "<daytona-api-key>";

type Redact = (text: string) => string;

/** A secret as an echo may carry it: raw, or encoded as a path or query component. */
function encodedForms(secret: string): string[] {
  const queryForm = new URLSearchParams({ s: secret }).toString().slice("s=".length);
  // Encoded forms first: raw text left in one would otherwise survive as a partial match.
  return [...new Set([queryForm, encodeURIComponent(secret), secret])];
}

function createRedactor(apiKey: string | undefined, secrets: string[]): Redact {
  const replacements: Array<[string, string]> = [];
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of encodedForms(secret)) replacements.push([form, DAYTONA_TOKEN_PLACEHOLDER]);
  }
  if (apiKey) {
    for (const form of encodedForms(apiKey)) replacements.push([form, DAYTONA_API_KEY_PLACEHOLDER]);
  }
  return (text) => {
    let redacted = text;
    for (const [secret, placeholder] of replacements) {
      redacted = redacted.replaceAll(secret, placeholder);
    }
    // Any token minted earlier, which an error of another request may still carry.
    return redactDaytonaTokens(redacted);
  };
}

// Pagination guard: a control plane that keeps returning a cursor must not loop forever.
const MAX_PAGES = 50;
const PAGE_LIMIT = 100;

const MAX_SERVER_MESSAGE_CHARS = 200;

/**
 * Error text ends up in toasts and turn errors: a proxy or a non-Daytona URL can answer with a
 * whole HTML page, so drop tags, collapse whitespace and keep a short excerpt.
 */
function toPlainExcerpt(text: string, redact: Redact): string | undefined {
  // Redacted before the cut, so a truncated secret cannot survive as a prefix.
  const plain = redact(text)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length > MAX_SERVER_MESSAGE_CHARS
    ? `${plain.slice(0, MAX_SERVER_MESSAGE_CHARS)}...`
    : plain;
}

function extractServerMessage(bodyText: string, redact: Redact): string | undefined {
  if (!bodyText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Not JSON (proxy error page etc.): keep a short plain-text excerpt instead.
    return toPlainExcerpt(bodyText, redact);
  }
  if (parsed && typeof parsed === "object" && "message" in parsed) {
    const message = parsed.message;
    if (typeof message === "string") return toPlainExcerpt(message, redact);
    if (Array.isArray(message)) {
      return toPlainExcerpt(message.filter((m) => typeof m === "string").join("; "), redact);
    }
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

function buildUrl(apiUrl: string, pathName: string, query: RequestOptions["query"] = {}): URL {
  const url = new URL(`${apiUrl}${pathName}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function httpError(
  status: number,
  bodyText: string,
  label: string,
  redact: Redact
): DaytonaApiError {
  const kind = kindForStatus(status);
  const serverMessage = extractServerMessage(bodyText, redact);
  const base = `${describeStatus(kind, status)} for ${label}`;
  return new DaytonaApiError(
    kind,
    serverMessage ? `${base}: ${serverMessage}` : base,
    status,
    serverMessage
  );
}

function transportError(
  error: unknown,
  context: {
    label: string;
    origin: string;
    timeoutMs: number;
    timedOut: boolean;
    cancelled: boolean;
    redact: Redact;
  }
): DaytonaApiError {
  if (context.timedOut) {
    return new DaytonaApiError(
      "timeout",
      `Daytona did not answer ${context.label} within ${Math.round(context.timeoutMs / 1000)}s`
    );
  }
  if (context.cancelled) {
    return new DaytonaApiError("timeout", `Daytona request ${context.label} was cancelled`);
  }
  return new DaytonaApiError(
    "unreachable",
    `Could not reach Daytona at ${context.origin} (${context.redact(getErrorMessage(error))})`
  );
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
    const label = `${method} ${pathName}`;
    const url = buildUrl(this.apiUrl, pathName, options.query);
    const redact = createRedactor(this.apiKey, options.secrets ?? []);
    const { response, bodyText } = await this.send(url, label, redact, {
      method,
      headers: this.buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      callerSignal: options.signal,
    });
    if (!response.ok) throw httpError(response.status, bodyText, label, redact);
    if (!bodyText) return undefined;
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw new DaytonaApiError("server", `Daytona returned invalid JSON for ${label}`);
    }
  }

  private buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.auth !== false) {
      if (!this.apiKey) {
        throw new DaytonaApiError("not_configured", "Daytona API key is not set");
      }
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    return headers;
  }

  /** fetch with this client's timeout and the caller's signal; transport failures are typed. */
  private async send(
    url: URL,
    label: string,
    redact: Redact,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      callerSignal?: AbortSignal;
    }
  ): Promise<{ response: Response; bodyText: string }> {
    // An explicit timer instead of AbortSignal.timeout/any: under Bun an AbortSignal.timeout
    // held only by a hung request's promise chain was seen never to fire. The pending timer
    // keeps the controller reachable, so a hung request is always aborted.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const callerSignal = init.callerSignal;
    const unlinkCaller = linkAbortSignal(callerSignal, controller);
    try {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      return { response, bodyText: await response.text() };
    } catch (error) {
      throw transportError(error, {
        label,
        origin: url.origin,
        timeoutMs: this.timeoutMs,
        timedOut,
        cancelled: callerSignal?.aborted === true,
        redact,
      });
    } finally {
      clearTimeout(timer);
      unlinkCaller();
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
      secrets: [token],
      signal,
    });
  }

  /** Replaces every label: Daytona has no call that removes a single one. */
  async replaceLabels(
    id: string,
    labels: Record<string, string>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.request("PUT", `/sandbox/${encodeURIComponent(id)}/labels`, {
      body: { labels },
      signal,
    });
  }

  /** Daytona counts only SSH and API traffic as activity; this keeps a busy box from stopping. */
  async refreshActivity(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sandbox/${encodeURIComponent(id)}/last-activity`, { signal });
  }

  async getSnapshot(name: string, signal?: AbortSignal): Promise<DaytonaSnapshot> {
    const raw = await this.request("GET", `/snapshots/${encodeURIComponent(name)}`, { signal });
    return toSnapshot(this.parse(SnapshotSchema, raw, "GET /snapshots/{id}"));
  }

  async listSnapshots(signal?: AbortSignal): Promise<DaytonaSnapshot[]> {
    const snapshots: DaytonaSnapshot[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = await this.request("GET", "/snapshots", {
        query: { page, limit: PAGE_LIMIT },
        signal,
      });
      const parsed = this.parse(SnapshotPageSchema, raw, "GET /snapshots");
      // A page with nothing new ends the walk: a server that ignores `page` repeats page 1.
      const fresh = parsed.items.map(toSnapshot).filter((snapshot) => !seen.has(snapshot.name));
      for (const snapshot of fresh) seen.add(snapshot.name);
      snapshots.push(...fresh);
      if (fresh.length === 0 || isLastPage(parsed, page)) return snapshots;
    }
    return snapshots;
  }
}

/** totalPages is optional: without it, a page shorter than the limit is the last one. */
function isLastPage(parsed: { items: unknown[]; totalPages?: number }, page: number): boolean {
  return parsed.totalPages === undefined
    ? parsed.items.length < PAGE_LIMIT
    : page >= parsed.totalPages;
}
