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
import { stampServiceWorker, type ServiceWorkerStamp } from "../../scripts/stamp-service-worker";
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
// An unstamped worker (the Vite dev server) uses the "dev" build id.
const cacheNameFor = (scope: string, build = "dev") => `mux-v4-${build}:${scope}`;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

type Network = (request: FakeRequest | string) => Response;

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html", ...headers } });
const ok = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });

/** Cache Storage keyed by absolute URL, shared by every worker and page of one origin. */
class MemoryCacheStorage {
  readonly stores = new Map<string, Map<string, Response>>();
  network: Network = () => html("shell");
  /** Every worker fetch with its init, e.g. the precache priority. */
  readonly fetchLog: Array<{ url: string; init?: RequestInit }> = [];

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
async function startWorker(
  options: { scope?: string; storage?: MemoryCacheStorage; stamp?: ServiceWorkerStamp } = {}
) {
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
  const source = options.stamp ? stampServiceWorker(WORKER_SOURCE, options.stamp) : WORKER_SOURCE;
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: (request: FakeRequest | string, init?: RequestInit) => {
      storage.fetchLog.push({ url: typeof request === "string" ? request : request.url, init });
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
  // As in a browser: a failed install never activates, and the previous worker stays.
  const installed = await lifecycle("install").then(
    () => true,
    () => false
  );
  if (installed) await lifecycle("activate");

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
    installed,
    storage,
    cacheName: cacheNameFor(scope, options.stamp?.buildId),
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
      [ROOT_SCOPE, `${ORIGIN}/${HASHED_JS}`, `${ORIGIN}/manifest.json`].sort()
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
    // #6867: the fixed-name cache of the previous design, with every release's files in it.
    storage.seed(`mux-v3:${ROOT_SCOPE}`, [`${ORIGIN}/main-OldRel01.js`]);
    storage.seed(cacheNameFor(otherScope), [`${otherScope}${HASHED_JS}`]);
    storage.seed("other-app", [`${ORIGIN}/their-file`]);
    await startWorker({ storage });

    expect([...storage.stores.keys()].sort()).toEqual(
      [cacheNameFor(otherScope), cacheNameFor(ROOT_SCOPE), "other-app"].sort()
    );
  });
});

describe("one cache per build (#6867)", () => {
  const IMMUTABLE = { "Cache-Control": "public, max-age=31536000, immutable" };
  const CSS = "main-AbCd1234.css";
  const stampFor = (buildId: string, precache = [HASHED_JS, CSS]): ServiceWorkerStamp => ({
    buildId,
    entryFile: HASHED_JS,
    precache,
  });
  const shellPage = () =>
    html(`<html><head><script type="module" src="./${HASHED_JS}"></script></head></html>`);
  /** The shell at "./", the build's files elsewhere. */
  const release: Network = (request) => {
    const url = typeof request === "string" ? new URL(request, ROOT_SCOPE).href : request.url;
    return url === ROOT_SCOPE ? shellPage() : ok(`file ${url}`, IMMUTABLE);
  };
  const withNetwork = (network: Network) => {
    const storage = new MemoryCacheStorage();
    storage.network = network;
    return storage;
  };

  test("a new build's worker drops the previous build's cache and its hashed files", async () => {
    const storage = withNetwork(release);
    const buildA = await startWorker({ storage, stamp: stampFor("aaaaaaaaaaaa", []) });
    await buildA.request(`${ORIGIN}/lazy-OldRel01.js`);
    expect(storage.storedUrls()).toContain(`${ORIGIN}/lazy-OldRel01.js`);

    const buildB = await startWorker({ storage, stamp: stampFor("bbbbbbbbbbbb", []) });
    expect([...storage.stores.keys()]).toEqual([buildB.cacheName]);
    expect(storage.storedUrls()).not.toContain(`${ORIGIN}/lazy-OldRel01.js`);
  });

  test("install stores the shell and precaches the first-load files at low priority", async () => {
    const storage = withNetwork(release);
    const worker = await startWorker({ storage, stamp: stampFor("bbbbbbbbbbbb") });
    expect(storage.urlsIn(worker.cacheName)).toEqual(
      [ROOT_SCOPE, `${ORIGIN}/${HASHED_JS}`, `${ORIGIN}/${CSS}`].sort()
    );
    const priorities = storage.fetchLog.map((entry) => [entry.url, entry.init?.priority]);
    expect(priorities).toContainEqual([HASHED_JS, "low"]);
    expect(priorities).toContainEqual([CSS, "low"]);

    // Offline, the next start has the shell and its entry files.
    worker.offline();
    expect((await worker.request(ROOT_SCOPE, { mode: "navigate" })).response?.status).toBe(200);
    expect(await (await worker.request(`${ORIGIN}/${HASHED_JS}`)).response?.text()).toContain(
      "file"
    );
  });

  test("install still activates when a precache fetch fails", async () => {
    const storage = withNetwork((request) => {
      if (request === CSS) throw new TypeError("Failed to fetch");
      return release(request);
    });
    storage.seed(`mux-v3:${ROOT_SCOPE}`, [`${ORIGIN}/main-OldRel01.js`]);
    const worker = await startWorker({ storage, stamp: stampFor("bbbbbbbbbbbb") });
    // Activate ran: the old cache is gone.
    expect([...storage.stores.keys()]).toEqual([worker.cacheName]);
    expect(storage.urlsIn(worker.cacheName)).toEqual([ROOT_SCOPE, `${ORIGIN}/${HASHED_JS}`].sort());
  });

  const redirectedShell = () => {
    const response = shellPage();
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  const failing = () => {
    throw new TypeError("Failed to fetch");
  };
  test.each([
    // A proxy's sign-in page answers "./" with a 200 HTML page (the #6929 case).
    ["a 200 sign-in page at ./", "./", () => html("<html><body>Sign in</body></html>")],
    ["a redirected shell", "./", redirectedShell],
    ["an error page at ./", "./", () => new Response("bad gateway", { status: 502 })],
    ["an unreachable shell", "./", failing],
    // A rolling deploy: another replica does not have this build's entry file yet.
    ["a missing entry file", HASHED_JS, () => new Response("not found", { status: 404 })],
  ])("install fails on %s and keeps the previous build's cache", async (_l, failingPath, reply) => {
    const storage = withNetwork((request) =>
      request === failingPath ? reply() : release(request)
    );
    storage.seed(`mux-v3:${ROOT_SCOPE}`, [ROOT_SCOPE, `${ORIGIN}/main-OldRel01.js`]);
    const worker = await startWorker({ storage, stamp: stampFor("bbbbbbbbbbbb") });
    expect(worker.installed).toBe(false);
    // The partial cache is gone, and the previous build still starts offline.
    expect([...storage.stores.keys()]).toEqual([`mux-v3:${ROOT_SCOPE}`]);
  });
});

describe("auth token changes clear the service worker caches (#6848)", () => {
  const otherScope = `${ORIGIN}/@u/other/apps/mux/`;
  let storage: MemoryCacheStorage;

  /**
   * A previous session's state: the shell and an asset here, a legacy cache, another scope, and
   * a newer generation of this scope (a worker that updated while this tab runs an older bundle).
   */
  function seedPreviousSession() {
    storage.seed("mux-v2", [`${ORIGIN}/api/docs`]);
    storage.seed(`mux-v4:${ROOT_SCOPE}`, [`${ORIGIN}/main-NewerGen.js`]);
    storage.seed(cacheNameFor(ROOT_SCOPE), [
      ROOT_SCOPE,
      `${ORIGIN}/index.html`,
      `${ORIGIN}/${HASHED_JS}`,
    ]);
    storage.seed(cacheNameFor(otherScope), [`${otherScope}${HASHED_JS}`]);
  }

  function expectCleared() {
    expect(storage.stores.has("mux-v2")).toBe(false);
    // #6876: this scope's caches hold only static build output and stay the offline start.
    expect(storage.urlsIn(cacheNameFor(ROOT_SCOPE))).toEqual(
      [ROOT_SCOPE, `${ORIGIN}/index.html`, `${ORIGIN}/${HASHED_JS}`].sort()
    );
    expect(storage.urlsIn(`mux-v4:${ROOT_SCOPE}`)).toEqual([`${ORIGIN}/main-NewerGen.js`]);
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

  test("logout keeps this scope's caches and finishes before its promise settles", async () => {
    seedPreviousSession();
    // #6867: the cleanup must not grow with the cache, so it never opens a cache to walk it.
    const view = storage.view(ROOT_SCOPE);
    let opened = 0;
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { ...view, open: (name: string) => (opened++, view.open(name)) },
    });
    await clearStoredAuthToken();
    expectCleared();
    expect(opened).toBe(0);
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
    // #6876: the asset survives the logout, whatever the worker's cache generation is.
    expect(await (await worker.request(`${ORIGIN}/${HASHED_JS}`)).response?.text()).toBe(
      "app code"
    );
  });
});
