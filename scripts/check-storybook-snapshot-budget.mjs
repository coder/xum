#!/usr/bin/env node

/**
 * Enforce the repo-wide Pixel snapshot budget against a served Storybook build.
 *
 * Why this exists: every Pixel variant costs capture time and review attention on
 * every PR, so snapshot growth must be a deliberate choice (exclude, consolidate,
 * or knowingly raise the cap), not drift.
 *
 * Why it counts from a build: the previous guard (tests/ui/storybook/budget.test.ts)
 * estimated variants with source regexes. It missed meta-level matrix inheritance,
 * named matrix constants and per-story exclusions, so it reported 608 while Pixel
 * captured 655 for the same stories. This script expands the matrix with Pixel's own
 * crawler (`@coder/pixel-storybook`, the modules `pixel-storybook` runs), so the count
 * is exactly what Pixel captures.
 *
 * Usage (Storybook must be built and served, like `make test-storybook`):
 *   node scripts/check-storybook-snapshot-budget.mjs [--url http://127.0.0.1:6006]
 *     [--max-snapshots N] [--max-files N]
 */
import { parseArgs } from "node:util";
// Deep file imports, as in scripts/storybook-flake-check.mjs: the package only exports
// its CLI + storyapi. Re-check them when bumping the pinned version.
import * as pixelConfig from "../node_modules/@coder/pixel-storybook/build/config.js";
import * as pixelCrawler from "../node_modules/@coder/pixel-storybook/build/crawler/storybook.js";
import * as pixelUtils from "../node_modules/@coder/pixel-storybook/build/utils.js";

// Exact counts on main when this check replaced the regex estimator (same 115 files,
// no new stories; 608 → 655 is a unit change from estimated to actual captures).
// Keep this no-headroom guardrail tight: future growth should exclude, consolidate,
// or intentionally rebalance snapshots rather than silently increasing Pixel load.
const MAX_SNAPSHOTS = 655;
const MAX_SNAPSHOT_ENABLED_FILES = 115;

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:6006" },
    // Overrides exist so a negative control can prove the assertion fires.
    "max-snapshots": { type: "string" },
    "max-files": { type: "string" },
  },
});

function parseLimit(raw, fallback, name) {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer, got: ${raw}`);
  }
  return value;
}

const maxSnapshots = parseLimit(values["max-snapshots"], MAX_SNAPSHOTS, "max-snapshots");
const maxFiles = parseLimit(values["max-files"], MAX_SNAPSHOT_ENABLED_FILES, "max-files");
const baseUrl = values.url.replace(/\/$/, "");

// Mirror pixel.jsonc (DPR + default matrix) without requiring PIXEL_KEY/upload settings.
const fileConfig = pixelConfig.readConfigFile(pixelConfig.findConfigFile(process.cwd()));
pixelConfig.setTestConfig({
  devicePixelRatio: fileConfig.devicePixelRatio,
  matrix: fileConfig.matrix,
});

const indexResponse = await fetch(`${baseUrl}/index.json`);
if (!indexResponse.ok) {
  throw new Error(
    `Cannot read ${baseUrl}/index.json (HTTP ${indexResponse.status}); is Storybook served?`
  );
}
const index = await indexResponse.json();
const importPathById = new Map(
  Object.entries(index.entries)
    .filter(([, entry]) => entry.type === "story")
    .map(([id, entry]) => [id, entry.importPath])
);

const browser = await pixelUtils.launchBrowser();
let stories;
try {
  ({ stories } = await pixelCrawler.collectStoriesFromPreview(await browser.newContext(), baseUrl));
} finally {
  await browser.close();
}

// A half-loaded preview or the wrong server would undercount and pass vacuously.
if (stories.length === 0 || stories.length !== importPathById.size) {
  throw new Error(
    `Preview reported ${stories.length} stories but index.json lists ${importPathById.size}; refusing to count.`
  );
}

const items = pixelCrawler.generateStorybookShotItems(baseUrl, stories, pixelConfig.config.matrix);
if (items.length === 0) {
  throw new Error("Pixel matrix expansion produced no snapshots; refusing to pass vacuously.");
}

const snapshotsByFile = new Map();
for (const item of items) {
  const file = importPathById.get(item.sourceId);
  if (file == null) {
    throw new Error(`Snapshot ${item.id} has no index.json entry for story ${item.sourceId}`);
  }
  snapshotsByFile.set(file, (snapshotsByFile.get(file) ?? 0) + 1);
}

const snapshotCount = items.length;
const fileCount = snapshotsByFile.size;
console.log(
  `Pixel snapshots: ${snapshotCount} (cap ${maxSnapshots}) across ${fileCount} story files (cap ${maxFiles}).`
);

if (snapshotCount > maxSnapshots || fileCount > maxFiles) {
  console.log("\nSnapshots per story file:");
  for (const [file, count] of [...snapshotsByFile].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    console.log(`${String(count).padStart(5)}  ${file}`);
  }
  console.error(
    "\nPixel snapshot budget exceeded. Exclude (pixel: PIXEL_DISABLED), consolidate stories or matrix " +
      "variants, or deliberately raise the cap in scripts/check-storybook-snapshot-budget.mjs."
  );
  process.exit(1);
}
