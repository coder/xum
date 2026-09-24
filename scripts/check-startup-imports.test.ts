// Fixture tests for scripts/check-startup-imports.ts. Each test writes a tiny
// project to a temp dir and runs the real analyzer on it. `make
// check-startup-imports` runs this file before the real check (scripts/ tests
// are not part of the `bun test src` lane).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { analyzeStartupImports, isBannedPackage, packageNameOf } from "./check-startup-imports";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "startup-imports-"));
  // Mirror the repo's `@/*` alias so alias edges are followed, not treated as packages.
  await writeFile(
    path.join(rootDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } })
  );
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function writeFiles(files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

async function analyze(entry = "src/entry.ts") {
  return analyzeStartupImports({ rootDir, entries: [entry], banned: ["ai", "@ai-sdk/*"] });
}

test("fails on a banned package reached through static imports, with the chain", async () => {
  await writeFiles({
    "src/entry.ts": 'import { a } from "./a";\nconsole.log(a);\n',
    "src/a.ts": 'import { b } from "@/b";\nexport const a = b;\n',
    "src/b.ts": 'import { streamText } from "ai";\nexport const b = streamText;\n',
  });

  const report = await analyze();

  expect(report.violations).toEqual([
    {
      entry: "src/entry.ts",
      packageName: "ai",
      chain: ["src/entry.ts", "src/a.ts", "src/b.ts", "ai"],
    },
  ]);
});

test("fails on side-effect imports and re-exports of banned scoped packages", async () => {
  await writeFiles({
    "src/entry.ts": 'export * from "./reexport";\nimport "./sideEffect";\n',
    "src/reexport.ts": 'export { createOpenAI } from "@ai-sdk/openai/internal";\n',
    "src/sideEffect.ts": 'import "ai";\n',
  });

  const report = await analyze();

  expect(report.violations.map((v) => v.packageName).sort()).toEqual(["@ai-sdk/openai", "ai"]);
});

test("fails when an allowed package loads a banned one", async () => {
  await writeFiles({
    "src/entry.ts": 'import { wrap } from "wrapper-pkg";\nconsole.log(wrap);\n',
    "node_modules/wrapper-pkg/package.json": JSON.stringify({
      name: "wrapper-pkg",
      main: "index.js",
    }),
    // CommonJS packages load dependencies with require(), which counts as eager there.
    "node_modules/wrapper-pkg/index.js":
      'const ai = require("ai");\nexports.wrap = ai.streamText;\n',
  });

  const report = await analyze();

  expect(report.violations).toEqual([
    {
      entry: "src/entry.ts",
      packageName: "ai",
      chain: ["src/entry.ts", "node_modules/wrapper-pkg/index.js", "ai"],
    },
  ]);
  expect(report.eagerGraphSizes).toEqual({ "src/entry.ts": { projectModules: 1, packages: 1 } });
});

test("follows the CommonJS export branch that the built main process loads", async () => {
  await writeFiles({
    "src/entry.ts": 'import { wrap } from "dual-pkg";\nconsole.log(wrap);\n',
    "node_modules/dual-pkg/package.json": JSON.stringify({
      name: "dual-pkg",
      exports: { import: "./clean.mjs", require: "./heavy.cjs" },
    }),
    "node_modules/dual-pkg/clean.mjs": "export const wrap = 1;\n",
    "node_modules/dual-pkg/heavy.cjs": 'exports.wrap = require("ai").streamText;\n',
  });

  const report = await analyze();

  expect(report.violations.map((v) => v.chain)).toEqual([
    ["src/entry.ts", "node_modules/dual-pkg/heavy.cjs", "ai"],
  ]);
});

test("detects a banned package reached through a package alias", async () => {
  await writeFiles({
    "src/entry.ts": 'import { wrap } from "alias-pkg";\nconsole.log(wrap);\n',
    "node_modules/alias-pkg/package.json": JSON.stringify({
      name: "alias-pkg",
      main: "index.js",
      imports: { "#model": "ai" },
    }),
    "node_modules/alias-pkg/index.js": 'exports.wrap = require("#model").streamText;\n',
    "node_modules/ai/package.json": JSON.stringify({ name: "ai", main: "index.js" }),
    "node_modules/ai/index.js": "exports.streamText = 1;\n",
  });

  const report = await analyze();

  expect(report.violations.map((v) => v.chain)).toEqual([
    ["src/entry.ts", "node_modules/alias-pkg/index.js", "node_modules/ai/index.js"],
  ]);
});

test("a lazy import does not make an elided static import of the same package eager", async () => {
  await writeFiles({
    "src/entry.ts": [
      'import { streamText } from "ai";',
      "export let fn: typeof streamText | undefined;",
      'export const load = () => import("ai");',
      "",
    ].join("\n"),
  });

  const report = await analyze();

  expect(report.violations).toEqual([]);
});

test("passes when banned packages are only reached lazily or as types", async () => {
  await writeFiles({
    "src/entry.ts": [
      'import type { LanguageModel } from "ai";',
      'import { type Tool } from "@ai-sdk/openai";',
      // A value import used only in type positions is elided by tsc and esbuild alike.
      'import { streamText } from "ai";',
      "export let model: LanguageModel | Tool | typeof streamText | undefined;",
      'export const load = () => import("./lazy");',
      'export const route = () => require("./routed");',
      "",
    ].join("\n"),
    "src/lazy.ts": 'import { streamText } from "ai";\nexport const s = streamText;\n',
    "src/routed.ts":
      'import { createOpenAI } from "@ai-sdk/openai";\nexport const c = createOpenAI;\n',
  });

  const report = await analyze();

  expect(report.violations).toEqual([]);
  expect(report.eagerGraphSizes).toEqual({ "src/entry.ts": { projectModules: 1, packages: 0 } });
});

test("package matching handles subpaths and scopes", () => {
  expect(packageNameOf("@ai-sdk/openai/internal")).toBe("@ai-sdk/openai");
  expect(packageNameOf("ai/rsc")).toBe("ai");
  expect(isBannedPackage("@ai-sdk/openai", ["@ai-sdk/*"])).toBe(true);
  expect(isBannedPackage("ai-tokenizer", ["ai"])).toBe(false);
  expect(isBannedPackage("@ai-sdk-extra/x", ["@ai-sdk/*"])).toBe(false);
});
