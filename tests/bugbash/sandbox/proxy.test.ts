import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { FAKE_USAGE, startFakeUpstream } from "./fakeUpstream";
import { PROXY_PATH, startProxy, type CallRecord } from "./proxy";
import { Ledger, MAX_BODY_BYTES, usageCost } from "./proxyPolicy";

const KEY = "sk-host-secret-key-for-the-proxy-test";
const MODEL = "claude-haiku-4-5";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every client-visible output of a test, so the key check covers all of them (P9). */
const outputs: string[] = [];

async function setup(options: { capUsd?: number; deadlineMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-proxy-"));
  fs.chmodSync(dir, 0o700);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = await startFakeUpstream();
  cleanups.push(fake.close);
  const ledger = new Ledger(options.capUsd ?? 1);
  const records: CallRecord[] = [];
  const waiters: (() => void)[] = [];
  const socketPath = path.join(dir, "proxy.sock");
  const proxy = await startProxy({
    socketPath,
    upstream: { baseUrl: fake.baseUrl, apiKey: KEY },
    job: { models: [MODEL] },
    ledger,
    deadlineMs: options.deadlineMs,
    log: (record) => {
      records.push(record);
      outputs.push(JSON.stringify(record));
      waiters.splice(0).forEach((wake) => wake());
    },
  });
  // The bound-miss test expects close() to reject; every other test must close cleanly.
  cleanups.push(() =>
    proxy.close().catch((error: unknown) => {
      if (proxy.stats().boundExceeded === 0) throw error;
    })
  );
  /** Resolves once `count` calls have their record. */
  const recorded = async (count: number) => {
    while (records.length < count) await new Promise<void>((wake) => waiters.push(wake));
    return records;
  };
  return { dir, socketPath, fake, ledger, proxy, records, recorded };
}

const body = (text: string, extra: object = {}) =>
  JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: text }],
    ...extra,
  });
const HEADERS = { "content-type": "application/json", "anthropic-version": "2023-06-01" };

interface Sent {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** One HTTP request over the proxy socket. `onData` runs on each response chunk. */
function send(
  socketPath: string,
  payload: string,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    onData?: (req: http.ClientRequest) => unknown;
  } = {}
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: options.method ?? "POST",
        path: options.path ?? PROXY_PATH,
        headers: { ...HEADERS, ...options.headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          options.onData?.(req);
        });
        const done = () => {
          outputs.push(text, JSON.stringify(res.headers));
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      }
    );
    req.on("error", (error) => (options.onData ? undefined : reject(error)));
    req.end(payload);
  });
}

test("forwards a JSON and a streamed call with only the host key, and settles their usage", async () => {
  const { socketPath, fake, ledger, records } = await setup();
  const container = { "x-api-key": "container-value", authorization: "Bearer container" };
  const json = await send(socketPath, body("hi"), { headers: container });
  const stream = await send(socketPath, body("hi", { stream: true }), { headers: container });
  expect([json.status, stream.status]).toEqual([200, 200]);
  expect((JSON.parse(json.text) as { usage: unknown }).usage).toEqual(FAKE_USAGE);
  expect(stream.text).toContain("event: message_stop");
  // Response headers are allowlisted: request-id passes, the fake's internal header does not.
  expect(stream.headers["request-id"]).toBe("req_fake");
  expect(stream.headers["x-fake-internal"]).toBeUndefined();
  // One call per connection for a client that behaves, so the connection limit never cuts a call.
  expect([json.headers.connection, stream.headers.connection]).toEqual(["close", "close"]);
  expect(fake.requests).toHaveLength(2);
  for (const request of fake.requests) {
    expect(request.url).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(request.headers.authorization).toBeUndefined();
  }
  expect(records.map((record) => record.outcome)).toEqual(["settled", "settled"]);
  expect(ledger.totals().spentNanoUsd).toBe(2 * usageCost(MODEL, FAKE_USAGE)!);
});

test("refuses other routes (P1) and oversized bodies before any upstream request", async () => {
  const { socketPath, fake, records } = await setup();
  for (const [method, route] of [
    ["GET", PROXY_PATH],
    ["POST", "/v1/messages"],
    ["POST", `${PROXY_PATH}?beta=true`],
  ]) {
    expect((await send(socketPath, body("hi"), { method, path: route })).status).toBe(404);
  }
  // The proxy stops reading a body above the limit, before checkRequest sees it.
  expect((await send(socketPath, body("x".repeat(MAX_BODY_BYTES)))).status).toBe(413);
  expect(fake.requests).toHaveLength(0);
  expect(records.map((record) => record.status)).toEqual([404, 404, 404, 413]);
});

test("refuses a duplicate allowlisted header sent on the wire (P2 wiring)", async () => {
  const { socketPath, fake } = await setup();
  const payload = body("hi");
  // Node and Bun clients join duplicate headers, so write the request by hand.
  const raw = await new Promise<string>((resolve) => {
    let out = "";
    const socket = net.connect(socketPath, () =>
      socket.write(
        `POST ${PROXY_PATH} HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\nanthropic-version: 2023-06-01\r\n` +
          `anthropic-version: 2023-06-01\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n${payload}`
      )
    );
    socket.on("data", (chunk) => (out += chunk.toString()));
    socket.on("close", () => resolve(out));
  });
  expect(raw).toStartWith("HTTP/1.1 400");
  expect(raw).toContain("header: duplicate anthropic-version");
  expect(fake.requests).toHaveLength(0);
});

test("turns an upstream redirect into a 502 and never follows it", async () => {
  const { socketPath, fake, ledger, records } = await setup();
  expect((await send(socketPath, body("[fake:redirect]"))).status).toBe(502);
  expect(fake.requests.map((request) => request.url)).toEqual(["/v1/messages"]);
  expect(records[0]).toMatchObject({ outcome: "kept", status: 502 });
  expect(ledger.totals().spentNanoUsd).toBe(records[0].reservedNanoUsd!);
});

test.each([
  ["the connection drops before message_stop", "[fake:cut]", ""],
  ["the stream ends without message_stop", "[fake:nostop]", ""],
  ["the deadline fires", "[fake:stall]", ""],
  ["the proxy closes mid-call", "[fake:hang]", "close"],
  ["the upstream answers 529", "[fake:529]", ""],
  ["the response exceeds 32 MiB", "[fake:huge]", ""],
])("keeps the full reservation when %s (P7)", async (_name, marker, action) => {
  // Only the stall case may reach the deadline: the others must end without it.
  const deadlineMs = marker === "[fake:stall]" ? 300 : 60_000;
  const { socketPath, ledger, proxy, records, recorded } = await setup({ deadlineMs });
  let closing: Promise<void> | undefined;
  const onData = action === "close" ? () => (closing ??= proxy.close()) : undefined;
  await send(socketPath, body(marker, { stream: true }), { onData });
  if (closing) {
    await closing;
    expect(records).toHaveLength(1); // close() returns only after the call is counted
  }
  const [record] = await recorded(1);
  expect(record.outcome).toBe("kept");
  expect(record.reservedNanoUsd).toBeGreaterThan(0);
  expect(ledger.totals()).toMatchObject({
    spentNanoUsd: record.reservedNanoUsd,
    reservedNanoUsd: 0,
  });
});

test("a client that goes away never makes a call cost more than its reservation", async () => {
  const { socketPath, ledger, recorded } = await setup({ deadlineMs: 60_000 });
  await send(socketPath, body("[fake:slow]", { stream: true }), { onData: (req) => req.destroy() });
  // Bun 1.3.12 cannot see the disconnect (proxy.ts), so there the call runs to its upstream end
  // and settles. Where the disconnect is seen, the call aborts and keeps its reservation.
  const [record] = await recorded(1);
  const cost = record.outcome === "settled" ? usageCost(MODEL, FAKE_USAGE) : record.reservedNanoUsd;
  expect(["settled", "kept"]).toContain(record.outcome);
  expect(ledger.totals().spentNanoUsd).toBe(cost!);
});

test("the deadline also bounds a request whose body never completes", async () => {
  const { socketPath, fake, recorded } = await setup({ deadlineMs: 300 });
  const head = `POST ${PROXY_PATH} HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n{"model"`;
  const socket = net.connect(socketPath, () => socket.write(head));
  socket.on("error", () => undefined);
  const [record] = await recorded(1);
  socket.destroy();
  expect(record).toMatchObject({ outcome: "refused", status: 499 });
  expect(fake.requests).toHaveLength(0);
});

test("a connection that never completes its headers is bounded, counted and closed", async () => {
  const { socketPath, proxy } = await setup({ deadlineMs: 300 });
  const open = () =>
    new Promise<{ closed: Promise<number>; isClosed: () => boolean }>((resolve) => {
      let done = false;
      const socket = net.connect(socketPath, () => {
        socket.write(`POST ${PROXY_PATH} HTTP/1.1\r\nhost: x\r\n`); // headers never end
        // One more header byte every 50 ms: no byte resets the connection's limit.
        const trickle = setInterval(() => socket.write("x"), 50);
        socket.on("close", () => clearInterval(trickle));
        const started = Date.now();
        const closed = new Promise<number>((settle) =>
          socket.on("close", () => {
            done = true;
            settle(Date.now() - started);
          })
        );
        resolve({ closed, isClosed: () => done });
      });
      socket.on("error", () => undefined);
    });
  // A half-open connection ends twice the call deadline after it was accepted.
  const first = await (await open()).closed;
  expect(first).toBeGreaterThanOrEqual(550);
  expect(first).toBeLessThan(1_500);
  // Connections beyond the limit are destroyed at once; close() destroys the rest.
  const held = [];
  for (let i = 0; i < 16; i++) held.push(await open());
  const extra = await open();
  expect(await extra.closed).toBeLessThan(300);
  expect(held.some((h) => h.isClosed())).toBe(false);
  const closing = Date.now();
  await proxy.close();
  await Promise.all(held.map((h) => h.closed));
  expect(Date.now() - closing).toBeLessThan(200); // close(), not their idle deadline
});

test("a failed start closes what it started and leaves no private folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-proxy-"));
  fs.chmodSync(dir, 0o700);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("xum-bugbash-proxy-"));
  // A unix socket path is limited to 108 bytes, so the job socket cannot bind.
  const socketPath = path.join(dir, "x".repeat(120));
  const options = {
    socketPath,
    upstream: { baseUrl: "http://127.0.0.1:9", apiKey: KEY },
    job: { models: [MODEL] },
    ledger: new Ledger(1),
    log: () => undefined,
  };
  const failed = await startProxy(options).then(
    () => "started",
    () => "failed"
  );
  expect(failed).toBe("failed");
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("xum-bugbash-proxy-"));
  expect(after.sort()).toEqual(before.sort());
});

test.each(["cut", "stall"])(
  "probe() settles without a 200 when the upstream answer is %s",
  async (mode) => {
    const { fake, proxy } = await setup({ deadlineMs: 300 });
    fake.setMode(mode);
    const probe = await proxy.probe(MODEL).then(
      (result) => `status ${result.status}`,
      (error: Error) => error.message
    );
    expect(probe).not.toBe("status 200");
  }
);

test("close() rejects when a call cost more than its bound, so the job fails", async () => {
  const { socketPath, proxy, records } = await setup();
  expect((await send(socketPath, body("[fake:overbill]"))).status).toBe(200);
  expect(records[0]).toMatchObject({ outcome: "settled", boundExceeded: true });
  expect(proxy.stats().boundExceeded).toBe(1);
  const closed = await proxy.close().then(
    () => "",
    (error: Error) => error.message
  );
  expect(closed).toContain("1 call(s) cost more than their reserved bound");
});

test("refuses a fifth concurrent call, and a call that does not fit the budget, before the upstream", async () => {
  const { socketPath, fake, proxy } = await setup();
  const stalled = Array.from({ length: 4 }, () => send(socketPath, body("[fake:stall]")));
  while (fake.requests.length < 4) await new Promise((wake) => setTimeout(wake, 5));
  expect((await send(socketPath, body("hi"))).status).toBe(429);
  expect(proxy.stats()).toMatchObject({ inFlight: 4, refused: 1 });
  await proxy.close();
  await Promise.allSettled(stalled);
  expect(fake.requests).toHaveLength(4);

  const poor = await setup({ capUsd: 0.001 });
  expect((await send(poor.socketPath, body("hi"))).status).toBe(402);
  expect(poor.fake.requests).toHaveLength(0);
  expect(poor.ledger.totals()).toMatchObject({ refused: 1, spentNanoUsd: 0 });
});

test("after close() the socket refuses connections and the upstream sees nothing new (P8)", async () => {
  const { socketPath, fake, proxy } = await setup();
  expect((await send(socketPath, body("hi"))).status).toBe(200);
  await proxy.close();
  const after = await send(socketPath, body("hi")).then(
    () => "answered",
    () => "refused"
  );
  expect(after).toBe("refused");
  expect(fake.requests).toHaveLength(1);
});

test("probe() sends one max_tokens 1 call through the policy and the ledger", async () => {
  const { fake, ledger, proxy } = await setup();
  expect(await proxy.probe(MODEL)).toEqual({ status: 200 });
  expect(JSON.parse(fake.requests[0].body)).toMatchObject({ model: MODEL, max_tokens: 1 });
  expect(ledger.totals().calls).toBe(1);
  expect(await proxy.probe("claude-opus-5-5")).toEqual({ status: 400 }); // not on the job list
});

test("the socket is 0600 in a 0700 folder, and a folder others can enter refuses", async () => {
  const { dir, socketPath } = await setup();
  expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  fs.chmodSync(dir, 0o755);
  const ledger = new Ledger(1);
  const options = {
    upstream: { baseUrl: "http://127.0.0.1:9", apiKey: KEY },
    job: { models: [MODEL] },
    ledger,
    log: () => undefined,
  };
  const other = startProxy({ ...options, socketPath: path.join(dir, "other.sock") });
  expect(
    await other.then(
      () => "",
      (error: Error) => error.message
    )
  ).toContain("0700");
});

test("the key appears in no record, log line or response (P9)", () => {
  // Runs last: `outputs` holds every record and response of the tests above.
  expect(outputs.length).toBeGreaterThan(20);
  for (const output of outputs) expect(output).not.toContain(KEY);
});
