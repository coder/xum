import { resolveBrowserAssetUrl } from "@/browser/utils/frontendBasePath";

// public/service-worker.js names its cache `mux-v<N>:<registration scope>`. Unscoped `mux-v<N>`
// names are legacy (mux-v2 stored every GET response). Keep both in sync with CACHE_NAME there.
const LEGACY_CACHE_NAME = /^mux-v\d+$/;

/** The scope main.tsx registers the worker with: the folder of service-worker.js. */
function getServiceWorkerScope(): string {
  return new URL(".", new URL(resolveBrowserAssetUrl("service-worker.js"), window.location.href))
    .href;
}

/**
 * #6848: drop what the service worker cached for the previous session. Deletes the legacy caches
 * and every entry of this scope's cache except the shell, which holds no session data and is the
 * offline start. Other scopes' caches stay. Cache Storage exists only in secure contexts, so
 * plain-HTTP pages skip it. Never rejects: a failure must not block login or logout.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const scope = getServiceWorkerScope();
    const shellUrls = new Set([scope, new URL("index.html", scope).href]);
    const names = await caches.keys();
    await Promise.all(
      names.map(async (name) => {
        if (LEGACY_CACHE_NAME.test(name)) {
          await caches.delete(name);
        } else if (name.startsWith("mux-v") && name.endsWith(`:${scope}`)) {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          await Promise.all(
            requests.filter((r) => !shellUrls.has(r.url)).map((r) => cache.delete(r))
          );
        }
      })
    );
  } catch (error) {
    console.warn("[serviceWorkerCache] Failed to clear service worker caches:", error);
  }
}
