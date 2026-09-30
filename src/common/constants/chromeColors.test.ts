import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CHROME_COLORS } from "./chromeColors";

// index.html duplicates this palette to paint browser chrome before the bundle loads.
describe("boot theme palette", () => {
  it("matches the shared chrome palette", () => {
    const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");

    const block = /const THEME_COLORS = \{([^}]*)\}/.exec(html);
    if (!block) {
      throw new Error("Could not find THEME_COLORS in index.html's boot script");
    }

    const bootColors = Object.fromEntries(
      [...block[1].matchAll(/"?([\w-]+)"?:\s*"(#[0-9a-fA-F]{3,8})"/g)].map((m) => [m[1], m[2]])
    );

    expect(bootColors).toEqual({ ...CHROME_COLORS });
  });

  // The static meta remains visible if storage access prevents early theme resolution.
  it("starts from the dark chrome color before any script runs", () => {
    const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");

    const meta = /<meta name="theme-color" content="(#[0-9a-fA-F]{3,8})"/.exec(html);
    if (!meta) {
      throw new Error("Could not find the theme-color meta tag in index.html");
    }

    expect(meta[1]).toBe(CHROME_COLORS.dark);
  });

  // Installed PWAs take splash and OS chrome colors from the manifest.
  it("matches the installed app's manifest colors", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "public", "manifest.json"), "utf8")
    ) as { background_color: string; theme_color: string };

    expect(manifest.theme_color).toBe(CHROME_COLORS.dark);
    expect(manifest.background_color).toBe(CHROME_COLORS.dark);
  });
});
