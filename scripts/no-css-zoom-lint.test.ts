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
    "const style = { [`zoom`]: 2 };",
    "const a = <div style={{ [`zoom`]: 2 }} />;",
    "element.style.zoom = '2';",
    "element.style['zoom'] = '2';",
    "element.style[`zoom`] = '2';",
    "element.style.setProperty('zoom', '2');",
    "element.style.setProperty('ZOOM', '2');",
    "element.style.setProperty(`zoom`, '2');",
    "element.style.setProperty('-webkit-zoom', '2');",
    "element.style.cssText = 'zoom: 2';",
    "element.style.cssText = 'width:1px;ZOOM : 2';",
    "element.style.cssText = `position:absolute;zoom:${scale}`;",
    "element.style.cssText += 'a:b;' + 'zoom:2';",
    "element.setAttribute('style', 'zoom:2');",
    "element.setAttribute('STYLE', `width:1px; zoom: 2`);",
    'const a = <div className="[zoom:2]" />;',
    'const a = <div className="p-2 md:[zoom:var(--scale)]" />;',
    "const a = <div className={cn('p-2', 'hover:[zoom:2]')} />;",
    "const a = <div className={`p-2 [zoom:2] ${other}`} />;",
    "const a = <div className={cond ? 'p-2' : '[ZOOM:2]'} />;",
  ])("reports %s", (code) => {
    expect(lint(code)).toEqual(["local/no-css-zoom"]);
  });

  test.each([
    "const { zoom } = props;",
    "function f({ zoom }: { zoom: number }) { return zoom; }",
    "interface Frame { zoom: number }",
    "const a = <div style={{ transform: `scale(${zoom})` }} />;",
    "const a = { [zoom]: 1 };",
    "const a = { [`zoom${suffix}`]: 1 };",
    "const a = { [`pinch-zoom`]: 1 };",
    "element.style[`width`] = '2px';",
    "viewer.zoom = 2;",
    "element.style.setProperty('--zoom', '2');",
    "element.style.width = '2px';",
    "element.style.cssText = 'width:2px';",
    "element.setAttribute('style', 'width:2px');",
    "element.setAttribute('data-label', 'zoom: 2');",
    "const label = 'Zoom: 100%';",
    'const a = <div className="zoom-in-95 animate-in" />;',
    'const a = <div className="[--diagram-zoom:2] [transform:scale(2)]" />;',
    "element.style.setProperty('pinch-zoom', '2');",
  ])("allows %s", (code) => {
    expect(lint(code)).toEqual([]);
  });
});
