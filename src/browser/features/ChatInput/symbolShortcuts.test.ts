import { describe, expect, test } from "bun:test";
import {
  convertSymbolCommandAtCursor,
  convertTerminatedSymbolCommand,
  findSymbolCommandAtCursor,
  getSymbolSuggestions,
} from "@/browser/features/ChatInput/symbolShortcuts";

const bs = String.fromCharCode(92);
const cmd = (name: string) => `${bs}${name}`;
const displays = (partial: string) =>
  getSymbolSuggestions(partial).map((suggestion) => suggestion.display);
const fenced = "```\n" + cmd("sum") + "\n```";

describe("findSymbolCommandAtCursor", () => {
  test.each([
    ["partial command", cmd("al"), 3, { partial: "al", startIndex: 0, endIndex: 3 }],
    ["bare trigger", bs, 1, { partial: "", startIndex: 0, endIndex: 1 }],
    ["caret in a token", cmd("alpha"), 3, { partial: "alpha", startIndex: 0, endIndex: 6 }],
    ["no trigger", "alpha", 5, null],
    ["escaped trigger", `${bs}${bs}alpha`, 7, null],
    ["inline code", "`" + cmd("div") + "`", 5, null],
    ["fenced code", fenced, fenced.indexOf("m") + 1, null],
    ["token outside code", cmd("div"), 4, { partial: "div", startIndex: 0, endIndex: 4 }],
  ])("handles %s", (_name, text, cursor, expected) => {
    expect(findSymbolCommandAtCursor(text, cursor)).toEqual(expected);
  });
});

describe("getSymbolSuggestions", () => {
  test.each([
    ["a", ["alpha", "ast", "approx", "angle"], true],
    ["A", ["Alpha"], true],
    ["in", ["in", "infty", "int"], false],
    ["sub", ["subset", "subseteq"], false],
    ["R", ["R", "Rho", "Rightarrow"], false],
  ])("lists %s commands in the intended order", (partial, names, ordered) => {
    const actual = displays(partial);
    expect(ordered ? actual : actual.sort()).toEqual(
      ordered ? names.map(cmd) : names.map(cmd).sort()
    );
  });

  test.each([
    ["in", "in", "∈"],
    ["to", "to", "→"],
    ["subset", "subset", "⊂"],
    ["a", "alpha", "α"],
  ])("makes %s default to %s", (partial, name, replacement) => {
    expect(getSymbolSuggestions(partial)[0]).toMatchObject({ display: cmd(name), replacement });
  });

  test("keeps suggestion metadata and command names valid", () => {
    const suggestions = getSymbolSuggestions("");
    for (const suggestion of suggestions) {
      expect(suggestion.replacement).toBe(suggestion.description);
      expect(suggestion.display.startsWith(bs)).toBe(true);
    }
    expect(new Set(displays("")).size).toBe(suggestions.length);
  });

  test("returns no suggestions for an unknown prefix", () => {
    expect(getSymbolSuggestions("zzz")).toEqual([]);
  });
});

describe("convertSymbolCommandAtCursor", () => {
  test.each([
    ["lowercase Greek", cmd("alpha"), 6, "α", 1],
    ["uppercase Greek", cmd("Alpha"), 6, "Α", 1],
    ["comparison", cmd("leq"), 4, "≤", 1],
    ["multiplication", cmd("times"), 6, "×", 1],
    ["set", cmd("subseteq"), 9, "⊆", 1],
    ["logic", cmd("implies"), 8, "⟹", 1],
    ["arrow", cmd("rightarrow"), 11, "→", 1],
    ["currency", cmd("euro"), 5, "€", 1],
    ["cryptocurrency", cmd("bitcoin"), 8, "₿", 1],
    ["big operator", cmd("sum"), 4, "∑", 1],
    ["surrounding text", `x ${cmd("geq")}`, 6, "x ≥", 3],
    ["unambiguous prefix collision", cmd("int"), 4, "∫", 1],
    ["unambiguous word", cmd("top"), 4, "⊤", 1],
  ])("converts %s", (_name, input, cursor, text, nextCursor) => {
    expect(convertSymbolCommandAtCursor(input, cursor)).toEqual({ text, cursor: nextCursor });
  });

  test.each([
    ["ambiguous in", cmd("in"), 3],
    ["ambiguous to", cmd("to"), 3],
    ["ambiguous subset", cmd("subset"), 7],
    ["ambiguous R", cmd("R"), 2],
    ["partial name", cmd("alph"), 5],
    ["unknown name", cmd("alphax"), 7],
    ["mid-token caret", cmd("alpha"), 3],
    ["escaped command", `${bs}${bs}alpha`, 7],
  ])("does not convert %s", (_name, input, cursor) => {
    expect(convertSymbolCommandAtCursor(input, cursor)).toBeNull();
  });
});

describe("convertTerminatedSymbolCommand", () => {
  test.each([
    ["ambiguous name", cmd("in") + " ", 4, "∈ ", 2],
    ["set name", cmd("subset") + ")", 8, "⊂)", 2],
    ["single-letter set", cmd("R") + ")", 3, "ℝ)", 2],
    ["pasted unambiguous run", cmd("alpha") + " ", 7, "α ", 2],
  ])("converts %s", (_name, input, cursor, text, nextCursor) => {
    expect(convertTerminatedSymbolCommand(input, cursor)).toEqual({ text, cursor: nextCursor });
  });

  test.each([
    ["unterminated name", cmd("in"), 3],
    ["unknown name", cmd("nope") + " ", 6],
    ["escaped command", `${bs}${bs}in `, 5],
  ])("does not convert %s", (_name, input, cursor) => {
    expect(convertTerminatedSymbolCommand(input, cursor)).toBeNull();
  });
});
