import { resolveBrowserAssetUrl } from "@/browser/utils/frontendBasePath";

// public/service-worker.js names its cache `mux-v<N>:<registration scope>`. Unscoped `mux-v<N>`
// names are legacy (mux-v2 stored every GET response). Keep both in sync with CACHE_NAME there.
const LEGACY_CACHE_NAME = /^mux-v\d+$/;
const CURRENT_CACHE_GENERATION = "mux-v3";

/** The scope main.tsx registers the worker with: the folder of service-worker.js. */
function getServiceWorkerScope(): string {
  return new URL(".", new URL(resolveBrowserAssetUrl("service-worker.js"), window.location.href))
    .href;
}

/**
 * #6848: drop what the service worker cached for the previous session. Deletes the legacy caches
 * and this scope's caches of other generations. #6876: this scope's current cache stays whole. Its
 * worker admits only the shell, hashed build files and the shell's public files, none of which
 * hold session data, so the offline start keeps its assets, and the cleanup no longer walks the
 * cache entry by entry. Other scopes' caches stay. Cache Storage exists only in secure contexts,
 * so plain-HTTP pages skip it. Never rejects: a failure must not block login or logout.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const scope = getServiceWorkerScope();
    const current = `${CURRENT_CACHE_GENERATION}:${scope}`;
    const names = await caches.keys();
    const otherGeneration = (name: string) =>
      name !== current && name.startsWith("mux-v") && name.endsWith(`:${scope}`);
    await Promise.all(
      names
        .filter((name) => LEGACY_CACHE_NAME.test(name) || otherGeneration(name))
        .map((name) => caches.delete(name))
    );
  } catch (error) {
    console.warn("[serviceWorkerCache] Failed to clear service worker caches:", error);
  }
}
