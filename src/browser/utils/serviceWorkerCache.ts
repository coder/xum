// public/service-worker.js names its cache `mux-v<N>:<registration scope>`. Unscoped `mux-v<N>`
// names are legacy (mux-v2 stored every GET response).
const LEGACY_CACHE_NAME = /^mux-v\d+$/;

/**
 * #6848: drop what the service worker cached for the previous session: the legacy unscoped caches
 * (mux-v2 stored every GET response, auth answers included). #6876: this scope's own caches stay
 * whole. Their worker admits only the shell, hashed build files and the shell's public files,
 * none of which hold session data, so the offline start keeps its assets and the cleanup no longer
 * walks the cache entry by entry. The worker's activate step drops its own older generations, so
 * the page never decides which generation is current: a tab still on an older bundle would
 * otherwise delete a newer worker's cache. Cache Storage exists only in secure contexts, so
 * plain-HTTP pages skip it. Never rejects: a failure must not block login or logout.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => LEGACY_CACHE_NAME.test(name)).map((name) => caches.delete(name))
    );
  } catch (error) {
    console.warn("[serviceWorkerCache] Failed to clear service worker caches:", error);
  }
}
