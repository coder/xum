import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

// The rule is defined in eslint-local-rules.mjs; lint snippets with only that rule enabled.
const localPlugin = (config as { plugins?: Record<string, unknown> }[]).find(
  (entry) => entry.plugins?.local !== undefined
)?.plugins?.local;

function lint(code: string): string[] {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tseslint.parser as Linter.Parser },
        plugins: { local: localPlugin as never },
        rules: { "local/no-css-zoom": "error" },
      },
    ],
    "src/browser/example.tsx"
  );
  return messages.map((message) => message.ruleId ?? message.message);
}

describe("local/no-css-zoom", () => {
  test.each([
    "const a = <div style={{ zoom: 2 }} />;",
    "const a = <div style={{ zoom }} />;",
    "const a = <div style={{ ...base, zoom: scale }} />;",
    "const style: CSSProperties = { 'zoom': 2 };",
    "const style = { ['zoom']: 2 };",
    "element.style.zoom = '2';",
    "element.style['zoom'] = '2';",
    "element.style.setProperty('zoom', '2');",
  ])("reports %s", (code) => {
    expect(lint(code)).toEqual(["local/no-css-zoom"]);
  });

  test.each([
    "const { zoom } = props;",
    "function f({ zoom }: { zoom: number }) { return zoom; }",
    "interface Frame { zoom: number }",
    "const a = <div style={{ transform: `scale(${zoom})` }} />;",
    "const a = { [zoom]: 1 };",
    "viewer.zoom = 2;",
    "element.style.setProperty('--zoom', '2');",
    "element.style.width = '2px';",
  ])("allows %s", (code) => {
    expect(lint(code)).toEqual([]);
  });
});
