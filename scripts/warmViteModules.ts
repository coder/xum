/**
 * Requests the renderer's whole module graph from a running Vite dev server, so Vite has
 * transformed every module before a browser asks for one.
 *
 * Why: Vite's dev server transforms each module on its first request, on one thread, and a cold
 * first page load asks for about 900 of them (React Compiler runs through Babel on every one).
 * That costs about 45 CPU seconds of Vite time. Under host load the first `open` plus `idle` of a
 * verify-xum run then outlasts agent-browser's 25 s wait and shows "Loading Xum" for as long as
 * the transforms take. During those seconds Chrome also holds dozens of queued module requests,
 * which a host network change (a Docker veth coming up) fails with ERR_NETWORK_CHANGED, and the
 * page then shows "<name> failed to load." (a lazy part) or the boot screen's "Xum could not load"
 * (a module of the first load). A warm Vite serves the same graph in about 2 s.
 *
 * The walk reads Vite's own output: Vite rewrites every import it serves to an absolute path, so a
 * regex over the served JavaScript finds the static and the `import("...")` edges. A 4xx answer is
 * ignored (a string that only looks like an import). A 5xx answer, a 3xx answer or a network
 * failure fails the walk, because the browser would fail on that module too. The walk never
 * leaves Vite's origin: the strings come from source files, `/\\host` is a URL on another host,
 * and a redirect can name another host, so no request follows one.
 *
 * Worker scripts (`new Worker(new URL("...", import.meta.url))`) are left out on purpose. Vite's
 * dependency scan does not see the highlight worker's `@pierre/highlights`, so the first request
 * for the worker makes Vite optimize it and invalidate the modules this walk just warmed. Only a
 * second walk would warm them again.
 *
 * Usage: bun scripts/warmViteModules.ts <vite origin> [<seconds before giving up>]
 */

const MODULE_CONCURRENCY = 8;
// A graph bigger than this is a runaway walk (a URL that always yields a new URL), not a renderer.
const MAX_MODULES = 20_000;

const STATIC_IMPORT_FROM = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g;
const STATIC_IMPORT_BARE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const SCRIPT_SRC = /<script\b[^>]*\bsrc="([^"]+)"/g;

export interface WarmResult {
  /** Modules that Vite answered with a 2xx, the entry page included. */
  served: number;
  /** URLs that Vite answered with a 4xx: strings in code that only look like imports. */
  notFound: number;
}

/** Same-origin URLs (path and query) that `source` imports or loads with a script tag. */
export function findModuleUrls(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [STATIC_IMPORT_FROM, STATIC_IMPORT_BARE, DYNAMIC_IMPORT, SCRIPT_SRC]) {
    for (const match of source.matchAll(pattern)) {
      const url = match[1];
      // Vite writes absolute paths. Anything else is a bare specifier or another origin.
      if (url.startsWith("/") && !url.startsWith("//")) found.add(url);
    }
  }
  return [...found];
}

/**
 * Walks the module graph that the page at `origin` loads, and resolves once Vite has answered for
 * every module. Throws when any module fails to load, or when `signal` aborts.
 */
export async function warmModuleGraph(
  origin: string,
  options: { signal?: AbortSignal; concurrency?: number } = {}
): Promise<WarmResult> {
  const concurrency = options.concurrency ?? MODULE_CONCURRENCY;
  if (!(concurrency >= 1)) throw new Error(`concurrency must be at least 1, got ${concurrency}`);
  const base = new URL(origin);
  const seen = new Set<string>();
  const failures: string[] = [];
  let served = 0;
  let notFound = 0;

  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (active < concurrency) {
      active++;
      return;
    }
    // The releasing request hands its slot over, so `active` stays the same.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  // The path and query of `candidate` on Vite's origin, or null when it names another origin. The
  // key can still start with `//` (`/.//host/x.js` parses to the path `//host/x.js`), so a key is
  // never resolved against the origin again: `requestUrl` joins them as text.
  const toKey = (candidate: string): string | null => {
    try {
      const target = new URL(candidate, base);
      return target.origin === base.origin ? target.pathname + target.search : null;
    } catch {
      return null;
    }
  };

  const requestUrl = (key: string): URL => {
    if (!key.startsWith("/")) throw new Error(`a module key must be a path, got ${key}`);
    return new URL(base.origin + key);
  };

  const claim = (url: string): boolean => {
    if (seen.has(url)) return false;
    if (seen.size >= MAX_MODULES) {
      throw new Error(`the module graph has more than ${MAX_MODULES} URLs: the walk is not ending`);
    }
    seen.add(url);
    return true;
  };

  const visit = async (url: string): Promise<void> => {
    let body = "";
    await acquire();
    try {
      options.signal?.throwIfAborted();
      // `fetch` follows a redirect by default, and a `Location` header can name another origin.
      const response = await fetch(requestUrl(url), {
        signal: options.signal,
        redirect: "manual",
      });
      const type = response.headers.get("content-type") ?? "";
      // Vite does not redirect a module, so a 3xx is a module that it could not serve.
      const redirected = response.status >= 300 && response.status < 400;
      if (redirected || response.status >= 500) {
        const note = redirected ? " (a redirect: the walk does not follow redirects)" : "";
        failures.push(`${url}: HTTP ${response.status}${note}`);
        await response.arrayBuffer();
        return;
      }
      if (!response.ok) {
        notFound++;
        await response.arrayBuffer();
        return;
      }
      served++;
      // Read every body: an unread one keeps its connection busy. Only text can name more modules.
      if (/javascript|html/i.test(type)) body = await response.text();
      else await response.arrayBuffer();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    } finally {
      release();
    }
    const children = findModuleUrls(body)
      .map(toKey)
      .filter((key): key is string => key !== null)
      .filter(claim);
    await Promise.all(children.map(visit));
  };

  claim("/");
  await visit("/");
  if (failures.length > 0) {
    const shown = failures.slice(0, 10).map((failure) => `  ${failure}`);
    const more =
      failures.length > shown.length ? `\n  and ${failures.length - shown.length} more` : "";
    throw new Error(
      `Vite could not serve ${failures.length} of ${seen.size} modules:\n${shown.join("\n")}${more}`
    );
  }
  return { served, notFound };
}

if (import.meta.main) {
  const [origin, seconds] = process.argv.slice(2);
  if (!origin) {
    console.error(
      "usage: bun scripts/warmViteModules.ts <vite origin> [<seconds before giving up>]"
    );
    process.exit(1);
  }
  if (seconds !== undefined && !(Number(seconds) > 0)) {
    console.error(
      `warmViteModules: <seconds before giving up> must be a positive number, got "${seconds}"`
    );
    process.exit(1);
  }
  const signal = seconds ? AbortSignal.timeout(Number(seconds) * 1000) : undefined;
  const started = Date.now();
  try {
    const result = await warmModuleGraph(origin, { signal });
    console.log(
      `vite served ${result.served} modules (${result.notFound} other URLs not found) in ` +
        `${Math.round((Date.now() - started) / 1000)} s`
    );
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `the walk did not end within ${seconds} s (the launch deadline): Vite had not answered every module`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`warmViteModules: ${reason}`);
    process.exit(1);
  }
}
