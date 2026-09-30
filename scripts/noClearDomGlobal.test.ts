// Cases for the `local/no-clear-dom-global` rule in eslint.config.mjs, which keeps test files
// from leaving DOM globals undefined for later files in the same bun process (#5084).
import { expect, test } from "bun:test";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";
import { DOM_GLOBAL_NAMES } from "../tests/ui/domGlobals";

function findRule(): Rule.RuleModule {
  for (const entry of config) {
    const plugin = entry.plugins?.local as { rules?: Record<string, Rule.RuleModule> } | undefined;
    const rule = plugin?.rules?.["no-clear-dom-global"];
    if (rule) {
      return rule;
    }
  }
  throw new Error("local/no-clear-dom-global is not registered in eslint.config.mjs");
}

const linter = new Linter({ configType: "flat" });
const lintConfig = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { local: { rules: { "no-clear-dom-global": findRule() } } },
    rules: { "local/no-clear-dom-global": "error" as const },
  },
];

function reportCount(code: string): number {
  return linter.verify(code, lintConfig, "case.test.ts").length;
}

test("reports clearing every global that saveDomGlobals() restores", () => {
  for (const name of DOM_GLOBAL_NAMES) {
    expect({ name, count: reportCount(`globalThis.${name} = undefined;`) }).toEqual({
      name,
      count: 1,
    });
  }
});

test("reports the cast, computed and void forms used in tests", () => {
  expect(
    reportCount(`globalThis.window = undefined as unknown as Window & typeof globalThis;`)
  ).toBe(1);
  expect(
    reportCount(`(globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = undefined;`)
  ).toBe(1);
  expect(reportCount(`global["document"] = void 0;`)).toBe(1);
});

test("allows restoring saved values, other globals and deletes", () => {
  expect(reportCount(`globalThis.window = previousWindow;`)).toBe(0);
  expect(reportCount(`globalThis.AI_SDK_LOG_WARNINGS = undefined;`)).toBe(0);
  expect(reportCount(`window.onerror = undefined;`)).toBe(0);
  expect(reportCount(`delete (globalThis as { Image?: unknown }).Image;`)).toBe(0);
});
