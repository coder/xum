import { describe, expect, test } from "bun:test";
import { findFirstViewFonts, firstViewFontPreloads } from "./staticAssets";

// Shaped like the built CSS: Vite minifies it, so family names and URLs carry no quotes.
const BUILT_CSS =
  '@font-face{font-family:Geist;src:url(./Geist-Variable-C_ya05Eu.woff2)format("woff2");font-weight:100 900}' +
  '@font-face{font-family:Seti;src:url(./seti-BYvugthT.woff)format("woff")}' +
  '@font-face{font-family:Nerd Font Symbols;src:url(./nerd-font-symbols-CoUzE12l.woff2)format("woff2")}' +
  '@font-face{font-family:Geist Mono;src:url(./GeistMono-Variable-BJ0bRpLQ.woff2)format("woff2")}' +
  ".x{font-family:Geist,sans-serif}";

describe("findFirstViewFonts", () => {
  test("takes each first-view family's woff2 file from the built CSS", () => {
    expect(findFirstViewFonts(BUILT_CSS)).toEqual({
      sans: "Geist-Variable-C_ya05Eu.woff2",
      mono: "GeistMono-Variable-BJ0bRpLQ.woff2",
    });
  });

  test("reads quoted names and URLs too, and leaves a missing family out", () => {
    const css = `@font-face { font-family: "Geist"; src: url("./Geist-Variable-AbCd1234.woff2") format("woff2"); }`;
    expect(findFirstViewFonts(css)).toEqual({ sans: "Geist-Variable-AbCd1234.woff2" });
    expect(findFirstViewFonts(".x{color:red}")).toEqual({});
  });
});

describe("firstViewFontPreloads", () => {
  const fonts = findFirstViewFonts(BUILT_CSS);

  test("preloads Geist on every route, and Geist Mono only on workspace routes", () => {
    expect(firstViewFontPreloads(fonts, "/")).toBe(
      '<link rel="preload" as="font" type="font/woff2" crossorigin href="./Geist-Variable-C_ya05Eu.woff2" />'
    );
    const workspace = firstViewFontPreloads(fonts, "/workspace/a1b2c3d4e5");
    expect(workspace).toContain('href="./Geist-Variable-C_ya05Eu.woff2"');
    expect(workspace).toContain('href="./GeistMono-Variable-BJ0bRpLQ.woff2"');
    expect(firstViewFontPreloads(fonts, "/project")).not.toContain("GeistMono");
  });

  test("never preloads a font the first view does not use", () => {
    for (const route of ["/", "/workspace/a1b2c3d4e5", "/project"]) {
      const links = firstViewFontPreloads(fonts, route);
      expect(links, route).not.toContain("nerd-font-symbols");
      expect(links, route).not.toContain("seti");
    }
  });
});
