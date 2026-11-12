import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

// Babel's first transform wraps Error.prepareStackTrace and raises Error.stackTraceLimit, both
// process-wide. Bun's own prepareStackTrace refuses a non-Error first argument, so once Babel has
// wrapped it, `Error.captureStackTrace({})` throws "First argument must be an Error object".
// undici's fetch() calls exactly that on every rejection, so a later test file in the same
// process saw that TypeError, with no cause, instead of its own rejection (the brotli guard test,
// once WorkspaceShell.test.tsx ran before it in its shard).
//
// Each case runs in a fresh process because the check cannot hold in this one. Babel installs
// its wrapper only on its first transform, so a transform that ran earlier in this process hides a
// helper that no longer puts the hooks back, and so does a hook that an earlier file installed
// (source-map-support's, which src/cli/cli.test.ts loads: Babel then wraps that hook, which
// accepts a plain object). The cases differ in how the first transform ends, because that first
// transform is the only one that can leave the hooks changed.
function problemsAfterFirstTransform(mode: "succeeds" | "throws"): string[] {
  const script = `
    import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { compileWithReactCompiler } from "./tests/ui/reactCompiledModule";

    const hook = (name: string): unknown => Object.getOwnPropertyDescriptor(Error, name)?.value;
    const before = { prepare: hook("prepareStackTrace"), limit: hook("stackTraceLimit") };
    const problems: string[] = [];

    const dir = mkdtempSync(path.join(tmpdir(), "react-compiled-module-"));
    try {
      const source = path.join(dir, "module.ts");
      writeFileSync(source, ${JSON.stringify(mode === "throws" ? "export const = ;" : "export const answer = 42;")});
      try {
        compileWithReactCompiler(source);
        if (${JSON.stringify(mode)} === "throws") problems.push("a syntax error did not throw");
      } catch (error) {
        if (${JSON.stringify(mode)} !== "throws") problems.push("the transform threw: " + String(error));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    try {
      Error.captureStackTrace({});
    } catch (error) {
      problems.push("Error.captureStackTrace({}) threw: " + (error as Error).message);
    }
    if (hook("prepareStackTrace") !== before.prepare) problems.push("prepareStackTrace changed");
    if (hook("stackTraceLimit") !== before.limit) problems.push("stackTraceLimit changed");
    console.log(JSON.stringify(problems));
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (child.status !== 0) {
    throw new Error(`the child process failed (${String(child.status)}): ${child.stderr}`);
  }
  return JSON.parse(child.stdout.trim().split("\n").pop() ?? "") as string[];
}

test.each(["succeeds", "throws"] as const)(
  "a first React Compiler transform that %s leaves the stack trace hooks as they were",
  (mode) => {
    expect(problemsAfterFirstTransform(mode)).toEqual([]);
  },
  30_000
);

// tests/ui/reactCompiledModule.ts is the one place that runs Babel and puts the hooks back, so
// any other file that imports @babel/core runs Babel without that. The earlier cases cannot
// see such a file once any transform or the source-map-support hook came first in the process.
// scripts/check_react_compiler_coverage.ts is allowed: only its Makefile target runs it, in its
// own process, never inside a test process.
const MAY_IMPORT_BABEL_CORE = new Set([
  "tests/ui/reactCompiledModule.ts",
  "scripts/check_react_compiler_coverage.ts",
]);
const BABEL_CORE_SPECIFIER = /["']@babel\/core(?:\/[^"']*)?["']/;
const SCANNED_ROOTS = ["src", "tests", "scripts", "vscode/src"];

test("no file except the React Compiler helper imports @babel/core", async () => {
  const scanned = new Set<string>();
  const importers: string[] = [];
  for (const root of SCANNED_ROOTS) {
    // One glob per root: a glob with a `/` inside its braces matches nothing in Bun.
    const files = new Bun.Glob(`${root}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`);
    for await (const file of files.scan({ cwd: REPO_ROOT })) {
      scanned.add(file);
      if (MAY_IMPORT_BABEL_CORE.has(file)) continue;
      if (BABEL_CORE_SPECIFIER.test(await Bun.file(path.join(REPO_ROOT, file)).text())) {
        importers.push(file);
      }
    }
  }
  // A scan that finds nothing would pass for the wrong reason: it must see the allowed files.
  for (const allowed of MAY_IMPORT_BABEL_CORE) expect(scanned.has(allowed)).toBe(true);
  expect(importers.sort()).toEqual([]);
}, 30_000);
