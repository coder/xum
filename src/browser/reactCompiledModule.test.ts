import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
// any other file that mentions @babel/core may run Babel without that. The cases above cannot
// see such a file once any transform or the source-map-support hook came first in the process.
// The match is a plain substring, so a quoted import, a template literal and a subpath all count,
// and so does a comment: name the package elsewhere in other words. Allowed files: the helper,
// this file (it names the package to look for), and scripts/check_react_compiler_coverage.ts,
// because only its Makefile target runs it, in its own process, never inside a test process.
const MAY_NAME_BABEL_CORE = new Set([
  "tests/ui/reactCompiledModule.ts",
  "src/browser/reactCompiledModule.test.ts",
  "scripts/check_react_compiler_coverage.ts",
]);
const SCANNED_ROOTS = ["src", "tests", "scripts", "vscode/src"];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// Reads the files on disk, not `git ls-files`: some jobs test without a git checkout. Vendored
// code is skipped without being walked: `make check-docs-links` leaves scripts/mintlify/node_modules
// (jiti alone has 35,000 files, and jiti bundles its own Babel), and dot folders hold tool output.
function sourceFilesUnder(repoRoot: string, dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        files.push(...sourceFilesUnder(repoRoot, relative));
      }
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

function scanForBabelCore(repoRoot: string): { scanned: Set<string>; mentions: string[] } {
  const scanned = new Set<string>();
  const mentions: string[] = [];
  for (const root of SCANNED_ROOTS) {
    if (!existsSync(path.join(repoRoot, root))) continue;
    for (const file of sourceFilesUnder(repoRoot, root)) {
      scanned.add(file);
      if (readFileSync(path.join(repoRoot, file), "utf8").includes("@babel/core")) {
        mentions.push(file);
      }
    }
  }
  return { scanned, mentions: mentions.sort() };
}

test("no source file on disk except the React Compiler helper names @babel/core", () => {
  const { scanned, mentions } = scanForBabelCore(REPO_ROOT);
  // A scan that finds nothing would pass for the wrong reason: it must see the allowed files.
  for (const allowed of MAY_NAME_BABEL_CORE) expect(scanned.has(allowed)).toBe(true);
  expect(mentions.filter((file) => !MAY_NAME_BABEL_CORE.has(file))).toEqual([]);
}, 30_000);

test("the scan skips node_modules and dot folders and finds a mention anywhere else", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "babel-core-scan-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), text);
    };
    write("src/found.ts", "export const a = `@babel/core`;");
    write("scripts/deep/er/found.mjs", "import 'x'; // @babel/core/lib/errors");
    write("tests/clean.ts", "export const b = 1;");
    write("scripts/mintlify/node_modules/jiti/dist/babel.js", 'require("@babel/core");');
    write("src/node_modules/dep/index.ts", 'import "@babel/core";');
    write("tests/.e2e/output.ts", 'import "@babel/core";');
    write("src/readme.md", "@babel/core");

    expect(scanForBabelCore(fixture).mentions).toEqual([
      "scripts/deep/er/found.mjs",
      "src/found.ts",
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
