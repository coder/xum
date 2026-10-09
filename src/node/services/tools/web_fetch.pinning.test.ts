/**
 * web_fetch connects only to the address it validated (#5966 security finding: DNS
 * rebinding). Real curl runs against loopback fixtures; only the runtime DNS answer is
 * stubbed. Hostnames use the reserved .test TLD, which real DNS cannot resolve, so any
 * request that curl (or a proxy) resolved again would fail instead of reaching a fixture.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import type { ExecResult } from "@/node/utils/runtime/helpers";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import * as blockedTargets from "@/node/utils/network/blockedTargets";
import type { WebFetchToolResult } from "@/common/types/tools";
import { createWebFetchTool } from "./web_fetch";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

type ExecArgs = Parameters<typeof runtimeHelpers.execBuffered>;
const realExecBuffered = runtimeHelpers.execBuffered;
const realIsBlockedIpAddress = blockedTargets.isBlockedIpAddress;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "127.0.0.2", "::1"]);
const PROXY_ENV = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "ALL_PROXY"];
const PROXY_ENV_ALL = [...PROXY_ENV, "all_proxy", "NO_PROXY", "no_proxy", "CURL_HOME"];
const hasCurl = Bun.which("curl") != null;

interface Hit {
  host: string | undefined;
  path: string | undefined;
}

/** HTTP fixture on one loopback address; records the Host header of every request. */
async function startHttpFixture(address: string) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ host: req.headers.host, path: req.url });
    const port = (server.address() as net.AddressInfo).port;
    if (req.url === "/redirect-other" || req.url === "/redirect-private") {
      const target = req.url === "/redirect-other" ? "other.test" : "private.test";
      res.writeHead(302, { Location: `http://${target}:${port}/` }).end();
    } else if (req.url === "/hang") {
      return; // never answers: abort test
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("pinned ok");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, resolve);
  });
  return { server, hits, port: (server.address() as net.AddressInfo).port };
}

/** Minimal HTTP CONNECT proxy and SOCKS5 server that log the target they are asked for. */
async function startProxyFixture(kind: "connect" | "deny" | "socks5") {
  const targets: string[] = [];
  const sockets = new Set<net.Socket>();
  const tunnel = (client: net.Socket, host: string, port: number, ok: Buffer) => {
    const upstream = net.connect(port, host, () => {
      client.write(ok);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
  };
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("error", () => undefined);
    if (kind === "socks5") {
      client.once("data", () => {
        client.write(Buffer.from([5, 0])); // no auth
        client.once("data", (req) => {
          const atyp = req[3];
          const host =
            atyp === 1
              ? Array.from(req.subarray(4, 8)).join(".")
              : atyp === 4
                ? "ipv6"
                : `domain:${req.subarray(5, 5 + req[4]).toString()}`;
          const port = req.readUInt16BE(req.length - 2);
          targets.push(`${host}:${port}`);
          tunnel(client, host, port, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      });
      return;
    }
    client.once("data", (head) => {
      const requestLine = head.toString().split("\r\n")[0];
      targets.push(requestLine);
      const [method, target] = requestLine.split(" ");
      if (kind === "deny" || method !== "CONNECT") {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const separator = target.lastIndexOf(":");
      const host = target.slice(0, separator).replace(/^\[|\]$/g, "");
      tunnel(
        client,
        host,
        Number(target.slice(separator + 1)),
        Buffer.from("HTTP/1.1 200 OK\r\n\r\n")
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { targets, close, url: `127.0.0.1:${(server.address() as net.AddressInfo).port}` };
}

describe.skipIf(!hasCurl)("web_fetch pins the validated address (real curl)", () => {
  let v4: Awaited<ReturnType<typeof startHttpFixture>>;
  let v6: Awaited<ReturnType<typeof startHttpFixture>> | null = null;
  const savedEnv = new Map<string, string | undefined>();
  let dns: Record<string, string[]> = {};
  let fetchCommands: string[] = [];

  beforeAll(async () => {
    v4 = await startHttpFixture("127.0.0.1");
    v6 = await startHttpFixture("::1").catch(() => null); // hosts without IPv6 skip that case
  });
  afterAll(async () => {
    for (const fixture of [v4, v6]) {
      if (fixture) await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    for (const name of PROXY_ENV_ALL) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    dns = {};
    fetchCommands = [];
    v4.hits.length = 0;
    v6?.hits.splice(0);
    spyOn(blockedTargets, "isBlockedIpAddress").mockImplementation((address: string) =>
      LOOPBACK_ADDRESSES.has(address) ? false : realIsBlockedIpAddress(address)
    );
    spyOn(runtimeHelpers, "execBuffered").mockImplementation((...args: ExecArgs) => {
      const command = args[1];
      if (command.startsWith("if command -v python3")) {
        const name = Object.keys(dns).find((host) => command.includes(`'${host}'`));
        const answer: ExecResult = {
          stdout: name ? JSON.stringify(dns[name]) : "",
          stderr: "",
          exitCode: name ? 0 : 1,
          duration: 1,
        };
        return Promise.resolve(answer);
      }
      if (command !== "curl -q --version") fetchCommands.push(command);
      return realExecBuffered(...args);
    });
  });
  afterEach(() => {
    mock.restore();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function fetchUrl(url: string, signal?: AbortSignal) {
    using dir = new TestTempDir("web-fetch-pin");
    const tool = createWebFetchTool(createTestToolConfig(dir.path));
    return (await tool.execute!(
      { url },
      { toolCallId: "pin", messages: [], context: undefined, abortSignal: signal }
    )) as WebFetchToolResult;
  }

  it("connects to the validated IPv4 address and keeps the hostname for Host", async () => {
    dns = { "rebind.test": ["127.0.0.1"] };
    const result = await fetchUrl(`http://rebind.test:${v4.port}/`);
    expect(result).toMatchObject({ success: true, content: "pinned ok" });
    expect(v4.hits).toEqual([{ host: `rebind.test:${v4.port}`, path: "/" }]);
  });

  it("keeps a trailing-dot hostname in the pin, so curl never resolves it", async () => {
    dns = { "rebind.test": ["127.0.0.1"] };
    expect(await fetchUrl(`http://rebind.test.:${v4.port}/`)).toMatchObject({ success: true });
  });

  it("connects to a validated IPv6 address", async () => {
    if (v6 == null) return console.warn("skipped: no IPv6 loopback on this host");
    dns = { "rebind6.test": ["::1"] };
    const result = await fetchUrl(`http://rebind6.test:${v6.port}/`);
    expect(result).toMatchObject({ success: true, content: "pinned ok" });
    expect(v6.hits).toEqual([{ host: `rebind6.test:${v6.port}`, path: "/" }]);
  });

  it("validates and pins each redirect hop, and still blocks a private redirect", async () => {
    dns = {
      "rebind.test": ["127.0.0.1"],
      "other.test": ["127.0.0.1"],
      "private.test": ["10.0.0.5"],
    };
    expect(await fetchUrl(`http://rebind.test:${v4.port}/redirect-other`)).toMatchObject({
      success: true,
      content: "pinned ok",
    });
    expect(v4.hits.map((hit) => hit.host)).toEqual([
      `rebind.test:${v4.port}`,
      `other.test:${v4.port}`,
    ]);

    const blocked = await fetchUrl(`http://rebind.test:${v4.port}/redirect-private`);
    expect(blocked.success === false && blocked.error).toContain("Blocked URL");
  });

  it.each(["connect", "socks5"] as const)(
    "tunnels through a %s proxy to the validated IP, never the hostname",
    async (kind) => {
      const proxy = await startProxyFixture(kind);
      try {
        process.env[kind === "socks5" ? "ALL_PROXY" : "http_proxy"] =
          kind === "socks5" ? `socks5h://${proxy.url}` : `http://${proxy.url}`;
        dns = { "rebind.test": ["127.0.0.1"] };
        const result = await fetchUrl(`http://rebind.test:${v4.port}/`);
        expect(result).toMatchObject({ success: true, content: "pinned ok" });
        expect(proxy.targets).toEqual([
          kind === "socks5" ? `127.0.0.1:${v4.port}` : `CONNECT 127.0.0.1:${v4.port} HTTP/1.1`,
        ]);
        expect(v4.hits).toEqual([{ host: `rebind.test:${v4.port}`, path: "/" }]);
      } finally {
        await proxy.close();
      }
    }
  );

  it("makes exactly one attempt when the selected address is dead (no fallback)", async () => {
    // 127.0.0.2 is validated and listed first, but nothing listens there.
    dns = { "rebind.test": ["127.0.0.2", "127.0.0.1"] };
    const result = await fetchUrl(`http://rebind.test:${v4.port}/`);
    expect(result).toMatchObject({
      success: false,
      error: "Failed to fetch URL: Failed to connect",
    });
    expect(fetchCommands).toHaveLength(1);
    expect(v4.hits).toEqual([]);
  });

  it("makes exactly one attempt when the proxy denies the tunnel", async () => {
    const proxy = await startProxyFixture("deny");
    try {
      process.env.http_proxy = `http://${proxy.url}`;
      dns = { "rebind.test": ["127.0.0.1"] };
      expect(await fetchUrl(`http://rebind.test:${v4.port}/`)).toMatchObject({ success: false });
      expect(fetchCommands).toHaveLength(1);
      expect(proxy.targets).toEqual([`CONNECT 127.0.0.1:${v4.port} HTTP/1.1`]);
      expect(v4.hits).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("ignores a .curlrc that sets a proxy and follows redirects", async () => {
    using rcDir = new TestTempDir("web-fetch-curlrc");
    const proxy = await startProxyFixture("deny");
    try {
      await fs.writeFile(
        path.join(rcDir.path, ".curlrc"),
        `location\nproxy = "http://${proxy.url}"\n`
      );
      process.env.CURL_HOME = rcDir.path;
      dns = { "rebind.test": ["127.0.0.1"], "private.test": ["10.0.0.5"] };
      // Xum still sees the redirect itself and blocks the private hop.
      const result = await fetchUrl(`http://rebind.test:${v4.port}/redirect-private`);
      expect(result.success === false && result.error).toContain("Blocked URL");
      expect(proxy.targets).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("stops a pinned fetch on abort", async () => {
    dns = { "rebind.test": ["127.0.0.1"] };
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const result = await fetchUrl(`http://rebind.test:${v4.port}/hang`, controller.signal);
    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The pinned request reached the fixture before the abort stopped it.
    expect(v4.hits).toEqual([{ host: `rebind.test:${v4.port}`, path: "/hang" }]);
  });
});

describe("web_fetch curl version probe", () => {
  afterEach(() => mock.restore());
  const httpOk = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok";
  const url = "https://93.184.216.34/page"; // public IP literal: no resolver call

  function setup(probe: () => Promise<ExecResult>, fetch: (command: string) => ExecResult) {
    const calls = { probes: 0, fetches: [] as string[] };
    spyOn(runtimeHelpers, "execBuffered").mockImplementation((_runtime, command) => {
      if (command === "curl -q --version") {
        calls.probes++;
        return probe();
      }
      calls.fetches.push(command);
      return Promise.resolve(fetch(command));
    });
    const dir = new TestTempDir("web-fetch-probe");
    const tool = createWebFetchTool(createTestToolConfig(dir.path));
    const run = async () =>
      (await tool.execute!(
        { url },
        { toolCallId: "p", messages: [], context: undefined }
      )) as WebFetchToolResult;
    return { calls, run, [Symbol.dispose]: () => dir[Symbol.dispose]() };
  }
  const version = (v: string) => () =>
    Promise.resolve({
      stdout: `curl ${v} (x86_64-pc-linux-gnu)\n`,
      stderr: "",
      exitCode: 0,
      duration: 1,
    });
  const response = (stderr: string): ExecResult => ({
    stdout: httpOk,
    stderr,
    exitCode: 0,
    duration: 1,
  });

  it("on curl 8.7+, checks the reported route and blocks a wrong or missing one", async () => {
    const cases: Array<[string, boolean]> = [
      ["XUM_CURL_ROUTE=93.184.216.34;0", true],
      ["XUM_CURL_ROUTE=10.9.9.9;1", true], // through a proxy: remote_ip is the proxy
      ["XUM_CURL_ROUTE=10.9.9.9;0", false], // direct to another address
      ["", false], // missing route line with a response
      ["XUM_CURL_ROUTE=garbage", false],
    ];
    for (const [stderr, allowed] of cases) {
      using env = setup(version("8.7.1"), () => response(stderr));
      const result = await env.run();
      expect({ stderr, success: result.success }).toEqual({ stderr, success: allowed });
      expect(env.calls.fetches[0]).toContain("%{proxy_used}");
    }
  });

  it("on curl before 8.7, pins without the route check", async () => {
    using env = setup(version("8.5.0"), () => response(""));
    expect((await env.run()).success).toBe(true);
    expect(env.calls.fetches[0]).not.toContain("proxy_used");
    expect(env.calls.fetches[0]).toContain("--proxytunnel");
  });

  it("probes once per runtime, shared by concurrent first fetches", async () => {
    using env = setup(version("8.7.1"), () => response("XUM_CURL_ROUTE=93.184.216.34;0"));
    const results = await Promise.all([env.run(), env.run(), env.run()]);
    expect(results.map((result) => result.success)).toEqual([true, true, true]);
    expect(await env.run()).toMatchObject({ success: true });
    expect(env.calls.probes).toBe(1);
  });

  it.each(["curl: not found", "curl 8 (no minor)", "wget 1.21.0"])(
    "refuses before any request when the probe cannot classify curl: %s",
    async (stdout) => {
      using env = setup(
        () =>
          Promise.resolve({
            stdout,
            stderr: "",
            exitCode: stdout.startsWith("curl:") ? 127 : 0,
            duration: 1,
          }),
        () => response("")
      );
      expect(await env.run()).toEqual({
        success: false,
        error: "Failed to fetch URL: could not determine the curl version",
      });
      expect(env.calls.fetches).toEqual([]);
    }
  );
});
