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
