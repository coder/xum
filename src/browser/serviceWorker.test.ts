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
const HASHED_JS = "main-AbCd1234.js";

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

type Network = (request: FakeRequest | string) => Response;

/** Cache Storage keyed by absolute URL, like the real one for these requests. */
class MemoryCacheStorage {
  readonly stores = new Map<string, Map<string, Response>>();

  constructor(
    private readonly baseUrl: string,
    private readonly network: () => Network
  ) {}

  private keyOf(key: FakeRequest | string): string {
    return typeof key === "string" ? new URL(key, this.baseUrl).href : key.url;
  }

  open(name: string) {
    let store = this.stores.get(name);
    if (!store) this.stores.set(name, (store = new Map()));
    const entries = store;
    return Promise.resolve({
      put: (key: FakeRequest | string, response: Response) => {
        entries.set(this.keyOf(key), response);
        return Promise.resolve();
      },
      match: (key: FakeRequest | string) => Promise.resolve(entries.get(this.keyOf(key))?.clone()),
      addAll: (urls: string[]) => {
        for (const url of urls) {
          const response = this.network()(url);
          if (!response.ok) return Promise.reject(new TypeError(`addAll: ${response.status}`));
          entries.set(this.keyOf(url), response);
        }
        return Promise.resolve();
      },
    });
  }

  keys() {
    return Promise.resolve([...this.stores.keys()]);
  }

  delete(name: string) {
    return Promise.resolve(this.stores.delete(name));
  }

  match(key: FakeRequest | string) {
    for (const store of this.stores.values()) {
      const hit = store.get(this.keyOf(key));
      if (hit) return Promise.resolve(hit.clone());
    }
    return Promise.resolve(undefined);
  }

  /** Every URL stored in any cache. */
  storedUrls(): string[] {
    return [...this.stores.values()].flatMap((store) => [...store.keys()]);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Loads the worker for a scope, runs install and activate, and dispatches fetch events. */
async function startWorker(options: { scope?: string; existingCaches?: string[] } = {}) {
  const scope = options.scope ?? `${ORIGIN}/`;
  let network: Network = () => new Response("shell", { status: 200 });
  const caches = new MemoryCacheStorage(new URL("service-worker.js", scope).href, () => network);
  for (const name of options.existingCaches ?? []) {
    const store = await caches.open(name);
    await store.put(`${scope}secret`, new Response("old entry"));
  }
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
        return Promise.resolve(network(request));
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
    listeners.get("fetch")?.({
      request: { url, method: init.method ?? "GET", mode: init.mode ?? "cors" },
      respondWith: (response: Promise<Response>) => {
        answer = response;
      },
    });
    const response = answer ? await answer : undefined;
    await flush(); // the worker stores responses without awaiting them
    return { handled: answer !== undefined, response };
  };

  return {
    caches,
    request,
    setNetwork: (next: Network) => {
      network = next;
    },
    offline: () => {
      network = () => {
        throw new TypeError("Failed to fetch");
      };
    },
  };
}

const ok = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });

describe("service worker caching (#6848)", () => {
  test("stores only the app shell and hashed assets", async () => {
    const worker = await startWorker();
    worker.setNetwork(() => ok("body", { "Cache-Control": "public, max-age=31536000, immutable" }));
    await worker.request(`${ORIGIN}/${HASHED_JS}`);
    await worker.request(`${ORIGIN}/manifest.json`);
    await worker.request(`${ORIGIN}/notes.json`);
    await worker.request(`${ORIGIN}/workspace/abc`, { mode: "navigate" });

    // The visited route is not a key: every route shares the "./" shell entry.
    expect(worker.caches.storedUrls().sort()).toEqual(
      [
        `${ORIGIN}/`,
        `${ORIGIN}/index.html`,
        `${ORIGIN}/${HASHED_JS}`,
        `${ORIGIN}/manifest.json`,
      ].sort()
    );
  });

  test.each([
    ["an error status", new Response("oops", { status: 500 })],
    ["Cache-Control: no-store", ok("x", { "Cache-Control": "no-store" })],
    ["Cache-Control: private", ok("x", { "Cache-Control": "private, max-age=60" })],
  ])("does not store a hashed asset served with %s", async (_label, response) => {
    const worker = await startWorker();
    worker.setNetwork(() => response.clone());
    await worker.request(`${ORIGIN}/${HASHED_JS}`);
    expect(worker.caches.storedUrls()).not.toContain(`${ORIGIN}/${HASHED_JS}`);
  });

  test.each([
    ["an OAuth start", `${ORIGIN}/auth/mux-gateway/start`, "cors"],
    ["an OAuth callback", `${ORIGIN}/auth/coder/callback?code=c0de&state=st4te`, "navigate"],
    ["an oRPC GET", `${ORIGIN}/orpc/workspace/list`, "cors"],
    ["the API docs", `${ORIGIN}/api/docs`, "navigate"],
    ["a token URL", `${ORIGIN}/?token=s3cret`, "navigate"],
    ["a hashed asset with a token", `${ORIGIN}/${HASHED_JS}?token=s3cret`, "cors"],
  ])(
    "leaves %s to the browser: never stored, never served from the cache",
    async (_l, url, mode) => {
      const worker = await startWorker();
      worker.setNetwork(() => ok("secret body"));
      expect(await worker.request(url, { mode })).toEqual({ handled: false, response: undefined });
      expect(worker.caches.storedUrls()).not.toContain(url);
      expect(worker.caches.storedUrls().some((stored) => stored.includes("s3cret"))).toBe(false);

      // Even an entry an older worker left behind is never answered offline.
      const store = await worker.caches.open("mux-v3");
      await store.put({ url, method: "GET", mode }, ok("stale secret"));
      worker.offline();
      expect((await worker.request(url, { mode })).handled).toBe(false);
    }
  );

  test("applies the rules under an app-proxy path prefix", async () => {
    const scope = `${ORIGIN}/@u/ws/apps/mux/`;
    const worker = await startWorker({ scope });
    worker.setNetwork(() => ok("body", { "Cache-Control": "public, max-age=31536000, immutable" }));
    expect((await worker.request(`${scope}api/docs`)).handled).toBe(false);
    await worker.request(`${scope}${HASHED_JS}`);
    expect(worker.caches.storedUrls()).toContain(`${scope}${HASHED_JS}`);
    expect(worker.caches.storedUrls()).not.toContain(`${scope}api/docs`);
  });

  test("serves the app shell offline for every client route", async () => {
    const worker = await startWorker();
    worker.offline();
    const { handled, response } = await worker.request(`${ORIGIN}/settings/providers`, {
      mode: "navigate",
    });
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
    expect(worker.caches.storedUrls()).not.toContain(`${ORIGIN}/orpc/workspace/list`);
  });

  test("activation drops the mux-v2 cache, which stored every GET response", async () => {
    const worker = await startWorker({ existingCaches: ["mux-v2"] });
    expect(await worker.caches.keys()).not.toContain("mux-v2");
    expect(worker.caches.storedUrls()).not.toContain(`${ORIGIN}/secret`);
  });
});

describe("auth token changes clear the service worker caches (#6848)", () => {
  let deleted: string[];

  beforeEach(() => {
    saveDomGlobals();
    const happyWindow = new GlobalWindow({ url: `${ORIGIN}/` });
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    deleted = [];
    const names = ["mux-v2", "mux-v3", "other-app"];
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        keys: () => Promise.resolve(names.filter((name) => !deleted.includes(name))),
        delete: (name: string) => {
          deleted.push(name);
          return Promise.resolve(true);
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "caches");
    restoreDomGlobals();
  });

  test("logout deletes every mux cache and nothing else", async () => {
    clearStoredAuthToken();
    await flush();
    expect(deleted.sort()).toEqual(["mux-v2", "mux-v3"]);
  });

  test("a new token deletes the mux caches; the same token again does not", async () => {
    setStoredAuthToken("token-a");
    await flush();
    expect(deleted.sort()).toEqual(["mux-v2", "mux-v3"]);

    deleted = [];
    setStoredAuthToken("token-a");
    await flush();
    expect(deleted).toEqual([]);
  });
});
