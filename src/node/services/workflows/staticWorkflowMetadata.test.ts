import { describe, expect, test } from "bun:test";
import { isStaticMetadataBindingImmutable } from "./staticWorkflowMetadata";

// isStaticMetadataBindingImmutable must ignore `meta` inside a regex literal but
// count a real `meta` identifier. Telling the two apart needs the "/" lexer rule
// that follows a "}" or a ")": after a block or a control header a "/" opens a
// regex, after an object literal or a call it is division. Each case puts
// `/meta/` in that position, so a regex reading returns true (the only `meta`
// is masked) and a division reading returns false (`meta` is an identifier).
// Division cases end in `/ 2` so a wrong regex reading would find a closing "/"
// on the line and mask `meta`.

const DECLARATION = "export const meta = { name: 'demo' };";

function immutableWith(statement: string): boolean {
  return isStaticMetadataBindingImmutable(`${DECLARATION}\n${statement}\n`);
}

describe("isStaticMetadataBindingImmutable regex detection", () => {
  test("baseline: a bare meta mention after the declaration makes it mutable", () => {
    expect(isStaticMetadataBindingImmutable(DECLARATION)).toBe(true);
    expect(immutableWith("console.log(meta);")).toBe(false);
  });

  describe("after a closing brace", () => {
    test.each([
      ["a function body", "function f() {}\n/meta/.test(s);"],
      ["an arrow function body", "const f = () => {}\n/meta/.test(s);"],
      ["a block after a statement end", "x(); {}\n/meta/.test(s);"],
      ["a nested block", "{ {} /meta/.test(s); }"],
      ["a block after a block", "{} {}\n/meta/.test(s);"],
      ["an else block", "if (a) {} else {}\n/meta/.test(s);"],
      ["a block with no matching open brace", "}\n/meta/.test(s);"],
    ])("treats / after %s as a regex", (_label, statement) => {
      expect(immutableWith(statement)).toBe(true);
    });

    test.each([
      ["an assigned object literal", "const v = {} / meta / 2;"],
      ["an object literal argument", "f({} / meta / 2);"],
      ["an object literal after return", "function g() { return {} / meta / 2; }"],
      ["an object literal after typeof", "const t = typeof {} / meta / 2;"],
      ["an object literal after an operator", "const u = a || {} / meta / 2;"],
    ])("treats / after %s as division", (_label, statement) => {
      expect(immutableWith(statement)).toBe(false);
    });

    test("treats a block at the very start of the file as a block", () => {
      expect(isStaticMetadataBindingImmutable(`{}\n/meta/.test(s);\n${DECLARATION}`)).toBe(true);
    });
  });

  describe("after a closing parenthesis", () => {
    test.each(["if", "while", "for", "switch", "with"])(
      "treats / after a %s header as a regex",
      (keyword) => {
        expect(immutableWith(`${keyword} (x) /meta/.test(s);`)).toBe(true);
      }
    );

    test("matches the header's own parenthesis past nested calls", () => {
      expect(immutableWith("if (f(x)) /meta/.test(s);")).toBe(true);
    });

    test.each([
      ["a call", "const c = f(x) / meta / 2;"],
      ["a grouping", "const g = (x) / meta / 2;"],
      ["a grouping after an operator", "const h = 1 + (x) / meta / 2;"],
      ["a nested call", "const n = f(g(x)) / meta / 2;"],
    ])("treats / after %s as division", (_label, statement) => {
      expect(immutableWith(statement)).toBe(false);
    });

    test("treats a grouping at the very start of the file as a value", () => {
      expect(isStaticMetadataBindingImmutable(`(x) / meta / 2;\n${DECLARATION}`)).toBe(false);
      expect(isStaticMetadataBindingImmutable(`  (x) / meta / 2;\n${DECLARATION}`)).toBe(false);
    });
  });
});
