import { describe, expect, test } from "bun:test";
import { findFirstViewFont, firstViewFontPreload } from "./staticAssets";

// Shaped like the built CSS: Vite minifies it, so family names and URLs carry no quotes.
const BUILT_CSS =
  '@font-face{font-family:Geist;src:url(./Geist-Variable-C_ya05Eu.woff2)format("woff2");font-weight:100 900}' +
  '@font-face{font-family:Seti;src:url(./seti-BYvugthT.woff)format("woff")}' +
  '@font-face{font-family:Nerd Font Symbols;src:url(./nerd-font-symbols-CoUzE12l.woff2)format("woff2")}' +
  '@font-face{font-family:Geist Mono;src:url(./GeistMono-Variable-BJ0bRpLQ.woff2)format("woff2")}' +
  ".x{font-family:Geist,sans-serif}";

describe("findFirstViewFont", () => {
  test("takes the Geist woff2 file from the built CSS, and no other family's", () => {
    // Geist Mono, Seti and Nerd Font Symbols are in the same CSS: none of them is the first-view font.
    expect(findFirstViewFont(BUILT_CSS)).toBe("Geist-Variable-C_ya05Eu.woff2");
  });

  test("reads quoted names and URLs too, and finds nothing without a Geist rule", () => {
    const css = `@font-face { font-family: "Geist"; src: url("./Geist-Variable-AbCd1234.woff2") format("woff2"); }`;
    expect(findFirstViewFont(css)).toBe("Geist-Variable-AbCd1234.woff2");
    const monoOnly =
      '@font-face{font-family:Geist Mono;src:url(./GeistMono-Variable-BJ0bRpLQ.woff2)format("woff2")}';
    expect(findFirstViewFont(monoOnly)).toBeUndefined();
    expect(findFirstViewFont(".x{color:red}")).toBeUndefined();
  });
});

describe("firstViewFontPreload", () => {
  test("is one font preload link, or nothing when the CSS names no first-view font", () => {
    expect(firstViewFontPreload(findFirstViewFont(BUILT_CSS))).toBe(
      '<link rel="preload" as="font" type="font/woff2" crossorigin href="./Geist-Variable-C_ya05Eu.woff2" />'
    );
    expect(firstViewFontPreload(undefined)).toBe("");
  });
});
