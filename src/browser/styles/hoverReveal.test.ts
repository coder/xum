import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postcss, { AtRule, type Node, type Rule } from "postcss";

// iOS applies :hover on the tap itself. When that hover reveals a hidden element (opacity,
// visibility or display), WebKit treats the tap as a hover and drops its click, so the control
// takes two taps. Tailwind's `hover:` and `group-hover:` variants already sit inside
// `@media (hover: hover)`; arbitrary `[&:hover_…]` variants and hand-written CSS do not.
const BROWSER_ROOT = path.join(import.meta.dir, "..");
const REVEAL_UTILITY =
  /^!?(opacity-|visible$|invisible$|hidden$|block$|flex$|inline|grid$|contents$)/;
const REVEAL_PROPERTY = new Set(["opacity", "visibility", "display"]);
const HOVER_MEDIA_VARIANT = "[@media(hover:hover)]:";

function sourceFiles(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !/\.(test|stories)\.tsx?$/.test(file));
}

function insideHoverMedia(rule: Rule): boolean {
  for (let node: Node | undefined = rule.parent; node != null; node = node.parent) {
    if (
      node instanceof AtRule &&
      node.name === "media" &&
      /\(\s*hover\s*:\s*hover\s*\)/.test(node.params)
    ) {
      return true;
    }
  }
  return false;
}

describe("hover reveals", () => {
  test("class names gate arbitrary :hover reveals on hover-capable pointers", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(BROWSER_ROOT, [".ts", ".tsx"])) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /[^\s"'`]*\[[^\]\s"'`]*:hover[^\]\s"'`]*\]:([^\s"'`]+)/g
      )) {
        const [token, utility] = match;
        if (REVEAL_UTILITY.test(utility) && !token.includes(HOVER_MEDIA_VARIANT)) {
          offenders.push(`${path.relative(BROWSER_ROOT, file)}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("stylesheets gate :hover reveals on hover-capable pointers", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(BROWSER_ROOT, [".css"])) {
      postcss.parse(readFileSync(file, "utf8")).walkRules((rule) => {
        if (!rule.selector.includes(":hover") || insideHoverMedia(rule)) return;
        rule.walkDecls((decl) => {
          if (REVEAL_PROPERTY.has(decl.prop)) {
            offenders.push(
              `${path.relative(BROWSER_ROOT, file)}: ${rule.selector} { ${decl.prop} }`
            );
          }
        });
      });
    }
    expect(offenders).toEqual([]);
  });
});
