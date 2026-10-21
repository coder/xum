import { describe, expect, test } from "bun:test";
import {
  describeMarketplaceEntries,
  entryDeclaresComponents,
  findMarketplaceEntry,
  parseClaudeMarketplace,
  resolveEntrySource,
  type ClaudeMarketplace,
} from "./claudeMarketplace";

const REMOTE_MARKETPLACE = "https://github.com/acme/market.git";

function marketplace(plugins: unknown[], metadata?: unknown): ClaudeMarketplace {
  return parseClaudeMarketplace(
    JSON.stringify({ name: "acme", owner: { name: "Acme" }, metadata, plugins })
  );
}

/** The resolved source of the only entry, or the reason it cannot install. */
function resolveOnly(
  source: unknown,
  options?: { metadata?: unknown; marketplaceUrl?: string }
): ReturnType<typeof resolveEntrySource> | string {
  const parsed = marketplace([{ name: "demo", source }], options?.metadata);
  try {
    return resolveEntrySource(
      parsed,
      options?.marketplaceUrl ?? REMOTE_MARKETPLACE,
      findMarketplaceEntry(parsed, "demo")
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("parseClaudeMarketplace", () => {
  test("lists every entry; malformed and refused entries are not installable", () => {
    const parsed = marketplace([
      {
        name: "docs",
        description: "Docs",
        source: "./",
        strict: false,
        skills: ["./skills/a", "./skills/b"],
      },
      "not an object",
      { description: "no name", source: "./x" },
      { name: "Bad Name", source: "./x" },
      { name: "docs", source: "./again" },
      { name: "pkg", source: { source: "npm", package: "@acme/pkg" } },
      { name: "zip", source: { source: "archive", url: "https://x/y.zip" } },
      { name: "run", source: { source: "command", command: "make plugin" } },
      { name: "odd", source: { source: "ftp" } },
    ]);
    const rows = describeMarketplaceEntries(parsed, REMOTE_MARKETPLACE);
    expect(rows.map((row) => [row.name, row.installable])).toEqual([
      ["docs", true],
      ["(entry 2)", false],
      ["(entry 3)", false],
      ["Bad Name", false],
      ["docs", false],
      ["pkg", false],
      ["zip", false],
      ["run", false],
      ["odd", false],
    ]);
    expect(rows[0]).toEqual({
      name: "docs",
      description: "Docs",
      sourceKind: "relative",
      source: "./",
      skillCount: 2,
      installable: true,
    });
    expect(rows.find((row) => row.name === "run")?.reason).toContain("runs on this machine");
    expect(rows.find((row) => row.name === "odd")?.sourceKind).toBe("unknown");
    // A repeated name cannot be picked: the first entry keeps it.
    expect(findMarketplaceEntry(parsed, "docs").raw.source).toBe("./");
  });

  test("a file that is not a marketplace fails with a message", () => {
    expect(() => parseClaudeMarketplace("{")).toThrow("is not valid JSON");
    expect(() => parseClaudeMarketplace("{}")).toThrow("has no 'plugins' list");
  });
});

describe("resolveEntrySource", () => {
  test("a relative path is a folder of the marketplace repository; a bare name joins pluginRoot", () => {
    expect(resolveOnly("./")).toEqual({ kind: "relative", subpath: undefined });
    expect(resolveOnly("./plugins/demo/")).toEqual({ kind: "relative", subpath: "plugins/demo" });
    const pluginRoot = { metadata: { pluginRoot: "./plugins" } };
    expect(resolveOnly("demo", pluginRoot)).toEqual({ kind: "relative", subpath: "plugins/demo" });
    // pluginRoot has no effect on a source that starts with "./" (the Claude rule).
    expect(resolveOnly("./", pluginRoot)).toEqual({ kind: "relative", subpath: undefined });
    expect(resolveOnly(".", pluginRoot)).toEqual({ kind: "relative", subpath: undefined });
    expect(resolveOnly("./tools/demo", pluginRoot)).toEqual({
      kind: "relative",
      subpath: "tools/demo",
    });
    // A path with "/" is not a bare name and needs "./", with or without pluginRoot.
    expect(resolveOnly("team-a/demo", pluginRoot)).toContain("must start with './'");
    expect(resolveOnly("team-a/demo")).toContain("must start with './'");
  });

  test("entry names follow the marketplace grammar, and conflicts are Claude's six keys", () => {
    const parsed = marketplace([
      { name: "My_Tool.v2", source: "./x" },
      { name: "_hidden", source: "./x" },
      { name: "a..b", source: "./x" },
    ]);
    expect(
      describeMarketplaceEntries(parsed, REMOTE_MARKETPLACE).map((row) => row.installable)
    ).toEqual([true, false, false]);
    const entry = (raw: Record<string, unknown>) =>
      marketplace([{ name: "demo", source: "./x", ...raw }]).entries[0];
    expect(entryDeclaresComponents(entry({ mcpServers: {}, lspServers: {} }))).toBe(false);
    expect(entryDeclaresComponents(entry({ themes: ["./t"] }))).toBe(true);
  });

  test("relative paths cannot leave the repository", () => {
    expect(resolveOnly("../outside")).toContain("contains '..'");
    expect(resolveOnly("./a/../../b")).toContain("contains '..'");
    expect(resolveOnly("/etc")).toContain("absolute path");
    expect(resolveOnly("~/plugins")).toContain("absolute path");
    expect(resolveOnly("./.git/hooks")).toContain(".git");
    expect(resolveOnly("./x", { metadata: { pluginRoot: "../up" } })).toContain(
      "metadata.pluginRoot"
    );
  });

  test("github, git-subdir and url name another repository; a sha pins the commit", () => {
    const sha = "a".repeat(40);
    expect(resolveOnly({ source: "github", repo: "acme/tool", ref: "v1" })).toEqual({
      kind: "remote",
      url: "https://github.com/acme/tool.git",
      ref: "v1",
      subpath: undefined,
    });
    expect(resolveOnly({ source: "github", repo: "acme/tool", ref: "v1", sha })).toMatchObject({
      ref: sha,
    });
    expect(resolveOnly({ source: "git-subdir", url: "acme/mono", path: "./tools/demo" })).toEqual({
      kind: "remote",
      url: "https://github.com/acme/mono.git",
      ref: undefined,
      subpath: "tools/demo",
    });
    expect(resolveOnly({ source: "url", url: "https://gitlab.com/acme/tool.git" })).toEqual({
      kind: "remote",
      url: "https://gitlab.com/acme/tool.git",
      ref: undefined,
      subpath: undefined,
    });
  });

  test("remote sources refuse credentials, escapes, short SHAs and paths on this machine", () => {
    expect(resolveOnly({ source: "url", url: "https://user:token@github.com/a/b.git" })).toContain(
      "credentials"
    );
    expect(resolveOnly({ source: "url", url: "ext::sh -c touch% /tmp/x" })).toContain(
      "remote-helper"
    );
    expect(resolveOnly({ source: "git-subdir", url: "acme/mono", path: "../x" })).toContain("'..'");
    expect(resolveOnly({ source: "github", repo: "acme/tool", sha: "abc123" })).toContain(
      "full 40-character"
    );
    expect(resolveOnly({ source: "github", repo: "not a repo" })).toContain("owner/repo");
    // A network marketplace cannot point at a local repository; a local marketplace may.
    expect(resolveOnly({ source: "url", url: "/home/me/private" })).toContain(
      "path on this machine"
    );
    expect(resolveOnly({ source: "url", url: "file:///home/me/private" })).toContain(
      "path on this machine"
    );
    expect(
      resolveOnly(
        { source: "url", url: "/srv/repos/tool" },
        { marketplaceUrl: "/srv/repos/market" }
      )
    ).toMatchObject({ kind: "remote", url: "/srv/repos/tool" });
  });
});
