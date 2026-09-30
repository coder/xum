import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import type { ConnectionOptions } from "node:tls";
// Same deep import as production: Bun's built-in "undici" shim has no real Agent.
import { Agent } from "undici/index.js";
import type { Client, Dispatcher } from "undici/index.js";
import {
  ICONS_EXAMPLE_HOSTNAME,
  ICONS_EXAMPLE_TLS,
} from "../../../../tests/fixtures/tls/iconsExample";
import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { createPinnedHttpsFetch, type PinnedHttpsFetchTransport } from "./pinnedHttpsFetch";

/** See src/common/types/undici.d.ts: the augmentation hides Agent's real Dispatcher type. */
const RealAgent = Agent as new (options: Client.Options) => Dispatcher;

/** Documentation ranges: public as far as the block list is concerned, never routed. */
const PUBLIC_ANSWERS: LookupAddress[] = [
  { address: "203.0.113.10", family: 4 },
  { address: "2001:db8::10", family: 6 },
];
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

interface SeenRequest {
  url: string;
  headers: IncomingHttpHeaders;
  /** Resolves when the server side of the connection closed. */
  closed: Promise<void>;
}

interface Harness {
  port: number;
  requests: SeenRequest[];
  server: https.Server;
}

async function startHarness(): Promise<Harness> {
  const requests: SeenRequest[] = [];
  const server = https.createServer(ICONS_EXAMPLE_TLS, (req, res) => {
    // Bun's https server does not emit `close` on the response when the client
    // tears the socket down mid-body; the request and socket do.
    const closed = new Promise<void>((resolve) => {
      req.once("close", () => resolve());
      req.socket.once("close", () => resolve());
    });
    requests.push({ url: req.url ?? "", headers: req.headers, closed });
    switch (req.url) {
      case "/icon.png":
        res.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
        res.end(PNG_BYTES);
        return;
      case "/redirect":
        res.writeHead(301, { location: "/icon.png", "content-type": "text/plain" });
        res.end("moved");
        return;
      case "/declared-oversize":
        // Declares more than the cap and then stalls: the client must reject on
        // the header alone instead of waiting for the body.
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": MCP_ICON_LIMITS.bodyMaxBytes + 1,
        });
        res.write("x");
        return;
      case "/streamed-oversize": {
        res.writeHead(200, { "content-type": "image/png" });
        const chunks = Math.ceil(MCP_ICON_LIMITS.bodyMaxBytes / CHUNK.length) + 2;
        for (let i = 0; i < chunks; i++) res.write(CHUNK);
        res.end();
        return;
      }
      case "/never-ending": {
        res.writeHead(200, { "content-type": "image/png" });
        const timer = setInterval(() => res.write("."), 10);
        res.once("close", () => clearInterval(timer));
        return;
      }
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { port: (server.address() as AddressInfo).port, requests, server };
}

interface TransportState {
  lookupCalls: string[];
  agentOptions: Client.Options[];
  /** What the production pinned lookup answered when the socket dialed. */
  dials: Array<{ host: string; answer: unknown }>;
  lifecycle: Array<"close" | "destroy">;
}

/**
 * Loopback transport: injected DNS answers (still validated by production
 * code) and an Agent that keeps the production connect options but routes the
 * actual dial to the harness — only after the production pinned lookup has
 * answered — and trusts the harness certificate.
 */
function createHarnessTransport(
  answers: LookupAddress[] | (() => Promise<LookupAddress[]>) = PUBLIC_ANSWERS,
  options: { refuseDial?: boolean } = {}
): { transport: PinnedHttpsFetchTransport; state: TransportState } {
  const state: TransportState = { lookupCalls: [], agentOptions: [], dials: [], lifecycle: [] };
  const transport: PinnedHttpsFetchTransport = {
    lookup: (hostname) => {
      state.lookupCalls.push(hostname);
      return typeof answers === "function" ? answers() : Promise.resolve(answers);
    },
    createAgent: (agentOptions) => {
      state.agentOptions.push(agentOptions);
      const connect = agentOptions.connect as Partial<ConnectionOptions> | undefined;
      const productionLookup = connect?.lookup;
      if (!productionLookup) {
        throw new Error("production connect options must install a pinned lookup");
      }
      // Node dials IP-literal hosts without consulting `lookup`, so a literal
      // target cannot be routed to the harness; refuse the dial instead of
      // touching the network.
      const agent = options.refuseDial
        ? new RealAgent({
            connect: (_connectOptions, callback) =>
              callback(new Error("harness refused the dial"), null),
          })
        : new RealAgent({
            ...options,
            connect: {
              ...connect,
              ca: [ICONS_EXAMPLE_TLS.cert],
              lookup: (host, lookupOptions, callback) => {
                productionLookup(host, lookupOptions, (error, address, family) => {
                  state.dials.push({
                    host,
                    answer: error ?? (family === undefined ? address : { address, family }),
                  });
                  if (lookupOptions.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
                  else callback(null, "127.0.0.1", 4);
                });
              },
            },
          });
      // Record the public (argument-less) lifecycle calls production makes. The
      // promise forms re-enter these methods with callbacks internally, so only
      // the outer call is logged.
      const record = (method: "close" | "destroy") => {
        const original = agent[method] as (...args: unknown[]) => unknown;
        (agent as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
          if (args.length === 0) state.lifecycle.push(method);
          return original.apply(agent, args);
        };
      };
      record("close");
      record("destroy");
      return agent;
    },
  };
  return { transport, state };
}

describe("pinnedHttpsFetch", () => {
  let harness: Harness;
  const url = (path: string) => new URL(`https://${ICONS_EXAMPLE_HOSTNAME}:${harness.port}${path}`);
  const signal = () => AbortSignal.timeout(5_000);

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    // Every client socket must already be gone: a leaked keep-alive connection
    // would keep the server from closing within the bound.
    let leakTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<"closed">((resolve) =>
      harness.server.close(() => resolve("closed"))
    );
    const leaked = new Promise<"leaked">((resolve) => {
      leakTimer = setTimeout(() => resolve("leaked"), 2_000);
    });
    const outcome = await Promise.race([closed, leaked]);
    clearTimeout(leakTimer);
    expect(outcome).toBe("closed");
  });

  test("fetches over a pinned, hostname-verified connection with only image accept headers", async () => {
    const { transport, state } = createHarnessTransport();
    const fetch = createPinnedHttpsFetch(transport);
    const result = await fetch(url("/icon.png"), signal());

    expect(result).not.toBeNull();
    expect(result!.bytes.equals(PNG_BYTES)).toBe(true);
    expect(result!.contentType).toBe("image/png");

    // DNS ran exactly once, before any dial.
    expect(state.lookupCalls).toEqual([ICONS_EXAMPLE_HOSTNAME]);

    // The production Agent options: only a pinned lookup plus the hostname as
    // servername — no relaxed TLS settings, no proxies, no extra connect keys.
    expect(state.agentOptions).toHaveLength(1);
    const connect = state.agentOptions[0].connect as Record<string, unknown>;
    expect(Object.keys(connect).sort()).toEqual(["lookup", "servername"]);
    expect(connect.servername).toBe(ICONS_EXAMPLE_HOSTNAME);

    // The pinned lookup answers from the validated list in both callback
    // shapes and never consults DNS again.
    const pinned = connect.lookup as (
      host: string,
      options: { all?: boolean },
      cb: (error: Error | null, address: unknown, family?: number) => void
    ) => void;
    const all = await new Promise<unknown>((resolve) =>
      pinned("anything", { all: true }, (_e, a) => resolve(a))
    );
    expect(all).toEqual(PUBLIC_ANSWERS);
    const one = await new Promise<unknown>((resolve) =>
      pinned("anything", {}, (_e, address, family) => resolve({ address, family }))
    );
    expect(one).toEqual({ address: "203.0.113.10", family: 4 });
    expect(state.lookupCalls).toHaveLength(1);

    // The socket consulted the production lookup for the URL hostname at dial time.
    expect(state.dials.length).toBeGreaterThan(0);
    expect(state.dials[0].host).toBe(ICONS_EXAMPLE_HOSTNAME);
    expect(state.dials[0].answer).toEqual(PUBLIC_ANSWERS);

    // Request headers: credential-free, image accept only, hostname preserved.
    const seen = harness.requests.find((r) => r.url === "/icon.png");
    expect(seen?.headers.accept).toBe("image/*");
    expect(seen?.headers.host).toBe(`${ICONS_EXAMPLE_HOSTNAME}:${harness.port}`);
    expect(seen?.headers.authorization).toBeUndefined();
    expect(seen?.headers.cookie).toBeUndefined();

    // Success: graceful close first, then the unconditional destroy (undici's
    // close() itself destroys internally, so destroy may appear more than once).
    expect(state.lifecycle[0]).toBe("close");
    expect(state.lifecycle.at(-1)).toBe("destroy");
    await seen!.closed;
  });

  test("never dials for non-https, credentialed, blocked, or literal-private targets", async () => {
    const { transport, state } = createHarnessTransport();
    const fetch = createPinnedHttpsFetch(transport);
    for (const target of [
      `http://${ICONS_EXAMPLE_HOSTNAME}/icon.png`,
      `https://alice:secret@${ICONS_EXAMPLE_HOSTNAME}/icon.png`,
      `https://alice@${ICONS_EXAMPLE_HOSTNAME}/icon.png`,
      "https://localhost/icon.png",
      "https://icons.internal/icon.png",
      "https://metadata.google.internal/icon.png",
      "https://127.0.0.1/icon.png",
      "https://[::1]/icon.png",
      "https://169.254.169.254/icon.png",
      "https://10.1.2.3/icon.png",
      "https://[::ffff:10.1.2.3]/icon.png",
    ]) {
      expect(await fetch(new URL(target), signal())).toBeNull();
    }
    expect(state.lookupCalls).toEqual([]);
    expect(state.agentOptions).toEqual([]);
  });

  test("rejects the whole fetch when any resolved address is blocked, or none resolve", async () => {
    for (const answers of [
      [PUBLIC_ANSWERS[0], { address: "10.0.0.5", family: 4 }],
      [{ address: "fd00::5", family: 6 }, PUBLIC_ANSWERS[1]],
      [PUBLIC_ANSWERS[0], { address: "::ffff:127.0.0.1", family: 6 }],
      [{ address: "not-an-ip", family: 0 }],
      [],
    ] as LookupAddress[][]) {
      const { transport, state } = createHarnessTransport(answers);
      expect(await createPinnedHttpsFetch(transport)(url("/icon.png"), signal())).toBeNull();
      expect(state.lookupCalls).toEqual([ICONS_EXAMPLE_HOSTNAME]);
      expect(state.agentOptions).toEqual([]);
    }
  });

  test("a literal public IP is validated directly and pinned without DNS", async () => {
    const { transport, state } = createHarnessTransport(PUBLIC_ANSWERS, {
      refuseDial: true,
    });
    const fetch = createPinnedHttpsFetch(transport);
    expect(
      await fetch(new URL(`https://203.0.113.10:${harness.port}/icon.png`), signal())
    ).toBeNull();
    expect(state.lookupCalls).toEqual([]);
    expect(state.agentOptions).toHaveLength(1);
    // No SNI servername for an IP literal; the pinned lookup still answers only the literal.
    const connect = state.agentOptions[0].connect as Record<string, unknown>;
    expect(Object.keys(connect)).toEqual(["lookup"]);
    const pinned = connect.lookup as (
      host: string,
      options: { all?: boolean },
      cb: (error: Error | null, address: unknown) => void
    ) => void;
    const all = await new Promise<unknown>((resolve) =>
      pinned("203.0.113.10", { all: true }, (_e, a) => resolve(a))
    );
    expect(all).toEqual([{ address: "203.0.113.10", family: 4 }]);
    expect(state.lifecycle).toEqual(["destroy"]);
  });

  test("does not follow redirects and treats every non-200 as absent", async () => {
    for (const path of ["/redirect", "/missing"]) {
      const { transport, state } = createHarnessTransport();
      const before = harness.requests.length;
      expect(await createPinnedHttpsFetch(transport)(url(path), signal())).toBeNull();
      const seen = harness.requests.slice(before);
      expect(seen.map((r) => r.url)).toEqual([path]);
      expect(state.lifecycle).toEqual(["destroy"]);
      await seen[0].closed;
    }
  });

  test("rejects an over-cap content-length before reading the body", async () => {
    const { transport, state } = createHarnessTransport();
    const started = Date.now();
    expect(await createPinnedHttpsFetch(transport)(url("/declared-oversize"), signal())).toBeNull();
    // The server never ends this response: returning promptly means the header
    // check short-circuited and the connection was torn down.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(state.lifecycle).toEqual(["destroy"]);
    await harness.requests.find((r) => r.url === "/declared-oversize")!.closed;
  });

  test("rejects a streamed body once it exceeds the cap", async () => {
    const { transport, state } = createHarnessTransport();
    expect(await createPinnedHttpsFetch(transport)(url("/streamed-oversize"), signal())).toBeNull();
    expect(state.lifecycle).toEqual(["destroy"]);
    await harness.requests.find((r) => r.url === "/streamed-oversize")!.closed;
  });

  test("the job signal bounds a never-ending body and tears the connection down", async () => {
    const { transport, state } = createHarnessTransport();
    const started = Date.now();
    expect(
      await createPinnedHttpsFetch(transport)(url("/never-ending"), AbortSignal.timeout(300))
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(state.lifecycle).toEqual(["destroy"]);
    await harness.requests.find((r) => r.url === "/never-ending")!.closed;
  });

  test("the job signal bounds DNS and nothing is dialed afterwards", async () => {
    const { transport, state } = createHarnessTransport(() => new Promise(() => undefined));
    const started = Date.now();
    expect(
      await createPinnedHttpsFetch(transport)(url("/icon.png"), AbortSignal.timeout(100))
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(state.lookupCalls).toEqual([ICONS_EXAMPLE_HOSTNAME]);
    expect(state.agentOptions).toEqual([]);
  });

  test("an already-aborted signal short-circuits before DNS", async () => {
    const { transport, state } = createHarnessTransport();
    const controller = new AbortController();
    controller.abort();
    expect(await createPinnedHttpsFetch(transport)(url("/icon.png"), controller.signal)).toBeNull();
    expect(state.lookupCalls).toEqual([]);
    expect(state.agentOptions).toEqual([]);
  });
});
