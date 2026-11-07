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
  ])("refuses %s", (_label, url) => {
    const row = entry({ source: { type: "git", url, ref: "main", refType: "branch" } });
    expect(BackupPluginEntrySchema.safeParse(row).success).toBe(false);
  });

  test.each([
    ["an https url", "https://github.com/example/repo.git"],
    ["an https url with a port", "https://git.example.com:8443/example/repo.git"],
    ["an ssh url", "ssh://git@github.com/example/repo.git"],
    ["an scp-style url", "git@github.com:example/repo.git"],
    ["a git url", "git://git.example.com/example/repo.git"],
  ])("keeps %s", (_label, url) => {
    const row = entry({ source: { type: "git", url, ref: "main", refType: "branch" } });
    expect(BackupPluginEntrySchema.safeParse(row).success).toBe(true);
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
