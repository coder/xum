import { describe, expect, test } from "bun:test";
import type { AgentPluginMarketplaceListing } from "@/common/orpc/schemas/agentPlugins";
import {
  CLAUDE_MARKETPLACE_RELATIVE_PATH,
  CURSOR_MARKETPLACE_RELATIVE_PATH,
  entryDeclaresComponents,
  findMarketplaceEntry,
  marketplaceListing,
  mergeMarketplaces,
  parseClaudeMarketplace,
  parseMarketplaces,
  resolveEntrySource,
  type ClaudeMarketplace,
} from "./claudeMarketplace";

const REMOTE_MARKETPLACE = "https://github.com/acme/market.git";

function marketplace(plugins: unknown[], metadata?: unknown): ClaudeMarketplace {
  return parseClaudeMarketplace(
    JSON.stringify({ name: "acme", owner: { name: "Acme" }, metadata, plugins })
  );
}

function listing(files: {
  cursor?: ClaudeMarketplace;
  claude?: ClaudeMarketplace;
}): AgentPluginMarketplaceListing {
  return marketplaceListing({
    marketplaces: {
      files: { cursor: files.cursor ?? null, claude: files.claude ?? null },
      warnings: [],
    },
    source: { type: "git", url: REMOTE_MARKETPLACE, ref: "main", refType: "branch" },
    lockedSha: "a".repeat(40),
    methods: [],
  });
}

function claudeRows(parsed: ClaudeMarketplace) {
  return listing({ claude: parsed }).entries.map((row) => {
    expect(row.builds.length).toBe(1);
    return { name: row.name, description: row.description, ...row.builds[0] };
  });
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
    const rows = claudeRows(parsed);
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
      file: "claude",
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

  test("a Cursor file keeps its first 500 entries and warns, as a Claude file does", () => {
    const plugins = Array.from({ length: 501 }, (_, index) => ({
      name: `p${index}`,
      source: `p${index}`,
    }));
    const parsed = parseClaudeMarketplace(
      JSON.stringify({ name: "cursor-plugins", plugins }),
      CURSOR_MARKETPLACE_RELATIVE_PATH
    );
    expect(parsed.entries.length).toBe(500);
    expect(parsed.entries.at(-1)?.name).toBe("p499");
    expect(parsed.warnings).toEqual([
      `${CURSOR_MARKETPLACE_RELATIVE_PATH} lists 501 plugins; Xum shows the first 500.`,
    ]);
  });

  test("a broken Cursor file names the Cursor path, not the Claude path", () => {
    let message = "";
    try {
      parseMarketplaces({ cursor: "{", claude: undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`${CURSOR_MARKETPLACE_RELATIVE_PATH} is not valid JSON`);
    expect(message).not.toContain(CLAUDE_MARKETPLACE_RELATIVE_PATH);
  });

  test("beside a good file, a broken one is a warning; two broken files fail with both", () => {
    const good = JSON.stringify({ name: "acme", plugins: [{ name: "a", source: "./a" }] });
    const parsed = parseMarketplaces({ cursor: "{}", claude: good });
    expect(parsed.files.cursor).toBeNull();
    expect(parsed.files.claude?.entries.map((entry) => entry.name)).toEqual(["a"]);
    expect(parsed.warnings).toEqual([`${CURSOR_MARKETPLACE_RELATIVE_PATH} has no 'plugins' list.`]);

    expect(() => parseMarketplaces({ cursor: "{}", claude: "[]" })).toThrow(
      `${CURSOR_MARKETPLACE_RELATIVE_PATH} has no 'plugins' list. ${CLAUDE_MARKETPLACE_RELATIVE_PATH} has no 'plugins' list.`
    );
  });
});

describe("mergeMarketplaces", () => {
  const entry = (name: string, source: string) => ({ name, source });

  test("lists the Cursor entries, then the Claude names Cursor lacks; a shared name has both builds", () => {
    const cursor = marketplace([entry("a", "a"), entry("b", "b")]);
    const claude = marketplace([entry("b", "./claude/b"), entry("c", "./claude/c")]);
    const merged = mergeMarketplaces(cursor, claude);
    expect(merged.map((row) => [row.name, row.builds.map((build) => build.file)])).toEqual([
      ["a", ["cursor"]],
      ["b", ["cursor", "claude"]],
      ["c", ["claude"]],
    ]);
    expect(merged[1].builds.map((build) => build.entry.raw.source)).toEqual(["b", "./claude/b"]);
  });

  test("entries with a problem never merge, even under the same label", () => {
    const cursor = marketplace(["not an object", entry("b", "b"), entry("b", "again")]);
    const claude = marketplace(["not an object", entry("b", "./claude/b")]);
    expect(
      mergeMarketplaces(cursor, claude).map((row) => [
        row.name,
        row.builds.map((build) => `${build.file}:${String(build.entry.raw.source)}`),
      ])
    ).toEqual([
      ["(entry 1)", ["cursor:undefined"]],
      ["b", ["cursor:b", "claude:./claude/b"]],
      // A second Cursor 'b' is a problem entry: the Claude build joins the first.
      ["b", ["cursor:again"]],
      ["(entry 1)", ["claude:undefined"]],
    ]);
  });
});

describe("marketplaceListing", () => {
  test("a row reads each build's status from its own file", () => {
    const cursor = parseClaudeMarketplace(
      JSON.stringify({
        name: "cursor-plugins",
        owner: { name: "Cursor" },
        plugins: [
          { name: "pstack", description: "Cursor build", source: { source: "npm", package: "x" } },
        ],
      }),
      CURSOR_MARKETPLACE_RELATIVE_PATH
    );
    const claude = marketplace([
      { name: "pstack", description: "Claude build", source: "./harness/pstack" },
    ]);
    const result = listing({ cursor, claude });
    expect([result.name, result.owner]).toEqual(["cursor-plugins", "Cursor"]);
    expect(result.entries).toEqual([
      {
        name: "pstack",
        description: "Cursor build",
        builds: [
          {
            file: "cursor",
            sourceKind: "npm",
            source: "npm",
            installable: false,
            reason: "Xum does not install npm packages. Only git sources install.",
          },
          {
            file: "claude",
            sourceKind: "relative",
            source: "harness/pstack",
            installable: true,
          },
        ],
      },
    ]);
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
    expect(claudeRows(parsed).map((row) => row.installable)).toEqual([true, false, false]);
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
    // A loopback host is this machine too: git would reach it with the user's own SSH keys.
    for (const url of [
      "ssh://localhost/home/me/private.git",
      "ssh://git@LOCALHOST./srv/private.git",
      "git@127.0.0.1:/srv/private.git",
      "ssh://127.1/srv/private.git",
      "ssh://2130706433/srv/private.git",
      "ssh://[::1]/srv/private.git",
      "git@[::ffff:127.0.0.1]:srv/private.git",
      "https://dev.localhost/acme/tool.git",
      "ssh://0.0.0.0/srv/private.git",
    ]) {
      expect(resolveOnly({ source: "url", url })).toContain("path on this machine");
    }
    // A network marketplace names only https sources: ssh and scp forms would sign in with the
    // user's SSH agent to any host the catalog picks, also a DNS alias of this machine.
    for (const url of ["git@gitlab.com:acme/tool.git", "ssh://git@github.com/acme/tool.git"]) {
      expect(resolveOnly({ source: "url", url })).toContain("only https");
    }
    expect(
      resolveOnly(
        { source: "url", url: "git@gitlab.com:acme/tool.git" },
        { marketplaceUrl: "/srv/repos/market" }
      )
    ).toMatchObject({ kind: "remote", url: "git@gitlab.com:acme/tool.git" });
    expect(
      resolveOnly(
        { source: "url", url: "ssh://localhost/srv/tool.git" },
        { marketplaceUrl: "ssh://localhost/srv/market.git" }
      )
    ).toMatchObject({ kind: "remote", url: "ssh://localhost/srv/tool.git" });
  });
});
