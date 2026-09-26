// Cases for the `local/require-module-mock-restore` rule in eslint.config.mjs. The rule's
// call-graph and describe-scope logic decides which bun module mocks count as restored, so its
// false negatives (a leak lint misses) are the regressions worth pinning here.
import { expect, test } from "bun:test";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

function findRule(): Rule.RuleModule {
  for (const entry of config) {
    const plugin = entry.plugins?.local as { rules?: Record<string, Rule.RuleModule> } | undefined;
    const rule = plugin?.rules?.["require-module-mock-restore"];
    if (rule) {
      return rule;
    }
  }
  throw new Error("local/require-module-mock-restore is not registered in eslint.config.mjs");
}

const linter = new Linter({ configType: "flat" });
const lintConfig = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { local: { rules: { "require-module-mock-restore": findRule() } } },
    rules: { "local/require-module-mock-restore": "error" as const },
  },
];

/** Specifiers reported as unrestored (or "<dynamic>"), in source order. */
function reported(code: string): string[] {
  return linter.verify(code, lintConfig, "case.test.ts").map((message) => {
    const match = /^mock\.module\("([^"]+)"\)/.exec(message.message);
    return match
      ? match[1]
      : message.messageId === "dynamicSpecifier"
        ? "<dynamic>"
        : message.message;
  });
}

test("file-scope, hook and helper installs need a restore", () => {
  expect(reported(`mock.module("a", () => ({}));`)).toEqual(["a"]);
  expect(reported(`beforeEach(() => { mock.module("a", () => ({})); });`)).toEqual(["a"]);
  expect(
    reported(`function install() { mock.module("a", () => ({})); } beforeEach(install);`)
  ).toEqual(["a"]);
});

test("restores from afterAll/afterEach, restoreModulesAfterSuite and teardown helpers", () => {
  expect(
    reported(`mock.module("a", () => ({})); afterAll(() => { mock.module("a", () => real); });`)
  ).toEqual([]);
  expect(
    reported(`restoreModulesAfterSuite([["a", real]]); mock.module("a", () => ({}));`)
  ).toEqual([]);
  // Inline and direct-reference hook callbacks, and helpers called from them.
  expect(
    reported(`
      function install() { mock.module("a", () => ({})); }
      function restore() { mock.module("a", () => real); }
      beforeEach(install);
      afterEach(restore);
    `)
  ).toEqual([]);
  expect(
    reported(`
      const restore = async () => { await mock.module("a", () => real); };
      beforeEach(() => { mock.module("a", () => ({})); });
      afterEach(async () => { await restore(); });
    `)
  ).toEqual([]);
});

test("looped specifiers resolve through const arrays", () => {
  expect(
    reported(`
      const PATHS = ["a", "b"];
      beforeEach(() => { for (const p of PATHS) mock.module(p, () => ({})); });
      afterAll(() => { for (const p of [...PATHS]) mock.module(p, () => real); });
    `)
  ).toEqual([]);
  expect(
    reported(`
      const realModules = [["a", {}], ["b", {}]];
      beforeEach(() => { mock.module("a", () => ({})); mock.module("b", () => ({})); });
      afterEach(() => { for (const [p, exports] of realModules) mock.module(p, () => exports); });
    `)
  ).toEqual([]);
  expect(reported(`beforeEach(() => { mock.module(pathFromSomewhere(), () => ({})); });`)).toEqual([
    "<dynamic>",
  ]);
});

test("a helper that setup also calls is an installer, not a restore", () => {
  expect(
    reported(`
      function register(p, exports) { mock.module(p, () => exports); }
      beforeEach(() => register("leaked", {}));
      afterEach(() => register("other", real));
    `)
  ).toEqual(["<dynamic>"]);
});

test("helpers resolve by binding, so a shadowed name does not count as teardown", () => {
  expect(
    reported(`
      function restore() { mock.module("a", () => real); }
      afterEach(() => restore());
      beforeEach(() => {
        function restore() { mock.module("b", () => ({})); }
        restore();
      });
    `)
  ).toEqual(["b"]);
});

test("a restore hook covers only installs inside its describe block", () => {
  expect(
    reported(`
      describe("restores", () => {
        beforeEach(() => { mock.module("a", () => ({})); });
        afterEach(() => { mock.module("a", () => real); });
      });
      describe("leaks", () => {
        beforeEach(() => { mock.module("a", () => ({})); });
      });
    `)
  ).toEqual(["a"]);
  // File-level installs run at load, before every suite, so a describe-level restore covers them.
  expect(
    reported(`
      mock.module("a", () => ({}));
      describe("suite", () => { afterAll(() => { mock.module("a", () => real); }); });
    `)
  ).toEqual([]);
});
