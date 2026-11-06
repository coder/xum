import { afterEach, describe, expect, test } from "bun:test";
import * as http from "http";
import type { AddressInfo } from "net";
import { answersAsXumBackend } from "./xumBackendProbe";
import { startFakeBackend, unservedBaseUrl, type FakeBackend } from "./testXumBackend";

describe("answersAsXumBackend", () => {
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
    expect(await answersAsXumBackend(live.baseUrl)).toBe(true);
    expect(live.requests).toHaveLength(1);
    expect(live.requests[0].url).toBe("/version");
    const headers = Object.keys(live.requests[0].headers);
    for (const credential of ["authorization", "cookie", "proxy-authorization"]) {
      expect(headers).not.toContain(credential);
    }
  });

  test("a base URL with a path prefix is asked under that prefix", async () => {
    const live = await backend("xum", { prefix: "/mux" });
    expect(await answersAsXumBackend(`${live.baseUrl}/`)).toBe(true);
    expect(live.requests.map((request) => request.url)).toEqual(["/mux/version"]);
  });

  test("a refused connection means no backend", async () => {
    expect(await answersAsXumBackend(await unservedBaseUrl())).toBe(false);
  });

  test("another server on the port means no backend", async () => {
    const other = await backend("other");
    expect(await answersAsXumBackend(other.baseUrl)).toBe(false);
  });

  test("a listener that never answers means no backend, within the timeout", async () => {
    const hung = await backend("hang");
    const started = Date.now();
    expect(await answersAsXumBackend(hung.baseUrl, 150)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
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
    expect(await answersAsXumBackend(await serve(handler), 1_000)).toBe(false);
  });

  test("a redirect is not followed, even to a xum backend", async () => {
    const live = await backend("xum");
    const redirecting = await serve((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `${live.baseUrl}/version`);
      res.end();
    });
    expect(await answersAsXumBackend(redirecting)).toBe(false);
    expect(live.requests).toEqual([]);
  });

  test("a URL that is not plain http(s) without credentials means no backend", async () => {
    const live = await backend("xum");
    const withCredentials = live.baseUrl.replace("http://", "http://user:secret@");
    for (const url of ["not a url", "ftp://127.0.0.1:21", "file:///etc/passwd", withCredentials]) {
      expect(await answersAsXumBackend(url)).toBe(false);
    }
    expect(live.requests).toEqual([]);
  });
});
