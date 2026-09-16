import * as dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import * as net from "node:net";
// Deep import on purpose: under the Bun runtime the bare "undici" specifier
// resolves to Bun's built-in shim whose Agent ignores `connect` options and
// whose request() ignores `dispatcher` — pinning would silently vanish. The
// package entry point is the real implementation on both Node and Bun.
import { Agent, request } from "undici/index.js";
import type { Client, Dispatcher } from "undici/index.js";
import assert from "@/common/utils/assert";
import { isBlockedHostname, isBlockedIpAddress, normalizeHostname } from "./blockedTargets";

/**
 * Credential-free, redirect-free, address-pinned HTTPS GET for small untrusted
 * resources (MCP server icons).
 *
 * Security posture, in order:
 * 1. Only `https:` URLs without userinfo; blocked hostnames never resolve.
 * 2. DNS runs once (`lookup all`) and EVERY returned address must pass the
 *    block list — a mixed public/private answer rejects the whole fetch so a
 *    resolver cannot steer the second connection attempt somewhere private.
 * 3. The socket's `lookup` is the installed pinned lookup: it returns only the
 *    addresses validated above and never consults DNS again, so the dialed
 *    address is always a validated one while the URL hostname stays the TLS
 *    `servername` (SNI + certificate verification are against the hostname).
 * 4. No redirects (any non-200 ⇒ null), only `accept: image/*`, never the
 *    server's configured headers or OAuth material.
 * 5. Body bounded before and while reading; cleanup destroys the body and the
 *    agent on every failure/abort; a success closes the agent bounded by
 *    SUCCESS_CLOSE_TIMEOUT_MS and then destroys it. The caller's `signal` is
 *    the absolute job deadline and covers DNS, connect, headers, body, and
 *    cleanup.
 */

// TODO(parent): replace with the shared MCP_ICON_LIMITS.bodyMaxBytes once it lands.
/** Maximum body bytes accepted (declared or streamed); larger responses yield null. */
export const PINNED_FETCH_BODY_MAX_BYTES = 512 * 1024;
/** Graceful close budget after a successful read before the agent is destroyed. */
const SUCCESS_CLOSE_TIMEOUT_MS = 1_000;

export interface PinnedHttpsFetchResult {
  bytes: Buffer;
  /** Raw `content-type` header, when present. Advisory only; callers sniff. */
  contentType?: string;
}

/**
 * The repo-wide `undici` module augmentation (src/common/types/undici.d.ts)
 * narrows Agent's declared type to a stub; the runtime class is the real
 * Dispatcher-derived Agent with `connect` options, `close()` and `destroy()`.
 */
type AgentConstructor = new (options: Client.Options) => Dispatcher;
const RealAgent = Agent as AgentConstructor;

export type PinnedHttpsFetch = (
  url: URL,
  signal: AbortSignal
) => Promise<PinnedHttpsFetchResult | null>;

/**
 * Test-only seams for a controlled loopback harness. Neither seam can widen
 * what is fetched: injected DNS answers still pass the block list, and the
 * agent factory still receives the pinned `connect.lookup` and `servername`.
 */
export interface PinnedHttpsFetchTransport {
  /** Defaults to `dns.promises.lookup(hostname, { all: true })`. */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  /** Defaults to `new Agent(options)`. */
  createAgent?: (options: Client.Options) => Dispatcher;
}

/**
 * Lookup installed on the socket: answers exclusively from the validated
 * address list, for both the `all: true` (autoSelectFamily) and the
 * single-address callback shapes, and never performs DNS.
 */
function createPinnedLookup(addresses: readonly LookupAddress[]): net.LookupFunction {
  assert(addresses.length > 0, "pinned lookup requires at least one validated address");
  return (_hostname, options, callback) => {
    const pinned = addresses.map((entry) => ({ address: entry.address, family: entry.family }));
    if (options.all) {
      callback(null, pinned);
    } else {
      callback(null, pinned[0].address, pinned[0].family);
    }
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("pinned fetch aborted");
}

/** Race a non-cancellable step (DNS) against the job signal; never starts it once aborted. */
function withAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolve and validate every address for `url`. Returns null when the URL,
 * hostname, or any resolved address is not allowed. Literal IP hostnames are
 * validated directly and never resolved.
 */
async function resolveValidatedAddresses(
  url: URL,
  signal: AbortSignal,
  lookup: NonNullable<PinnedHttpsFetchTransport["lookup"]>
): Promise<LookupAddress[] | null> {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    return null;
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    return isBlockedIpAddress(hostname) ? null : [{ address: hostname, family: literalFamily }];
  }
  const answers = await withAbort(() => lookup(hostname), signal);
  if (answers.length === 0) {
    return null;
  }
  for (const answer of answers) {
    if (net.isIP(answer.address) === 0 || isBlockedIpAddress(answer.address)) {
      return null;
    }
  }
  return answers;
}

function destroyBody(body: Dispatcher.ResponseData["body"]): void {
  // Destroying an unfinished body emits an abort error asynchronously; the body
  // is being discarded, so swallow it. The agent's destroy below waits for the
  // underlying socket to close.
  body.on("error", () => undefined);
  body.destroy();
}

async function readBounded(
  body: Dispatcher.ResponseData["body"],
  maxBytes: number
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Build a fetcher. Production callers use `pinnedHttpsFetch` (no transport
 * seams); tests inject a controlled loopback transport.
 */
export function createPinnedHttpsFetch(
  transport: PinnedHttpsFetchTransport = {}
): PinnedHttpsFetch {
  const lookup = transport.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true }));
  const createAgent =
    transport.createAgent ?? ((options: Client.Options) => new RealAgent(options));

  return async (url, signal) => {
    let addresses: LookupAddress[] | null;
    try {
      addresses = await resolveValidatedAddresses(url, signal, lookup);
    } catch {
      return null;
    }
    if (!addresses || signal.aborted) {
      return null;
    }

    const hostname = normalizeHostname(url.hostname);
    // SNI carries hostnames only; a literal IP is verified against the
    // certificate's IP entries by the TLS layer without a servername.
    const agent = createAgent({
      connect: {
        lookup: createPinnedLookup(addresses),
        ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
      },
    });

    let body: Dispatcher.ResponseData["body"] | undefined;
    let succeeded = false;
    try {
      const response = await request(url, {
        dispatcher: agent,
        method: "GET",
        headers: { accept: "image/*" },
        signal,
      });
      body = response.body;
      if (response.statusCode !== 200) {
        return null;
      }
      const declaredLength = parseContentLength(response.headers["content-length"]);
      if (declaredLength !== undefined && declaredLength > PINNED_FETCH_BODY_MAX_BYTES) {
        return null;
      }
      const bytes = await readBounded(body, PINNED_FETCH_BODY_MAX_BYTES);
      if (bytes === null) {
        return null;
      }
      succeeded = true;
      return { bytes, contentType: headerString(response.headers["content-type"]) };
    } catch {
      return null;
    } finally {
      if (!succeeded && body && !body.destroyed) {
        destroyBody(body);
      }
      if (succeeded) {
        // Graceful close lets the keep-alive socket end cleanly, but never
        // beyond a bounded wait; destroy is the unconditional backstop.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            agent.close(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, SUCCESS_CLOSE_TIMEOUT_MS);
            }),
          ]);
        } catch {
          // Fall through to destroy.
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      try {
        await agent.destroy();
      } catch {
        // Nothing left to release.
      }
    }
  };
}

/** Production fetcher: real DNS, real undici Agent, no seams. */
export const pinnedHttpsFetch: PinnedHttpsFetch = createPinnedHttpsFetch();
