import { afterEach, describe, expect, test } from "bun:test";

import { findModuleUrls, warmModuleGraph } from "./warmViteModules";

type Handler = (url: URL) => Response | Promise<Response>;

const servers: { stop: (force?: boolean) => void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function js(source: string): Response {
  return new Response(source, { headers: { "content-type": "text/javascript" } });
}

/** A stand-in for Vite: `routes` maps a path (with its query) to a handler. Records each request. */
function serve(routes: Record<string, Handler>): { origin: string; requests: string[] } {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const key = url.pathname + url.search;
      requests.push(key);
      const handler = routes[key];
      return handler ? await handler(url) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, requests };
}

const INDEX_HTML = `<!doctype html><html><head>
<script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);</script>
<script type="module" src="/@vite/client"></script></head><body>
<script type="module" src="/src/main.tsx"></script></body></html>`;

describe("findModuleUrls", () => {
  test("reads the import forms that Vite serves, and only same-origin paths", () => {
    const urls = findModuleUrls(`
      import React from "/node_modules/.vite/deps/react.js?v=abc123";
      import {
        a,
        b,
      } from "/src/multi.ts";
      import "/src/styles/globals.css";
      export * from "/src/reexport.ts";
      export { c } from "/src/named.ts";
      const lazy = () => import("/src/lazy.tsx");
      import bare from "react-dom";
      import cdn from "//cdn.example.com/x.js";
      import remote from "https://example.com/y.js";
      const doc = "React.lazy(() => import(...))";
    `);
    expect(urls.sort()).toEqual([
      "/node_modules/.vite/deps/react.js?v=abc123",
      "/src/lazy.tsx",
      "/src/multi.ts",
      "/src/named.ts",
      "/src/reexport.ts",
      "/src/styles/globals.css",
    ]);
  });
});

describe("warmModuleGraph", () => {
  test("serves static and dynamic modules once each, cycles included, and waits for the slowest", async () => {
    let slowAnswered = false;
    const { origin, requests } = serve({
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      "/@react-refresh": () => js("export default {}"),
      "/@vite/client": () => js("export {}"),
      "/src/main.tsx": () =>
        js(`import "/src/a.ts"; const lazy = () => import("/src/lazy.tsx"); export {}`),
      // a.ts imports main.tsx back: the walk must end.
      "/src/a.ts": () =>
        js(`import "/src/main.tsx"; import "/src/shared.ts"; import "/src/slow.ts"; export {}`),
      "/src/lazy.tsx": () =>
        js(`import "/src/shared.ts"; import "/node_modules/.vite/deps/react.js?v=abc"; export {}`),
      "/src/shared.ts": () => js("export {}"),
      "/node_modules/.vite/deps/react.js?v=abc": () => js("export {}"),
      "/src/slow.ts": async () => {
        // Vite answers a module that it has not transformed yet only after the transform.
        await Bun.sleep(150);
        slowAnswered = true;
        return js(`import "/src/after-slow.ts"; export {}`);
      },
      "/src/after-slow.ts": () => js("export {}"),
    });

    const result = await warmModuleGraph(origin);

    // Done only after the slow module's own imports were fetched too.
    expect(slowAnswered).toBe(true);
    expect(requests.sort()).toEqual(
      [
        "/",
        "/@react-refresh",
        "/@vite/client",
        "/node_modules/.vite/deps/react.js?v=abc",
        "/src/a.ts",
        "/src/after-slow.ts",
        "/src/lazy.tsx",
        "/src/main.tsx",
        "/src/shared.ts",
        "/src/slow.ts",
      ].sort()
    );
    expect(result).toEqual({ served: 10, notFound: 0 });
  });

  test("ignores a 404 for a string that only looks like an import", async () => {
    const { origin } = serve({
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      "/@react-refresh": () => js("export default {}"),
      "/@vite/client": () => js("export {}"),
      "/src/main.tsx": () =>
        js(`const s = 'import x from "/not/a/module.js"'; import "/src/ok.ts"`),
      "/src/ok.ts": () => js("export {}"),
    });

    const result = await warmModuleGraph(origin);

    // Only the string inside main.tsx is unrouted. The page's own two scripts are served.
    expect(result).toEqual({ served: 5, notFound: 1 });
  });

  test("fails and names the module when Vite answers a transform error", async () => {
    const { origin } = serve({
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      "/src/main.tsx": () => js(`import "/src/broken.tsx"; import "/src/ok.ts"`),
      "/src/broken.tsx": () => new Response("transform error", { status: 500 }),
      "/src/ok.ts": () => js("export {}"),
    });

    const failure = await warmModuleGraph(origin).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("/src/broken.tsx: HTTP 500");
    expect((failure as Error).message).not.toContain("/src/ok.ts: HTTP");
  });

  test("never requests another origin, whatever a module's import strings say", async () => {
    const other = serve({ "/x.js": () => js("export {}") });
    const otherHost = other.origin.replace("http://", "");
    const { origin, requests } = serve({
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      // `/\\host:port/x.js` is a URL on another host: WHATWG URL reads the backslash as a slash.
      "/src/main.tsx": () =>
        js(`import "/\\${otherHost}/x.js"; import "/src/ok.ts"; import "//${otherHost}/x.js"`),
      "/src/ok.ts": () => js("export {}"),
    });

    const result = await warmModuleGraph(origin);

    // Nothing reaches the other host, and Vite gets no request that names it either.
    expect(other.requests).toEqual([]);
    expect(requests.filter((path) => path.includes(otherHost))).toEqual([]);
    expect(requests).not.toContain("/x.js");
    expect(result.served).toBe(3);
  });

  // `new URL(path, base)` turns a path that starts with `//` into another host. URL parsing keeps
  // such a path after it removes dot segments from `/.//host/x.js`, so the walk must never resolve
  // a path against the origin a second time.
  test.each([
    ["a dot segment before the slashes", (host: string) => `/.//${host}/x.js`, "/x.js"],
    [
      "a parent segment before the slashes, with a query",
      (host: string) => `/a/..//${host}/y.js?q=1`,
      "/y.js",
    ],
    ["an encoded dot segment before the slashes", (host: string) => `/%2e//${host}/z.js`, "/z.js"],
  ])("never requests another origin through %s", async (_name, importPath, otherPath) => {
    const other = serve({
      "/x.js": () => js("export {}"),
      "/y.js?q=1": () => js("export {}"),
      "/z.js": () => js("export {}"),
    });
    const otherHost = other.origin.replace("http://", "");
    const { origin } = serve({
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      "/src/main.tsx": () => js(`import "${importPath(otherHost)}"; import "/src/ok.ts"`),
      "/src/ok.ts": () => js("export {}"),
    });

    const result = await warmModuleGraph(origin);

    expect(other.requests, `the other host got a request for ${otherPath}`).toEqual([]);
    expect(result.served).toBe(3);
  });

  // `fetch` follows a redirect unless told not to, and the walk must not leave Vite's origin. Vite
  // does not redirect a module, so a 3xx is a module that Vite could not serve.
  test.each([
    ["another origin", (otherOrigin: string) => `${otherOrigin}/x.js`],
    ["the same origin", () => "/src/ok.ts"],
  ])("fails on a redirect to %s and does not follow it", async (_name, location) => {
    const other = serve({ "/x.js": () => js("export {}") });
    const { origin, requests } = serve({
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      "/src/main.tsx": () =>
        new Response(null, { status: 302, headers: { location: location(other.origin) } }),
      "/src/ok.ts": () => js("export {}"),
    });

    const failure = await warmModuleGraph(origin).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("/src/main.tsx: HTTP 302");
    expect(other.requests).toEqual([]);
    // The redirect target is not requested either: a redirect is a failure, not a hop.
    expect(requests).not.toContain("/src/ok.ts");
  });

  test("keeps at most `concurrency` requests in flight", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const leaves = Array.from({ length: 12 }, (_, index) => `/src/leaf${index}.ts`);
    const routes: Record<string, Handler> = {
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      "/src/main.tsx": () => js(leaves.map((leaf) => `import "${leaf}";`).join("\n")),
    };
    for (const leaf of leaves) {
      routes[leaf] = async () => {
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        // Long enough that the walk has queued every other leaf while this one is open.
        await Bun.sleep(60);
        inFlight--;
        return js("export {}");
      };
    }
    const { origin } = serve(routes);

    await warmModuleGraph(origin, { concurrency: 3 });

    expect(mostInFlight).toBe(3);
  });

  test("rejects a concurrency below 1", async () => {
    const { origin } = serve({});

    const failure = await warmModuleGraph(origin, { concurrency: 0 }).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error).message).toContain("concurrency must be at least 1");
  });

  test("stops a walk whose graph never ends", async () => {
    // Every module /m/<n> imports 50 modules that no one has asked for yet.
    const runaway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/") {
          return new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });
        }
        if (path === "/src/main.tsx") return js(`import "/m/0";`);
        const id = Number(path.replace("/m/", ""));
        if (!Number.isInteger(id)) return new Response("not found", { status: 404 });
        return js(
          Array.from({ length: 50 }, (_, i) => `import "/m/${id * 50 + i + 1}";`).join("\n")
        );
      },
    });
    servers.push(runaway);

    const failure = await warmModuleGraph(`http://127.0.0.1:${runaway.port}`).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as Error).message).toMatch(/more than \d+ URLs/);
  });

  test("gives up when the signal aborts while Vite never answers", async () => {
    const { origin } = serve({
      "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      "/src/main.tsx": () => new Promise<Response>(() => {}),
    });

    const failure = await warmModuleGraph(origin, { signal: AbortSignal.timeout(300) }).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("TimeoutError");
  });
});
