import { afterEach, describe, expect, test } from "bun:test";
import * as http from "http";
import type { AddressInfo } from "net";
import { probeXumBackend } from "./xumBackendProbe";
import { startFakeBackend, unservedBaseUrl, type FakeBackend } from "./testXumBackend";

describe("probeXumBackend", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });
  async function backend(...args: Parameters<typeof startFakeBackend>): Promise<FakeBackend> {
    const started = await startFakeBackend(...args);
    closers.push(started.close);
    return started;
  }
  /** A server that answers every request with `handler`. */
  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test("a xum backend answers, and the request carries no token", async () => {
    const live = await backend("xum");
    expect(await probeXumBackend(live.baseUrl)).toBe("answers");
    expect(live.requests).toHaveLength(1);
    expect(live.requests[0].url).toBe("/version");
    const headers = Object.keys(live.requests[0].headers);
    for (const credential of ["authorization", "cookie", "proxy-authorization"]) {
      expect(headers).not.toContain(credential);
    }
  });

  test("a base URL with a path prefix is asked under that prefix", async () => {
    const live = await backend("xum", { prefix: "/mux" });
    expect(await probeXumBackend(`${live.baseUrl}/`)).toBe("answers");
    expect(live.requests.map((request) => request.url)).toEqual(["/mux/version"]);
  });

  test("a refused connection means no backend", async () => {
    expect(await probeXumBackend(await unservedBaseUrl())).toBe("no");
  });

  test("another server on the port means no backend", async () => {
    const other = await backend("other");
    expect(await probeXumBackend(other.baseUrl)).toBe("no");
  });

  test("a listener that accepts and never answers is silent, within the timeout", async () => {
    // A frozen backend looks like this: the kernel accepts connections for a stopped process.
    const hung = await backend("hang");
    const started = Date.now();
    expect(await probeXumBackend(hung.baseUrl, 150)).toBe("silent");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a connection that is closed without an answer means no backend, not silent", async () => {
    const closing = await serve((req) => req.socket.destroy());
    expect(await probeXumBackend(closing, 1_000)).toBe("no");
  });

  test("a connect that never completes means no backend, not silent", async () => {
    // 192.0.2.1 (TEST-NET-1) is not routable: the SYN gets no answer. Sandboxes that reject it
    // at once give "no" too, so this holds either way.
    expect(await probeXumBackend("http://192.0.2.1:9", 300)).toBe("no");
  });

  test.each([
    [
      "a 200 that is not JSON",
      (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("hello"),
    ],
    [
      "JSON from another server (no mode)",
      (_req: http.IncomingMessage, res: http.ServerResponse) => res.end('{"version":"1"}'),
    ],
    [
      "JSON with another mode",
      (_req: http.IncomingMessage, res: http.ServerResponse) =>
        res.end('{"mode":"other","git_describe":"v1"}'),
    ],
    [
      "an oversized answer",
      (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.write("x".repeat(64 * 1024));
      },
    ],
    [
      "a server error",
      (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.statusCode = 500;
        res.end('{"mode":"server","git_describe":"v1"}');
      },
    ],
  ])("%s means no backend", async (_name, handler) => {
    expect(await probeXumBackend(await serve(handler), 1_000)).toBe("no");
  });

  test("an answer of exactly the size limit is read, one byte more is not", async () => {
    const answer = '{"mode":"server","git_describe":"v1"}';
    const padded = (bytes: number) => answer + " ".repeat(bytes - answer.length);
    const atLimit = await serve((_req, res) => res.end(padded(4_096)));
    const overLimit = await serve((_req, res) => res.end(padded(4_097)));
    expect(await probeXumBackend(atLimit)).toBe("answers");
    expect(await probeXumBackend(overLimit)).toBe("no");
  });

  test("a connection that drops in the middle of the answer means no backend", async () => {
    const dropping = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write('{"mode":"server",');
      setTimeout(() => res.destroy(), 20);
    });
    expect(await probeXumBackend(dropping, 1_000)).toBe("no");
  });

  test("a redirect is not followed, even to a xum backend", async () => {
    const live = await backend("xum");
    const redirecting = await serve((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `${live.baseUrl}/version`);
      res.end();
    });
    expect(await probeXumBackend(redirecting)).toBe("no");
    expect(live.requests).toEqual([]);
  });

  test("a URL that is not plain http(s) without credentials means no backend", async () => {
    const live = await backend("xum");
    const withCredentials = ["http://user:secret@", "http://user@", "http://:secret@"].map(
      (prefix) => live.baseUrl.replace("http://", prefix)
    );
    for (const url of [
      "not a url",
      "ftp://127.0.0.1:21",
      "file:///etc/passwd",
      ...withCredentials,
    ]) {
      expect(await probeXumBackend(url)).toBe("no");
    }
    expect(live.requests).toEqual([]);
  });
});
