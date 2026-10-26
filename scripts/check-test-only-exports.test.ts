// Tests for scripts/check-test-only-exports.ts. `make check-test-only-exports` runs this file
// before the real check (scripts/ tests are not part of the `bun test src` lane).
import { expect, test } from "bun:test";
import {
  checkExports,
  collectModuleFacts,
  findUnreferencedExports,
  hasImportedExports,
  resolveSpecifier,
  type ModuleFacts,
} from "./check-test-only-exports";

/** Unreferenced exports (`file#name`) of a set of production files. */
function unreferenced(files: Record<string, string>): string[] {
  const facts = new Map<string, ModuleFacts>();
  for (const [file, text] of Object.entries(files)) facts.set(file, collectModuleFacts(file, text));
  const names = Object.keys(files);
  return findUnreferencedExports(facts, names, names).map((hit) => `${hit.file}#${hit.symbol}`);
}

test("flags an export that no production file imports or uses", () => {
  // Tests are never parsed, so an export only a test imports looks exactly like this.
  expect(
    unreferenced({
      "src/a.ts": "export function used() {}\nexport function testOnly() {}",
      "src/b.ts": 'import { used } from "./a";\nused();',
    })
  ).toEqual(["src/a.ts#testOnly"]);
});

test("counts a use in the export's own file, but not a property with the same name", () => {
  expect(
    unreferenced({
      "src/a.ts": [
        "export const LIMIT = 3;",
        "export function inner() {}",
        "export function outer() { return inner() + LIMIT; }",
        "export const lone = 1;",
        "const o = { lone: 2 };",
        "o.lone;",
        "const { lone: renamed } = o;",
      ].join("\n"),
      "src/b.ts": 'import { outer } from "@/a";\nouter();',
    })
  ).toEqual(["src/a.ts#lone"]);
});

test("follows named and star re-exports through barrels", () => {
  expect(
    unreferenced({
      "src/lib/a.ts": "export const viaStar = 1;\nexport const viaName = 2;\nexport default 3;",
      "src/lib/index.ts":
        'export * from "./a";\nexport { viaName as renamed, default } from "./a";',
      "src/b.ts": 'import { viaStar, renamed } from "./lib";\nviaStar + renamed;',
    })
  ).toEqual(["src/lib/a.ts#default"]);
  // `export *` does not forward `default`.
  expect(
    unreferenced({
      "src/a.ts": "export default 1;",
      "src/index.ts": 'export * from "./a";',
      "src/b.ts": 'import x from "./index";\nx;',
    })
  ).toEqual(["src/a.ts#default"]);
});

test("treats namespace, dynamic, require and import-type uses as references", () => {
  const target = "export const a = 1;\nexport const b = 2;";
  expect(unreferenced({ "src/t.ts": target, "src/u.ts": 'import * as t from "./t";\nt;' })).toEqual(
    []
  );
  expect(
    unreferenced({ "src/t.ts": target, "src/u.ts": 'const lazy = () => import("./t");' })
  ).toEqual([]);
  expect(unreferenced({ "src/t.ts": target, "src/u.ts": 'requireDesktopModule("./t");' })).toEqual(
    []
  );
  expect(
    unreferenced({ "src/t.ts": target, "src/u.ts": 'type A = typeof import("./t").a;' })
  ).toEqual(["src/t.ts#b"]);
  expect(
    unreferenced({ "src/t.ts": "export default 1;", "src/u.ts": 'import d from "./t";\nd;' })
  ).toEqual([]);
  // A side-effect import uses no export.
  expect(unreferenced({ "src/t.ts": target, "src/u.ts": 'import "./t";' })).toEqual([
    "src/t.ts#a",
    "src/t.ts#b",
  ]);
});

test("reports every exported declaration form once", () => {
  expect(
    unreferenced({
      "src/a.ts": [
        "export function over(x: string): void;",
        "export function over(x: unknown) {}",
        "export const { d1, d2: d3 } = { d1: 1, d2: 2 };",
        "export interface I {}",
        "export type T = 1;",
        "export enum E { A }",
        "export class C {}",
        "const local = 1;",
        "export { local as aliased };",
        'export * as ns from "./b";',
      ].join("\n"),
      "src/b.ts": "export const used = 1;",
    })
  ).toEqual([
    "src/a.ts#over",
    "src/a.ts#d1",
    "src/a.ts#d3",
    "src/a.ts#I",
    "src/a.ts#T",
    "src/a.ts#E",
    "src/a.ts#C",
    "src/a.ts#aliased",
    "src/a.ts#ns",
  ]);
});

test("resolves the @/ alias, relative paths, ESM .js suffixes and index files", () => {
  const known = new Set(["src/a/b.ts", "src/a/index.tsx", "src/c.js"]);
  expect(resolveSpecifier("@/a/b", "src/x.ts", known)).toBe("src/a/b.ts");
  expect(resolveSpecifier("./b.js", "src/a/x.ts", known)).toBe("src/a/b.ts");
  expect(resolveSpecifier("../a", "src/z/x.ts", known)).toBe("src/a/index.tsx");
  expect(resolveSpecifier("./c.js", "src/x.ts", known)).toBe("src/c.js");
  expect(resolveSpecifier("zod", "src/x.ts", known)).toBeUndefined();
});

test("skips workflow scripts, whose exports the workflow runtime reads", () => {
  expect(hasImportedExports("src/node/builtinSkills/deep-research/workflow.js")).toBe(false);
  expect(hasImportedExports("src/node/builtinSkills/index.ts")).toBe(true);
  expect(hasImportedExports("src/node/services/x.js")).toBe(true);
});

test("reports unlisted findings, stale and duplicate entries, and pendingDeletion growth", () => {
  const finding = (symbol: string) => ({ file: "src/a.ts", symbol, line: 1 });
  const entry = (symbol: string) => ({ file: "src/a.ts", symbol, reason: "r" });
  const pending = (symbol: string) => ({ ...entry(symbol), owner: "o" });
  const result = checkExports(
    [finding("allowed"), finding("fresh"), finding("pending"), finding("newPending")],
    {
      allowed: [entry("allowed"), entry("gone"), entry("allowed")],
      pendingDeletion: [pending("pending"), pending("newPending")],
    },
    ["src/a.ts#pending", "src/a.ts#deleted"]
  );
  expect(result.unlisted.map((hit) => hit.symbol)).toEqual(["fresh"]);
  expect(result.stale.map((hit) => hit.symbol)).toEqual(["gone"]);
  expect(result.duplicates.map((hit) => hit.symbol)).toEqual(["allowed"]);
  expect(result.unfrozen.map((hit) => hit.symbol)).toEqual(["newPending"]);
  expect(result.thawed).toEqual(["src/a.ts#deleted"]);
});
