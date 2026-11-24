// mux Service Worker for PWA support
//
// #6848: the worker caches only an allow-list (the app shell, Vite's content-hashed assets and
// the shell's own public files),
// only cacheable responses, and never auth flows, API/oRPC routes or token-bearing URLs. It
// answers only GET requests and never caches the authenticated non-GET traffic (#5971 relies
// on that). When the auth token changes or is removed, the app deletes the legacy unscoped
// "mux-v<N>" caches and keeps this scope's (src/browser/utils/serviceWorkerCache.ts), so keep
// the scoped "mux-v...:<scope>" name.
// One cache per registration scope and build: app-proxy deployments run several workers on one
// origin, and Cache Storage is origin-wide. #6867: scripts/stamp-service-worker.ts writes the
// build's values into the three lines below, so each release ships a byte-different worker. The
// browser's update check installs it, and activate drops every other cache of this scope (older
// builds and their hashed files) and the unscoped legacy caches ("mux-v2" stored every GET
// response). Unstamped (the Vite dev server), the values below keep one "dev" cache.
const BUILD_ID = "dev";
const ENTRY_FILE = "";
const PRECACHE = [];
const CACHE_NAME = `mux-v4-${BUILD_ID}:${self.registration.scope}`;
const LEGACY_CACHE_NAME = /^mux-v\d+$/;
const SHELL_PATH = "./";

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
 * browser keeps the worker alive until it ends. The optional `verify` runs only inside that
 * write, on the stored copy: the page gets the network response without waiting for it.
 */
function networkFirst(event, cacheKey, isCacheable, verify) {
  return fetch(event.request)
    .then((response) => {
      if (isCacheable(response)) {
        const responseToCache = response.clone();
        event.waitUntil(
          (verify ? verify(responseToCache) : Promise.resolve(true))
            .then(
              (verified) =>
                verified &&
                caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, responseToCache))
            )
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

/**
 * True when the HTML loads this build's entry file. It reads a clone, so `response` stays usable.
 * #6991: a root navigation stores the shell only then. During a rolling deploy it can reach a
 * replica of another build, whose shell does not match this worker's precached files.
 */
function loadsThisBuild(response) {
  if (ENTRY_FILE === "") return Promise.resolve(true);
  return response
    .clone()
    .text()
    .then((html) => html.includes(ENTRY_FILE));
}

/**
 * Install accepts the shell by the fetch handler's rule, and also only when it is not a redirect
 * and loads this build's entry file: a proxy's 200 sign-in page at "./" is not the shell.
 */
function isInstallShell(response) {
  if (!isShellResponse(response) || response.redirected) return Promise.resolve(false);
  return loadsThisBuild(response);
}

function precacheFile(cache, name) {
  // Low priority, so the live page's requests go first. HTTP cache hits are used.
  return fetch(name, { priority: "low" }).then((response) => {
    if (!isCacheableResponse(response)) throw new Error(`precache ${name}: ${response.status}`);
    return cache.put(name, response);
  });
}

// Install event - cache the app shell and this build's first-load files (#6867). The server sends
// the shell with no-store, so a root navigation refreshes it later. The shell and every module of
// the first-load graph are required: activate deletes the previous build's cache, so without them
// the next offline start would fail. Then the install fails, drops its partial cache, and the
// previous worker stays in control until the next update check. The stylesheet and the font may
// fail on their own.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        const shell = fetch(SHELL_PATH).then((response) =>
          isInstallShell(response).then((accepted) => {
            if (!accepted) throw new Error("install: ./ is not this build's shell");
            return cache.put(SHELL_PATH, response);
          })
        );
        // #6991: the entry is required by name. The stamp script lists it in PRECACHE, so the Set
        // adds no request on a real build.
        const names = ENTRY_FILE === "" ? PRECACHE : [...new Set([ENTRY_FILE, ...PRECACHE])];
        const files = names.map((name) => precacheFile(cache, name));
        // Every module of the static first-load graph is required (the entry imports them).
        const required = [
          shell,
          ...files.filter((_, i) => names[i] === ENTRY_FILE || names[i].endsWith(".js")),
        ];
        // Wait for every write first, so the failure delete below never races a late put.
        return Promise.allSettled([shell, ...files]).then(() => Promise.all(required));
      })
      .then(
        () => self.skipWaiting(),
        (error) =>
          // Unstamped workers all share the "dev" cache, which may be the active one.
          BUILD_ID === "dev"
            ? Promise.reject(error)
            : caches.delete(CACHE_NAME).then(() => {
                throw error;
              })
      )
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
      event.respondWith(networkFirst(event, SHELL_PATH, isShellResponse, loadsThisBuild));
    }
    return;
  }

  if (HASHED_STATIC_ASSET_NAME.test(path) || SHELL_PUBLIC_FILES.has(path)) {
    event.respondWith(networkFirst(event, event.request, isCacheableResponse));
  }
});
