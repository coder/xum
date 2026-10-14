import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

// The rule is defined inline in eslint.config.mjs; lint snippets with only that rule enabled.
const localPlugin = (config as { plugins?: Record<string, unknown> }[]).find(
  (entry) => entry.plugins?.local !== undefined
)?.plugins?.local;

function lint(code: string): string[] {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tseslint.parser as Linter.Parser },
        plugins: { local: localPlugin as never },
        rules: { "local/no-direct-web-storage": "error" },
      },
    ],
    "src/browser/example.ts"
  );
  return messages.map((message) => message.ruleId ?? message.message);
}

describe("local/no-direct-web-storage", () => {
  test.each([
    "window.localStorage.getItem('k');",
    "const { localStorage: s } = window;",
    "const { localStorage: s } = window as Window;",
    "const { localStorage: s } = window!;",
    "const { sessionStorage: s } = globalThis satisfies typeof globalThis;",
    "let s: Storage; ({ localStorage: s } = (window as Window));",
    "(window as Window).localStorage.getItem('k');",
    "window!.sessionStorage.clear();",
  ])("reports %s", (code) => {
    expect(lint(code)).toEqual(["local/no-direct-web-storage"]);
  });

  test("allows a local variable named storage", () => {
    expect(lint("function f(storage: Storage) { return storage.getItem('k'); }")).toEqual([]);
  });
});
