// mux Service Worker for PWA support
//
// #6848: the worker caches only an allow-list (the app shell, Vite's content-hashed assets and
// the shell's own public files),
// only cacheable responses, and never auth flows, API/oRPC routes or token-bearing URLs. It
// answers only GET requests and never caches the authenticated non-GET traffic (#5971 relies
// on that). When the auth token changes or is removed, the app deletes the other "mux-" caches
// and every entry of this one except the shell (src/browser/utils/serviceWorkerCache.ts), so
// keep that prefix and the SHELL_PATH key.
// One cache per registration scope: app-proxy deployments run several workers on one origin, and
// Cache Storage is origin-wide. Older generations of this scope and the unscoped legacy caches
// ("mux-v2" stored every GET response) are dropped on activate.
const CACHE_NAME = `mux-v3:${self.registration.scope}`;
const LEGACY_CACHE_NAME = /^mux-v\d+$/;
const SHELL_PATH = "./";
const urlsToCache = [SHELL_PATH, "./index.html"];

// Same rule as isHashedStaticAssetName (src/node/orpc/staticAssets.ts): one path segment named
// `<name>-<8 char base64url hash>.<ext>`. Such files never change content.
const HASHED_STATIC_ASSET_NAME = /^[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9.]+$/;
// The unhashed public files the shell itself loads (index.html, public/manifest.json and the
// theme favicons in ThemeContext.tsx). Static build output: no session data.
const SHELL_PUBLIC_FILES = new Set([
  "manifest.json",
  "favicon.ico",
  "favicon-dark.ico",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
]);
// Never cached and never served from the cache: OAuth starts and callbacks (they carry code and
// state), the REST and oRPC surfaces, and anything with an auth token in the URL.
const UNCACHEABLE_PREFIXES = ["auth/", "orpc/", "api/"];

/** The request path relative to this worker's scope, or null outside it. */
function scopedPath(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  return url.pathname.slice(scope.pathname.length);
}

function isUncacheable(url, path) {
  if (url.searchParams.has("token")) return true;
  // Express matches routes case-insensitively, so /AUTH/... reaches the auth routes too.
  const lowerPath = path.toLowerCase();
  return UNCACHEABLE_PREFIXES.some(
    (prefix) => lowerPath.startsWith(prefix) || `${lowerPath}/` === prefix
  );
}

/**
 * True when the server answers this navigation with the SPA shell. Mirrors the SPA fallback rule
 * in src/node/orpc/server.ts: index.html, `workspace/<id>` (legacy IDs can contain dots), or a
 * path with no file extension and no dot segment. Other HTML build entries (terminal.html and
 * desktop.html popouts) must never replace the shell, or an offline launch opens a popout.
 */
function isSpaRoute(path) {
  if (path === "index.html" || /^workspace\/[^/]+$/.test(path)) return true;
  // serve-static decodes percent escapes before its lookup (terminal%2Ehtml is terminal.html).
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Not decodable: classify the raw path, as the server does.
  }
  const lastSegment = decoded.slice(decoded.lastIndexOf("/") + 1);
  return !`/${decoded}`.includes("/.") && !lastSegment.includes(".");
}

/**
 * The shell is the one exception to Cache-Control: the server sends it with no-store, but it
 * holds no session or workspace data (base href, first-run view, module list, font preload, the
 * deployment's proxy URI template). A 200 navigation refreshes the cached copy, so an offline
 * launch starts the newest frontend, not the one from the first install.
 */
function isShellResponse(response) {
  // A navigation can also open manifest.json, an icon or a script: only HTML may become the shell.
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  return (
    response.status === 200 && response.type !== "opaque" && contentType.startsWith("text/html")
  );
}

/** Only a successful response that the server allows any cache to keep. */
function isCacheableResponse(response) {
  if (!response.ok || response.type === "opaque") return false;
  const cacheControl = (response.headers.get("Cache-Control") || "").toLowerCase();
  return !/(^|[\s,])(no-store|private)([\s,=]|$)/.test(cacheControl);
}

function offlineResponse() {
  return new Response("Network error and no cached version available", {
    status: 503,
    statusText: "Service Unavailable",
    headers: new Headers({ "Content-Type": "text/plain" }),
  });
}

/**
 * Network first: store a cacheable answer under `cacheKey`, else answer from this cache.
 * `isCacheable` decides what may be stored. The write runs under `event.waitUntil`, so the
 * browser keeps the worker alive until it ends.
 */
function networkFirst(event, cacheKey, isCacheable) {
  return fetch(event.request)
    .then((response) => {
      if (isCacheable(response)) {
        const responseToCache = response.clone();
        event.waitUntil(
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(cacheKey, responseToCache))
            .catch(() => undefined)
        );
      }
      return response;
    })
    .catch(() =>
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(cacheKey))
        .then((cachedResponse) => cachedResponse || offlineResponse())
    );
}

// Install event - cache the app shell. The server sends it with no-store, so this is the only
// copy the offline shell gets; a new worker version refreshes it.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Activate event - drop this scope's older caches and the legacy unscoped ones (#6848)
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            const ownGeneration =
              cacheName.startsWith("mux-v") && cacheName.endsWith(`:${self.registration.scope}`);
            if (cacheName !== CACHE_NAME && (ownGeneration || LEGACY_CACHE_NAME.test(cacheName))) {
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - network first, cache only the allow-list
self.addEventListener("fetch", (event) => {
  // Skip caching for non-GET requests (POST, PUT, DELETE, etc.)
  // The Cache API only supports GET requests
  if (event.request.method !== "GET") {
    event.respondWith(fetch(event.request));
    return;
  }

  const url = new URL(event.request.url);
  const path = scopedPath(url);
  // Outside the scope, cross-origin, or an uncacheable route: the browser handles it as if no
  // worker existed, so nothing is stored and nothing is answered from the cache.
  if (path === null || isUncacheable(url, path)) return;

  if (event.request.mode === "navigate") {
    // Every client route loads the same shell; one entry, never keyed by the visited URL.
    // Other navigations (popout pages, files) go to the network untouched.
    if (isSpaRoute(path)) event.respondWith(networkFirst(event, SHELL_PATH, isShellResponse));
    return;
  }

  if (HASHED_STATIC_ASSET_NAME.test(path) || SHELL_PUBLIC_FILES.has(path)) {
    event.respondWith(networkFirst(event, event.request, isCacheableResponse));
  }
});
