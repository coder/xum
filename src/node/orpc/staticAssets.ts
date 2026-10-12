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

// T3 Option C step 1: the fonts the first view paints with, as woff2 files named by the built CSS
// (never hard-coded hashes). Geist is the UI font on every route. Geist Mono shows only on the
// workspace page (code), so other routes do not preload it. Other families stay unpreloaded.
const FIRST_VIEW_FAMILIES = { sans: "Geist", mono: "Geist Mono" } as const;
export type FirstViewFonts = Partial<Record<keyof typeof FIRST_VIEW_FAMILIES, string>>;

/** Each first-view family's woff2 file name, from the `@font-face` rules of the built CSS. */
export function findFirstViewFonts(css: string): FirstViewFonts {
  const fonts: FirstViewFonts = {};
  for (const [, rule] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:\s*["']?([^;"'}]+?)["']?\s*(?:;|$)/.exec(rule)?.[1];
    // Vite file names only ([\w.-]), so the name is safe inside the link's href attribute.
    const file = /url\(\s*["']?(?:\.\/)?([\w.-]+\.woff2)["']?\s*\)/.exec(rule)?.[1];
    for (const [key, name] of Object.entries(FIRST_VIEW_FAMILIES)) {
      if (family === name && file) fonts[key as keyof FirstViewFonts] = file;
    }
  }
  return fonts;
}

/** The preload links for one request path: Geist on every route, Geist Mono on workspace routes. */
export function firstViewFontPreloads(fonts: FirstViewFonts, requestPath: string): string {
  const files = [fonts.sans, requestPath.startsWith("/workspace/") ? fonts.mono : undefined];
  return files
    .filter((file) => file !== undefined)
    .map(
      (file) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="./${file}" />`
    )
    .join("");
}
