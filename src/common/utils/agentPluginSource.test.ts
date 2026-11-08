import { describe, expect, test } from "bun:test";

import {
  hasEscapedUnreservedCharacter,
  httpsFormOfSshUrl,
  isAbbreviatedCommitSha,
  isNormalizedAgentPluginSubpath,
  normalizeAgentPluginSubpath,
  reviewUrlOf,
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

describe("hasEscapedUnreservedCharacter", () => {
  test.each([
    ["a letter", "https://h/%67hp"],
    ["a capital letter", "https://h/%47"],
    ["a digit", "https://h/%35"],
    ["a hyphen", "https://h/a%2Db"],
    ["a dot", "https://h/a%2Eb"],
    ["an underscore", "https://h/a%5fb"],
    ["a tilde", "https://h/a%7Eb"],
    ["an unreserved escape after a reserved one", "https://h/My%20Project/%61"],
  ])("is true for an escaped %s", (_label, url) => {
    expect(hasEscapedUnreservedCharacter(url)).toBe(true);
  });

  test.each([
    ["no escape", "https://h/a/b.git"],
    ["a space", "https://h/My%20Project"],
    ["a slash", "https://h/a%2Fb"],
    ["a UTF-8 letter", "https://h/caf%C3%A9"],
    ["a percent sign with no digits", "https://h/100%/a%g1"],
    ["an escaped percent sign", "https://h/a%25b"],
  ])("is false for %s", (_label, url) => {
    expect(hasEscapedUnreservedCharacter(url)).toBe(false);
  });
});

describe("httpsFormOfSshUrl", () => {
  test.each([
    [
      "an scp URL with a user",
      "git@github.com:example/repo.git",
      "https://github.com/example/repo.git",
    ],
    ["an scp URL with no user", "gitbox:srv/repo.git", "https://gitbox/srv/repo.git"],
    ["an scp URL with a rooted path", "git@host:/srv/repo.git", "https://host/srv/repo.git"],
    ["an ssh URL", "ssh://git@github.com/example/repo.git", "https://github.com/example/repo.git"],
    [
      "an ssh URL with a port",
      "ssh://git@host:2222/example/repo.git",
      "https://host/example/repo.git",
    ],
    ["an ssh URL with no user", "ssh://host/example/repo.git", "https://host/example/repo.git"],
    [
      "an ssh scheme in capitals",
      "SSH://git@host/example/repo.git",
      "https://host/example/repo.git",
    ],
    [
      "an scp URL with a bracketed host",
      "git@[2001:db8::1]:example/r.git",
      "https://[2001:db8::1]/example/r.git",
    ],
  ])("gives the https form of %s", (_label, url, https) => {
    expect(httpsFormOfSshUrl(url)).toBe(https);
  });

  test.each([
    ["an https URL", "https://github.com/example/repo.git"],
    ["an http URL", "http://github.com/example/repo.git"],
    ["a git URL", "git://github.com/example/repo.git"],
    ["a file URL", "file:///srv/repo.git"],
    ["an ssh URL with no path", "ssh://git@host"],
    ["an ssh URL with only a slash", "ssh://git@host/"],
    ["a transport helper", "ext::payload"],
    ["a one-letter host (a drive on Windows)", "h:org/repo.git"],
    ["an scp URL with whitespace in its path", "gitbox:srv/my repos/r.git"],
    ["an scp URL with no path", "git@host:"],
    ["a path", "/srv/repo.git"],
    ["a name", "repo"],
  ])("gives nothing for %s", (_label, url) => {
    expect(httpsFormOfSshUrl(url)).toBeUndefined();
  });
});

describe("reviewUrlOf", () => {
  test("previews an https source as written", () => {
    expect(reviewUrlOf("https://github.com/example/repo.git")).toBe(
      "https://github.com/example/repo.git"
    );
  });

  test("previews the https form of an ssh or scp source", () => {
    expect(reviewUrlOf("git@github.com:example/repo.git")).toBe(
      "https://github.com/example/repo.git"
    );
    expect(reviewUrlOf("ssh://git@github.com:22/example/repo.git")).toBe(
      "https://github.com/example/repo.git"
    );
  });

  test.each(["http://host/r.git", "git://host/r.git", "HTTPS://host/r.git", "file:///r.git"])(
    "previews nothing for %s",
    (url) => {
      expect(reviewUrlOf(url)).toBeUndefined();
    }
  );
});
