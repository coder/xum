import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

// The worker caches GET responses. The static workspace view reads transcript text with a POST
// (workspace.history.tail, T3 #5971), which must never land in Cache Storage.
const workerPath = path.join(__dirname, "../../public/service-worker.js");

async function dispatchFetch(method: string) {
  const source = await fs.readFile(workerPath, "utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const put = mock(() => Promise.resolve());
  const caches = { open: mock(() => Promise.resolve({ put })), match: mock(), keys: mock() };
  const fetch = mock(() => Promise.resolve(new Response("transcript text")));
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
  };
  vm.runInNewContext(source, { self, caches, fetch, Response, Headers });
  let responded: Promise<Response> | undefined;
  const request = { method, url: "http://127.0.0.1/api/workspace/history/tail" };
  listeners.get("fetch")!({ request, respondWith: (p: Promise<Response>) => (responded = p) });
  expect(await (await responded!).text()).toBe("transcript text");
  // Let the worker's detached caches.open(...).then(cache.put) chain run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { open: caches.open, put };
}

describe("service worker", () => {
  test("a POST response never reaches Cache Storage", async () => {
    const { open, put } = await dispatchFetch("POST");
    expect(open).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  test("a GET response is cached (the harness sees cache writes)", async () => {
    expect((await dispatchFetch("GET")).put).toHaveBeenCalledTimes(1);
  });
});
