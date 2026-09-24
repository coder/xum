#!/usr/bin/env bun
/**
 * Startup import guard (replaces check_eager_imports.sh / check_bundle_size.sh, #233).
 *
 * Heavy packages (the AI SDK, provider SDKs, DuckDB, ...) must stay off the eager
 * startup path: the Electron main process has to show the splash screen before it
 * loads services, and the CLI shim routes subcommands before loading any of them.
 *
 * The main process is compiled per file by tsc (CommonJS, no bundling), so the size
 * of dist/desktop/main.js says nothing about what it loads. Instead this walks the
 * real static import graph: esbuild resolves every entry point (tsconfig path aliases
 * included, type-only imports elided like tsc does) and records each import's kind.
 * Third-party packages are traversed too, so an allowed package that loads a banned
 * one is caught. Banned packages, Node built-ins and `electron` stay external.
 *
 * Eager edges:
 * - Project code: only static `import`/`export ... from`. `await import()` is the
 *   documented lazy-loading mechanism, and `require()` is lint-banned
 *   (`no-require-imports`), so each call is a reviewed escape hatch; the CLI shim
 *   uses it to route subcommands lazily.
 * - Packages (node_modules): static imports and `require()` calls, since CommonJS
 *   packages load their dependencies with top-level `require()`. A `require()` inside
 *   a function is counted too, which errs on the side of reporting.
 *
 * Run: bun scripts/check-startup-imports.ts
 */
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import * as path from "node:path";
import * as esbuild from "esbuild";

export interface StartupEntry {
  /** Entry module, relative to the project root. */
  entry: string;
  /** Why this module's eager graph is startup-critical. */
  reason: string;
}

export const STARTUP_ENTRIES: readonly StartupEntry[] = [
  {
    entry: "src/cli/index.ts",
    reason: "CLI shim; runs before every subcommand and the desktop app",
  },
  {
    entry: "src/desktop/main.ts",
    reason: "Electron main process before the splash screen (loadServices() loads the rest)",
  },
  {
    entry: "src/desktop/preload.ts",
    reason: "renderer preload script",
  },
];

/**
 * Package names, or `@scope/*` for a whole scope. These are only needed once services
 * run, and each costs noticeable load time.
 */
export const BANNED_PACKAGES: readonly string[] = [
  "ai",
  "@ai-sdk/*",
  "@aws-sdk/*",
  "@duckdb/*",
  "@modelcontextprotocol/*",
  "typescript",
];

export interface EagerImportViolation {
  entry: string;
  /** Banned package name (not the full specifier). */
  packageName: string;
  /** Shortest eager import chain: entry, intermediate modules, then the import specifier. */
  chain: string[];
}

export interface EagerGraphSize {
  /** Project modules (outside node_modules) loaded eagerly. */
  projectModules: number;
  /** Distinct third-party packages loaded eagerly (built-ins and externals excluded). */
  packages: number;
}

export interface StartupImportReport {
  violations: EagerImportViolation[];
  /** Eager graph size per entry (informational). */
  eagerGraphSizes: Record<string, EagerGraphSize>;
}

// tsconfig path aliases resolve to project files, not packages.
const PATH_ALIAS_PREFIXES = ["@/", "@shared/"];

const BUILTIN_MODULES = new Set(builtinModules);

/** Packages provided by the runtime rather than loaded from node_modules. */
const RUNTIME_PROVIDED_PACKAGES = new Set(["electron"]);

function isInNodeModules(file: string): boolean {
  return file.startsWith("node_modules/") || file.includes("/node_modules/");
}

function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !path.isAbsolute(specifier) &&
    !PATH_ALIAS_PREFIXES.some((prefix) => specifier.startsWith(prefix))
  );
}

/** "@scope/pkg/sub" -> "@scope/pkg", "pkg/sub" -> "pkg". */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function isBannedPackage(packageName: string, banned: readonly string[]): boolean {
  return banned.some((pattern) =>
    pattern.endsWith("/*") ? packageName.startsWith(pattern.slice(0, -1)) : packageName === pattern
  );
}

export async function analyzeStartupImports(options: {
  rootDir: string;
  entries: readonly string[];
  banned: readonly string[];
}): Promise<StartupImportReport> {
  assert(path.isAbsolute(options.rootDir), "rootDir must be absolute");
  assert(options.entries.length > 0, "at least one entry is required");

  // esbuild lists imports it elided (type-only or unused bindings) in the metafile as
  // unresolved externals without calling onResolve. Record the banned imports that were
  // really resolved so elided ones are not mistaken for eager loads.
  const resolvedBannedImports = new Set<string>();
  const edgeKey = (importer: string, specifier: string) => `${importer}\0${specifier}`;

  const result = await esbuild.build({
    absWorkingDir: options.rootDir,
    entryPoints: [...options.entries],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    outdir: path.join(options.rootDir, ".startup-imports-unused-outdir"),
    logLevel: "silent",
    // Native addons and wasm blobs are leaves; their contents do not matter here.
    loader: { ".node": "empty", ".wasm": "empty" },
    plugins: [
      {
        name: "externalize-banned-and-builtin",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (!isBareSpecifier(args.path)) return undefined;
            const packageName = packageNameOf(args.path);
            if (args.path.startsWith("node:") || BUILTIN_MODULES.has(packageName)) {
              return { path: args.path, external: true };
            }
            if (RUNTIME_PROVIDED_PACKAGES.has(packageName)) {
              return { path: args.path, external: true };
            }
            if (isBannedPackage(packageName, options.banned)) {
              const importer = path
                .relative(options.rootDir, args.importer)
                .split(path.sep)
                .join("/");
              resolvedBannedImports.add(edgeKey(importer, args.path));
              return { path: args.path, external: true };
            }
            // Allowed package: let esbuild resolve it so its own imports are walked.
            return undefined;
          });
        },
      },
    ],
  });

  const inputs = result.metafile.inputs;
  const report: StartupImportReport = { violations: [], eagerGraphSizes: {} };

  for (const entry of options.entries) {
    assert(inputs[entry] != null, `esbuild did not resolve entry ${entry}`);
    // Breadth-first search so each reported chain is a shortest path.
    const parent = new Map<string, string>();
    const visited = new Set<string>([entry]);
    const queue = [entry];
    const reported = new Set<string>();
    while (queue.length > 0) {
      const file = queue.shift()!;
      const input = inputs[file];
      assert(input != null, `metafile is missing ${file}`);
      const fromPackage = isInNodeModules(file);
      for (const imp of input.imports) {
        const eager =
          imp.kind === "import-statement" || (fromPackage && imp.kind === "require-call");
        if (!eager) continue;
        const specifier = imp.original ?? imp.path;
        if (imp.external) {
          if (!resolvedBannedImports.has(edgeKey(file, specifier))) continue;
          const packageName = packageNameOf(specifier);
          if (reported.has(packageName)) continue;
          reported.add(packageName);
          const chain = [specifier];
          for (let at: string | undefined = file; at != null; at = parent.get(at)) chain.push(at);
          report.violations.push({ entry, packageName, chain: chain.reverse() });
        } else if (!visited.has(imp.path)) {
          visited.add(imp.path);
          parent.set(imp.path, file);
          queue.push(imp.path);
        }
      }
    }
    const packageFiles = [...visited].filter(isInNodeModules);
    report.eagerGraphSizes[entry] = {
      projectModules: visited.size - packageFiles.length,
      packages: new Set(packageFiles.map((f) => packageNameOf(f.split("node_modules/").pop()!)))
        .size,
    };
  }
  return report;
}

async function main(): Promise<number> {
  const rootDir = path.resolve(import.meta.dir, "..");
  const report = await analyzeStartupImports({
    rootDir,
    entries: STARTUP_ENTRIES.map((e) => e.entry),
    banned: BANNED_PACKAGES,
  });

  for (const { entry, reason } of STARTUP_ENTRIES) {
    const size = report.eagerGraphSizes[entry];
    console.log(
      `${entry}: ${size.projectModules} eager project modules, ${size.packages} packages (${reason})`
    );
  }
  if (report.violations.length === 0) {
    console.log("✅ No banned packages on the eager startup path");
    return 0;
  }
  for (const violation of report.violations) {
    console.error(`\n❌ ${violation.entry} eagerly loads "${violation.packageName}":`);
    console.error(violation.chain.map((step, i) => `   ${i === 0 ? "" : "→ "}${step}`).join("\n"));
  }
  console.error(
    "\nLoad the module with `await import()` from the code path that needs it" +
      " (see loadServices() in src/desktop/main.ts), or use `import type` for types."
  );
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
