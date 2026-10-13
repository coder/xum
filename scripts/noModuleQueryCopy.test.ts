// Cases for the `local/no-module-query-copy` rule in eslint.config.mjs, which keeps test files
// from loading second copies of repo modules: Bun's LCOV keeps only the last-loaded copy of a
// file, so a copy made CI coverage of the module depend on shard order (#6339).
import { expect, test } from "bun:test";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

function findRule(): Rule.RuleModule {
  for (const entry of config) {
    const plugin = entry.plugins?.local as { rules?: Record<string, Rule.RuleModule> } | undefined;
    const rule = plugin?.rules?.["no-module-query-copy"];
    if (rule) {
      return rule;
    }
  }
  throw new Error("local/no-module-query-copy is not registered in eslint.config.mjs");
}

const linter = new Linter({ configType: "flat" });

function reportCount(code: string, allow: Record<string, string[]> = {}): number {
  const lintConfig = [
    {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser },
      plugins: { local: { rules: { "no-module-query-copy": findRule() } } },
      rules: { "local/no-module-query-copy": ["error", { allow }] as ["error", unknown] },
    },
  ];
  return linter.verify(code, lintConfig, "case.test.ts").length;
}

test("reports query copies of alias and relative repo modules", () => {
  expect(reportCount(`require("@/browser/stores/WorkspaceStore?real=1");`)).toBe(1);
  expect(reportCount(`const m = require("./Dialog?fresh=1") as unknown;`)).toBe(1);
  expect(reportCount(`void import("../App?prefetch=browser");`)).toBe(1);
});

test("allows plain repo specifiers and package query copies", () => {
  expect(reportCount(`require("@/browser/stores/WorkspaceStore");`)).toBe(0);
  expect(reportCount(`require("react-dnd?real=1");`)).toBe(0);
});

test("allows only the listed specifiers of the listed file", () => {
  const allow = { "case.test.ts": ["./Dialog?real=1"] };
  expect(reportCount(`require("./Dialog?real=1");`, allow)).toBe(0);
  expect(reportCount(`require("./Dialog?real=2");`, allow)).toBe(1);
  expect(reportCount(`require("./Dialog?real=1");`, { "other.test.ts": ["./Dialog?real=1"] })).toBe(
    1
  );
});
