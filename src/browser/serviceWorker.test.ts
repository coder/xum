/**
 * #6848: runs the real public/service-worker.js in a VM context with an in-memory Cache
 * Storage and a scripted network, and checks what it stores and what it answers offline.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vm from "node:vm";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../tests/ui/domGlobals";
import {
  clearStoredAuthToken,
  setStoredAuthToken,
} from "@/browser/components/AuthTokenModal/AuthTokenModal";

const WORKER_SOURCE = await fs.readFile(
  path.join(import.meta.dir, "../../public/service-worker.js"),
  "utf-8"
);
const ORIGIN = "https://xum.test";
const ROOT_SCOPE = `${ORIGIN}/`;
const HASHED_JS = "main-AbCd1234.js";
const cacheNameFor = (scope: string) => `mux-v3:${scope}`;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

// A promise lets a test hold a response back. Install (addAll) needs a plain Response.
type Network = (request: FakeRequest | string) => Response | Promise<Response>;

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html", ...headers } });
const ok = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });

/** Cache Storage keyed by absolute URL, shared by every worker and page of one origin. */
class MemoryCacheStorage {
  readonly stores = new Map<string, Map<string, Response>>();
  network: Network = () => html("shell");

  private keyOf(base: string, key: FakeRequest | string): string {
    return typeof key === "string" ? new URL(key, base).href : key.url;
  }

  /** `base` resolves relative keys, like the worker's or the page's own URL does. */
  view(base: string) {
    return {
      open: (name: string) => {
        let store = this.stores.get(name);
        if (!store) {
          store = new Map<string, Response>();
          this.stores.set(name, store);
        }
        const entries = store;
        return Promise.resolve({
          put: (key: FakeRequest | string, response: Response) => {
            entries.set(this.keyOf(base, key), response);
            return Promise.resolve();
          },
          match: (key: FakeRequest | string) =>
            Promise.resolve(entries.get(this.keyOf(base, key))?.clone()),
          keys: () => Promise.resolve([...entries.keys()].map((url) => ({ url }))),
          delete: (key: FakeRequest | string) =>
            Promise.resolve(entries.delete(this.keyOf(base, key))),
          addAll: (urls: string[]) => {
            for (const url of urls) {
              const response = this.network(url);
              if (!(response instanceof Response)) throw new TypeError("addAll: async network");
              if (!response.ok) return Promise.reject(new TypeError(`addAll: ${response.status}`));
              entries.set(this.keyOf(base, url), response);
            }
            return Promise.resolve();
          },
        });
      },
      keys: () => Promise.resolve([...this.stores.keys()]),
      delete: (name: string) => Promise.resolve(this.stores.delete(name)),
    };
  }

  seed(name: string, urls: string[]) {
    const store = this.stores.get(name) ?? new Map<string, Response>();
    for (const url of urls) store.set(url, ok(`seeded ${url}`));
    this.stores.set(name, store);
  }

  urlsIn(name: string): string[] {
    return [...(this.stores.get(name)?.keys() ?? [])].sort();
  }

  /** Every URL stored in any cache. */
  storedUrls(): string[] {
    return [...this.stores.values()].flatMap((store) => [...store.keys()]);
  }
}

/** Loads the worker for a scope, runs install and activate, and dispatches fetch events. */
async function startWorker(options: { scope?: string; storage?: MemoryCacheStorage } = {}) {
  const scope = options.scope ?? ROOT_SCOPE;
  const storage = options.storage ?? new MemoryCacheStorage();
  const caches = storage.view(new URL("service-worker.js", scope).href);
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    registration: { scope },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  vm.runInNewContext(WORKER_SOURCE, {
    self,
    caches,
    fetch: (request: FakeRequest | string) => {
      try {
        return Promise.resolve(storage.network(request));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new TypeError(String(error)));
      }
    },
    Response,
    Headers,
    URL,
  });

  const lifecycle = async (type: string) => {
    const pending: Array<Promise<unknown>> = [];
    listeners.get(type)?.({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  };
  await lifecycle("install");
  await lifecycle("activate");

  /** One fetch event. `handled` is false when the worker left it to the browser. */
  const request = async (url: string, init: { method?: string; mode?: string } = {}) => {
    let answer: Promise<Response> | undefined;
    const kept: Array<Promise<unknown>> = [];
    listeners.get("fetch")?.({
      request: { url, method: init.method ?? "GET", mode: init.mode ?? "cors" },
      respondWith: (response: Promise<Response>) => {
        answer = response;
      },
      waitUntil: (promise: Promise<unknown>) => kept.push(promise),
    });
    const response = answer ? await answer : undefined;
    // The browser keeps the worker alive only for respondWith and waitUntil promises.
    await Promise.all(kept);
    return { handled: answer !== undefined, response, waitUntilCalls: kept.length };
  };

  return {
    storage,
    cacheName: cacheNameFor(scope),
    request,
    setNetwork: (next: Network) => {
      storage.network = next;
    },
    offline: () => {
      storage.network = () => {
        throw new TypeError("Failed to fetch");
      };
    },
  };
}

describe("service worker caching (#6848)", () => {
  test("stores only the app shell, hashed assets and the shell's public files", async () => {
    const worker = await startWorker();
    worker.setNetwork(() => ok("body", { "Cache-Control": "public, max-age=31536000, immutable" }));
    await worker.request(`${ORIGIN}/${HASHED_JS}`);
    await worker.request(`${ORIGIN}/manifest.json`);
    await worker.request(`${ORIGIN}/notes.json`);
    await worker.request(`${ORIGIN}/workspace/abc`, { mode: "navigate" });

    // A deep route is left to the browser, so it adds no entry; the root shares "./".
    expect(worker.storage.urlsIn(worker.cacheName)).toEqual(
      [
        ROOT_SCOPE,
        `${ORIGIN}/index.html`,
        `${ORIGIN}/${HASHED_JS}`,
        `${ORIGIN}/manifest.json`,
      ].sort()
    );
  });

  test("keeps the worker alive until the cache write ends", async () => {
    const worker = await startWorker();
    worker.setNetwork(() => ok("body"));
    expect((await worker.request(`${ORIGIN}/${HASHED_JS}`)).waitUntilCalls).toBe(1);
    expect(worker.storage.urlsIn(worker.cacheName)).toContain(`${ORIGIN}/${HASHED_JS}`);
  });

  test.each([
    ["an error status", new Response("oops", { status: 500 })],
    ["Cache-Control: no-store", ok("x", { "Cache-Control": "no-store" })],
    ["Cache-Control: private", ok("x", { "Cache-Control": "private, max-age=60" })],
  ])("does not store a hashed asset served with %s", async (_label, response) => {
    const worker = await startWorker();
    worker.setNetwork(() => response.clone());
    await worker.request(`${ORIGIN}/${HASHED_JS}`);
    expect(worker.storage.storedUrls()).not.toContain(`${ORIGIN}/${HASHED_JS}`);
  });

  test.each([
    ["an OAuth start", `${ORIGIN}/auth/mux-gateway/start`, "cors"],
    ["an OAuth callback", `${ORIGIN}/auth/coder/callback?code=c0de&state=st4te`, "navigate"],
    ["an upper-case OAuth callback", `${ORIGIN}/AUTH/coder/callback?code=c0de`, "navigate"],
    ["an oRPC GET", `${ORIGIN}/orpc/workspace/list`, "cors"],
    ["the API docs", `${ORIGIN}/api/docs`, "navigate"],
    ["mixed-case API docs", `${ORIGIN}/Api/docs`, "navigate"],
    ["a token URL", `${ORIGIN}/?token=s3cret`, "navigate"],
    ["a hashed asset with a token", `${ORIGIN}/${HASHED_JS}?token=s3cret`, "cors"],
  ])(
    "leaves %s to the browser: never stored, never served from the cache",
    async (_l, url, mode) => {
      const worker = await startWorker();
      worker.setNetwork(() => html("secret body"));
      const first = await worker.request(url, { mode });
      expect(first.handled).toBe(false);
      expect(worker.storage.storedUrls()).not.toContain(url);
      expect(worker.storage.storedUrls().some((stored) => stored.includes("s3cret"))).toBe(false);
      // The shell was not replaced by the secret page either.
      worker.offline();
      const shell = await worker.request(`${ORIGIN}/`, { mode: "navigate" });
      expect(await shell.response?.text()).toBe("shell");

      // Even an entry an older worker left behind is never answered offline.
      worker.storage.seed(worker.cacheName, [url]);
      expect((await worker.request(url, { mode })).handled).toBe(false);
    }
  );

  test("applies the rules under an app-proxy path prefix", async () => {
    const scope = `${ORIGIN}/@u/ws/apps/mux/`;
    const worker = await startWorker({ scope });
    worker.setNetwork(() => ok("body", { "Cache-Control": "public, max-age=31536000, immutable" }));
    expect((await worker.request(`${scope}api/docs`)).handled).toBe(false);
    await worker.request(`${scope}${HASHED_JS}`);
    expect(worker.storage.urlsIn(cacheNameFor(scope))).toContain(`${scope}${HASHED_JS}`);
    expect(worker.storage.storedUrls()).not.toContain(`${scope}api/docs`);
    // The scope root is the app root: an offline launch there gets the shell.
    worker.offline();
    expect(await (await worker.request(scope, { mode: "navigate" })).response?.text()).toBe(
      "shell"
    );
  });

  test("a no-store navigation refreshes the shell, so offline starts the newest one", async () => {
    const worker = await startWorker(); // installs "shell"
    // The server sends the shell with no-store; the shell is the one exception.
    worker.setNetwork(() => html("shell v2", { "Cache-Control": "no-store" }));
    await worker.request(`${ORIGIN}/`, { mode: "navigate" });
    // An error page must not replace the shell.
    worker.setNetwork(() => new Response("bad gateway", { status: 502 }));
    await worker.request(`${ORIGIN}/`, { mode: "navigate" });

    worker.offline();
    const { response } = await worker.request(`${ORIGIN}/`, { mode: "navigate" });
    expect(await response?.text()).toBe("shell v2");
  });

  test.each([
    [
      "a non-HTML file",
      "manifest.json",
      () => ok('{"name":"xum"}', { "Content-Type": "application/json" }),
    ],
    ["the terminal popout", "terminal.html?workspaceId=w&sessionId=s", () => html("terminal page")],
    ["the desktop popout", "desktop.html?workspaceId=w&instanceId=i", () => html("desktop page")],
    ["an escaped popout name", "terminal%2Ehtml?workspaceId=w", () => html("terminal page")],
    // The server builds the shell per route (relative <base>, root-only redirect and loader).
    ["a deep route", "workspace/abc", () => html("deep-route shell")],
    // Served at /index.html, the root shell's redirect would navigate to /index.html/.
    ["the index file", "index.html", () => html("index page")],
  ])(
    "a navigation to %s is left to the browser and never replaces the shell",
    async (_l, path, reply) => {
      const worker = await startWorker();
      worker.setNetwork(reply);
      expect((await worker.request(`${ORIGIN}/${path}`, { mode: "navigate" })).handled).toBe(false);
      worker.offline();
      expect((await worker.request(`${ORIGIN}/${path}`, { mode: "navigate" })).handled).toBe(false);
      const { response } = await worker.request(`${ORIGIN}/`, { mode: "navigate" });
      expect(await response?.text()).toBe("shell");
    }
  );

  test("a no-store GET that is not a navigation is still not stored", async () => {
    const worker = await startWorker();
    worker.setNetwork(() => html("page", { "Cache-Control": "no-store" }));
    await worker.request(`${ORIGIN}/`, { mode: "cors" });
    worker.offline();
    const { response } = await worker.request(`${ORIGIN}/`, { mode: "navigate" });
    // Still the installed shell, not the no-store fetch() answer.
    expect(await response?.text()).toBe("shell");
  });

  test("serves the app shell offline at the app root, where the installed PWA starts", async () => {
    const worker = await startWorker();
    worker.offline();
    const { handled, response } = await worker.request(`${ORIGIN}/`, { mode: "navigate" });
    expect(handled).toBe(true);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("shell");
  });

  test("passes non-GET requests to the network and never stores them (#5971)", async () => {
    const worker = await startWorker();
    worker.setNetwork(() => ok("rpc result"));
    const { handled, response } = await worker.request(`${ORIGIN}/orpc/workspace/list`, {
      method: "POST",
    });
    expect(handled).toBe(true);
    expect(await response?.text()).toBe("rpc result");
    expect(worker.storage.storedUrls()).not.toContain(`${ORIGIN}/orpc/workspace/list`);
  });

  test("activation drops legacy caches and its own old ones, but not other scopes' or apps'", async () => {
    const storage = new MemoryCacheStorage();
    const otherScope = `${ORIGIN}/@u/other/apps/mux/`;
    storage.seed("mux-v2", [`${ORIGIN}/secret`]);
    storage.seed(`mux-v1:${ROOT_SCOPE}`, [`${ORIGIN}/old`]);
    storage.seed(cacheNameFor(otherScope), [`${otherScope}${HASHED_JS}`]);
    storage.seed("other-app", [`${ORIGIN}/their-file`]);
    await startWorker({ storage });

    expect([...storage.stores.keys()].sort()).toEqual(
      [cacheNameFor(otherScope), cacheNameFor(ROOT_SCOPE), "other-app"].sort()
    );
  });
});

describe("old releases' hashed files are evicted (#6867)", () => {
  const IMMUTABLE = { "Cache-Control": "public, max-age=31536000, immutable" };
  const shellLoading = (...names: string[]) =>
    html(
      `<html><head>${names.map((n) => `<script type="module" src="./${n}"></script>`).join("")}` +
        `<script type="application/json" id="m">["./${names[0]}"]</script></head></html>`
    );
  let shell: () => Response | Promise<Response>;
  const network: Network = (request) => {
    const url = typeof request === "string" ? request : request.url;
    const isShell = url === ROOT_SCOPE || url === "./" || url.endsWith("index.html");
    return isShell ? shell() : ok(`asset ${url}`, IMMUTABLE);
  };
  const hashedIn = (worker: { storage: MemoryCacheStorage; cacheName: string }) =>
    worker.storage
      .urlsIn(worker.cacheName)
      .map((url) => url.slice(ORIGIN.length + 1))
      .filter((name) => /-[A-Za-z0-9_-]{8}\./.test(name));

  /** Installs release 1 and caches its entry chunk, a lazy chunk and the manifest. */
  async function startRelease1() {
    shell = () => shellLoading("main-AAAAAAAA.js", "main-AAAAAAAA.css");
    const storage = new MemoryCacheStorage();
    storage.network = network;
    const worker = await startWorker({ storage });
    for (const name of [
      "main-AAAAAAAA.js",
      "main-AAAAAAAA.css",
      "lazy-BBBBBBBB.js",
      "manifest.json",
    ]) {
      await worker.request(`${ORIGIN}/${name}`);
    }
    return worker;
  }

  test("a new release's shell evicts the hashed files it does not load", async () => {
    const worker = await startRelease1();
    shell = () => shellLoading("main-CCCCCCCC.js");
    await worker.request(ROOT_SCOPE, { mode: "navigate" });
    expect(hashedIn(worker)).toEqual([]);
    // The shell and the public files stay.
    expect(worker.storage.urlsIn(worker.cacheName)).toEqual(
      [ROOT_SCOPE, `${ORIGIN}/index.html`, `${ORIGIN}/manifest.json`].sort()
    );

    await worker.request(`${ORIGIN}/main-CCCCCCCC.js`);
    expect(hashedIn(worker)).toEqual(["main-CCCCCCCC.js"]);
  });

  test("a reload of the same release evicts nothing, lazy chunks included", async () => {
    const worker = await startRelease1();
    await worker.request(ROOT_SCOPE, { mode: "navigate" });
    expect(hashedIn(worker)).toEqual(["lazy-BBBBBBBB.js", "main-AAAAAAAA.css", "main-AAAAAAAA.js"]);
  });

  test("a file stored after the navigation started is kept", async () => {
    const worker = await startRelease1();
    let sendShell = (_response: Response) => undefined as void;
    shell = () => new Promise<Response>((resolve) => (sendShell = resolve));
    const navigation = worker.request(ROOT_SCOPE, { mode: "navigate" });
    // Stored while the new shell is still on its way, so after the eviction's key list was read.
    await worker.request(`${ORIGIN}/lazy-EEEEEEEE.js`);
    sendShell(shellLoading("main-CCCCCCCC.js"));
    await navigation;
    expect(hashedIn(worker)).toEqual(["lazy-EEEEEEEE.js"]);
  });
});

describe("auth token changes clear the service worker caches (#6848)", () => {
  const otherScope = `${ORIGIN}/@u/other/apps/mux/`;
  let storage: MemoryCacheStorage;

  /**
   * A previous session's state: the shell and an asset here, a legacy cache, an older generation
   * of this scope, another scope.
   */
  function seedPreviousSession() {
    storage.seed("mux-v2", [`${ORIGIN}/api/docs`]);
    storage.seed(`mux-v1:${ROOT_SCOPE}`, [`${ORIGIN}/old`]);
    storage.seed(cacheNameFor(ROOT_SCOPE), [
      ROOT_SCOPE,
      `${ORIGIN}/index.html`,
      `${ORIGIN}/${HASHED_JS}`,
    ]);
    storage.seed(cacheNameFor(otherScope), [`${otherScope}${HASHED_JS}`]);
  }

  function expectCleared() {
    expect(storage.stores.has("mux-v2")).toBe(false);
    expect(storage.stores.has(`mux-v1:${ROOT_SCOPE}`)).toBe(false);
    // #6876: the current cache holds only static build output and stays the offline start.
    expect(storage.urlsIn(cacheNameFor(ROOT_SCOPE))).toEqual(
      [ROOT_SCOPE, `${ORIGIN}/index.html`, `${ORIGIN}/${HASHED_JS}`].sort()
    );
    expect(storage.urlsIn(cacheNameFor(otherScope))).toEqual([`${otherScope}${HASHED_JS}`]);
  }

  beforeEach(() => {
    saveDomGlobals();
    const happyWindow = new GlobalWindow({ url: ROOT_SCOPE });
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    storage = new MemoryCacheStorage();
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: storage.view(ROOT_SCOPE),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "caches");
    restoreDomGlobals();
  });

  test("logout keeps this scope's current cache and finishes before its promise settles", async () => {
    seedPreviousSession();
    await clearStoredAuthToken();
    expectCleared();
  });

  test("a new token clears the previous session; the same token again does not", async () => {
    seedPreviousSession();
    await setStoredAuthToken("token-a");
    expectCleared();

    storage.seed("mux-v2", [`${ORIGIN}/api/docs`]);
    await setStoredAuthToken("token-a");
    expect(storage.stores.has("mux-v2")).toBe(true);
  });

  test("after logout the worker still starts offline with the shell and its assets", async () => {
    const worker = await startWorker({ storage });
    worker.setNetwork(() =>
      ok("app code", { "Cache-Control": "public, max-age=31536000, immutable" })
    );
    await worker.request(`${ORIGIN}/${HASHED_JS}`);
    await clearStoredAuthToken();
    worker.offline();
    const { response } = await worker.request(`${ORIGIN}/`, { mode: "navigate" });
    expect(await response?.text()).toBe("shell");
    // #6876: the worker's own cache, whatever its generation, survives the logout.
    expect(await (await worker.request(`${ORIGIN}/${HASHED_JS}`)).response?.text()).toBe(
      "app code"
    );
  });
});
