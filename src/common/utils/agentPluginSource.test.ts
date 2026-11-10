import { describe, expect, test } from "bun:test";

import {
  hasEscapedUnreservedCharacter,
  httpsFormOfSshUrl,
  isAbbreviatedCommitSha,
  isNormalizedAgentPluginSubpath,
  normalizeAgentPluginSubpath,
  percentDecodedForms,
  PLAIN_HTTPS_URL,
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

  // The upper end: a ref one digit short of a full commit id is still abbreviated, and the
  // ranges between the ends all read as abbreviated.
  test.each([20, 21, 38, 39])("is true for %d hex digits", (digits) => {
    expect(isAbbreviatedCommitSha("a".repeat(digits))).toBe(true);
    expect(isAbbreviatedCommitSha("F".repeat(digits))).toBe(true);
  });

  test("is true for the shortest abbreviation, and false one digit below it", () => {
    expect(isAbbreviatedCommitSha("a".repeat(7))).toBe(true);
    expect(isAbbreviatedCommitSha("a".repeat(6))).toBe(false);
  });

  test.each(["abc123", "a".repeat(40), "a".repeat(41), "main", "v1.0.0", "abc123g"])(
    "is false for %j",
    (ref) => {
      expect(isAbbreviatedCommitSha(ref)).toBe(false);
    }
  );
});

/** A space escaped `levels` times: `%20`, `%2520`, `%252520`, and so on. */
const escapedSpace = (levels: number) => `%${"25".repeat(levels - 1)}20`;

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
    // The first pass sees only `%25`, a percent sign. Each later pass sees the escape it hides.
    ["a letter escaped twice", "https://h/%2567hp_aaaa"],
    ["a letter escaped three times", "https://h/%252567hp_aaaa"],
    ["a letter escaped four times", "https://h/%25252567hp_aaaa"],
    ["a letter escaped past the passes the check makes", "https://h/%2525252567hp_aaaa"],
  ])("is true for an escaped %s", (_label, url) => {
    expect(hasEscapedUnreservedCharacter(url)).toBe(true);
  });

  test.each([
    ["an escape that is cut short", "https://h/%E0%A4%A/r.git"],
    ["bytes that are not UTF-8", "https://h/%FF/r.git"],
    ["a space escaped five times, one more than the check decodes", `https://h/${escapedSpace(5)}`],
  ])("is true for %s: nothing says how a reader decodes it", (_label, url) => {
    expect(hasEscapedUnreservedCharacter(url)).toBe(true);
  });

  test.each([
    ["no escape", "https://h/a/b.git"],
    ["a space", "https://h/My%20Project"],
    ["a slash", "https://h/a%2Fb"],
    ["a UTF-8 letter", "https://h/caf%C3%A9"],
    ["a percent sign with no digits", "https://h/100%/a%g1"],
    ["an escaped percent sign", "https://h/a%25b"],
    ["a space escaped twice", "https://h/My%2520Project"],
    ["a space escaped three times", "https://h/My%252520Project"],
    // Four levels is the most the check decodes: it reads all four and finds nothing hidden.
    ["a space escaped four times", `https://h/My${escapedSpace(4)}Project`],
  ])("is false for %s", (_label, url) => {
    expect(hasEscapedUnreservedCharacter(url)).toBe(false);
  });
});

describe("percentDecodedForms", () => {
  test.each([
    ["no escape", "https://h/a", []],
    ["a percent sign that starts no escape", "100%", []],
    ["an escaped space", "a%20b", ["a b"]],
    ["an escaped space escaped again", "a%2520b", ["a%20b", "a b"]],
    ["a letter escaped three times", "%252567", ["%2567", "%67", "g"]],
    ["a UTF-8 letter", "caf%C3%A9", ["café"]],
  ])("decodes %s one level at a time", (_label, text, forms) => {
    expect(percentDecodedForms(text)).toEqual(forms);
  });

  test.each([
    ["an escape that is cut short", "%E0%A4%A"],
    ["bytes that are not UTF-8", "%FF"],
    ["a space escaped five times, one more than it decodes", escapedSpace(5)],
  ])("gives nothing for %s", (_label, text) => {
    expect(percentDecodedForms(text)).toBeUndefined();
  });

  // Four levels decode in full (every level shows), and a fifth is left: its reader is unknown.
  test("decodes a space escaped four times, one level at a time", () => {
    expect(percentDecodedForms(escapedSpace(4))).toEqual(["%252520", "%2520", "%20", " "]);
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
  test.each([
    [
      "an https source",
      "https://github.com/example/repo.git",
      "https://github.com/example/repo.git",
    ],
    [
      "an https source with a port and a nested path",
      "https://git.example.com:8443/group/sub_group/repo-name.v2.git",
      "https://git.example.com:8443/group/sub_group/repo-name.v2.git",
    ],
    [
      "an IPv4 host",
      "https://203.0.113.7/example/repo.git",
      "https://203.0.113.7/example/repo.git",
    ],
    ["an scp source", "git@github.com:example/repo.git", "https://github.com/example/repo.git"],
    [
      "an ssh source with a port",
      "ssh://git@github.com:22/example/repo.git",
      "https://github.com/example/repo.git",
    ],
  ])("previews %s at a plain https URL", (_label, url, previewed) => {
    expect(reviewUrlOf(url)).toBe(previewed);
  });

  // One allowlist decides, for an https row and for the https form of an ssh row alike.
  test.each([
    ["a backslash before a user part", "https://github.com\\@attacker.example/repo.git"],
    ["a user part", "https://user@github.com/example/repo.git"],
    ["a query", "https://github.com/example/repo.git?mirror=1"],
    ["a fragment", "https://github.com/example/repo.git#main"],
    ["a percent escape", "https://github.com/example/my%20repo.git"],
    ["a loopback host", "https://127.0.0.1/example/repo.git"],
    ["a localhost name", "https://localhost/example/repo.git"],
    ["an IPv6 literal", "https://[::1]/example/repo.git"],
    ["an upper-case scheme", "HTTPS://github.com/example/repo.git"],
    ["no path", "https://github.com"],
    // An unanchored match would accept this one: its https form ends in an https URL.
    ["an ssh URL that ends in an https URL", "ssh://git@attacker.example/https://a.example/b"],
    ["a bare query mark", "https://github.com/o/r?x"],
    ["an at sign in the path", "https://github.com/o/r@x"],
    ["a backslash in the host", "https://github.com\\attacker.example/o/r"],
    // libcurl and git read a backslash as a slash or as part of a user part, WHATWG as a slash.
    ["a backslash in the path", "https://example.com/a\\b"],
    ["a backslash that starts the path", "https://example.com\\a/b"],
    ["a port over five digits", "https://github.com:123456/r"],
    ["an ssh source whose https form is on this machine", "git@127.0.0.1:example/repo.git"],
    ["an ssh URL whose https form is localhost", "ssh://git@localhost/example/repo.git"],
    ["an ssh source whose path is not plain", "git@github.com:example/repo.git?x=1"],
    ["an ssh source with a bracketed host", "git@[2001:db8::1]:example/repo.git"],
    ["an ssh source with a space in its path", "gitbox:srv/my repos/r.git"],
    ["an http source", "http://host.example/r.git"],
    ["a git source", "git://host.example/r.git"],
    ["a file source", "file:///r.git"],
  ])("previews nothing for %s", (_label, url) => {
    expect(reviewUrlOf(url)).toBeUndefined();
  });

  test("returns only what PLAIN_HTTPS_URL accepts", () => {
    for (const url of [
      "git@github.com:example/repo.git",
      "ssh://git@host.example:2222/example/repo.git",
      "https://github.com/example/repo.git",
    ]) {
      expect(PLAIN_HTTPS_URL.test(reviewUrlOf(url) ?? "")).toBe(true);
    }
  });
});
