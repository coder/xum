// public/service-worker.js names its caches "mux-v<N>". Keep this prefix in sync with its
// CACHE_NAME.
const SERVICE_WORKER_CACHE_PREFIX = "mux-";

/**
 * #6848: drop what the service worker cached for the previous session (the app shell and
 * hashed assets today, every GET response before the allow-list). Called when the auth token
 * changes or is removed. Cache Storage exists only in secure contexts, so plain-HTTP pages skip
 * it. Best effort: a failure here must never block login or logout.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(SERVICE_WORKER_CACHE_PREFIX))
        .map((name) => caches.delete(name))
    );
  } catch (error) {
    console.warn("[serviceWorkerCache] Failed to clear service worker caches:", error);
  }
}
