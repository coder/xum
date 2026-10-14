/**
 * Shared by the server (src/node/orpc/server.ts) and the build step that precompresses the
 * renderer bundle (scripts/precompress-static.ts), so both agree on which files are hashed.
 */

// Vite (assetsDir ".") writes every chunk and asset to the dist/ top level as
// `<name>-<8 char base64url hash>.<ext>`. Content-hashed names never change content, so they
// can be cached as immutable. Unhashed files (index.html, manifest.json, icons) must not.
const HASHED_STATIC_ASSET_NAME = /^[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9.]+$/;

/** True for a single path segment with a Vite content hash, e.g. `main-AbCd1234.js`. */
export function isHashedStaticAssetName(name: string): boolean {
  return HASHED_STATIC_ASSET_NAME.test(name);
}

/** Precompressed siblings written at build time, in server preference order. */
export const PRECOMPRESSED_ENCODINGS = [
  { encoding: "br", extension: ".br" },
  { encoding: "gzip", extension: ".gz" },
] as const;

// T3 Option C step 1: the font the first view paints with, as a woff2 file named by the built CSS
// (never a hard-coded hash). Only Geist, the UI font on every route. Not Geist Mono (code on the
// workspace page): on a throttled phone its preload competed with the app JS and made the
// workspace page's content 0.28 s later (page-timing, #6216). No other family either.
const FIRST_VIEW_FAMILY = "Geist";

/** The first-view font's woff2 file name, from the `@font-face` rules of the built CSS. */
export function findFirstViewFont(css: string): string | undefined {
  for (const [, rule] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:\s*["']?([^;"'}]+?)["']?\s*(?:;|$)/.exec(rule)?.[1];
    // Vite file names only ([\w.-]), so the name is safe inside the link's href attribute.
    const file = /url\(\s*["']?(?:\.\/)?([\w.-]+\.woff2)["']?\s*\)/.exec(rule)?.[1];
    if (family === FIRST_VIEW_FAMILY && file) return file;
  }
  return undefined;
}

/** The preload link for the first-view font, or nothing when the CSS names none. */
export function firstViewFontPreload(file: string | undefined): string {
  return file === undefined
    ? ""
    : `<link rel="preload" as="font" type="font/woff2" crossorigin href="./${file}" />`;
}

const MODULE_TAG = /[ \t]*<(script|link)\b([^>]*)>(?:<\/script>)?\n?/gi;
const attribute = (attrs: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1];

/**
 * T3 C step 2 (plan section 5.6, PR 4b): index.html without Vite's module script and modulepreload
 * tags, and their hrefs in order, for the early script to add after the static first-run view
 * paints. Null unless the page has exactly one module script with a src: then "/" is served as is.
 */
// No `preload` type annotations here: check-startup-imports.test.ts reads every "preload" plus colon
// in src/ as an Electron preload script.
export function deferAppModules(html: string) {
  const scripts: Array<string | undefined> = [];
  const preload = new Array<string>();
  const rest = html.replace(MODULE_TAG, (tag, name: string, attrs: string) => {
    if (name.toLowerCase() === "script") {
      if (attribute(attrs, "type") !== "module") return tag; // inline boot scripts
      scripts.push(attribute(attrs, "src"));
      return "";
    }
    const href = attribute(attrs, "href");
    if (!attribute(attrs, "rel")?.split(/\s+/).includes("modulepreload") || href == null)
      return tag;
    preload.push(href);
    return "";
  });
  const [script] = scripts;
  return scripts.length === 1 && script != null
    ? { html: rest, modules: { script, preload } }
    : null;
}
