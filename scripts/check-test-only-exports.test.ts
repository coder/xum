// Tests for scripts/check-test-only-exports.ts. `make check-test-only-exports` runs this file
// before the real check (scripts/ tests are not part of the `bun test src` lane).
import { expect, test } from "bun:test";
import {
  checkExports,
  collectModuleFacts,
  findUnreferencedExports,
  isRuntimeContractExport,
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
  // NodeNext sources are imported by their emitted extensions.
  const nodeNext = new Set(["src/m.mts", "src/c.cts"]);
  expect(resolveSpecifier("./m.mjs", "src/x.ts", nodeNext)).toBe("src/m.mts");
  expect(resolveSpecifier("./c.cjs", "src/x.ts", nodeNext)).toBe("src/c.cts");
});

test("exempts only the meta and default exports of workflow scripts", () => {
  const workflow = "src/node/builtinSkills/deep-research/workflow.js";
  expect(isRuntimeContractExport(workflow, "meta")).toBe(true);
  expect(isRuntimeContractExport(workflow, "default")).toBe(true);
  expect(isRuntimeContractExport(workflow, "helper")).toBe(false);
  expect(isRuntimeContractExport("src/node/services/x.js", "default")).toBe(false);
});

test("does not count shadowing bindings or a declaration's own body as uses", () => {
  expect(
    unreferenced({
      "src/a.ts": [
        "export const param = 1;",
        "export const caught = 2;",
        "export const blockLocal = 3;",
        "export type Generic = 4;",
        "export function recursive(n: number): number { return n && recursive(n - 1); }",
        "export class Self { static make() { return new Self(); } }",
        "function f(param: number) { return param; }",
        "try {} catch (caught) { void caught; }",
        "function g() { const blockLocal = 0; return blockLocal; }",
        "function h<Generic>(x: Generic) { return x; }",
        "export const used = 5;",
        "function k(other: number) { return other + used; }",
      ].join("\n"),
    })
  ).toEqual([
    "src/a.ts#param",
    "src/a.ts#caught",
    "src/a.ts#blockLocal",
    "src/a.ts#Generic",
    "src/a.ts#recursive",
    "src/a.ts#Self",
  ]);
});

test("reads CommonJS exports", () => {
  expect(
    unreferenced({
      "src/a.cjs": "exports.one = 1;\nmodule.exports.two = 2;",
      "src/b.cjs": "module.exports = { three: 3, four: 4 };",
      "src/c.cjs": "module.exports = function () {};",
      "src/d.ts": 'import { one, three } from "./a.cjs";\nimport { three as t } from "./b.cjs";',
    })
  ).toEqual(["src/a.cjs#two", "src/b.cjs#four", "src/c.cjs#default"]);
});

test("an explicit barrel export shadows the same name from export *", () => {
  expect(
    unreferenced({
      "src/a.ts": "export const value = 1;",
      "src/index.ts": 'export * from "./a";\nexport const value = 2;',
      "src/b.ts": 'import { value } from "./index";\nvalue;',
    })
  ).toEqual(["src/a.ts#value"]);
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
