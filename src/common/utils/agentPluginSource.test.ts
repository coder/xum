import { describe, expect, test } from "bun:test";

import {
  isAbbreviatedCommitSha,
  isNormalizedAgentPluginSubpath,
  normalizeAgentPluginSubpath,
} from "./agentPluginSource";

describe("normalizeAgentPluginSubpath", () => {
  test("accepts repo-relative folders, trimming whitespace and one trailing slash", () => {
    expect(normalizeAgentPluginSubpath("pstack")).toBe("pstack");
    expect(normalizeAgentPluginSubpath(" packages/demo/ ")).toBe("packages/demo");
    expect(normalizeAgentPluginSubpath("a/.github/b-c_d.e")).toBe("a/.github/b-c_d.e");
  });

  test.each([
    ["", /must not be empty/],
    ["/", /must not be empty/],
    ["/abs/path", /absolute path/],
    ["~/plugins", /absolute path/],
    ["C:/plugins", /absolute path/],
    ["..", /not a valid plugin subpath/],
    ["../x", /not a valid plugin subpath/],
    ["a/../../x", /not a valid plugin subpath/],
    ["./x", /not a valid plugin subpath/],
    ["a//b", /not a valid plugin subpath/],
    ["a/b//", /not a valid plugin subpath/],
    [".git", /\.git folder/],
    ["a/.GIT/hooks", /\.git folder/],
    ["a\\b", /not allowed/],
    ["a*", /not allowed/],
    ["a/[b]", /not allowed/],
    ["!a", /not allowed/],
    ["#a", /not allowed/],
    ["a\u0000b", /control characters/],
    ["a\nb", /control characters/],
    ["a /b", /whitespace/],
  ])("rejects %j", (input, message) => {
    expect(() => normalizeAgentPluginSubpath(input)).toThrow(message);
  });
});

describe("isNormalizedAgentPluginSubpath", () => {
  test("accepts the form normalizeAgentPluginSubpath returns", () => {
    expect(isNormalizedAgentPluginSubpath("packages/demo")).toBe(true);
    expect(isNormalizedAgentPluginSubpath("a/.github/b-c_d.e")).toBe(true);
  });

  test.each([
    // The installer takes these only after trimming, so a stored source in this spelling is refused.
    " packages/demo",
    "packages/demo/",
    // The installer refuses these outright.
    "/plugins/demo",
    "../demo",
    "a//b",
    ".git",
    "",
  ])("rejects %j", (subpath) => {
    expect(isNormalizedAgentPluginSubpath(subpath)).toBe(false);
  });
});

describe("isAbbreviatedCommitSha", () => {
  test("is true for 7 to 39 hex digits in either case", () => {
    expect(isAbbreviatedCommitSha("abc1234")).toBe(true);
    expect(isAbbreviatedCommitSha("ABCDEF1234")).toBe(true);
  });

  test.each(["abc123", "a".repeat(40), "main", "v1.0.0", "abc123g"])("is false for %j", (ref) => {
    expect(isAbbreviatedCommitSha(ref)).toBe(false);
  });
});
