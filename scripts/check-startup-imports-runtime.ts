#!/usr/bin/env bun
/**
 * Runtime startup import check (#4423), the post-build complement to
 * scripts/check-startup-imports.ts.
 *
 * The static guard cannot see a module-scope `import()` (it starts loading at startup
 * but looks lazy) or computed loaders (`require(variable)`, `createRequire()` results).
 * This loads the built dist/desktop/main.js in plain Node with a stubbed `electron`
 * (scripts/check-startup-imports-runtime.cjs), so Electron's ready event never fires,
 * and fails when a BANNED_PACKAGES package is in require.cache anyway.
 *
 * Limitation: the module list is taken after one setImmediate, so it covers module-scope
 * code and its microtasks, not work that resumes after real I/O. Electron stubs are not
 * strings either, so startup code that feeds e.g. `app.getPath()` into `path.join()`
 * throws (main.ts logs and swallows that); both only matter for code that runs before
 * the ready event, which main.ts keeps minimal.
 *
 * Needs a build: `make check-startup-imports-runtime` builds main first and runs in CI's
 * Smoke / Server job rather than static-check.
 *
 * Run: bun scripts/check-startup-imports-runtime.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  BANNED_PACKAGES,
  isBannedPackage,
  packageNameOfFile,
  STARTUP_ENTRIES,
} from "./check-startup-imports";

const HARNESS = path.join(import.meta.dir, "check-startup-imports-runtime.cjs");
const LOAD_TIMEOUT_MS = 60_000;

interface HarnessResult {
  error: string | null;
  modules: string[];
}

export interface BannedModule {
  packageName: string;
  /** One loaded file of the package, as an example. */
  file: string;
}

/**
 * Loads `target` in plain Node with a stubbed `electron` and returns every file in
 * require.cache after module-scope work (including module-scope `import()`) has run.
 * Throws when the load throws, so a broken harness can never pass vacuously.
 */
export async function loadEagerModules(requestedTarget: string): Promise<string[]> {
  assert(path.isAbsolute(requestedTarget), `target must be absolute: ${requestedTarget}`);
  assert(existsSync(requestedTarget), `target does not exist: ${requestedTarget}`);
  // require.cache is keyed by real path.
  const target = realpathSync(requestedTarget);

  const workDir = await mkdtemp(path.join(tmpdir(), "startup-imports-runtime-"));
  try {
    // Loading main.js must never touch the developer's real ~/.xum.
    const xumRoot = path.join(workDir, "xum-root");
    const outFile = path.join(workDir, "out.json");
    const { code, signal, output, timedOut } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn("node", [HARNESS, target, outFile], {
        cwd: workDir,
        env: { ...process.env, XUM_ROOT: xumRoot, MUX_ROOT: xumRoot },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let captured = "";
      child.stdout.on("data", (chunk: Buffer) => (captured += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (captured += chunk.toString()));
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        child.kill("SIGKILL");
      }, LOAD_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (exitCode, exitSignal) => {
        clearTimeout(timer);
        resolve({ code: exitCode, signal: exitSignal, output: captured, timedOut: expired });
      });
    });

    if (timedOut) {
      throw new Error(`Loading ${target} timed out after ${LOAD_TIMEOUT_MS} ms:\n${output}`);
    }
    if (code !== 0) {
      throw new Error(
        `Loading ${target} exited with ${code ?? signal} (harness failed):\n${output}`
      );
    }
    const result = JSON.parse(await readFile(outFile, "utf8")) as HarnessResult;
    if (result.error != null) {
      throw new Error(`Loading ${target} threw:\n${result.error}\n${output}`);
    }
    assert(Array.isArray(result.modules), "harness wrote no module list");
    if (!result.modules.includes(target)) {
      throw new Error(`Harness module list does not contain ${target}; the load did not run`);
    }
    return result.modules;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Owning package of a loaded file, or null for files outside node_modules. */
function packageOfLoadedFile(file: string): string | null {
  const normalized = file.split(path.sep).join("/");
  return normalized.includes("/node_modules/") ? packageNameOfFile(normalized) : null;
}

/** Banned packages among loaded files, one example file per package, sorted by name. */
export function findBannedModules(
  modules: readonly string[],
  banned: readonly string[]
): BannedModule[] {
  const found = new Map<string, string>();
  for (const file of modules) {
    const packageName = packageOfLoadedFile(file);
    if (packageName == null || !isBannedPackage(packageName, banned) || found.has(packageName)) {
      continue;
    }
    found.set(packageName, file);
  }
  return [...found]
    .map(([packageName, file]) => ({ packageName, file }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

async function main(): Promise<number> {
  const rootDir = path.resolve(import.meta.dir, "..");
  const desktopMain = STARTUP_ENTRIES.find((e) => e.entry === "src/desktop/main.ts");
  assert(desktopMain != null, "STARTUP_ENTRIES has no src/desktop/main.ts entry");
  const target = path.join(rootDir, desktopMain.dist);
  if (!existsSync(target)) {
    console.error(`❌ ${desktopMain.dist} does not exist; run make build-main first`);
    return 1;
  }

  const modules = await loadEagerModules(target);
  const packages = new Set(modules.map(packageOfLoadedFile).filter((p) => p != null));
  console.log(`${desktopMain.dist}: ${modules.length} modules loaded (${packages.size} packages)`);

  const violations = findBannedModules(modules, BANNED_PACKAGES);
  if (violations.length === 0) {
    console.log("✅ No banned packages loaded before Electron is ready");
    return 0;
  }
  for (const { packageName, file } of violations) {
    console.error(`\n❌ ${desktopMain.dist} loads "${packageName}" at startup, e.g.:`);
    console.error(`   ${path.relative(rootDir, file)}`);
  }
  console.error(
    "\nLoad it with `await import()` inside the function that needs it." +
      " `bun scripts/check-startup-imports.ts` prints the static import chain; if it passes," +
      " look for a module-scope import() or a computed require()."
  );
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
