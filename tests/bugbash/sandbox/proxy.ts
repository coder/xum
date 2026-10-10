/**
 * The bug-bash provider proxy (#5714, plan PR A2). Nothing starts it yet: PR B1 runs one per job
 * in the launcher process on the host, on a unix socket in the job's 0700 folder, and the
 * container reaches it only through that socket. The provider key stays in this process.
 *
 * Per call: only `POST /anthropic/v1/messages` (P1); `checkRequest` from proxyPolicy.ts (P2 to
 * P6); a reservation in the run-wide ledger before dispatch (P7); `fetch` to the host-configured
 * upstream with the host key and `redirect: "manual"` (a 3xx becomes a 502); and the response
 * streamed back through a header allowlist. The call settles to its usage only after a complete
 * response: a JSON body with `usage`, or an SSE stream through `message_stop`. Every other outcome
 * keeps the full reservation. `close()` aborts every call and returns only after each one is
 * counted (P8). Records and refusal texts carry no body, header value or key (P9).
 *
 * A `net` front owns the job's socket and pipes each connection to the HTTP server, which listens
 * on a socket in a private folder of its own. Bun 1.3.12's node:http server never reports a
 * connection whose request headers do not complete, so only the front can bound those: at most
 * MAX_CONNECTIONS, each destroyed twice the call deadline after it was accepted (an absolute
 * limit that no byte resets), and all destroyed by close(). Every response says
 * `connection: close`, so a client that behaves opens a new connection per call and never meets
 * that limit inside a call.
 */
import { once } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { checkRequest, MAX_BODY_BYTES, type JobPolicy, type Ledger } from "./proxyPolicy";

export const PROXY_PATH = "/anthropic/v1/messages";
const MAX_IN_FLIGHT = 4;
/** Open connections per job, idle ones included. Each one beyond this is destroyed at once. */
const MAX_CONNECTIONS = 16;
const DEADLINE_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * Refusals cost the container nothing, so it can send them without end. The first ones are
 * logged in full; after that only their count per category grows (stats().refusedBy).
 */
const LOGGED_REFUSALS = 20;
const RESPONSE_HEADERS = /^(content-type|request-id|retry-after|anthropic-ratelimit-[a-z0-9-]+)$/;

/** One line per call for the launcher log. */
export interface CallRecord {
  outcome: "refused" | "settled" | "kept";
  /** The settled usage cost more than the reservation: the cost model is wrong. */
  boundExceeded?: true;
  status: number;
  model?: string;
  reason?: string;
  reservedNanoUsd?: number;
  ms: number;
}

export interface ProxyOptions {
  /** Inside a folder that only this user can enter (mode 0700). */
  socketPath: string;
  /** From the host config only. `baseUrl` has no `/v1`, like ANTHROPIC_BASE_URL. */
  upstream: { baseUrl: string; apiKey: string };
  job: JobPolicy;
  ledger: Ledger;
  log: (record: CallRecord) => void;
  /** Per call, from the first request byte to the last response byte. */
  deadlineMs?: number;
}

/** Reads `usage` from Anthropic SSE events: message_start, then cumulative message_delta. */
class SseUsage {
  usage: Record<string, unknown> = {};
  stopped = false;
  /** A delta lowered or nulled a count of message_start: the shape changed, so do not settle. */
  lowered = false;
  #decoder = new TextDecoder();
  #line = "";

  feed(chunk: Uint8Array) {
    const lines = (this.#line + this.#decoder.decode(chunk, { stream: true })).split("\n");
    this.#line = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let event: { type?: string; message?: { usage?: object }; usage?: object };
      try {
        event = JSON.parse(line.slice(5)) as typeof event;
      } catch {
        continue; // an unreadable event cannot settle the call: no message_stop follows it
      }
      if (event.type === "message_start") this.usage = { ...event.message?.usage };
      if (event.type === "message_delta") {
        // Delta counts are cumulative, so one below its message_start value is a shape change.
        for (const [key, value] of Object.entries(event.usage ?? {})) {
          const before = this.usage[key];
          if (value == null || (typeof before === "number" && Number(value) < before))
            this.lowered = true;
        }
        this.usage = { ...this.usage, ...event.usage };
      }
      // An error after message_stop is impossible; one before it leaves `stopped` false.
      if (event.type === "message_stop") this.stopped = true;
    }
  }
}

export async function startProxy(options: ProxyOptions) {
  const dir = fs.statSync(path.dirname(options.socketPath));
  if ((dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid?.()) {
    throw new Error("proxy: the socket folder must be mode 0700 and owned by this user");
  }
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const calls = new Set<{ abort: AbortController; done: Promise<void> }>();
  const counts = { refused: 0, settled: 0, kept: 0, boundExceeded: 0 };
  /**
   * Refusals per category: the reason up to its first quoted (container-chosen) name, so the
   * keys come from the fixed reason texts of this file and proxyPolicy.ts and stay few.
   */
  const refusedBy: Record<string, number> = {};
  const record = (entry: CallRecord) => {
    counts[entry.outcome] += 1;
    if (entry.outcome === "refused") {
      const category = (entry.reason ?? "").split('"')[0].trim();
      refusedBy[category] = (refusedBy[category] ?? 0) + 1;
      if (counts.refused > LOGGED_REFUSALS) return;
    }
    options.log(entry);
  };
  let closed = false;
  let listening: Promise<unknown> = Promise.resolve();

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    abort: AbortController
  ) {
    const started = Date.now();
    const log = (entry: Omit<CallRecord, "ms">) => record({ ...entry, ms: Date.now() - started });
    const reply = (status: number, reason: string) => replyError(res, status, reason);
    const refuse = (status: number, reason: string, model?: string) => {
      if (!res.headersSent && !res.destroyed) reply(status, reason);
      log({ outcome: "refused", status, reason, model });
    };

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const body = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]() as AsyncIterator<
        Buffer,
        undefined
      >;
      for (;;) {
        const { done, value: chunk } = await untilAbort(body.next(), abort.signal);
        if (done) break;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return refuse(413, "body: too large");
        chunks.push(chunk);
      }
    } catch {
      return refuse(499, "client: request not complete");
    }
    if (abort.signal.aborted) return refuse(499, "client: request not complete");
    const checked = checkRequest(options.job, req.rawHeaders, Buffer.concat(chunks));
    if (!checked.ok) return refuse(400, checked.reason);
    const { model, maxCostNanoUsd } = checked;
    const id = options.ledger.reserve(model, maxCostNanoUsd);
    if (id === undefined)
      return refuse(402, "budget: call does not fit the remaining budget", model);

    // From here the call is dispatched: it ends with exactly one settle or keep.
    let usage: unknown;
    let status = 502;
    let reason: string | undefined;
    try {
      const upstream = await fetch(`${options.upstream.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...checked.headers, "x-api-key": options.upstream.apiKey },
        body: checked.body,
        redirect: "manual",
        signal: abort.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        reason = "upstream: redirect";
        reply(502, reason);
        return;
      }
      status = upstream.status;
      const headers = [...upstream.headers].filter(([name]) => RESPONSE_HEADERS.test(name));
      res.writeHead(status, { ...Object.fromEntries(headers), connection: "close" });
      const sse = upstream.headers.get("content-type")?.startsWith("text/event-stream") ?? false;
      const parser = new SseUsage();
      const json: Uint8Array[] = [];
      let received = 0;
      const reader = upstream.body?.getReader();
      for (;;) {
        const { done, value: chunk } = reader
          ? await untilAbort(reader.read(), abort.signal)
          : { done: true as const };
        if (done) break;
        received += chunk.byteLength;
        if (received > MAX_RESPONSE_BYTES) throw new Error("response cap");
        if (sse) parser.feed(chunk);
        else json.push(chunk);
        if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
      }
      // Not awaited: the cost depends on the upstream answer, and Bun 1.3.12 never finishes an
      // end() to a client that went away.
      res.end();
      if (status !== 200 || abort.signal.aborted) return;
      if (sse) usage = parser.stopped && !parser.lowered ? parser.usage : undefined;
      else usage = (JSON.parse(Buffer.concat(json).toString()) as { usage?: unknown }).usage;
    } catch {
      // Fixed texts only: fetch errors can name the upstream host and other details.
      reason = abort.signal.aborted ? "aborted: deadline, client or close" : "upstream: failed";
      if (!res.headersSent && !res.destroyed) reply(502, reason);
      else res.destroy();
    } finally {
      const record = { model, status, reason, reservedNanoUsd: maxCostNanoUsd };
      if (usage === undefined) {
        options.ledger.keep(id);
        log({ outcome: "kept", ...record });
      } else {
        // settle() is synchronous, so the counter delta belongs to this call alone.
        const misses = options.ledger.totals().boundExceeded;
        options.ledger.settle(id, usage); // unreadable usage keeps the reservation (proxyPolicy.ts)
        const exceeded = options.ledger.totals().boundExceeded > misses;
        if (exceeded) counts.boundExceeded += 1;
        log({ outcome: "settled", ...record, ...(exceeded && { boundExceeded: true }) });
      }
    }
  }

  const server = http.createServer((req, res) => {
    if (closed) return res.destroy(); // a kept-alive connection after close()
    const refuse = (status: number, reason: string) => {
      replyError(res, status, reason);
      record({ outcome: "refused", status, reason, ms: 0 });
    };
    // P1: an exact match, so a query string or any other path refuses.
    if (req.method !== "POST" || req.url !== PROXY_PATH) return refuse(404, "route: not allowed");
    if (calls.size >= MAX_IN_FLIGHT) return refuse(429, "concurrency: too many calls in flight");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadlineMs);
    // A client that goes away before the response ends aborts the call. Bun 1.3.12's node:http
    // never reports that (no 'close', writes still succeed; Bun 1.4.2 does), so there the call
    // runs on to its upstream end, its deadline or close(), and holds its slot until then.
    // Bun.serve does report it, but it drops duplicate headers, which P2 must see.
    // Removal trigger: the Bun bump that #4958 blocks. With it, make proxy.test.ts's "a client
    // that goes away" test strict again (the call aborts and keeps its full reservation) and
    // run it on the new Bun. On this host Bun 1.3.13 still misses the disconnect; 1.4.2 sees it.
    res.on("close", () => res.writableFinished || abort.abort());
    abort.signal.addEventListener("abort", () => res.destroy(), { once: true });
    const call = { abort, done: Promise.resolve() };
    call.done = handle(req, res, abort).finally(() => {
      clearTimeout(timer);
      calls.delete(call);
    });
    calls.add(call);
  });
  // Not in the job folder: the container must reach the HTTP server only through the front.
  const inner = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-proxy-"));
  const innerPath = path.join(inner, "http.sock");
  const pipes = new Set<net.Socket>();
  const front = net.createServer((outer) => {
    // Deferred: Bun 1.3.12 ignores a destroy() inside the connection handler itself.
    if (closed || pipes.size >= MAX_CONNECTIONS) return void setImmediate(() => outer.destroy());
    const peer = net.connect(innerPath);
    // Twice the call deadline, so the call deadline of a request sent at once answers first.
    const lifetime = setTimeout(() => end(), 2 * deadlineMs);
    const end = () => {
      clearTimeout(lifetime);
      pipes.delete(outer);
      outer.destroy();
      peer.destroy();
    };
    pipes.add(outer);
    for (const [from, to] of [
      [outer, peer],
      [peer, outer],
    ] as const) {
      from.on("close", end).on("error", end);
      from.pipe(to);
    }
  });
  try {
    for (const [listener, socketPath] of [
      [server, innerPath],
      [front, options.socketPath],
    ] as const) {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, resolve);
      });
      fs.chmodSync(socketPath, 0o600);
    }
  } catch (error) {
    // No handle exists yet, so nobody else can close what already started.
    closed = true;
    for (const listener of [front, server]) if (listener.listening) listener.close();
    fs.rmSync(inner, { recursive: true, force: true });
    throw error;
  }

  return {
    /**
     * Stops the listener, aborts every call and returns after each one is counted. Idempotent.
     * Rejects when a call of this job cost more than its bound: the cost model is wrong, so the
     * job must fail loudly even though the ledger stayed under its cap.
     */
    async close() {
      if (!closed) {
        closed = true;
        // The close callbacks run once the socket files are gone (Bun and Node remove them).
        listening = Promise.all(
          [front, server].map((listener) => new Promise((done) => listener.close(done)))
        );
      }
      for (const call of calls) call.abort.abort();
      for (const outer of pipes) outer.emit("close");
      await Promise.allSettled([...calls].map((call) => call.done));
      await listening;
      fs.rmSync(inner, { recursive: true, force: true });
      if (counts.boundExceeded > 0) {
        throw new Error(
          `proxy: ${counts.boundExceeded} call(s) cost more than their reserved bound; fix maxCostNanoUsd in proxyPolicy.ts`
        );
      }
    },
    /** The app AI mode probe (`max_tokens: 1`) through the same policy, ledger and upstream. */
    probe(model: string): Promise<{ status: number }> {
      const messages = [{ role: "user", content: "ping" }];
      const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
      return new Promise((resolve, reject) => {
        const req = http.request(
          { socketPath: options.socketPath, method: "POST", path: PROXY_PATH, headers },
          (res) => {
            let text = "";
            res.on("data", (chunk: Buffer) => (text += chunk.toString()));
            // A response cut after its headers can end early or look complete (Bun), so only a
            // whole JSON body counts as an answer.
            const settle = () => {
              try {
                JSON.parse(text);
                resolve({ status: res.statusCode ?? 0 });
              } catch {
                reject(new Error("probe: the response ended early"));
              }
            };
            res.on("end", settle).on("close", settle).on("error", settle);
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model, max_tokens: 1, messages }));
      });
    },
    stats: () => ({ ...counts, inFlight: calls.size, refusedBy: { ...refusedBy } }),
  };
}

function replyError(res: http.ServerResponse, status: number, message: string) {
  const error = { type: "error", error: { type: "bugbash_proxy_error", message } };
  const headers = { "content-type": "application/json", connection: "close" };
  res.writeHead(status, headers).end(JSON.stringify(error));
}

/** Rejects when the call aborts, so the deadline and close() bound every wait. */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
