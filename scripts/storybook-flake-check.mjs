#!/usr/bin/env node

/**
 * Detect nondeterministic Pixel snapshots before they reach review.
 *
 * Why this exists: Pixel captures every story once per build, so a story whose
 * final frame depends on timing (scroll-lock races, async highlighting, sorting
 * by arrival order, ...) shows up as a spurious "changed" snapshot on unrelated
 * PRs. Reviewers then learn to rubber-stamp diffs, which hides real regressions.
 *
 * This replays Pixel's *own* capture pipeline (story discovery, matrix expansion,
 * masks, render/stability waits, deterministic Chromium flags) several times per
 * variant against a static Storybook build and fails when any variant produces
 * more than one distinct image. Reusing the pinned @coder/pixel-storybook modules
 * instead of a hand-rolled Playwright loop keeps local verdicts faithful to CI.
 *
 * Runs under Node (like `pixel-storybook` itself): under Bun, relaunching
 * Playwright after closing a browser intermittently hangs.
 *
 * Usage:
 *   node scripts/storybook-flake-check.mjs [--dir storybook-static] [--runs 3]
 *     [--filter <story-id regex>] [--files <a.stories.tsx,...>] [--out <dir>]
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Deep imports: the package only exports its CLI + storyapi, but these are the
// exact modules `pixel-storybook` runs. Re-check them when bumping the pinned version.
// File URLs keep dynamic import() working with Windows drive-letter paths.
const PIXEL_BUILD = resolve("node_modules/@coder/pixel-storybook/build");
const importPixel = (module) => import(pathToFileURL(join(PIXEL_BUILD, module)).href);
const pixelConfig = await importPixel("config.js");
const pixelCrawler = await importPixel("crawler/storybook.js");
const pixelShots = await importPixel("shots/shots.js");
const pixelUtils = await importPixel("utils.js");

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: "storybook-static" },
    runs: { type: "string", default: "3" },
    filter: { type: "string" },
    files: { type: "string" },
    out: { type: "string", default: "storybook-flakes" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf-8").split("*/")[0]);
  process.exit(0);
}

const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 2) {
  throw new Error(`--runs must be an integer >= 2, got: ${values.runs}`);
}
const staticDir = resolve(values.dir);
if (!existsSync(join(staticDir, "index.json"))) {
  throw new Error(`No Storybook build at ${staticDir}; run \`make storybook-build\` first.`);
}

// Mirror pixel.jsonc (DPR + default matrix) without requiring PIXEL_KEY/upload settings.
const fileConfig = pixelConfig.readConfigFile(pixelConfig.findConfigFile(process.cwd()));
pixelConfig.setTestConfig({
  devicePixelRatio: fileConfig.devicePixelRatio,
  matrix: fileConfig.matrix,
});

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
  const file = join(staticDir, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(staticDir) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

/** Map --files (story source paths) to story ids via the build's index.json. */
function selectStoryIds() {
  if (!values.files) return null;
  const wanted = new Set(
    values.files
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((file) => `./${file.replace(/^\.\//, "")}`)
  );
  const index = JSON.parse(readFileSync(join(staticDir, "index.json"), "utf-8"));
  return new Set(
    Object.entries(index.entries)
      .filter(([, entry]) => entry.type === "story" && wanted.has(entry.importPath))
      .map(([id]) => id)
  );
}

const discoveryBrowser = await pixelUtils.launchBrowser();
const { stories } = await pixelCrawler.collectStoriesFromPreview(
  await discoveryBrowser.newContext(),
  baseUrl
);
await discoveryBrowser.close();

const storyIds = selectStoryIds();
const filter = values.filter ? new RegExp(values.filter) : null;
const selected = stories.filter(
  (story) => (storyIds?.has(story.id) ?? true) && (filter?.test(story.id) ?? true)
);
const baseItems = pixelCrawler.generateStorybookShotItems(baseUrl, selected, pixelConfig.config.matrix);

if (baseItems.length === 0) {
  console.log("No Pixel snapshots selected; nothing to check.");
  server.close();
  process.exit(0);
}
console.log(`Capturing ${baseItems.length} Pixel variant(s) x ${runs} runs...`);

const renderFailures = new Set();

/**
 * Capture every item `count` times.
 * @returns {Promise<Map<string, Map<string, Buffer>>>} shot id -> image hash -> image
 */
async function captureRepeatedly(items, count, label) {
  const renders = new Map();
  const originalLog = console.log;
  for (let run = 0; run < count; run++) {
    // Fresh shot items per run: takeScreenShots mutates them (image, timings, logs).
    const fresh = items.map((item) => ({ ...item }));
    // Pixel logs several lines per shot; keep our own summary readable by default.
    if (!values.verbose) console.log = () => undefined;
    try {
      await pixelShots.takeScreenShots(fresh, undefined, (item) => {
        if (item.render?.status !== "rendered") renderFailures.add(item.id);
        if (!item.image) return;
        const variants = renders.get(item.id) ?? new Map();
        variants.set(pixelUtils.hashBuffer(item.image), item.image);
        renders.set(item.id, variants);
      });
    } finally {
      console.log = originalLog;
    }
    console.log(`  ${label} run ${run + 1}/${count} done`);
  }
  return renders;
}

const renders = await captureRepeatedly(baseItems, runs, "sweep");
const candidates = new Set([...renders].filter(([, v]) => v.size > 1).map(([id]) => id));

// Confirm candidates in a smaller batch. A full sweep saturates the runner, and at that
// load Chromium occasionally rasterizes an antialiased edge differently (one-pixel-row
// diffs) in stories that are stable at Pixel's normal per-build load. Real timing races
// (scroll locks, async data, arrival order) reproduce here too; that load noise does not.
const flaky = [];
if (candidates.size > 0) {
  console.log(`Confirming ${candidates.size} candidate(s)...`);
  const confirm = await captureRepeatedly(
    baseItems.filter((item) => candidates.has(item.id)),
    Math.max(runs, 6),
    "confirm"
  );
  for (const id of candidates) {
    const variants = confirm.get(id);
    if (variants && variants.size > 1) {
      flaky.push([id, variants]);
    } else {
      console.log(`WARN differed only under full-sweep load (not failing): ${id}`);
    }
  }
}
server.close();

for (const id of renderFailures) {
  console.log(`WARN story did not render cleanly (play threw or timed out): ${id}`);
}
if (flaky.length === 0) {
  console.log(`All ${renders.size} variant(s) were pixel-identical across ${runs} runs.`);
  process.exit(0);
}

const outDir = resolve(values.out);
mkdirSync(outDir, { recursive: true });
for (const [id, variants] of flaky) {
  console.log(`FLAKY ${id}: ${variants.size} distinct renders`);
  let n = 0;
  for (const image of variants.values()) {
    writeFileSync(join(outDir, `${id.replace(/[^\w.-]+/g, "_")}.${n++}.png`), image);
  }
}
console.log(`\n${flaky.length} flaky variant(s); distinct renders written to ${outDir}`);
process.exit(1);
