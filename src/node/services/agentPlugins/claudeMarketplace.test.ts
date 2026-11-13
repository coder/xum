import assert from "node:assert";
import { describe, expect, test } from "bun:test";
import type { AgentPluginMarketplaceListing } from "@/common/orpc/schemas/agentPlugins";
import {
  AGENTS_MARKETPLACE_RELATIVE_PATH,
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
  type MarketplaceFile,
} from "./claudeMarketplace";

const REMOTE_MARKETPLACE = "https://github.com/acme/market.git";

function marketplace(
  plugins: unknown[],
  metadata?: unknown,
  file: MarketplaceFile = "claude"
): ClaudeMarketplace {
  return parseClaudeMarketplace(
    JSON.stringify({ name: "acme", owner: { name: "Acme" }, metadata, plugins }),
    file
  );
}

type ParsedFiles = Partial<Record<MarketplaceFile, ClaudeMarketplace>>;

function allFiles(files: ParsedFiles): Record<MarketplaceFile, ClaudeMarketplace | null> {
  return {
    cursor: files.cursor ?? null,
    claude: files.claude ?? null,
    agents: files.agents ?? null,
  };
}

function listing(files: ParsedFiles): AgentPluginMarketplaceListing {
  return marketplaceListing({
    marketplaces: { files: allFiles(files), warnings: [] },
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
  options?: { metadata?: unknown; marketplaceUrl?: string; file?: MarketplaceFile }
): ReturnType<typeof resolveEntrySource> | string {
  const parsed = marketplace([{ name: "demo", source }], options?.metadata, options?.file);
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
      "cursor"
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
      parseMarketplaces({ cursor: "{", claude: undefined, agents: undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`${CURSOR_MARKETPLACE_RELATIVE_PATH} is not valid JSON`);
    expect(message).not.toContain(CLAUDE_MARKETPLACE_RELATIVE_PATH);
  });

  test("beside a good file, a broken one is a warning; two broken files fail with both", () => {
    const good = JSON.stringify({ name: "acme", plugins: [{ name: "a", source: "./a" }] });
    const parsed = parseMarketplaces({ cursor: "{}", claude: good, agents: undefined });
    expect(parsed.files.cursor).toBeNull();
    expect(parsed.files.claude?.entries.map((entry) => entry.name)).toEqual(["a"]);
    expect(parsed.warnings).toEqual([`${CURSOR_MARKETPLACE_RELATIVE_PATH} has no 'plugins' list.`]);

    expect(() => parseMarketplaces({ cursor: "{}", claude: "[]", agents: undefined })).toThrow(
      `${CURSOR_MARKETPLACE_RELATIVE_PATH} has no 'plugins' list. ${CLAUDE_MARKETPLACE_RELATIVE_PATH} has no 'plugins' list.`
    );
  });
});

describe("mergeMarketplaces", () => {
  const entry = (name: string, source: string) => ({ name, source });

  test("lists the Cursor entries, then the Claude names Cursor lacks; a shared name has both builds", () => {
    const cursor = marketplace([entry("a", "a"), entry("b", "b")]);
    const claude = marketplace([entry("b", "./claude/b"), entry("c", "./claude/c")]);
    const merged = mergeMarketplaces(allFiles({ cursor, claude }));
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
      mergeMarketplaces(allFiles({ cursor, claude })).map((row) => [
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

  test("a name the Claude file lists twice joins the Cursor row once; the repeat is its own row", () => {
    const cursor = marketplace([entry("b", "b")], undefined, "cursor");
    const claude = marketplace([entry("b", "./claude/b"), entry("b", "./claude/again")]);
    expect(
      mergeMarketplaces(allFiles({ cursor, claude })).map((row) => [
        row.name,
        row.builds.map((build) => `${build.file}:${String(build.entry.raw.source)}`),
      ])
    ).toEqual([
      ["b", ["cursor:b", "claude:./claude/b"]],
      ["b", ["claude:./claude/again"]],
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
      "cursor"
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

  test("a Cursor path starts at the marketplace root, with or without './', and cannot leave it", () => {
    const cursor = { file: "cursor" as const };
    const withRoot = { ...cursor, metadata: { pluginRoot: "./plugins" } };
    expect(resolveOnly("third_party/attio", cursor)).toEqual({
      kind: "relative",
      subpath: "third_party/attio",
    });
    expect(resolveOnly("./third_party/attio", cursor)).toEqual({
      kind: "relative",
      subpath: "third_party/attio",
    });
    // Cursor has no metadata.pluginRoot: a bare name is a folder at the root.
    expect(resolveOnly("pstack", withRoot)).toEqual({ kind: "relative", subpath: "pstack" });
    expect(resolveOnly(".", cursor)).toEqual({ kind: "relative", subpath: undefined });
    expect(resolveOnly("third_party/../../outside", cursor)).toContain("contains '..'");
    expect(resolveOnly("/etc/plugins", cursor)).toContain("absolute path");
    expect(resolveOnly("~/plugins", cursor)).toContain("absolute path");
    expect(resolveOnly("third_party/.git/hooks", cursor)).toContain(".git");
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

  test("a path at most 32 folders deep resolves; a deeper one is refused before any file is read", () => {
    const deep = (folders: number) => `./${Array.from({ length: folders }, () => "a").join("/")}`;
    expect(resolveOnly(deep(32))).toEqual({ kind: "relative", subpath: deep(32).slice(2) });
    expect(resolveOnly(deep(33))).toBe(
      "The path is 33 folders deep. A marketplace path can be at most 32 folders deep."
    );
    // Empty and "." parts are not folders.
    expect(resolveOnly(`${deep(32)}/./`)).toEqual({ kind: "relative", subpath: deep(32).slice(2) });
    expect(resolveOnly("./x", { metadata: { pluginRoot: deep(33) } })).toContain("33 folders deep");
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
  });

  // A marketplace gets the rights of one on this machine only when git reads its URL as a path on
  // the platform Xum runs on. Rights are the two things a remote marketplace lacks: a path on this
  // machine and a source that is not https.
  const NAMES_PATH = { source: "url", url: "/home/me/private" };
  const NAMES_SSH = { source: "url", url: "git@evil.example:org/x.git" };
  const NAMES_HTTPS = { source: "url", url: "https://gitlab.com/acme/tool.git" };

  function expectRemoteMarketplace(marketplaceUrl: string): void {
    expect(resolveOnly(NAMES_SSH, { marketplaceUrl })).toContain("only https");
    expect(resolveOnly(NAMES_PATH, { marketplaceUrl })).toContain("path on this machine");
    // A remote marketplace still names https sources.
    expect(resolveOnly(NAMES_HTTPS, { marketplaceUrl })).toMatchObject({
      kind: "remote",
      url: "https://gitlab.com/acme/tool.git",
    });
  }

  function expectLocalMarketplace(marketplaceUrl: string): void {
    expect(resolveOnly(NAMES_SSH, { marketplaceUrl })).toMatchObject({
      kind: "remote",
      url: "git@evil.example:org/x.git",
    });
    expect(resolveOnly(NAMES_PATH, { marketplaceUrl })).toMatchObject({
      kind: "remote",
      url: "/home/me/private",
    });
  }

  function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    assert(original !== undefined, "process.platform must be an own property");
    Object.defineProperty(process, "platform", { ...original, value: platform });
    try {
      return run();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  }

  test("a drive is a marketplace on this machine on Windows only", () => {
    // Git for Windows reads an ASCII letter and a colon as a drive, but git on Linux and macOS
    // signs in over ssh to the host `h`: there such a marketplace is remote and names only https.
    for (const marketplaceUrl of [
      "C:\\repos\\market",
      "C:/repos/market",
      "C:market",
      "h:/org/market.git",
      "h:org/market.git",
    ]) {
      onPlatform("win32", () => expectLocalMarketplace(marketplaceUrl));
      for (const platform of ["linux", "darwin"] as const) {
        onPlatform(platform, () => expectRemoteMarketplace(marketplaceUrl));
      }
    }
  });

  test("a drive that Git for Windows does not read as a valid path is remote everywhere", () => {
    // Git for Windows then reads the URL as scp to the host `h`, and so does git elsewhere.
    for (const marketplaceUrl of [
      "h:/org/market:archive.git",
      "h:/aux/market.git",
      "h:/org/market*.git",
      "C:\\a:b",
    ]) {
      for (const platform of ["linux", "win32"] as const) {
        onPlatform(platform, () => expectRemoteMarketplace(marketplaceUrl));
      }
    }
  });

  test("a network share is a marketplace on this machine only where git reads it as a path", () => {
    // Git for Windows reads these as a share of another machine.
    for (const marketplaceUrl of ["\\\\server\\share\\market", "file://server/share/market.git"]) {
      onPlatform("linux", () => expectLocalMarketplace(marketplaceUrl));
      onPlatform("win32", () => expectRemoteMarketplace(marketplaceUrl));
    }
  });

  test("a marketplace at a host is remote on every platform, loopback included", () => {
    // Xum reads no host for this check: git decodes, splits and trims a URL in ways that `URL`
    // does not, so `%40%5b` hides evil.example behind localhost, and `:+22` or `|` hides a host.
    for (const marketplaceUrl of [
      "git@h:org/market.git",
      "ssh://localhost/srv/market.git",
      "git@127.0.0.1:srv/market.git",
      "https://127.0.0.1/market.git",
      "ssh://127.evil.example/x",
      "ssh://localhost/y%40%5bevil.example%5d/market.git",
      "ssh://localhost/x%40[2001:db8::1]/y",
      "ssh://localhost#@evil.example/market.git",
      "ssh://localhost:65536/x",
      "ssh://evil.example:+22/market.git",
      "evil.example:c@localhost:market.git",
      "ssh://localhost/y@[fe80::1]/market.git",
      "\\h:org/market.git",
      "\\\\?\\C:\\repos\\market",
    ]) {
      for (const platform of ["linux", "win32"] as const) {
        onPlatform(platform, () => expectRemoteMarketplace(marketplaceUrl));
      }
    }
  });

  test("a path and a file URL are a marketplace on this machine on every platform", () => {
    for (const marketplaceUrl of ["/srv/repos/market", "~/market", "file:///srv/repos/market"]) {
      for (const platform of ["linux", "darwin", "win32"] as const) {
        onPlatform(platform, () => expectLocalMarketplace(marketplaceUrl));
      }
    }
  });
});

describe("the Agent Plugins marketplace file", () => {
  const agents = (plugins: unknown[], header: Record<string, unknown> = {}) =>
    parseClaudeMarketplace(JSON.stringify({ name: "e2e", ...header, plugins }), "agents");

  /** The resolved source of an entry of the given file, or the reason it cannot install. */
  function resolveEntry(
    entry: Record<string, unknown>,
    file: MarketplaceFile = "agents"
  ): ReturnType<typeof resolveEntrySource> | string {
    const parsed = marketplace([{ name: "demo", ...entry }], undefined, file);
    try {
      return resolveEntrySource(parsed, REMOTE_MARKETPLACE, findMarketplaceEntry(parsed, "demo"));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  test("the title is interface.displayName, else name; a missing name warns", () => {
    expect(agents([], { interface: { displayName: "E2E Tools" } }).name).toBe("E2E Tools");
    expect(agents([], { interface: { displayName: " " } }).name).toBe("e2e");
    expect(agents([]).name).toBe("e2e");
    // The other files have no such field: their title stays `name`.
    const claude = parseClaudeMarketplace(
      JSON.stringify({ name: "acme", interface: { displayName: "Other" }, plugins: [] }),
      "claude"
    );
    expect(claude.name).toBe("acme");
    const nameless = parseClaudeMarketplace(JSON.stringify({ plugins: [] }), "agents");
    expect(nameless.warnings).toEqual([`${AGENTS_MARKETPLACE_RELATIVE_PATH} has no 'name'.`]);
  });

  test("a local source object or a plain path names a folder from the marketplace root", () => {
    const folder = { kind: "relative" as const, subpath: "plugins/x" };
    expect(resolveEntry({ source: { source: "local", path: "./plugins/x" } })).toEqual(folder);
    expect(resolveEntry({ source: "./plugins/x" })).toEqual(folder);
    expect(resolveEntry({ source: { source: "local", path: "./plugins/x/" } })).toEqual(folder);
    // "." and "./" are the root itself, as in Codex.
    for (const path of ["./", "."]) {
      const root = { kind: "relative" as const, subpath: undefined };
      expect(resolveEntry({ source: { source: "local", path } })).toEqual(root);
      expect(resolveEntry({ source: path })).toEqual(root);
    }
    // metadata.pluginRoot is not part of this format.
    const parsed = marketplace(
      [{ name: "demo", source: { source: "local", path: "./x" } }],
      { pluginRoot: "./plugins" },
      "agents"
    );
    expect(
      resolveEntrySource(parsed, REMOTE_MARKETPLACE, findMarketplaceEntry(parsed, "demo"))
    ).toEqual({ kind: "relative", subpath: "x" });
    // The build lists the folder as a relative source.
    expect(
      listing({ agents: agents([{ name: "demo", source: { source: "local", path: "./x" } }]) })
        .entries[0].builds
    ).toEqual([{ file: "agents", sourceKind: "relative", source: "x", installable: true }]);
  });

  test("a path must start with './' and cannot leave the marketplace", () => {
    for (const path of ["plugins/x", "x", "..", "../x", "/etc/plugins", "~/plugins", ".\\x"]) {
      expect(resolveEntry({ source: { source: "local", path } })).toContain("must start with './'");
      expect(resolveEntry({ source: path })).toContain("must start with './'");
    }
    expect(resolveEntry({ source: { source: "local", path: "./a/../../b" } })).toContain(
      "contains '..'"
    );
    expect(resolveEntry({ source: "./../outside" })).toContain("contains '..'");
    expect(resolveEntry({ source: "./.git/hooks" })).toContain(".git");
    expect(resolveEntry({ source: { source: "local" } })).toContain("needs 'path'");
    expect(resolveEntry({ source: { source: "local", path: 3 } })).toContain("needs 'path'");
  });

  test("a local source object is a folder only in this file", () => {
    for (const file of ["claude", "cursor"] as const) {
      expect(resolveEntry({ source: { source: "local", path: "./plugins/x" } }, file)).toBe(
        "Marketplace source 'local' is not supported."
      );
      const parsed = marketplace(
        [{ name: "demo", source: { source: "local", path: "./plugins/x" } }],
        undefined,
        file
      );
      expect(parsed.entries[0].sourceKind).toBe("unknown");
    }
  });

  test("policy.installation NOT_AVAILABLE refuses the entry and names the policy", () => {
    const withheld = resolveEntry({
      source: "./x",
      policy: { installation: "NOT_AVAILABLE" },
    });
    expect(withheld).toContain("policy.installation NOT_AVAILABLE");
    for (const installation of ["AVAILABLE", "INSTALLED_BY_DEFAULT", undefined]) {
      expect(resolveEntry({ source: "./x", policy: { installation } })).toEqual({
        kind: "relative",
        subpath: "x",
      });
    }
    // A products list allows only the products it names (Codex's check), so Codex must be in it.
    for (const products of [[], ["CHATGPT"], ["atlas", "chatgpt"]]) {
      expect(resolveEntry({ source: "./x", policy: { products } })).toContain(
        "policy.products does not list Codex"
      );
    }
    for (const products of [["CODEX"], ["chatgpt", "codex"]]) {
      expect(resolveEntry({ source: "./x", policy: { products } })).toEqual({
        kind: "relative",
        subpath: "x",
      });
    }
    // The policy is an Agent Plugins field: another file's entry that carries it is unaffected.
    expect(
      resolveEntry({ source: "./x", policy: { installation: "NOT_AVAILABLE" } }, "claude")
    ).toEqual({ kind: "relative", subpath: "x" });
  });

  test("entry names use the marketplace grammar, as Codex's plugin ids do; entry skills are not counted", () => {
    const parsed = agents([{ name: "My_Plugin.v2", source: "./x", skills: ["./skills/a"] }]);
    expect(parsed.entries[0].problem).toBeUndefined();
    // The folder's own manifest decides the skills, so the entry's paths are not a count.
    expect(parsed.entries[0].skillCount).toBeUndefined();
    const cursor = marketplace(
      [{ name: "x", source: "./x", skills: ["./a"] }],
      undefined,
      "cursor"
    );
    expect(cursor.entries[0].skillCount).toBeUndefined();
    const claude = marketplace(
      [{ name: "x", source: "./x", skills: ["./a"] }],
      undefined,
      "claude"
    );
    expect(claude.entries[0].skillCount).toBe(1);
  });

  test("an entry that names the root installs only from a Claude file", () => {
    // A listing exists only when the root has no plugin manifest, so only an entry that is its
    // own manifest (Claude) can install from the root.
    const builds = listing({
      cursor: marketplace([{ name: "demo", source: "./" }], undefined, "cursor"),
      claude: marketplace([{ name: "demo", source: "./" }], undefined, "claude"),
      agents: agents([{ name: "demo", source: { source: "local", path: "." } }]),
    }).entries[0].builds;
    expect(builds.map((build) => [build.file, build.installable])).toEqual([
      ["cursor", false],
      ["claude", true],
      ["agents", false],
    ]);
    expect(builds[2].reason).toContain("names the repository root");
  });

  test("a url source keeps its optional path folder, only in this file", () => {
    const source = { source: "url", url: "https://github.com/acme/mono.git", path: "./tools/x" };
    expect(resolveEntry({ source })).toEqual({
      kind: "remote",
      url: "https://github.com/acme/mono.git",
      ref: undefined,
      subpath: "tools/x",
    });
    expect(resolveEntry({ source: { ...source, path: "../x" } })).toContain("contains '..'");
    for (const path of ["", "./", 3]) {
      expect(resolveEntry({ source: { ...source, path } })).toContain("must name a folder");
    }
    // A null ref or sha is absent too: a null sha keeps a given ref.
    expect(resolveEntry({ source: { ...source, ref: null, sha: null } })).toMatchObject({
      kind: "remote",
      ref: undefined,
      subpath: "tools/x",
    });
    expect(resolveEntry({ source: { ...source, ref: "release-v2", sha: null } })).toMatchObject({
      kind: "remote",
      ref: "release-v2",
    });
    // So is a blank one, and a ref comes back trimmed.
    expect(resolveEntry({ source: { ...source, ref: " release-v2 ", sha: " " } })).toMatchObject({
      kind: "remote",
      ref: "release-v2",
    });
    const sha = "A".repeat(40);
    expect(resolveEntry({ source: { ...source, sha: ` ${sha} ` } })).toMatchObject({
      ref: sha.toLowerCase(),
    });
    expect(resolveEntry({ source: { ...source, ref: "", sha: "" } })).toMatchObject({
      kind: "remote",
      ref: undefined,
    });
    expect(resolveEntry({ source: { ...source, ref: 3 } })).toBe(
      "'ref' must be a branch or tag name."
    );
    // A null path is absent, as in Codex: the repository root.
    expect(resolveEntry({ source: { ...source, path: null } })).toMatchObject({
      kind: "remote",
      subpath: undefined,
    });
    // Claude's and Cursor's url sources have no path: the repository root, as before.
    for (const file of ["claude", "cursor"] as const) {
      expect(resolveEntry({ source }, file)).toEqual({
        kind: "remote",
        url: "https://github.com/acme/mono.git",
        ref: undefined,
        subpath: undefined,
      });
    }
  });

  test("url and git-subdir sources name another repository, and npm is refused, as in Claude's", () => {
    expect(
      resolveEntry({ source: { source: "git-subdir", url: "acme/mono", path: "./tools/x" } })
    ).toEqual({
      kind: "remote",
      url: "https://github.com/acme/mono.git",
      ref: undefined,
      subpath: "tools/x",
    });
    expect(
      resolveEntry({ source: { source: "url", url: "https://gitlab.com/acme/x.git", ref: "v2" } })
    ).toMatchObject({ kind: "remote", url: "https://gitlab.com/acme/x.git", ref: "v2" });
    expect(resolveEntry({ source: { source: "npm", package: "@acme/x" } })).toContain("npm");
    // Claude's other source kinds are not part of this format (Codex skips them).
    for (const kind of ["github", "archive", "command"]) {
      const source = { source: kind, repo: "acme/x", url: "https://example.com/x.tgz" };
      expect(resolveEntry({ source })).toBe(`Marketplace source '${kind}' is not supported.`);
      expect(resolveEntry({ source }, "claude")).not.toBe(
        `Marketplace source '${kind}' is not supported.`
      );
    }
  });

  test("keeps its first 500 entries and warns, as the other files do", () => {
    const plugins = Array.from({ length: 501 }, (_, index) => ({
      name: `p${index}`,
      source: `./p${index}`,
    }));
    const parsed = agents(plugins);
    expect(parsed.entries.length).toBe(500);
    expect(parsed.warnings).toEqual([
      `${AGENTS_MARKETPLACE_RELATIVE_PATH} lists 501 plugins; Xum shows the first 500.`,
    ]);
  });
});

describe("three marketplace files", () => {
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    source: `./${name}`,
    ...extra,
  });
  const files = (fileEntries: Record<MarketplaceFile, unknown[]>) =>
    allFiles({
      cursor: marketplace(fileEntries.cursor, undefined, "cursor"),
      claude: marketplace(fileEntries.claude, undefined, "claude"),
      agents: marketplace(fileEntries.agents, undefined, "agents"),
    });
  const layout = (rows: ReturnType<typeof mergeMarketplaces>) =>
    rows.map((row) => [row.name, row.builds.map((build) => build.file)]);

  test("a name has at most one build per file, in the order Cursor, Claude, Agent Plugins", () => {
    const merged = mergeMarketplaces(
      files({
        cursor: [entry("a"), entry("b")],
        claude: [entry("b"), entry("c")],
        agents: [entry("d"), entry("c"), entry("b"), entry("a")],
      })
    );
    expect(layout(merged)).toEqual([
      ["a", ["cursor", "agents"]],
      ["b", ["cursor", "claude", "agents"]],
      ["c", ["claude", "agents"]],
      ["d", ["agents"]],
    ]);
  });

  test("a file with a missing neighbour merges the others, and Cursor and Claude alone keep their rows", () => {
    const claude = marketplace([entry("b"), entry("c")]);
    const agents = marketplace([entry("c"), entry("e")], undefined, "agents");
    expect(layout(mergeMarketplaces(allFiles({ claude, agents })))).toEqual([
      ["b", ["claude"]],
      ["c", ["claude", "agents"]],
      ["e", ["agents"]],
    ]);
    const cursor = marketplace([entry("a"), entry("b")], undefined, "cursor");
    expect(layout(mergeMarketplaces(allFiles({ cursor, claude })))).toEqual([
      ["a", ["cursor"]],
      ["b", ["cursor", "claude"]],
      ["c", ["claude"]],
    ]);
  });

  test("an entry with a problem never merges, from any file", () => {
    const merged = mergeMarketplaces(
      files({
        cursor: [entry("b")],
        claude: ["not an object", entry("b"), entry("b", { source: "./again" })],
        agents: ["not an object", entry("b"), { source: "./nameless" }],
      })
    );
    expect(layout(merged)).toEqual([
      ["b", ["cursor", "claude", "agents"]],
      ["(entry 1)", ["claude"]],
      // The second 'b' of the Claude file is a problem entry: it keeps its own row.
      ["b", ["claude"]],
      ["(entry 1)", ["agents"]],
      ["(entry 3)", ["agents"]],
    ]);
  });

  test("the row description is the first build that has one", () => {
    const rows = (plugins: Record<MarketplaceFile, unknown[]>) =>
      listing({
        cursor: marketplace(plugins.cursor, undefined, "cursor"),
        claude: marketplace(plugins.claude, undefined, "claude"),
        agents: marketplace(plugins.agents, undefined, "agents"),
      }).entries.map((row) => row.description);
    expect(
      rows({
        cursor: [entry("a")],
        claude: [entry("a", { description: "Claude a" })],
        agents: [entry("a", { description: "Agents a" })],
      })
    ).toEqual(["Claude a"]);
    expect(
      rows({
        cursor: [entry("a", { description: "Cursor a" })],
        claude: [entry("a", { description: "Claude a" })],
        agents: [entry("a")],
      })
    ).toEqual(["Cursor a"]);
    expect(rows({ cursor: [], claude: [], agents: [entry("a")] })).toEqual([undefined]);
  });

  test("a withheld Agent Plugins build joins its row and stays not installable beside the others", () => {
    const result = listing({
      cursor: marketplace([entry("a")], undefined, "cursor"),
      agents: marketplace(
        [entry("a", { policy: { installation: "NOT_AVAILABLE" } })],
        undefined,
        "agents"
      ),
    });
    expect(result.entries.map((row) => row.builds.map((b) => [b.file, b.installable]))).toEqual([
      [
        ["cursor", true],
        ["agents", false],
      ],
    ]);
    expect(result.entries[0].builds[1].reason).toContain("NOT_AVAILABLE");
  });

  test("the header is the first file that parsed, and its title is that file's", () => {
    const agentsOnly = listing({
      agents: parseClaudeMarketplace(
        JSON.stringify({ name: "e2e", interface: { displayName: "E2E Tools" }, plugins: [] }),
        "agents"
      ),
    });
    expect(agentsOnly.name).toBe("E2E Tools");
    const withClaude = listing({
      claude: marketplace([]),
      agents: parseClaudeMarketplace(JSON.stringify({ name: "e2e", plugins: [] }), "agents"),
    });
    expect(withClaude.name).toBe("acme");
  });

  test("warnings of every file are listed, in file order", () => {
    const warnings = listing({
      cursor: parseClaudeMarketplace(JSON.stringify({ plugins: [] }), "cursor"),
      agents: parseClaudeMarketplace(JSON.stringify({ plugins: [] }), "agents"),
    }).warnings;
    expect(warnings).toEqual([
      `${CURSOR_MARKETPLACE_RELATIVE_PATH} has no 'name'.`,
      `${AGENTS_MARKETPLACE_RELATIVE_PATH} has no 'name'.`,
    ]);
  });

  test("a broken file is a warning beside a good one; the listing fails only when all are broken", () => {
    const good = JSON.stringify({ name: "acme", plugins: [{ name: "a", source: "./a" }] });
    const parsed = parseMarketplaces({ cursor: "{", claude: undefined, agents: good });
    expect(parsed.files.cursor).toBeNull();
    expect(parsed.files.agents?.entries.map((e) => e.name)).toEqual(["a"]);
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0]).toContain(CURSOR_MARKETPLACE_RELATIVE_PATH);

    // One file alone fails when it is broken: the Agent Plugins path is named, no other.
    expect(() => parseMarketplaces({ cursor: undefined, claude: undefined, agents: "{}" })).toThrow(
      `${AGENTS_MARKETPLACE_RELATIVE_PATH} has no 'plugins' list.`
    );
    let message = "";
    try {
      parseMarketplaces({ cursor: "{}", claude: "[]", agents: "[]" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    for (const path of [
      CURSOR_MARKETPLACE_RELATIVE_PATH,
      CLAUDE_MARKETPLACE_RELATIVE_PATH,
      AGENTS_MARKETPLACE_RELATIVE_PATH,
    ]) {
      expect(message).toContain(path);
    }
  });
});
