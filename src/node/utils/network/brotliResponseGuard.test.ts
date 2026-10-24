import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as zlib from "node:zlib";
import { Client, fetch } from "undici/index.js";
import { isBrotliResponseGuardNeeded, refuseBrotliResponses } from "./brotliResponseGuard";

let server: http.Server;
let baseUrl: string;
const sentAcceptEncoding: Array<string | undefined> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    sentAcceptEncoding.push(req.headers["accept-encoding"]);
    const brotli = req.url === "/br";
    res.writeHead(200, { "content-encoding": brotli ? "br" : "gzip" });
    res.end(brotli ? zlib.brotliCompressSync("secret") : zlib.gzipSync("hello"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("refuseBrotliResponses", () => {
  test("refuses a Brotli-encoded response, which fetch would otherwise decode", async () => {
    const plain = await fetch(`${baseUrl}/br`, { dispatcher: new Client(baseUrl) });
    expect(await plain.text()).toBe("secret");

    const guarded = new Client(baseUrl).compose(refuseBrotliResponses);
    const failure = await fetch(`${baseUrl}/br`, { dispatcher: guarded }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).cause).toMatchObject({
      message: expect.stringContaining("Brotli"),
    });
  });

  test.each([
    ["br, gzip, deflate", "gzip, deflate"],
    ["BR;q=1.0, gzip;q=0.5", "gzip;q=0.5"],
    ["br", "identity"],
    ["*", "identity"],
    ["gzip", "gzip"],
  ])("asks for %p as %p and still decodes gzip", async (requested, sent) => {
    sentAcceptEncoding.length = 0;
    const response = await fetch(`${baseUrl}/gzip`, {
      dispatcher: new Client(baseUrl).compose(refuseBrotliResponses),
      headers: { "accept-encoding": requested },
    });
    expect(await response.text()).toBe("hello");
    expect(sentAcceptEncoding).toEqual([sent]);
  });
});

test.each([
  [{ node: "24.21.0", electron: "44.5.1" }, true],
  [{ node: "22.20.0" }, true],
  [{ node: "24.22.1", electron: "44.9.4" }, false],
  [{ node: "26.12.1" }, false],
  [{ node: "24.3.0", bun: "1.4.3" }, false],
])("isBrotliResponseGuardNeeded(%p) is %p", (versions, needed) => {
  expect(isBrotliResponseGuardNeeded(versions)).toBe(needed);
});
