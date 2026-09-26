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
    reported(
      `import { restoreModulesAfterSuite } from "../tests/ui/moduleMocks"; restoreModulesAfterSuite([["a", real]]); mock.module("a", () => ({}));`
    )
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
      afterAll(() => { for (const p of PATHS) mock.module(p, () => real); });
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

test("helper installs belong to the suites that call them", () => {
  expect(
    reported(`
      function install() { mock.module("a", () => ({})); }
      describe("restores", () => {
        beforeEach(install);
        afterEach(() => { mock.module("a", () => real); });
      });
    `)
  ).toEqual([]);
  expect(
    reported(`
      function install() { mock.module("a", () => ({})); }
      describe("earlier", () => { afterEach(() => { mock.module("a", () => real); }); });
      describe("later", () => { beforeEach(() => install()); });
    `)
  ).toEqual(["a"]);
});

test("restores that never run do not count", () => {
  expect(
    reported(`
      mock.module("a", () => ({}));
      describe.skip("skipped", () => { afterAll(() => { mock.module("a", () => real); }); });
    `)
  ).toEqual(["a"]);
  expect(
    reported(`
      import { restoreModulesAfterSuite } from "../tests/ui/moduleMocks";
      function registerCleanup() { restoreModulesAfterSuite([["a", real]]); }
      beforeEach(() => { mock.module("a", () => ({})); });
    `)
  ).toEqual(["a"]);
});

test("a local look-alike of restoreModulesAfterSuite restores nothing", () => {
  expect(
    reported(`
      function restoreModulesAfterSuite(entries) {}
      restoreModulesAfterSuite([["a", real]]);
      mock.module("a", () => ({}));
    `)
  ).toEqual(["a"]);
});

test("describe callbacks passed by name are suites", () => {
  expect(
    reported(`
      function restores() { afterEach(() => { mock.module("a", () => real); }); }
      function leaks() { beforeEach(() => { mock.module("a", () => ({})); }); }
      describe("restores", restores);
      describe("leaks", leaks);
    `)
  ).toEqual(["a"]);
});

test("code that never runs is not checked", () => {
  expect(
    reported(`
      function register(p) { mock.module(p, () => ({})); }
      function skipped() { beforeEach(() => register(pathFromSomewhere())); }
      describe.skip("skipped", skipped);
    `)
  ).toEqual([]);
});

// #4660: the rule stays sound in the conservative direction. Installs over-approximate and
// restores under-approximate, so a restore that might not run, or might not cover every
// specifier, restores nothing.
test("a restore list that is mutated or escapes proves nothing", () => {
  const importLine = `import { restoreModulesAfterSuite } from "../tests/ui/moduleMocks";`;
  expect(
    reported(`${importLine}
      const entries = [["a", real]];
      restoreModulesAfterSuite(entries);
      entries.length = 0;
      mock.module("a", () => ({}));
    `)
  ).toEqual(["a"]);
  expect(
    reported(`${importLine}
      const entries = [["a", real]];
      restoreModulesAfterSuite(entries);
      for (const entry of entries) entry[0] = "b";
      mock.module("a", () => ({}));
    `)
  ).toEqual(["a"]);
  // A copy shares the tuples, so `copy[0][0] = "b"` rewrites the restore list too.
  expect(
    reported(`${importLine}
      const entries = [["a", real]];
      restoreModulesAfterSuite(entries);
      const copy = [...entries];
      mock.module("a", () => ({}));
    `)
  ).toEqual(["a"]);
});

test("a restore behind a filter restores nothing; a filtered install installs every candidate", () => {
  expect(
    reported(`
      const PATHS = ["a", "b"];
      beforeEach(() => { for (const p of PATHS) mock.module(p, () => ({})); });
      afterAll(() => { for (const p of PATHS) if (p === "a") mock.module(p, () => real); });
    `)
  ).toEqual(["a", "b"]);
  expect(
    reported(`
      const PATHS = ["a", "b"];
      beforeEach(() => { for (const p of PATHS) { if (p !== "a") continue; mock.module(p, () => real); } });
      afterAll(() => { mock.module("a", () => real); });
    `)
  ).toEqual(["b"]);
  expect(
    reported(`
      function restore() { mock.module("a", () => real); }
      beforeEach(() => { mock.module("a", () => ({})); });
      afterEach(() => { if (flag) restore(); });
    `)
  ).toEqual(["a"]);
  expect(
    reported(`
      mock.module("a", () => ({}));
      afterAll(() => { for (const x of []) mock.module("a", () => real); });
    `)
  ).toEqual(["a"]);
  // Restoring once suffices: one sure call site makes a helper's restore count.
  expect(
    reported(`
      function restore() { mock.module("a", () => real); }
      mock.module("a", () => ({}));
      afterAll(restore);
      if (flag) afterAll(restore);
      describe("skipped", () => { afterEach(restore); test.skip("x", () => {}); });
    `)
  ).toEqual([]);
});

test("afterEach restores in a suite whose tests are all skipped never run", () => {
  expect(
    reported(`
      mock.module("a", () => ({}));
      describe("skipped tests", () => {
        afterEach(() => { mock.module("a", () => real); });
        test.skip("x", () => {});
      });
    `)
  ).toEqual(["a"]);
  expect(
    reported(`
      mock.module("a", () => ({}));
      afterEach(() => { mock.module("a", () => real); });
      test.each([])("x %p", () => {});
    `)
  ).toEqual(["a"]);
  // Tests the rule cannot see may run, so their afterEach restores count.
  expect(
    reported(`
      import { test as t } from "bun:test";
      mock.module("a", () => ({}));
      function nested() { test("x", () => {}); }
      describe("outer", () => {
        afterEach(() => { mock.module("a", () => real); });
        describe("inner", nested);
      });
      describe("one-arg", () => { afterEach(() => { mock.module("a", () => real); }); test(() => {}); });
      describe("aliased", () => { afterEach(() => { mock.module("a", () => real); }); t("x", () => {}); });
    `)
  ).toEqual([]);
  expect(
    reported(`
      mock.module("a", () => ({}));
      describe("outer", () => {
        afterEach(() => { mock.module("a", () => real); });
        describe("inner", () => { test.skip("x", () => {}); });
      });
    `)
  ).toEqual(["a"]);
  // bun still runs afterAll for such a suite.
  expect(
    reported(`
      mock.module("a", () => ({}));
      describe("skipped tests", () => {
        afterAll(() => { mock.module("a", () => real); });
        test.skip("x", () => {});
      });
    `)
  ).toEqual([]);
});

test("a helper called at load and from a scoped hook needs coverage in both contexts", () => {
  expect(
    reported(`
      function install() { mock.module("a", () => ({})); }
      install();
      describe("earlier", () => { afterEach(() => { mock.module("a", () => real); }); });
      describe("later", () => { beforeEach(install); });
    `)
  ).toEqual(["a"]);
});

test("a helper passed around dynamically needs a file-scope restore", () => {
  expect(
    reported(`
      function install() { mock.module("a", () => ({})); }
      describe("suite", () => {
        afterEach(() => { mock.module("a", () => real); });
        test("t", () => { runLater(install); });
      });
    `)
  ).toEqual(["a"]);
  expect(
    reported(`
      function install() { mock.module("a", () => ({})); }
      describe("suite", () => { test("t", () => { runLater(install); }); });
      afterAll(() => { mock.module("a", () => real); });
    `)
  ).toEqual([]);
});
