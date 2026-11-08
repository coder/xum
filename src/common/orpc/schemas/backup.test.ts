import { describe, expect, test } from "bun:test";
import { BackupPluginEntrySchema, MAX_BACKUP_PLUGIN_COMPONENTS } from "./backup";

const SHA = "a".repeat(40);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: "pstack",
    source: {
      type: "git",
      url: "https://github.com/example/pstack.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: SHA,
    ...overrides,
  };
}

describe("BackupPluginEntrySchema", () => {
  test("keeps the source, pin and imports of an entry", () => {
    const parsed = BackupPluginEntrySchema.parse(
      entry({
        source: {
          type: "git",
          url: "https://github.com/example/mono.git",
          ref: "v1.2.0",
          refType: "tag",
          subpath: "packages/plugin",
        },
        importedComponents: { skills: ["review"], mcpServers: [] },
      })
    );
    expect(parsed).toMatchObject({
      source: { ref: "v1.2.0", refType: "tag", subpath: "packages/plugin" },
      importedComponents: { skills: ["review"], mcpServers: [] },
    });
  });

  test("drops local trust state a hand-edited list carries", () => {
    const parsed = BackupPluginEntrySchema.parse(
      entry({
        installedAt: "2026-01-01T00:00:00.000Z",
        autoUpdate: true,
        componentConsent: { skills: { review: "abc" }, mcpServers: {} },
      })
    );
    expect(Object.keys(parsed).sort()).toEqual(["lockedSha", "name", "source"]);
  });

  test.each([
    ["a short commit id", entry({ lockedSha: "abc1234" })],
    ["an uppercase commit id", entry({ lockedSha: "A".repeat(40) })],
    ["a 64-character commit id", entry({ lockedSha: "a".repeat(64) })],
    ["a name with a path separator", entry({ name: "../evil" })],
    ["a reserved device name", entry({ name: "con" })],
    [
      "a url git would read as an option",
      entry({
        source: {
          type: "git",
          url: "--upload-pack=touch /tmp/pwned",
          ref: "main",
          refType: "branch",
        },
      }),
    ],
    [
      "a url that is an option after the preview trims it",
      entry({
        source: { type: "git", url: " -ux:touch", ref: "main", refType: "branch" },
      }),
    ],
    ["a non-git source", entry({ source: { type: "path", url: "/tmp/x" } })],
    [
      "an oversized url",
      entry({
        source: {
          type: "git",
          url: `https://h/${"a".repeat(3000)}`,
          ref: "main",
          refType: "branch",
        },
      }),
    ],
  ])("refuses %s", (_label, row) => {
    expect(BackupPluginEntrySchema.safeParse(row).success).toBe(false);
  });

  test.each([
    ["a UNC share", "//host/share/repo.git"],
    ["a UNC share with backslashes", "\\\\host\\share\\repo.git"],
    ["a UNC share with mixed separators", "\\/host/share/repo.git"],
    ["a file URL with a host (a Windows share)", "file://attacker/share/repo.git"],
    ["a file URL with a UNC path", "file:////attacker/share/repo.git"],
    ["a local file URL in another case", "FILE:///tmp/repo.git"],
    ["a path that Git for Windows can open as a share", "/??/UNC/attacker/share/repo.git"],
    ["a POSIX path", "/home/someone/repo.git"],
    ["a Windows rooted path", "\\??\\UNC\\attacker\\share"],
    ["a home path", "~/repo.git"],
    ["a drive path", "C:\\repo.git"],
    ["a drive path with a slash", "C:/repo.git"],
    // Each of these has a colon, so host parsing alone would call it a remote scp host.
    ["a drive-relative path", "C:repo.git"],
    ["a drive-relative path in lower case", "c:repo.git"],
    ["a digit that Git for Windows reads as a drive", "1:repo.git"],
    ["a one-letter host without a user, which Git for Windows reads as a drive", "h:org/repo.git"],
    // The host parser finds a host before the colon in each, so only the leading check catches them.
    ["a backslash path with a colon", "\\x:y/z"],
    ["a UNC share with a colon after the share", "\\\\host\\share:x"],
    ["a home path with a colon", "~x:y"],
    ["a user home path with a colon", "~user:repo.git"],
    ["a Win32 file namespace path", "\\\\?\\C:\\repo.git"],
    ["a Win32 device namespace path", "\\\\.\\C:\\repo.git"],
    ["a UNC share with a colon in its path", "\\\\attacker\\share\\repo:x.git"],
    ["a loopback ssh host", "ssh://git@localhost/someone/repo.git"],
    ["a loopback scp host", "git@127.0.0.1:someone/repo.git"],
    ["a url with internal whitespace", "https://github.com/example/my repo.git"],
    ["a url with a newline", "https://github.com/example/repo.git\nextra"],
    ["a url with a control character", "https://github.com/example/rep\u0007o.git"],
    ["a url with a right-to-left override", "https://github.com/example/\u202Egit.repo"],
    ["a url with a zero-width bidi mark", "https://github.com/exam\u200Fple/repo.git"],
    ["a url with a C1 control character", "https://github.com/example/re\u0085po.git"],
    ["a url with an Arabic letter mark", "https://github.com/exam\u061Cple/repo.git"],
    ["a url with a left-to-right mark", "https://github.com/exam\u200Eple/repo.git"],
    ["a url with a left-to-right embedding", "https://github.com/\u202Aexample/repo.git"],
    ["a url with a bidi isolate", "https://github.com/\u2066example\u2069/repo.git"],
    ["a url with a zero-width space", "https://github.com/exam\u200Bple/repo.git"],
    ["a url with a word joiner", "https://github.com/exam\u2060ple/repo.git"],
    ["a url with a credential", "https://user:pass-word@example.com/example/repo.git"],
    // The secret scan reads the list as written, so a token spelled with escapes would pass it.
    ["a url with a percent-escaped token", `https://example.com/%67hp_${"a".repeat(36)}/repo.git`],
    ["a url that escapes a capital letter", "https://example.com/%41/repo.git"],
    ["a url that escapes a digit", "https://example.com/%30/repo.git"],
    ["a url that escapes a hyphen", "https://example.com/a%2Db/repo.git"],
    ["a url that escapes a dot in lower case hex", "https://example.com/a%2eb/repo.git"],
    ["a url that escapes an underscore", "https://example.com/a%5Fb/repo.git"],
    ["a url that escapes a tilde", "https://example.com/a%7eb/repo.git"],
  ])("refuses %s", (_label, url) => {
    const row = entry({ source: { type: "git", url, ref: "main", refType: "branch" } });
    expect(BackupPluginEntrySchema.safeParse(row).success).toBe(false);
  });

  test.each([
    ["an https url", "https://github.com/example/repo.git"],
    ["an https url with a port", "https://git.example.com:8443/example/repo.git"],
    ["an ssh url", "ssh://git@github.com/example/repo.git"],
    ["an scp-style url", "git@github.com:example/repo.git"],
    ["an scp-style url with a user and a one-letter host", "git@h:org/repo.git"],
    // These characters have no other spelling, so a producer may escape them.
    ["a url that escapes a space", "https://dev.azure.com/org/My%20Project/_git/plugins"],
    ["a url that escapes a slash and a colon", "https://example.com/a%2Fb%3Ac/repo.git"],
    ["a url that escapes a non-ASCII letter", "https://example.com/caf%C3%A9/repo.git"],
    ["a url with a percent sign and no escape", "https://example.com/100%/repo.git"],
    ["an scp-style url with a two-letter host", "gh:org/repo.git"],
    ["an ssh url with a one-letter host", "ssh://git@h/org/repo.git"],
    ["a git url", "git://git.example.com/example/repo.git"],
    // Git reads this as scp-style ssh to a host named `file`, and Xum installs it, so the export
    // writes it and a restore must read it.
    ["an scp-style url to a host named file", "file:host/share/repo.git"],
  ])("keeps %s", (_label, url) => {
    const row = entry({ source: { type: "git", url, ref: "main", refType: "branch" } });
    expect(BackupPluginEntrySchema.safeParse(row).success).toBe(true);
  });

  // A row the schema reads is a row the install review can open: the installer's own grammar for
  // the folder and its refusals for the ref decide it, so the list and the installer cannot disagree.
  const withSource = (source: Record<string, unknown>) =>
    entry({
      source: {
        type: "git",
        url: "https://github.com/example/mono.git",
        ref: "main",
        refType: "branch",
        ...source,
      },
    });

  test.each([
    ["an absolute folder", "/plugins/demo"],
    ["a parent folder", "../demo"],
    ["a folder that leaves the repository midway", "a/../../x"],
    ["an empty part", "a//b"],
    ["the git folder", ".git"],
    ["a folder inside the git folder", "a/.GIT/hooks"],
    ["a glob", "plugins/*"],
    ["a folder with a leading space", " packages/demo"],
    ["a folder with a trailing slash", "packages/demo/"],
    ["a folder with a control character", "packages/de\u0007mo"],
  ])("refuses %s as a subpath", (_label, subpath) => {
    expect(BackupPluginEntrySchema.safeParse(withSource({ subpath })).success).toBe(false);
  });

  test.each([
    ["a branch", "main", "branch"],
    ["a branch with a slash", "release/2026-11", "branch"],
    ["a tag", "v1.2.0-rc.1", "tag"],
    ["a full commit id", "a".repeat(40), "commit"],
  ])("keeps %s as a ref", (_label, ref, refType) => {
    expect(BackupPluginEntrySchema.safeParse(withSource({ ref, refType })).success).toBe(true);
  });

  test.each([
    ["a ref with a space", "feature branch"],
    ["a ref with a newline", "main\nextra"],
    ["a ref with two dots", "a..b"],
    ["a ref that ends in .lock", "feature.lock"],
    ["a ref that ends in a dot", "v1."],
    ["a ref with a tilde", "main~1"],
    ["a ref with a colon", "origin:main"],
    ["a ref that git would read as an option", "--upload-pack=x"],
    ["a fully qualified ref", "refs/heads/main"],
    ["a ref with a right-to-left override", "ma\u202Ein"],
    ["a ref with a zero-width space", "ma\u200Bin"],
    ["an abbreviated commit id", "abc1234"],
    ["an abbreviated commit id in capitals", "ABCDEF1234"],
  ])("refuses %s as a ref", (_label, ref) => {
    expect(BackupPluginEntrySchema.safeParse(withSource({ ref })).success).toBe(false);
  });

  describe("caps on repository-controlled fields", () => {
    const names = (count: number, length = 8) =>
      Array.from({ length: count }, (_, index) => `${index}`.padStart(length, "s"));

    test("accept the most skills and MCP servers one row may import", () => {
      const importedComponents = {
        skills: names(MAX_BACKUP_PLUGIN_COMPONENTS),
        mcpServers: names(MAX_BACKUP_PLUGIN_COMPONENTS),
      };
      expect(BackupPluginEntrySchema.safeParse(entry({ importedComponents })).success).toBe(true);
    });

    test.each([
      ["one skill too many", { skills: names(MAX_BACKUP_PLUGIN_COMPONENTS + 1), mcpServers: [] }],
      [
        "one MCP server too many",
        { skills: [], mcpServers: names(MAX_BACKUP_PLUGIN_COMPONENTS + 1) },
      ],
      ["a skill name of 257 characters", { skills: ["s".repeat(257)], mcpServers: [] }],
      ["an empty MCP server name", { skills: [], mcpServers: [""] }],
    ])("refuse %s", (_label, importedComponents) => {
      expect(BackupPluginEntrySchema.safeParse(entry({ importedComponents })).success).toBe(false);
    });
  });

  test("drops an install method that a list written by an earlier build carries", () => {
    // A repository-authored list must not choose how a restore installs a plugin.
    const parsed = BackupPluginEntrySchema.parse(entry({ method: { kind: "skills" } }));
    expect(Object.keys(parsed).sort()).toEqual(["lockedSha", "name", "source"]);
  });
});
