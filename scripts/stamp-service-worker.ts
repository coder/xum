#!/usr/bin/env bun
/**
 * #6867: one service worker cache per build. Writes the build's id, its shell entry file and its
 * first-load files into <dir>/service-worker.js (copied from public/ by Vite), so each release
 * ships a byte-different worker. The browser's update check installs it, and its activate step
 * deletes every other cache of its scope, old releases' hashed files included.
 * Runs after precompress-static in `make build-renderer`. Usage: bun scripts/stamp-service-worker.ts dist
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { findFirstViewFont, isHashedStaticAssetName } from "../src/node/orpc/staticAssets";
import { firstLoadFiles } from "./perf/firstLoadJs";

export interface ServiceWorkerStamp {
  buildId: string;
  entryFile: string;
  precache: string[];
}

// One marker line per value. Rewritten in place, so a second run gives the same bytes.
const MARKERS = {
  buildId: /^const BUILD_ID = .*;$/m,
  entryFile: /^const ENTRY_FILE = .*;$/m,
  precache: /^const PRECACHE = .*;$/m,
} as const;

/** Rewrites the marker lines of the worker source. Throws when a marker is missing or repeated. */
export function stampServiceWorker(source: string, stamp: ServiceWorkerStamp): string {
  const values: Record<keyof typeof MARKERS, string> = {
    buildId: `const BUILD_ID = ${JSON.stringify(stamp.buildId)};`,
    entryFile: `const ENTRY_FILE = ${JSON.stringify(stamp.entryFile)};`,
    precache: `const PRECACHE = ${JSON.stringify(stamp.precache)};`,
  };
  let stamped = source;
  for (const key of Object.keys(MARKERS) as Array<keyof typeof MARKERS>) {
    const global = new RegExp(MARKERS[key].source, "gm");
    const count = stamped.match(global)?.length ?? 0;
    if (count !== 1)
      throw new Error(`service-worker.js must have exactly one ${key} marker, found ${count}`);
    stamped = stamped.replace(MARKERS[key], () => values[key]);
  }
  return stamped;
}

/**
 * The stamp for a built dist: the id is a hash of the built index.html (it lists the hashed entry
 * files, and the server rewrites only per request), the entry is its module script, and the
 * precache list is its first-load module graph, its stylesheets and the first-view font.
 */
export function stampForDist(distDir: string): ServiceWorkerStamp {
  const html = fs.readFileSync(path.join(distDir, "index.html"), "utf-8");
  const buildId = crypto.createHash("sha256").update(html).digest("hex").slice(0, 12);
  const entryFile = /<script\b[^>]*type="module"[^>]*src="(?:\.\/)?([^"]+)"/.exec(html)?.[1];
  if (entryFile === undefined) throw new Error(`${distDir}/index.html has no module script`);

  const names = new Set<string>();
  for (const file of firstLoadFiles(distDir).keys()) names.add(path.relative(distDir, file));
  for (const [, href] of html.matchAll(
    /<link[^>]*rel="stylesheet"[^>]*href="(?:\.\/)?([^"]+\.css)"/g
  )) {
    names.add(href);
    const font = findFirstViewFont(fs.readFileSync(path.join(distDir, href), "utf-8"));
    if (font !== undefined) names.add(font);
  }
  const precache = [...names].sort();
  // The #6848 allow-list: the worker caches only content-hashed build files besides the shell.
  const outside = precache.filter((name) => !isHashedStaticAssetName(name));
  if (outside.length > 0)
    throw new Error(`precache outside the hashed allow-list: ${outside.join(", ")}`);
  if (!precache.includes(entryFile))
    throw new Error(`the entry ${entryFile} is not in the precache list`);
  return { buildId, entryFile, precache };
}

/** Brotli bytes the client downloads for the precache list (the .br sibling when there is one). */
function precacheBrotliBytes(distDir: string, precache: string[]): number {
  let total = 0;
  for (const name of precache) {
    const file = path.join(distDir, name);
    total += fs.existsSync(`${file}.br`)
      ? fs.statSync(`${file}.br`).size
      : zlib.brotliCompressSync(fs.readFileSync(file)).length;
  }
  return total;
}

function main(argv: string[]): void {
  const distDir = argv[0];
  if (distDir === undefined) throw new Error("usage: bun scripts/stamp-service-worker.ts <dist>");
  const workerPath = path.join(distDir, "service-worker.js");
  const stamp = stampForDist(distDir);
  fs.writeFileSync(workerPath, stampServiceWorker(fs.readFileSync(workerPath, "utf-8"), stamp));
  const kib = (precacheBrotliBytes(distDir, stamp.precache) / 1024).toFixed(1);
  console.log(
    `service-worker.js: build ${stamp.buildId}, precache ${stamp.precache.length} files, ${kib} KiB br`
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
