// mux Service Worker for PWA support
//
// #6848: the worker caches only an allow-list (the app shell, Vite's content-hashed assets and
// the shell's own public files),
// only cacheable responses, and never auth flows, API/oRPC routes or token-bearing URLs. It
// answers only GET requests and never caches the authenticated non-GET traffic (#5971 relies
// on that). When the auth token changes or is removed, the app deletes the legacy caches and
// this scope's other generations, and keeps this one (src/browser/utils/serviceWorkerCache.ts):
// keep the "mux-v" prefix, and bump CURRENT_CACHE_GENERATION there together with CACHE_NAME.
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
 * The shell is the one exception to Cache-Control: the server sends it with no-store, but it
 * holds no session or workspace data (base href, first-run view, module list, font preload, the
 * deployment's proxy URI template). A 200 root navigation refreshes the cached copy, so an offline
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

// #6867: hashed file names in the shell HTML: module scripts, stylesheets, preloads and the
// first-run module list. Lazy chunks and CSS-only fonts are not listed there.
const HASHED_NAME_IN_HTML = /[^\s"'<>/()=]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+(?:\.[a-z0-9]+)*/g;

function referencedAssets(html) {
  return new Set(html.match(HASHED_NAME_IN_HTML) || []);
}

/**
 * #6867: Vite gives every release new hashed names, and nothing else evicts the old ones. When a
 * refreshed shell loads other hashed files than the cached one (a new release), drop every hashed
 * file that was cached before this navigation and that the new shell does not load. The cache then
 * holds about one release. A lazy chunk or font of the new release that was cached earlier goes too;
 * the app fetches it again on next use. Within one release the shell's file list does not change,
 * so a normal reload evicts nothing. `before` is the key list read when the navigation started:
 * the new page's own files are stored only after it has the response, so none of them are in it.
 */
function storeShell(cache, response, before) {
  const copy = response.clone();
  // The shell write never depends on the eviction: a failed read only skips the eviction.
  return cache
    .match(SHELL_PATH)
    .then((cached) => (cached ? cached.text() : null))
    .catch(() => null)
    .then((cachedHtml) =>
      cache
        .put(SHELL_PATH, response)
        .then(() => evictOldRelease(cache, copy, cachedHtml, before).catch(() => undefined))
    );
}

function evictOldRelease(cache, response, cachedHtml, before) {
  return Promise.all([response.text(), before]).then(([html, requests]) => {
    const next = referencedAssets(html);
    // A 200 HTML page that loads no hashed file (a proxy's sign-in page) is not a release.
    if (cachedHtml === null || next.size === 0) return undefined;
    const previous = referencedAssets(cachedHtml);
    if (previous.size === next.size && [...next].every((name) => previous.has(name)))
      return undefined;
    const stale = requests.filter((request) => {
      const path = scopedPath(new URL(request.url));
      return path !== null && HASHED_STATIC_ASSET_NAME.test(path) && !next.has(path);
    });
    return Promise.all(stale.map((request) => cache.delete(request)));
  });
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
 * `isCacheable` decides what may be stored, and `write` stores it. The write runs under
 * `event.waitUntil`, so the browser keeps the worker alive until it ends.
 */
function networkFirst(
  event,
  cacheKey,
  isCacheable,
  write = (cache, response) => cache.put(cacheKey, response)
) {
  return fetch(event.request)
    .then((response) => {
      if (isCacheable(response)) {
        const responseToCache = response.clone();
        event.waitUntil(
          caches
            .open(CACHE_NAME)
            .then((cache) => write(cache, responseToCache))
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
    // Only the app root, where the installed PWA starts (manifest start_url "."). The server builds
    // the shell for the route it answers: a route-relative <base>, and at the root a redirect and
    // a first-run loader that needs it. So the cached root copy is correct only at the root.
    // Every other navigation (deep routes, popout pages, files) goes to the network untouched.
    if (path === "") {
      // Read before the response reaches the page (see storeShell). Not awaited: off the load path.
      const before = caches
        .open(CACHE_NAME)
        .then((cache) => cache.keys())
        .catch(() => []);
      event.respondWith(
        networkFirst(event, SHELL_PATH, isShellResponse, (cache, response) =>
          storeShell(cache, response, before)
        )
      );
    }
    return;
  }

  if (HASHED_STATIC_ASSET_NAME.test(path) || SHELL_PUBLIC_FILES.has(path)) {
    event.respondWith(networkFirst(event, event.request, isCacheableResponse));
  }
});
