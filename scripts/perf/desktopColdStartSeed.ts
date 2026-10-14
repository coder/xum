/**
 * The seeded root for scripts/perf/desktopColdStart.ts (desktop protocol D2).
 *
 * Why (#6241 item 2): prepareDemoProject writes a legacy workspace entry (path only), and the
 * runner copies the seed fresh before every launch. So every launch ran the one-time legacy
 * config migration: its config.json write took 29 ms in some launches and 85-130 ms in others.
 * That decided when the backend's next ~50 ms synchronous block ran (the first log line from
 * workspaceService.js parses its source map): before the renderer needed the main process, or in
 * the middle of its startup requests. app-shell-ready was then ~170 ms or ~225 ms, and an A/A had
 * a half-width of 9.4%. A user's config migrates once, so the seed is migrated here, once.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Config } from "../../src/node/config";
import { prepareDemoProject } from "../../tests/e2e/utils/demoProject";

export async function prepareColdStartSeed(root: string): Promise<void> {
  prepareDemoProject(root);
  // The app's own read persists the migrated fields (id, name, createdAt, runtimeConfig).
  await new Config(root).getAllWorkspaceMetadata();
  // A failed migration write only logs a warning, so check that a second load writes nothing.
  const configPath = path.join(root, "config.json");
  const migrated = fs.readFileSync(configPath, "utf8");
  await new Config(root).getAllWorkspaceMetadata();
  assert.equal(fs.readFileSync(configPath, "utf8"), migrated, "seed config.json still migrates");
}
