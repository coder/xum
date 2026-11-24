#!/usr/bin/env bun
/**
 * Runtime startup import check (#4423), the post-build complement to
 * scripts/check-startup-imports.ts.
 *
 * The static guard cannot see a module-scope `import()` (it starts loading at startup
 * but looks lazy) or computed loaders (`require(variable)`, `createRequire()` results).
 * This launches the built package.json `main` (the CLI shim, which routes to desktop
 * main) the way `electron .` does, in plain Node with a stubbed `electron`
 * (scripts/check-startup-imports-runtime.cjs), so Electron's ready event never fires,
 * and fails when a BANNED_PACKAGES package is in require.cache anyway, or when the load
 * did not reach desktop main. The module list is taken when startup reaches
 * `app.whenReady()` (or goes idle first), so it includes code that runs after real I/O.
 * It runs once per desktop platform (simulated `process.platform`), because startup
 * branches on the OS. The preload is covered by the static guard only.
 *
 * Limitation: only `app.getPath()` returns a real value (a path in a temp dir); other
 * Electron values are stubs, so startup code that needs e.g. a real string from another
 * Electron API may throw before reaching the ready gate.
 *
 * Needs a build: `make check-startup-imports-runtime` builds main first and runs in CI's
 * Smoke / Server job rather than static-check.
 *
 * Run: bun scripts/check-startup-imports-runtime.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
/** Desktop platforms whose startup branches the check runs (`process.platform` values). */
export const DESKTOP_PLATFORMS = ["linux", "darwin", "win32"] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

interface HarnessResult {
  error: string | null;
  trigger: string;
  modules: string[];
}

export interface EagerModules {
  /** What ended startup: `app.whenReady()` or an idle event loop. */
  trigger: string;
  /** Every file in require.cache at that point (real paths). */
  modules: string[];
}

export interface BannedModule {
  packageName: string;
  /** One loaded file of the package, as an example. */
  file: string;
}

/**
 * Loads `target` in plain Node with a stubbed `electron` and returns every file in
 * require.cache once startup reaches the ready gate (see the harness for the triggers).
 * Throws when the load throws, so a broken harness can never pass vacuously.
 */
export async function loadEagerModules(
  requestedTarget: string,
  platform?: DesktopPlatform
): Promise<EagerModules> {
  assert(path.isAbsolute(requestedTarget), `target must be absolute: ${requestedTarget}`);
  assert(existsSync(requestedTarget), `target does not exist: ${requestedTarget}`);
  // require.cache is keyed by real path.
  const target = realpathSync(requestedTarget);

  const workDir = await mkdtemp(path.join(tmpdir(), "startup-imports-runtime-"));
  try {
    // Startup runs its home/userData migrations, so point every location it can touch
    // (HOME and its Windows equivalents, XUM_ROOT, Electron's app paths) into the temp
    // dir: the check must never touch the developer's real ~/.xum.
    const xumRoot = path.join(workDir, "xum-root");
    const home = path.join(workDir, "home");
    const appData = path.join(workDir, "app-data");
    await mkdir(home);
    await mkdir(appData);
    const outFile = path.join(workDir, "out.json");
    const { code, signal, output, timedOut } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn("node", [HARNESS, target, outFile], {
        cwd: workDir,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: path.join(appData, "roaming"),
          LOCALAPPDATA: path.join(appData, "local"),
          XUM_ROOT: xumRoot,
          MUX_ROOT: xumRoot,
          STARTUP_CHECK_APP_DATA: appData,
          ...(platform != null ? { STARTUP_CHECK_PLATFORM: platform } : {}),
        },
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
    if (!existsSync(outFile)) {
      throw new Error(`${target} exited before startup reached app.whenReady():\n${output}`);
    }
    const result = JSON.parse(await readFile(outFile, "utf8")) as HarnessResult;
    if (result.error != null) {
      throw new Error(`Loading ${target} threw:\n${result.error}\n${output}`);
    }
    assert(Array.isArray(result.modules), "harness wrote no module list");
    if (!result.modules.includes(target)) {
      throw new Error(`Harness module list does not contain ${target}; the load did not run`);
    }
    return { trigger: result.trigger, modules: result.modules };
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
  // Electron launches package.json `main` (the CLI shim), not desktop main directly.
  const { main: packageMain } = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8")
  ) as { main: string };
  const entry = STARTUP_ENTRIES.find((e) => e.dist === packageMain);
  assert(entry != null, `package.json main (${packageMain}) is not in STARTUP_ENTRIES`);
  const target = path.join(rootDir, entry.dist);
  if (!existsSync(target)) {
    console.error(`❌ ${entry.dist} does not exist; run make build-main first`);
    return 1;
  }
  const desktopMainFile = realpathSync(path.join(rootDir, desktopMain.dist));

  let failed = false;
  for (const platform of DESKTOP_PLATFORMS) {
    const { trigger, modules } = await loadEagerModules(target, platform);
    const packages = new Set(modules.map(packageOfLoadedFile).filter((p) => p != null));
    console.log(
      `${entry.dist} (${platform}): ${modules.length} modules loaded` +
        ` (${packages.size} packages) until ${trigger}`
    );
    // Startup that ends anywhere else (e.g. a swallowed error ended it early) would
    // check only part of the pre-splash path, so it fails instead of passing.
    if (trigger !== "app.whenReady()") {
      console.error(`❌ ${entry.dist} (${platform}) did not reach app.whenReady()`);
      failed = true;
    }
    // The shim must have routed to desktop main, so this run covers everything a
    // desktop-main-only load would (and a whenReady() call before it cannot pass).
    if (!modules.includes(desktopMainFile)) {
      console.error(`❌ ${entry.dist} (${platform}) did not load ${desktopMain.dist}`);
      failed = true;
    }
    for (const { packageName, file } of findBannedModules(modules, BANNED_PACKAGES)) {
      console.error(`\n❌ ${entry.dist} (${platform}) loads "${packageName}" at startup, e.g.:`);
      console.error(`   ${path.relative(rootDir, file)}`);
      console.error(
        "   Load it with `await import()` inside the function that needs it." +
          " `bun scripts/check-startup-imports.ts` prints the static import chain; if it" +
          " passes, look for an import() that runs during startup (at module scope or in a" +
          " startup function) or a computed require() in" +
          " src/cli/index.ts, src/desktop/main.ts or the modules they load."
      );
      failed = true;
    }
  }
  if (failed) return 1;
  console.log("✅ No banned packages loaded before Electron is ready");
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
