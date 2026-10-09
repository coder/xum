import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import { createOrpcServer, DESKTOP_WS_PATH, ORPC_WS_PATH } from "./server";
import { log } from "@/node/services/log";
import type { ORPCContext } from "./context";
import type { AppRouter } from "./router";

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  if (!("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function waitForWebSocketRejection(ws: WebSocket): Promise<void> {
  // Since Bun 1.3.10 the `ws` client shim's once() installs two native forwarders, so a
  // rejected handshake fires 'error' twice (and terminate() before 'close' re-emits it).
  // The listeners below detach once settled, so keep one for the socket's lifetime;
  // otherwise the extra 'error' is thrown as unhandled.
  ws.on("error", () => undefined);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Expected WebSocket handshake to be rejected"));
    }, 5_000);

    const onError = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      resolve();
    };

    const onOpen = () => {
      cleanup();
      reject(new Error("Expected WebSocket handshake to be rejected"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("error", onError);
      ws.off("close", onClose);
      ws.off("open", onOpen);
    };

    ws.once("error", onError);
    ws.once("close", onClose);
    ws.once("open", onOpen);
  });
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

function createHttpClient(
  baseUrl: string,
  headers?: Record<string, string>
): RouterClient<AppRouter> {
  const link = new HTTPRPCLink({
    origin: baseUrl,
    url: "/orpc",
    headers,
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- test helper
  return createORPCClient(link) as RouterClient<AppRouter>;
}

async function withProxyUriTemplateEnv<T>(
  env: { muxProxyUri?: string; vscodeProxyUri?: string },
  run: () => Promise<T>
): Promise<T> {
  const previousMuxProxyUri = process.env.MUX_PROXY_URI;
  const previousVscodeProxyUri = process.env.VSCODE_PROXY_URI;

  if (env.muxProxyUri === undefined) {
    delete process.env.MUX_PROXY_URI;
  } else {
    process.env.MUX_PROXY_URI = env.muxProxyUri;
  }

  if (env.vscodeProxyUri === undefined) {
    delete process.env.VSCODE_PROXY_URI;
  } else {
    process.env.VSCODE_PROXY_URI = env.vscodeProxyUri;
  }

  try {
    return await run();
  } finally {
    if (previousMuxProxyUri === undefined) {
      delete process.env.MUX_PROXY_URI;
    } else {
      process.env.MUX_PROXY_URI = previousMuxProxyUri;
    }

    if (previousVscodeProxyUri === undefined) {
      delete process.env.VSCODE_PROXY_URI;
    } else {
      process.env.VSCODE_PROXY_URI = previousVscodeProxyUri;
    }
  }
}

const APP_PROXY_BASE_PATH = "/@u/ws/apps/mux";
const APP_PROXY_BASE_PATH_ALT = "/@alice/dev/apps/mux";

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function expectSlashlessRootRedirectBeforeBase(html: string, baseHref: string): void {
  const redirectIndex = html.indexOf("location.replace(location.origin+pathname");
  const baseIndex = html.indexOf(`<base href="${baseHref}"`);
  expect(redirectIndex).toBeGreaterThanOrEqual(0);
  expect(baseIndex).toBeGreaterThan(redirectIndex);
}

async function createStaticTestServer(
  options: {
    files?: Record<string, string>;
    context?: Partial<ORPCContext>;
    authToken?: string;
  } = {}
): Promise<{
  server: Awaited<ReturnType<typeof createOrpcServer>>;
  tempDir: string;
  close: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-app-proxy-"));
  const files = {
    "index.html":
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>",
    ...options.files,
  };

  for (const [filePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(tempDir, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents, "utf-8");
  }

  let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
  try {
    server = await createOrpcServer({
      host: "127.0.0.1",
      port: 0,
      context: (options.context ?? {}) as ORPCContext,
      authToken: options.authToken,
      serveStatic: true,
      staticDir: tempDir,
    });
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    server,
    tempDir,
    close: async () => {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

type TestOrpcServer = Awaited<ReturnType<typeof createOrpcServer>>;

type ServerOptions = Omit<Parameters<typeof createOrpcServer>[0], "host" | "port" | "context">;

async function withTestOrpcServer<T>(
  run: (server: TestOrpcServer) => Promise<T>,
  options: ServerOptions = {}
): Promise<T> {
  const server = await createOrpcServer({
    host: "127.0.0.1",
    port: 0,
    // Tests in this file don't exercise context services unless explicitly supplied.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    context: {} as ORPCContext,
    ...options,
  });

  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

type OriginHeaders = Record<string, string> | ((server: TestOrpcServer) => Record<string, string>);

function resolveOriginHeaders(
  headers: OriginHeaders | undefined,
  server: TestOrpcServer
): Record<string, string> | undefined {
  return typeof headers === "function" ? headers(server) : headers;
}

async function expectHttpOriginCase(input: {
  headers?: OriginHeaders;
  status: number;
  allowOrigin?: string | null | ((server: TestOrpcServer) => string | null);
  allowHttpOrigin?: boolean;
}): Promise<void> {
  await withTestOrpcServer(
    async (server) => {
      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: resolveOriginHeaders(input.headers, server),
      });

      expect(response.status).toBe(input.status);
      if (input.allowOrigin !== undefined) {
        const allowOrigin =
          typeof input.allowOrigin === "function" ? input.allowOrigin(server) : input.allowOrigin;
        expect(response.headers.get("access-control-allow-origin")).toBe(allowOrigin);
        if (allowOrigin != null) {
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        }
      }
    },
    input.allowHttpOrigin ? { allowHttpOrigin: true } : {}
  );
}

async function expectWebSocketOriginCase(input: {
  headers?: OriginHeaders;
  accepted: boolean;
  allowHttpOrigin?: boolean;
}): Promise<void> {
  await withTestOrpcServer(
    async (server) => {
      const ws = new WebSocket(server.wsUrl, {
        headers: resolveOriginHeaders(input.headers, server),
      });

      try {
        if (input.accepted) {
          await waitForWebSocketOpen(ws);
          await closeWebSocket(ws);
        } else {
          await waitForWebSocketRejection(ws);
        }
      } finally {
        ws.terminate();
      }
    },
    input.allowHttpOrigin ? { allowHttpOrigin: true } : {}
  );
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// node:http instead of fetch: fetch decodes Content-Encoding transparently, which would hide
// which file (identity, .br or .gz) the server actually sent.
function rawRequest(
  baseUrl: string,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(urlPath, baseUrl),
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function varyIncludesAcceptEncoding(headers: http.IncomingHttpHeaders): boolean {
  const vary = headers.vary;
  return (
    vary
      ?.split(",")
      .map((value) => value.trim().toLowerCase())
      .includes("accept-encoding") ?? false
  );
}

describe("createOrpcServer hashed static asset compression", () => {
  const HASHED_JS = "main-AbCd1234.js";
  const IDENTITY_BODY = "console.log('identity body');";
  // Distinct bytes and lengths per file so each assertion proves which file the server sent.
  const BROTLI_BODY = "fake brotli payload";
  const GZIP_BODY = "fake gzip payload, longer";
  const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
  const staticFiles = {
    [HASHED_JS]: IDENTITY_BODY,
    [`${HASHED_JS}.br`]: BROTLI_BODY,
    [`${HASHED_JS}.gz`]: GZIP_BODY,
    "plain-ZyXw9876.js": "console.log('no precompressed siblings');",
    "manifest.json": '{"name":"xum"}',
    "manifest.json.br": "unhashed brotli must never be sent",
    "terminal.html": "<!doctype html><title>terminal</title>",
  };

  test("negotiates the precompressed file by Accept-Encoding and caches it as immutable", async () => {
    const { server, close } = await createStaticTestServer({ files: staticFiles });

    try {
      const identity = await rawRequest(server.baseUrl, `/${HASHED_JS}`);
      expect(identity.headers["content-type"]).toContain("javascript");

      const cases: Array<{
        urlPath: string;
        acceptEncoding: string | undefined;
        encoding: string | undefined;
        body: string;
      }> = [
        // Browsers list gzip before br; brotli must still win.
        {
          urlPath: `/${HASHED_JS}`,
          acceptEncoding: "gzip, deflate, br, zstd",
          encoding: "br",
          body: BROTLI_BODY,
        },
        { urlPath: `/${HASHED_JS}?v=1`, acceptEncoding: "br", encoding: "br", body: BROTLI_BODY },
        { urlPath: `/${HASHED_JS}`, acceptEncoding: "gzip", encoding: "gzip", body: GZIP_BODY },
        // A higher client q-value beats the server's brotli preference.
        {
          urlPath: `/${HASHED_JS}`,
          acceptEncoding: "gzip;q=1, br;q=0.1",
          encoding: "gzip",
          body: GZIP_BODY,
        },
        {
          urlPath: `/${HASHED_JS}`,
          acceptEncoding: "identity;q=1, br;q=0.5",
          encoding: undefined,
          body: IDENTITY_BODY,
        },
        {
          urlPath: `/${HASHED_JS}`,
          acceptEncoding: undefined,
          encoding: undefined,
          body: IDENTITY_BODY,
        },
        {
          urlPath: `/${HASHED_JS}`,
          acceptEncoding: "identity",
          encoding: undefined,
          body: IDENTITY_BODY,
        },
        {
          urlPath: `/${HASHED_JS}`,
          acceptEncoding: "br;q=0, gzip;q=0",
          encoding: undefined,
          body: IDENTITY_BODY,
        },
        // No .br/.gz on disk: fall back to the identity file, not an error or the SPA HTML.
        {
          urlPath: "/plain-ZyXw9876.js",
          acceptEncoding: "br, gzip",
          encoding: undefined,
          body: staticFiles["plain-ZyXw9876.js"],
        },
      ];

      for (const testCase of cases) {
        const label = `${testCase.urlPath} with Accept-Encoding ${testCase.acceptEncoding ?? "(none)"}`;
        const res = await rawRequest(server.baseUrl, testCase.urlPath, {
          headers: testCase.acceptEncoding ? { "Accept-Encoding": testCase.acceptEncoding } : {},
        });
        expect(res.status, label).toBe(200);
        expect(res.headers["content-encoding"], label).toBe(testCase.encoding);
        expect(res.body, label).toBe(testCase.body);
        expect(res.headers["content-type"], label).toBe(identity.headers["content-type"]);
        expect(varyIncludesAcceptEncoding(res.headers), label).toBe(true);
        expect(res.headers["cache-control"], label).toBe(IMMUTABLE_CACHE_CONTROL);
      }
    } finally {
      await close();
    }
  });

  test("keeps existing headers for unhashed files and the SPA index", async () => {
    const { server, close } = await createStaticTestServer({ files: staticFiles });

    try {
      const cases = [
        {
          urlPath: "/manifest.json",
          cacheControl: "public, max-age=0",
          body: staticFiles["manifest.json"],
        },
        {
          urlPath: "/terminal.html",
          cacheControl: "public, max-age=0",
          body: staticFiles["terminal.html"],
        },
        { urlPath: "/", cacheControl: "no-store", body: "<title>mux</title>" },
        { urlPath: "/index.html", cacheControl: "no-store", body: "<title>mux</title>" },
      ];

      for (const testCase of cases) {
        const res = await rawRequest(server.baseUrl, testCase.urlPath, {
          headers: { "Accept-Encoding": "br, gzip" },
        });
        expect(res.status, testCase.urlPath).toBe(200);
        expect(res.body, testCase.urlPath).toContain(testCase.body);
        expect(res.headers["content-encoding"], testCase.urlPath).toBeUndefined();
        expect(res.headers["cache-control"], testCase.urlPath).toBe(testCase.cacheControl);
        expect(varyIncludesAcceptEncoding(res.headers), testCase.urlPath).toBe(false);
      }
    } finally {
      await close();
    }
  });

  test("answers HEAD on an encoded hashed asset with the GET headers and no body", async () => {
    const { server, close } = await createStaticTestServer({ files: staticFiles });

    try {
      const headers = { "Accept-Encoding": "br" };
      const get = await rawRequest(server.baseUrl, `/${HASHED_JS}`, { headers });
      const head = await rawRequest(server.baseUrl, `/${HASHED_JS}`, { method: "HEAD", headers });
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-encoding"]).toBe("br");
      expect(head.headers["content-length"]).toBe(String(BROTLI_BODY.length));
      for (const name of ["content-type", "content-length", "cache-control", "vary", "etag"]) {
        expect(head.headers[name], name).toBe(get.headers[name]);
      }
    } finally {
      await close();
    }
  });

  test("ignores Range on encoded hashed assets but honors it on identity responses", async () => {
    const { server, close } = await createStaticTestServer({ files: staticFiles });

    try {
      // A byte range of the brotli stream is not a range of the identity resource: send it whole.
      const encoded = await rawRequest(server.baseUrl, `/${HASHED_JS}`, {
        headers: { "Accept-Encoding": "br", Range: "bytes=0-3" },
      });
      expect(encoded.status).toBe(200);
      expect(encoded.body).toBe(BROTLI_BODY);
      expect(encoded.headers["content-range"]).toBeUndefined();
      expect(encoded.headers["accept-ranges"]).toBeUndefined();

      const identity = await rawRequest(server.baseUrl, `/${HASHED_JS}`, {
        headers: { Range: "bytes=0-3" },
      });
      expect(identity.status).toBe(206);
      expect(identity.headers["content-range"]).toBe(`bytes 0-3/${IDENTITY_BODY.length}`);
      expect(identity.body).toBe(IDENTITY_BODY.slice(0, 4));
    } finally {
      await close();
    }
  });
});

// #5945: crawlers and agents probe /robots.txt, /llms.txt and /.well-known/*. Answering them with
// the SPA page (status 200, text/html) makes Lighthouse report invalid files instead of absent ones.
describe("createOrpcServer SPA fallback for file and well-known paths", () => {
  const SPA_TITLE = "<title>mux</title>";

  test("serves a robots.txt that disallows every crawler", async () => {
    const { server, close } = await createStaticTestServer();

    try {
      for (const urlPath of ["/robots.txt", `${APP_PROXY_BASE_PATH}/robots.txt`]) {
        const res = await rawRequest(server.baseUrl, urlPath);
        expect(res.status, urlPath).toBe(200);
        expect(res.headers["content-type"], urlPath).toContain("text/plain");
        expect(res.body, urlPath).toBe("User-agent: *\nDisallow: /\n");
      }
    } finally {
      await close();
    }
  });

  test("answers missing file paths and /.well-known/ with 404 instead of the SPA page", async () => {
    const { server, close } = await createStaticTestServer();

    try {
      const urlPaths = [
        "/llms.txt",
        "/.well-known/ai-catalog.json",
        "/.well-known/security",
        "/.well-known",
        "/assets/x.js",
        "/other/missing.js",
        "/workspace/abc/missing.js",
        "/favicon.png?v=1",
        `${APP_PROXY_BASE_PATH}/llms.txt`,
      ];
      for (const urlPath of urlPaths) {
        const res = await rawRequest(server.baseUrl, urlPath);
        expect(res.status, urlPath).toBe(404);
        expect(res.body, urlPath).not.toContain(SPA_TITLE);
        expect(res.headers["cache-control"], urlPath).not.toBe("no-store");
      }

      // Hashed-looking but absent (#5953): no immutable cache or encoding headers either.
      const missingHashed = await rawRequest(server.baseUrl, "/missing-AbCd1234.js", {
        headers: { "Accept-Encoding": "br, gzip" },
      });
      expect(missingHashed.status).toBe(404);
      expect(missingHashed.body).not.toContain(SPA_TITLE);
      expect(missingHashed.headers["content-encoding"]).toBeUndefined();
      expect(missingHashed.headers["cache-control"]).toBeUndefined();
      expect(varyIncludesAcceptEncoding(missingHashed.headers)).toBe(false);
    } finally {
      await close();
    }
  });

  test("keeps serving the no-store SPA page for client routes and API files", async () => {
    const { server, close } = await createStaticTestServer();

    try {
      const spaPaths = [
        "/",
        "/index.html",
        "/workspace/abc",
        // Legacy workspace IDs are `${project}-${branch}` and can contain dots.
        "/workspace/next.js-main",
        "/workspace/proj-release-1.2",
        "/workspace/proj-fix.js",
        "/settings",
        "/settings/providers",
        "/project?path=%2Fhome%2Fdev%2Frepo.git",
        `${APP_PROXY_BASE_PATH}/workspace/abc`,
      ];
      for (const urlPath of spaPaths) {
        const res = await rawRequest(server.baseUrl, urlPath);
        expect(res.status, urlPath).toBe(200);
        expect(res.body, urlPath).toContain(SPA_TITLE);
        expect(res.headers["cache-control"], urlPath).toBe("no-store");
      }

      // API paths that end in a file extension stay with their own handlers.
      const spec = await rawRequest(server.baseUrl, "/api/spec.json");
      expect(spec.status).toBe(200);
      expect(spec.headers["content-type"]).toContain("application/json");
    } finally {
      await close();
    }
  });
});

describe("createOrpcServer", () => {
  test("serveStatic fallback does not swallow /api routes", async () => {
    // Minimal context stub - router won't be exercised by this test.
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");

      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        serveStatic: true,
        staticDir: tempDir,
      });

      const uiRes = await fetch(`${server.baseUrl}/some/spa/route`);
      expect(uiRes.status).toBe(200);
      const uiText = await uiRes.text();
      expect(uiText).toContain("mux");
      expect(uiText).toContain('<base href="./../../"');

      const apiRes = await fetch(`${server.baseUrl}/api/not-a-real-route`);
      expect(apiRes.status).toBe(404);
    } finally {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("serves SPA base href from the detected public base path per request", async () => {
    const { server, close } = await createStaticTestServer();

    try {
      const rootRes = await fetch(`${server.baseUrl}/`);
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(countOccurrences(rootHtml, '<base href="./" />')).toBe(1);
      expectSlashlessRootRedirectBeforeBase(rootHtml, "./");

      // A dotted host looks like a file name and gets a 404 (#5945). The dotless host keeps the
      // redirect guard covered on an SPA response.
      for (const [urlPath, status] of [
        ["//attacker.example", 404],
        ["//attacker", 200],
      ] as const) {
        const doubleSlashRes = await fetch(`${server.baseUrl}${urlPath}`);
        expect(doubleSlashRes.status, urlPath).toBe(status);
        const doubleSlashHtml = await doubleSlashRes.text();
        expect(doubleSlashHtml, urlPath).not.toContain("location.replace(location.origin+pathname");
      }

      const deepRouteRes = await fetch(`${server.baseUrl}/some/spa/route`);
      expect(deepRouteRes.status).toBe(200);
      const deepRouteHtml = await deepRouteRes.text();
      expect(deepRouteHtml).toContain('<base href="./../../" />');
      expect(deepRouteHtml).not.toContain("location.replace(location.pathname");

      const directoryRouteRes = await fetch(`${server.baseUrl}/some/spa/route/`);
      expect(directoryRouteRes.status).toBe(200);
      expect(await directoryRouteRes.text()).toContain('<base href="./../../../" />');

      const forwardedPrefixRes = await fetch(`${server.baseUrl}/some/spa/route`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH },
      });
      expect(forwardedPrefixRes.status).toBe(200);
      const forwardedPrefixHtml = await forwardedPrefixRes.text();
      expect(forwardedPrefixHtml).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);

      const originalUriRes = await fetch(`${server.baseUrl}/`, {
        headers: { "X-Original-Uri": `${APP_PROXY_BASE_PATH}/` },
      });
      expect(originalUriRes.status).toBe(200);
      const originalUriHtml = await originalUriRes.text();
      expect(originalUriHtml).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);

      const firstPrefixRes = await fetch(`${server.baseUrl}/one`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH },
      });
      const secondPrefixRes = await fetch(`${server.baseUrl}/two`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH_ALT },
      });
      expect(await firstPrefixRes.text()).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);
      expect(await secondPrefixRes.text()).toContain(`<base href="${APP_PROXY_BASE_PATH_ALT}/" />`);
    } finally {
      await close();
    }
  });

  test("routes direct app-proxy HTTP requests to root-mounted handlers", async () => {
    const mainJs = "console.log('prefixed asset');";
    const authContext: Partial<ORPCContext> = {
      serverAuthService: {
        isGithubDeviceFlowEnabled: () => true,
      } as unknown as ORPCContext["serverAuthService"],
    };
    const { server, close } = await createStaticTestServer({
      files: { "assets/main.js": mainJs },
      context: authContext,
    });

    try {
      const rootAssetRes = await fetch(`${server.baseUrl}/assets/main.js`);
      const prefixedAssetRes = await fetch(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/assets/main.js`
      );
      expect(prefixedAssetRes.status).toBe(200);
      expect(await prefixedAssetRes.text()).toBe(await rootAssetRes.text());

      const prefixedRootRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}`);
      expect(prefixedRootRes.status).toBe(200);
      const prefixedRootHtml = await prefixedRootRes.text();
      expect(prefixedRootHtml).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);
      expectSlashlessRootRedirectBeforeBase(prefixedRootHtml, `${APP_PROXY_BASE_PATH}/`);

      const coderUrlRes = await fetch(
        `${server.baseUrl}/@admin/mux-workspace-095801.main/apps/mux/?token=redacted`
      );
      expect(coderUrlRes.status).toBe(200);
      const coderUrlHtml = await coderUrlRes.text();
      expect(coderUrlHtml).toContain('<base href="/@admin/mux-workspace-095801.main/apps/mux/" />');
      expectSlashlessRootRedirectBeforeBase(
        coderUrlHtml,
        "/@admin/mux-workspace-095801.main/apps/mux/"
      );

      const prefixedSpaRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/settings`);
      expect(prefixedSpaRes.status).toBe(200);
      expect(await prefixedSpaRes.text()).toContain(`<base href="${APP_PROXY_BASE_PATH}/" />`);

      const specRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/api/spec.json`);
      expect(specRes.status).toBe(200);
      expect(specRes.headers.get("content-type")).toContain("application/json");
      const spec = (await specRes.json()) as { servers?: Array<{ url?: string }> };
      expect(spec.servers?.[0]?.url).toBe(`${APP_PROXY_BASE_PATH}/api`);

      const docsRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/api/docs`);
      expect(docsRes.status).toBe(200);
      expect(await docsRes.text()).toContain(`${APP_PROXY_BASE_PATH}/api/spec.json`);

      const authRes = await fetch(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/server-login/options`
      );
      expect(authRes.status).toBe(200);
      expect(await authRes.json()).toEqual({ githubDeviceFlowEnabled: true });

      const client = createHttpClient(`${server.baseUrl}${APP_PROXY_BASE_PATH}`);
      const pingResult = await Promise.resolve(client.general.ping("app-proxy"));
      expect(pingResult).toBe("Pong: app-proxy");

      const falsePositiveRes = await fetch(`${server.baseUrl}/projects/apps/other`);
      expect(falsePositiveRes.status).toBe(200);
      expect(await falsePositiveRes.text()).toContain('<base href="./../../" />');
    } finally {
      await close();
    }
  });

  test("keeps origin validation active after direct app-proxy prefix stripping", async () => {
    const stubContext: Partial<ORPCContext> = {};
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const rootResponse = await fetch(`${server.baseUrl}/orpc`, {
        headers: { Origin: "https://evil.example.com" },
      });
      const prefixedResponse = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/orpc`, {
        headers: { Origin: "https://evil.example.com" },
      });

      expect(rootResponse.status).toBe(403);
      expect(prefixedResponse.status).toBe(rootResponse.status);
    } finally {
      await server?.close();
    }
  });

  test("serves Scalar docs with request-specific spec URLs", async () => {
    const { server, close } = await createStaticTestServer();

    try {
      const rootDocsRes = await fetch(`${server.baseUrl}/api/docs`);
      expect(rootDocsRes.status).toBe(200);
      expect(await rootDocsRes.text()).toContain('url: "/api/spec.json"');

      const forwardedDocsRes = await fetch(`${server.baseUrl}/api/docs`, {
        headers: { "X-Forwarded-Prefix": APP_PROXY_BASE_PATH },
      });
      expect(forwardedDocsRes.status).toBe(200);
      expect(await forwardedDocsRes.text()).toContain(
        `url: "${APP_PROXY_BASE_PATH}/api/spec.json"`
      );

      const directDocsRes = await fetch(`${server.baseUrl}${APP_PROXY_BASE_PATH}/api/docs`);
      expect(directDocsRes.status).toBe(200);
      expect(await directDocsRes.text()).toContain(`url: "${APP_PROXY_BASE_PATH}/api/spec.json"`);
    } finally {
      await close();
    }
  });

  test("accepts direct app-proxy WebSocket upgrades", async () => {
    const stubContext: Partial<ORPCContext> = {};
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    let ws: WebSocket | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      ws = new WebSocket(
        `${server.baseUrl.replace(/^http/, "ws")}${APP_PROXY_BASE_PATH}/orpc/ws?token=test-token`
      );

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("includes app-proxy base paths in OAuth redirect and callback return URLs", async () => {
    let muxGatewayRedirectUri = "";
    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway" };
        },
        handleServerCallbackAndExchange: () => Promise.resolve({ success: true, data: undefined }),
      } as unknown as ORPCContext["muxGatewayOauthService"],
    };
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const startResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: {
          Authorization: "Bearer test-token",
          "X-Forwarded-Prefix": APP_PROXY_BASE_PATH,
        },
      });
      expect(startResponse.status).toBe(200);
      expect(muxGatewayRedirectUri).toBe(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/mux-gateway/callback`
      );

      const callbackResponse = await fetch(
        `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/mux-gateway/callback?state=test&code=test`
      );
      expect(callbackResponse.status).toBe(200);
      const callbackHtml = await callbackResponse.text();
      expect(callbackHtml).toContain(`href="${APP_PROXY_BASE_PATH}/"`);
      expect(callbackHtml).toContain(`window.location.replace("${APP_PROXY_BASE_PATH}/")`);
    } finally {
      await server?.close();
    }
  });

  test("injects proxy URI template into SPA fallback HTML when env is set", async () => {
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-proxy-template-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";
    const muxProxyUri = "https://proxy-{{port}}.example.test/path</script>";

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");

      await withProxyUriTemplateEnv({ muxProxyUri }, async () => {
        const server = await createOrpcServer({
          host: "127.0.0.1",
          port: 0,
          context: stubContext as ORPCContext,
          authToken: "test-token",
          serveStatic: true,
          staticDir: tempDir,
        });

        try {
          const rootRes = await fetch(`${server.baseUrl}/`);
          expect(rootRes.status).toBe(200);
          const rootHtml = await rootRes.text();

          const uiRes = await fetch(`${server.baseUrl}/some/spa/route`);
          expect(uiRes.status).toBe(200);
          const uiText = await uiRes.text();

          expect(rootHtml).toContain('<base href="./"');
          expect(uiText).toContain('<base href="./../../"');

          for (const html of [rootHtml, uiText]) {
            expect(html).toContain("window.__MUX_PROXY_URI_TEMPLATE__ =");
            expect(html).toContain(
              'window.__MUX_PROXY_URI_TEMPLATE__ = "https://proxy-{{port}}.example.test/path\\u003c/script>";'
            );
          }
        } finally {
          await server.close();
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("injects null proxy URI template into SPA fallback HTML when env vars are absent", async () => {
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-proxy-template-null-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");

      await withProxyUriTemplateEnv({}, async () => {
        const server = await createOrpcServer({
          host: "127.0.0.1",
          port: 0,
          context: stubContext as ORPCContext,
          authToken: "test-token",
          serveStatic: true,
          staticDir: tempDir,
        });

        try {
          const rootRes = await fetch(`${server.baseUrl}/`);
          expect(rootRes.status).toBe(200);
          const rootHtml = await rootRes.text();

          const uiRes = await fetch(`${server.baseUrl}/some/spa/route`);
          expect(uiRes.status).toBe(200);
          const uiText = await uiRes.text();

          for (const html of [rootHtml, uiText]) {
            expect(html).toContain("window.__MUX_PROXY_URI_TEMPLATE__ = null;");
          }
        } finally {
          await server.close();
        }
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not apply origin validation to static and SPA fallback routes", async () => {
    // Static app shell must remain reachable even if proxy/header rewriting makes
    // request Origin values unexpected. API/WS/auth routes are validated separately.
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-origin-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";
    const mainJs = "console.log('ok');";
    const mainCss = "body { color: #fff; }";

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");
      await fs.writeFile(path.join(tempDir, "main.js"), mainJs, "utf-8");
      await fs.writeFile(path.join(tempDir, "main.css"), mainCss, "utf-8");

      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        serveStatic: true,
        staticDir: tempDir,
      });

      const directIndexResponse = await fetch(`${server.baseUrl}/`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(directIndexResponse.status).toBe(200);
      expect(directIndexResponse.headers.get("access-control-allow-origin")).toBeNull();

      const staticJsResponse = await fetch(`${server.baseUrl}/main.js`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(staticJsResponse.status).toBe(200);
      expect(staticJsResponse.headers.get("access-control-allow-origin")).toBeNull();

      const staticCssResponse = await fetch(`${server.baseUrl}/main.css`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(staticCssResponse.status).toBe(200);
      expect(staticCssResponse.headers.get("access-control-allow-origin")).toBeNull();

      const fallbackRouteResponse = await fetch(`${server.baseUrl}/some/spa/route`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(fallbackRouteResponse.status).toBe(200);
      expect(fallbackRouteResponse.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports whether GitHub device-flow login is enabled", async () => {
    async function runCase(enabled: boolean): Promise<void> {
      const stubContext: Partial<ORPCContext> = {
        serverAuthService: {
          isGithubDeviceFlowEnabled: () => enabled,
        } as unknown as ORPCContext["serverAuthService"],
      };

      let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

      try {
        server = await createOrpcServer({
          host: "127.0.0.1",
          port: 0,
          context: stubContext as ORPCContext,
        });

        const response = await fetch(`${server.baseUrl}/auth/server-login/options`);
        expect(response.status).toBe(200);

        const payload = (await response.json()) as { githubDeviceFlowEnabled?: boolean };
        expect(payload.githubDeviceFlowEnabled).toBe(enabled);
      } finally {
        await server?.close();
      }
    }

    await runCase(false);
    await runCase(true);
  });

  test("returns 429 when GitHub device-flow start is rate limited", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        startGithubDeviceFlow: () =>
          Promise.resolve({
            success: false,
            error: "Too many concurrent GitHub login attempts. Please wait and try again.",
          }),
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/start`, {
        method: "POST",
      });
      expect(response.status).toBe(429);
    } finally {
      await server?.close();
    }
  });

  test("uses HTTPS redirect URIs for OAuth start routes when allowHttpOrigin is enabled", async () => {
    let muxGatewayRedirectUri = "";

    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway" };
        },
      } as unknown as ORPCContext["muxGatewayOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        allowHttpOrigin: true,
      });

      const sharedHeaders = {
        Authorization: "Bearer test-token",
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com:443",
        "X-Forwarded-Proto": "http",
      };

      const muxGatewayResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: sharedHeaders,
      });
      expect(muxGatewayResponse.status).toBe(200);

      expect(muxGatewayRedirectUri).toBe(
        "https://mux-public.example.com/auth/mux-gateway/callback"
      );
    } finally {
      await server?.close();
    }
  });

  test("uses HTTP redirect URIs for OAuth start routes when client-facing proto is HTTP", async () => {
    let muxGatewayRedirectUri = "";

    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway-http" };
        },
      } as unknown as ORPCContext["muxGatewayOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const response = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: {
          Authorization: "Bearer test-token",
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "http,https",
        },
      });

      expect(response.status).toBe(200);
      expect(muxGatewayRedirectUri).toBe(`${server.baseUrl}/auth/mux-gateway/callback`);
    } finally {
      await server?.close();
    }
  });

  test("scopes mux_session cookie path to forwarded app base path", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-1", sessionToken: "session-token-1" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Prefix": "/@test/workspace/apps/mux/",
        },
        body: JSON.stringify({ flowId: "flow-1" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-1");
      expect(cookieHeader).toContain("Path=/@test/workspace/apps/mux;");
    } finally {
      await server?.close();
    }
  });

  test("sets Secure mux_session cookie when allowHttpOrigin is enabled", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-2", sessionToken: "session-token-compat" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        allowHttpOrigin: true,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://mux-public.example.com",
          "X-Forwarded-Host": "mux-public.example.com:443",
          "X-Forwarded-Proto": "http",
        },
        body: JSON.stringify({ flowId: "flow-compat" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-compat");
      expect(cookieHeader).toContain("; Secure");
    } finally {
      await server?.close();
    }
  });

  test("does not set Secure mux_session cookie when client-facing proto is HTTP", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-3", sessionToken: "session-token-http" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "http,https",
        },
        body: JSON.stringify({ flowId: "flow-http" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-http");
      expect(cookieHeader).not.toContain("; Secure");
    } finally {
      await server?.close();
    }
  });

  test("workspace.createMultiProject rejects direct IPC calls when the experiment is disabled", async () => {
    const createMultiProjectMock = mock(() => {
      throw new Error("workspaceService.createMultiProject should not be called");
    });
    const stubContext: Partial<ORPCContext> = {
      workspaceService: {
        createMultiProject: createMultiProjectMock,
      } as unknown as ORPCContext["workspaceService"],
      experimentsService: {
        isExperimentEnabled: () => false,
      } as unknown as ORPCContext["experimentsService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const client = createHttpClient(server.baseUrl, {
        Authorization: "Bearer test-token",
      });

      let error: unknown = null;
      try {
        await Promise.resolve(
          client.workspace.createMultiProject({
            projects: [
              { projectPath: "/tmp/project-a", projectName: "project-a" },
              { projectPath: "/tmp/project-b", projectName: "project-b" },
            ],
            branchName: "feature-disabled",
            trunkBranch: "main",
          })
        );
      } catch (caughtError) {
        error = caughtError;
      }

      expect(error).toBeTruthy();
      expect(createMultiProjectMock).not.toHaveBeenCalled();
      const message =
        error && typeof error === "object" && "message" in error
          ? (error as { message?: unknown }).message
          : "";
      expect(String(message)).toContain("Multi-project workspaces experiment is disabled");
    } finally {
      await server?.close();
    }
  });

  test("accepts ORPC requests authenticated via mux_session cookie", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        validateSessionToken: (token: string) => {
          if (token === "valid-session-token") {
            return Promise.resolve({ sessionId: "session-1" });
          }
          return Promise.resolve(null);
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const unauthenticatedClient = createHttpClient(server.baseUrl);

      let unauthenticatedError: unknown = null;
      try {
        await Promise.resolve(unauthenticatedClient.general.ping("cookie-auth"));
      } catch (error) {
        unauthenticatedError = error;
      }
      expect(unauthenticatedError).toBeTruthy();

      const duplicateCookieClient = createHttpClient(server.baseUrl, {
        Cookie: "mux_session=invalid-session-token; mux_session=valid-session-token",
      });
      const duplicateCookiePing = await Promise.resolve(
        duplicateCookieClient.general.ping("cookie-auth")
      );
      expect(duplicateCookiePing).toBe("Pong: cookie-auth");

      const cookieClient = createHttpClient(server.baseUrl, {
        Cookie: "mux_session=valid-session-token",
      });
      const authenticatedPing = await Promise.resolve(cookieClient.general.ping("cookie-auth"));
      expect(authenticatedPing).toBe("Pong: cookie-auth");
    } finally {
      await server?.close();
    }
  });

  test("OAuth callback routes accept POST redirects (query + form_post)", async () => {
    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        handleServerCallbackAndExchange: () => Promise.resolve({ success: true, data: undefined }),
      } as unknown as ORPCContext["muxGatewayOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      // Some OAuth providers issue 307/308 redirects which preserve POST.
      const queryRes = await fetch(
        `${server.baseUrl}/auth/mux-gateway/callback?state=test-state&code=test-code`,
        { method: "POST" }
      );
      expect(queryRes.status).toBe(200);
      const queryText = await queryRes.text();
      expect(queryText).toContain("Login complete");

      // response_mode=form_post delivers params in the request body.
      const formRes = await fetch(`${server.baseUrl}/auth/mux-gateway/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=test-state&code=test-code",
      });
      expect(formRes.status).toBe(200);
      const formText = await formRes.text();
      expect(formText).toContain("Login complete");
    } finally {
      await server?.close();
    }
  });

  test("MCP OAuth callback forwards the RFC 9207 iss parameter (query + form_post)", async () => {
    // The MCP SDK rejects the code exchange for issuers that advertise RFC 9207
    // unless the route passes `iss` through (Linear login regression).
    const callbackInputs: unknown[] = [];
    const stubContext: Partial<ORPCContext> = {
      mcpOauthService: {
        handleServerCallbackAndExchange: (input: unknown) => {
          callbackInputs.push(input);
          return Promise.resolve({ success: true, data: undefined });
        },
      } as unknown as ORPCContext["mcpOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const issuer = "https://mcp.linear.app";
      const queryRes = await fetch(
        `${server.baseUrl}/auth/mcp-oauth/callback?state=query-state&code=query-code&iss=${encodeURIComponent(issuer)}`
      );
      expect(queryRes.status).toBe(200);

      const formRes = await fetch(`${server.baseUrl}/auth/mcp-oauth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          state: "form-state",
          code: "form-code",
          iss: issuer,
        }).toString(),
      });
      expect(formRes.status).toBe(200);

      expect(callbackInputs).toEqual([
        expect.objectContaining({ state: "query-state", code: "query-code", iss: issuer }),
        expect.objectContaining({ state: "form-state", code: "form-code", iss: issuer }),
      ]);
    } finally {
      await server?.close();
    }
  });

  test("allows cross-origin POST requests on OAuth callback routes", async () => {
    const handleSuccessfulCallback = () => Promise.resolve({ success: true, data: undefined });
    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["muxGatewayOauthService"],
      mcpOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["mcpOauthService"],
      coderOauthService: {
        handleServerCallback: handleSuccessfulCallback,
      } as unknown as ORPCContext["coderOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const callbackHeaders = {
        Origin: "https://evil.example.com",
        "Content-Type": "application/x-www-form-urlencoded",
      };

      const coderOauthResponse = await fetch(`${server.baseUrl}/auth/coder/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(coderOauthResponse.status).toBe(200);
      expect(coderOauthResponse.headers.get("access-control-allow-origin")).toBeNull();

      const muxGatewayResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(muxGatewayResponse.status).toBe(200);
      expect(muxGatewayResponse.headers.get("access-control-allow-origin")).toBeNull();

      const mcpOauthResponse = await fetch(`${server.baseUrl}/auth/mcp-oauth/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(mcpOauthResponse.status).toBe(200);
      expect(mcpOauthResponse.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server?.close();
    }
  });

  test("Coder OAuth start route builds a server-hosted redirect URI and the callback renders the flow outcome", async () => {
    const startCalls: Array<{ deploymentUrl: string; flowId?: string; redirectUri: string }> = [];
    const callbackCalls: Array<{
      state: string | null;
      code: string | null;
      error: string | null;
    }> = [];
    const stubContext: Partial<ORPCContext> = {
      coderOauthService: {
        startServerFlow: (input: {
          deploymentUrl: string;
          flowId?: string;
          redirectUri: string;
        }) => {
          startCalls.push(input);
          return Promise.resolve({
            success: true,
            data: {
              flowId: input.flowId ?? "generated",
              authorizeUrl: "https://coder.test/authorize",
            },
          });
        },
        handleServerCallback: (input: {
          state: string | null;
          code: string | null;
          error: string | null;
        }) => {
          callbackCalls.push(input);
          return Promise.resolve(
            input.state === "known-state"
              ? { success: true, data: undefined }
              : { success: false, error: "Unknown or expired OAuth state" }
          );
        },
      } as unknown as ORPCContext["coderOauthService"],
    };
    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      // Start requires auth: the route mints a registration on the deployment.
      const unauthenticated = await fetch(
        `${server.baseUrl}/auth/coder/start?deploymentUrl=https://coder.test`
      );
      expect(unauthenticated.status).toBe(401);
      expect(startCalls).toHaveLength(0);

      const missingDeployment = await fetch(`${server.baseUrl}/auth/coder/start`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(missingDeployment.status).toBe(400);

      // The redirect URI is derived from the request (incl. app-proxy prefix),
      // never taken from the client.
      const startResponse = await fetch(
        `${server.baseUrl}/auth/coder/start?deploymentUrl=https://coder.test&flowId=flow-0123456789abcdef`,
        {
          headers: {
            Authorization: "Bearer test-token",
            "X-Forwarded-Prefix": APP_PROXY_BASE_PATH,
          },
        }
      );
      expect(startResponse.status).toBe(200);
      expect(await startResponse.json()).toEqual({
        flowId: "flow-0123456789abcdef",
        authorizeUrl: "https://coder.test/authorize",
      });
      expect(startCalls).toEqual([
        {
          deploymentUrl: "https://coder.test",
          flowId: "flow-0123456789abcdef",
          redirectUri: `${server.baseUrl}${APP_PROXY_BASE_PATH}/auth/coder/callback`,
        },
      ]);

      // Callback: unauthenticated navigation; outcome decides the page.
      const okResponse = await fetch(
        `${server.baseUrl}/auth/coder/callback?state=known-state&code=test-code`
      );
      expect(okResponse.status).toBe(200);
      const okHtml = await okResponse.text();
      expect(okHtml).toContain("Login complete");
      expect(okHtml).toContain('"type":"coder-oauth"');

      const failedResponse = await fetch(
        `${server.baseUrl}/auth/coder/callback?state=stale-state&code=test-code`
      );
      expect(failedResponse.status).toBe(400);
      expect(await failedResponse.text()).toContain("Unknown or expired OAuth state");
      expect(callbackCalls.map((c) => c.state)).toEqual(["known-state", "stale-state"]);
    } finally {
      await server?.close();
    }
  });

  test("localhost binds both loopback families on one port", async () => {
    // Regression: binding "localhost" used to take only the first resolved family,
    // leaving the other loopback address free for another dev server on the same port.
    // Mixed case also exercises hostname normalization.
    const stubContext: Partial<ORPCContext> = {};
    const server = await createOrpcServer({
      host: "LocalHost",
      port: 0,
      context: stubContext as ORPCContext,
      authToken: "test-token",
    });

    try {
      expect(server.baseUrl).toBe(`http://LocalHost:${server.port}`);
      const v4 = await fetch(`http://127.0.0.1:${server.port}/version`);
      expect(v4.status).toBe(200);

      let v6: Response;
      try {
        v6 = await fetch(`http://[::1]:${server.port}/version`);
      } catch {
        // Some CI environments do not have IPv6 loopback; the server falls back to IPv4 only.
        return;
      }
      expect(v6.status).toBe(200);

      // WebSocket upgrades arriving on ::1 must reach the shared upgrade handler.
      const ws = new WebSocket(`ws://[::1]:${server.port}${ORPC_WS_PATH}?token=test-token`);
      try {
        await waitForWebSocketOpen(ws);
      } finally {
        ws.terminate();
      }
    } finally {
      await server.close();
    }

    // close() must release both listeners.
    const reuse = net.createServer();
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(server.port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => reuse.close(() => resolve()));
  });

  test("localhost fails with EADDRINUSE when another process holds the IPv6 loopback port", async () => {
    const squatter = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        squatter.once("error", reject);
        squatter.listen(0, "::1", () => resolve());
      });
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
        return;
      }
      throw error;
    }

    const address = squatter.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const port = address.port;

    try {
      const stubContext: Partial<ORPCContext> = {};
      let caught: unknown = null;
      try {
        const server = await createOrpcServer({
          host: "localhost",
          port,
          context: stubContext as ORPCContext,
          authToken: "test-token",
        });
        await server.close();
      } catch (error) {
        caught = error;
      }
      expect(getErrorCode(caught)).toBe("EADDRINUSE");

      // The IPv4 listener bound before the failure must be released.
      const reuse = net.createServer();
      await new Promise<void>((resolve, reject) => {
        reuse.once("error", reject);
        reuse.listen(port, "127.0.0.1", () => resolve());
      });
      await new Promise<void>((resolve) => reuse.close(() => resolve()));
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  test("brackets IPv6 hosts in returned URLs", async () => {
    // Minimal context stub - router won't be exercised by this test.
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "::1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });
    } catch (error) {
      const code = getErrorCode(error);

      // Some CI environments may not have IPv6 enabled.
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
        return;
      }

      throw error;
    }

    try {
      expect(server.baseUrl).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect(server.wsUrl).toMatch(/^ws:\/\/\[::1\]:\d+\/orpc\/ws$/);
      expect(server.specUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/spec\.json$/);
      expect(server.docsUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/docs$/);
    } finally {
      await server.close();
    }
  });

  const httpOriginCases: Array<{
    name: string;
    headers?: OriginHeaders;
    status: number;
    allowOrigin?: string | null | ((server: TestOrpcServer) => string | null);
    allowHttpOrigin?: boolean;
  }> = [
    {
      name: "blocks cross-origin HTTP requests with Origin headers",
      headers: { Origin: "https://evil.example.com" },
      status: 403,
    },
    {
      name: "allows same-origin HTTP requests with Origin headers",
      headers: (server) => ({ Origin: server.baseUrl }),
      status: 200,
      allowOrigin: (server) => server.baseUrl,
    },
    {
      name: "allows same-origin HTTP requests when X-Forwarded-Host does not match",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Host": "internal.proxy.local",
      }),
      status: 200,
      allowOrigin: (server) => server.baseUrl,
    },
    {
      name: "allows same-origin requests when X-Forwarded-Proto overrides inferred protocol",
      headers: (server) => ({
        Origin: server.baseUrl.replace(/^http:/, "https:"),
        "X-Forwarded-Proto": "https",
      }),
      status: 200,
      allowOrigin: (server) => server.baseUrl.replace(/^http:/, "https:"),
    },
    {
      name: "allows HTTP origins when X-Forwarded-Proto includes multiple hops with leading http",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Proto": "http,https",
      }),
      status: 200,
      allowOrigin: (server) => server.baseUrl,
    },
    {
      name: "rejects HTTPS origins when X-Forwarded-Proto includes multiple hops with trailing https by default",
      headers: (server) => ({
        Origin: server.baseUrl.replace(/^http:/, "https:"),
        "X-Forwarded-Proto": "http,https",
      }),
      status: 403,
    },
    {
      name: "rejects HTTPS origins when X-Forwarded-Proto is overwritten to http by downstream proxy by default",
      headers: {
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com",
        "X-Forwarded-Proto": "http",
      },
      status: 403,
    },
    {
      name: "accepts HTTPS origins when allowHttpOrigin is enabled and X-Forwarded-Proto is overwritten to http by downstream proxy",
      headers: {
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com",
        "X-Forwarded-Proto": "http",
      },
      status: 200,
      allowOrigin: "https://mux-public.example.com",
      allowHttpOrigin: true,
    },
    {
      name: "allows HTTPS origins when allowHttpOrigin is enabled and overwritten proto uses forwarded host with explicit :443",
      headers: {
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com:443",
        "X-Forwarded-Proto": "http",
      },
      status: 200,
      allowOrigin: "https://mux-public.example.com",
      allowHttpOrigin: true,
    },
    {
      name: "rejects downgraded HTTP origins when X-Forwarded-Proto pins https",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Proto": "https",
      }),
      status: 403,
    },
    {
      name: "rejects downgraded HTTP origins when X-Forwarded-Proto includes multiple hops",
      headers: (server) => ({
        Origin: server.baseUrl,
        "X-Forwarded-Proto": "https,http",
      }),
      status: 403,
    },
    {
      name: "allows HTTP requests without Origin headers",
      status: 200,
      allowOrigin: null,
    },
  ];

  for (const httpCase of httpOriginCases) {
    test(httpCase.name, async () => {
      await expectHttpOriginCase(httpCase);
    });
  }

  test("routes desktop WebSocket connections to the bridge server without ORPC origin validation", async () => {
    const stubContext: Partial<ORPCContext> = {};
    const desktopRelayServer = new WebSocketServer({ noServer: true });
    let desktopRelayServerStopped = false;
    const desktopRequests: Array<{ origin: string | null; url: string | undefined }> = [];
    const desktopBridgeServer = {
      handleUpgrade(
        req: Parameters<WebSocketServer["handleUpgrade"]>[0],
        socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
        head: Parameters<WebSocketServer["handleUpgrade"]>[2]
      ) {
        desktopRelayServer.handleUpgrade(req, socket, head, (ws) => {
          desktopRelayServer.emit("connection", ws, req);
        });
      },
      async stop() {
        if (desktopRelayServerStopped) {
          return;
        }

        desktopRelayServerStopped = true;
        await new Promise<void>((resolve) => {
          desktopRelayServer.close(() => resolve());
        });
      },
    };

    desktopRelayServer.on("connection", (_ws, req) => {
      desktopRequests.push({
        origin: typeof req.headers.origin === "string" ? req.headers.origin : null,
        url: req.url,
      });
    });

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    let ws: WebSocket | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        desktopBridgeServer,
      });

      ws = new WebSocket(
        `${server.baseUrl.replace(/^http/, "ws")}${DESKTOP_WS_PATH}?token=test-token`,
        {
          headers: { origin: "https://evil.example.com" },
        }
      );

      await waitForWebSocketOpen(ws);
      expect(desktopRequests).toEqual([
        {
          origin: "https://evil.example.com",
          url: `${DESKTOP_WS_PATH}?token=test-token`,
        },
      ]);

      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      if (server) {
        await server.close();
      } else {
        await desktopBridgeServer.stop();
      }
    }
  });

  const webSocketOriginCases: Array<{
    name: string;
    headers?: OriginHeaders;
    accepted: boolean;
    allowHttpOrigin?: boolean;
  }> = [
    {
      name: "rejects cross-origin WebSocket connections",
      headers: { origin: "https://evil.example.com" },
      accepted: false,
    },
    {
      name: "accepts same-origin WebSocket connections",
      headers: (server) => ({ origin: server.baseUrl }),
      accepted: true,
    },
    {
      name: "accepts same-origin WebSocket connections when X-Forwarded-Host does not match",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-host": "internal.proxy.local",
      }),
      accepted: true,
    },
    {
      name: "accepts proxied HTTPS WebSocket origins when forwarded headers describe public app URL",
      headers: {
        origin: "https://mux-public.example.com",
        "x-forwarded-host": "mux-public.example.com",
        "x-forwarded-proto": "https",
      },
      accepted: true,
    },
    {
      name: "accepts HTTP WebSocket origins when X-Forwarded-Proto includes multiple hops with leading http",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-proto": "http,https",
      }),
      accepted: true,
    },
    {
      name: "rejects HTTPS WebSocket origins when X-Forwarded-Proto includes multiple hops with trailing https by default",
      headers: (server) => ({
        origin: server.baseUrl.replace(/^http:/, "https:"),
        "x-forwarded-proto": "http,https",
      }),
      accepted: false,
    },
    {
      name: "rejects HTTPS WebSocket origins when X-Forwarded-Proto is overwritten to http by downstream proxy by default",
      headers: {
        origin: "https://mux-public.example.com",
        "x-forwarded-host": "mux-public.example.com",
        "x-forwarded-proto": "http",
      },
      accepted: false,
    },
    {
      name: "accepts HTTPS WebSocket origins when allowHttpOrigin is enabled and X-Forwarded-Proto is overwritten to http by downstream proxy",
      headers: {
        origin: "https://mux-public.example.com",
        "x-forwarded-host": "mux-public.example.com",
        "x-forwarded-proto": "http",
      },
      accepted: true,
      allowHttpOrigin: true,
    },
    {
      name: "rejects downgraded WebSocket origins when X-Forwarded-Proto pins https",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-proto": "https",
      }),
      accepted: false,
    },
    {
      name: "rejects downgraded WebSocket origins when X-Forwarded-Proto includes multiple hops",
      headers: (server) => ({
        origin: server.baseUrl,
        "x-forwarded-proto": "https,http",
      }),
      accepted: false,
    },
    {
      name: "accepts WebSocket connections without Origin headers",
      accepted: true,
    },
  ];

  for (const wsCase of webSocketOriginCases) {
    test(wsCase.name, async () => {
      await expectWebSocketOriginCase(wsCase);
    });
  }

  test("does not log the auth token of a blocked cross-origin WebSocket upgrade", async () => {
    // Browser clients authenticate the oRPC WebSocket with `?token=` (#4853).
    const secret = "SECRET-auth-token-4853";
    const warnSpy = spyOn(log, "warn");

    try {
      await withTestOrpcServer(async (server) => {
        const ws = new WebSocket(`${server.wsUrl}?token=${secret}`, {
          headers: { origin: "https://evil.example.com" },
        });

        try {
          await waitForWebSocketRejection(ws);
        } finally {
          ws.terminate();
        }
      });

      const blockedCalls = warnSpy.mock.calls.filter(
        ([message]) => message === "Blocked cross-origin WebSocket upgrade request"
      );
      expect(blockedCalls).toHaveLength(1);
      expect(blockedCalls[0]?.[1]).toMatchObject({ path: ORPC_WS_PATH });
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("returns restrictive CORS preflight headers for same-origin requests", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        method: "OPTIONS",
        headers: {
          Origin: server.baseUrl,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization, Content-Type"
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
    } finally {
      await server?.close();
    }
  });

  test("general.restartApp delegates to the window service restart hook", async () => {
    const restartApp = mock(() => Promise.resolve({ supported: true as const }));
    const stubContext: Partial<ORPCContext> = {
      windowService: {
        restartApp,
      } as unknown as ORPCContext["windowService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const client = createHttpClient(server.baseUrl);
      const result = await Promise.resolve(client.general.restartApp());

      expect(restartApp).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ supported: true });
    } finally {
      await server?.close();
    }
  });

  test("general.restartApp reports unsupported when no restart handler is registered", async () => {
    const stubContext: Partial<ORPCContext> = {
      windowService: {
        restartApp: mock(() =>
          Promise.resolve({
            supported: false as const,
            message: "Restart is only available in the desktop app.",
          })
        ),
      } as unknown as ORPCContext["windowService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const client = createHttpClient(server.baseUrl);
      const result = await Promise.resolve(client.general.restartApp());

      expect(result).toEqual({
        supported: false,
        message: "Restart is only available in the desktop app.",
      });
    } finally {
      await server?.close();
    }
  });

  test("rejects CORS preflight requests from cross-origin callers", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example.com",
          "Access-Control-Request-Method": "GET",
        },
      });

      expect(response.status).toBe(403);
    } finally {
      await server?.close();
    }
  });
});
