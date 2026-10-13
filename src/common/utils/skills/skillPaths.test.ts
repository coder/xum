import { describe, expect, test } from "bun:test";

import { matchesSkillPaths, normalizeSkillPaths } from "./skillPaths";

describe("normalizeSkillPaths", () => {
  test("splits a comma string on top-level commas only and keeps list entries whole", () => {
    expect(normalizeSkillPaths("src/**/*.ts, *.{ts,tsx} ,./docs/*.md")).toEqual({
      ok: true,
      paths: ["src/**/*.ts", "*.{ts,tsx}", "docs/*.md"],
    });
    expect(normalizeSkillPaths(["**/*.ts", "**/*.ts", "a,b"])).toEqual({
      ok: true,
      paths: ["**/*.ts", "a,b"],
    });
    expect(normalizeSkillPaths(undefined)).toEqual({ ok: true, paths: undefined });
  });

  test("a comma inside a [...] class is rejected in the string form, kept in the list form", () => {
    for (const raw of ["[),],*.ts", "[]a,],*.ts", "src/[,]x.ts, *.ts"]) {
      const result = normalizeSkillPaths(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("list form");
    }
    expect(normalizeSkillPaths(["src/[,]x.ts"])).toEqual({ ok: true, paths: ["src/[,]x.ts"] });
  });

  test("list entries keep their whitespace; string fragments are trimmed", () => {
    expect(normalizeSkillPaths([" leading.ts"])).toEqual({ ok: true, paths: [" leading.ts"] });
    expect(normalizeSkillPaths(" a.ts , b.ts ")).toEqual({ ok: true, paths: ["a.ts", "b.ts"] });
  });

  test.each([
    ["unclosed bracket", ["src/[abc"], "src/[abc"],
    ["empty entry", "**/*.ts,,", "empty"],
    ["empty list", [], "at least one"],
    ["absolute posix", ["/etc/*.conf"], "/etc/*.conf"],
    ["absolute windows", ["C:/src/*.ts"], "C:/src/*.ts"],
    ["parent segment", ["src/../../*.ts"], ".."],
    ["interior current-dir segment", ["src/./**/*.ts"], "'.'"],
    ["negated pattern", ["src/**/*.ts", "!src/**/*.test.ts"], "!src/**/*.test.ts"],
    ["backslash separator", ["src\\**\\*.ts"], "use '/'"],
  ])("rejects %s with an error naming the problem", (_label, raw, fragment) => {
    const result = normalizeSkillPaths(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(fragment);
  });
});

describe("matchesSkillPaths", () => {
  test("matches workspace-relative POSIX paths, including root files and dot dirs", () => {
    expect(matchesSkillPaths(["**/*.ts"], "src/foo.ts")).toBe(true);
    expect(matchesSkillPaths(["**/*.ts"], "foo.ts")).toBe(true);
    expect(matchesSkillPaths(["**/*.ts"], ".github/scripts/x.ts")).toBe(true);
    expect(matchesSkillPaths(["**/*.ts"], "src/foo.md")).toBe(false);
    expect(matchesSkillPaths(["docs/*.md", "src/**"], "src/a/b.md")).toBe(true);
    expect(matchesSkillPaths(["docs/*.md"], "docs/a/b.md")).toBe(false);
  });
});
