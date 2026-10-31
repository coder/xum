/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
/**
 * Claude Code and Cursor marketplaces through the install service, against real local git
 * "remotes": the preview lists the entries, the user installs one entry per install, and updates
 * read the entry again from marketplace.json at the new commit.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
  AgentPluginMarketplaceListing,
  AgentPluginNotApplied,
} from "@/common/orpc/schemas/agentPlugins";
import { Config } from "@/node/config";
import { execFileAsync } from "@/node/utils/disposableExec";
import { discoverAgentPluginAt } from "./discovery";
import { AgentPluginInstallService } from "./installService";

async function git(cwd: string, ...args: string[]): Promise<string> {
  using proc = execFileAsync("git", [`-C`, cwd, ...args]);
  return (await proc.result).stdout;
}

const skillMd = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody\n`;

/** The scratch clone of anthropics/skills, when this machine has it (no network needed). */
const ANTHROPIC_SKILLS_CLONE = "/home/coder/.mux/sessions/912d5d0f95/scratch/as";
/** The scratch clone of cursor/plugins, when this machine has it (no network needed). */
const CURSOR_PLUGINS_CLONE = "/home/coder/.xum/sessions/58dd3a349d/scratch/cursor-plugins";

async function initRepo(dir: string): Promise<void> {
  await fsPromises.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await fsPromises.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fsPromises.writeFile(path.join(dir, relative), content);
  }
}

async function commit(dir: string, message: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
}

/** The rows of a listing whose names each file lists once, as the name and its only build. */
function singleBuildRows(listing: AgentPluginMarketplaceListing) {
  return listing.entries.map((entry) => {
    expect(entry.builds.length).toBe(1);
    return { name: entry.name, ...entry.builds[0] };
  });
}

describe("AgentPluginInstallService marketplaces", () => {
  let tmpRoot: string;
  let xumRoot: string;
  let marketDir: string;
  let service: AgentPluginInstallService;

  /** Shaped like anthropics/skills: two root entries share "./" with different skill lists. */
  const marketplace = (plugins: unknown[]) =>
    JSON.stringify({ name: "acme-market", owner: { name: "Acme" }, plugins });
  const DOCS = {
    name: "docs",
    description: "Document skills",
    source: "./",
    strict: false,
    skills: ["./skills/pdf", "./skills/xlsx"],
  };
  const EXAMPLES = {
    name: "examples",
    source: "./",
    strict: false,
    skills: ["./skills/art"],
  };

  async function previewEntry(entry: string): Promise<AgentPluginInstallPreview> {
    return service.preview({ input: marketDir, method: { kind: "claude-marketplace", entry } });
  }

  async function previewCursorEntry(entry: string): Promise<AgentPluginInstallPreview> {
    return service.preview({ input: marketDir, method: { kind: "cursor-marketplace", entry } });
  }

  async function listMarketplace(): Promise<AgentPluginMarketplaceListing> {
    const listed = await service.previewSource({ input: marketDir });
    if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
    return listed.marketplace;
  }

  /**
   * Shaped like cursor/plugins: the Cursor file lists bare folder names, and the Claude file
   * lists `pstack` from another folder.
   */
  async function writeCursorMarketplace(): Promise<void> {
    await writeFiles(marketDir, {
      ".cursor-plugin/marketplace.json": JSON.stringify({
        name: "cursor-market",
        owner: { name: "Cursor" },
        plugins: [
          { name: "pstack", source: "pstack", description: "Cursor pstack" },
          { name: "kit", source: "kit" },
          { name: "bare", source: "bare" },
        ],
      }),
      ".claude-plugin/marketplace.json": marketplace([
        { name: "pstack", source: "./harness/pstack/claude-code", description: "Claude pstack" },
      ]),
      "pstack/.cursor-plugin/plugin.json": JSON.stringify({ name: "pstack" }),
      "pstack/skills/go-deep/SKILL.md": skillMd("go-deep"),
      "harness/pstack/claude-code/.claude-plugin/plugin.json": JSON.stringify({ name: "pstack" }),
      "harness/pstack/claude-code/skills/claude-only/SKILL.md": skillMd("claude-only"),
      "kit/.cursor-plugin/plugin.json": JSON.stringify({ name: "kit", variables: { TOKEN: "x" } }),
      "kit/skills/lint/SKILL.md": skillMd("lint"),
      "bare/skills/loose/SKILL.md": skillMd("loose"),
    });
    await commit(marketDir, "cursor marketplace");
  }

  async function install(preview: AgentPluginInstallPreview): Promise<void> {
    await service.install({
      source: preview.source,
      method: preview.method,
      expectedSha: preview.lockedSha,
      expectedConsentDigest: preview.consentDigest,
    });
  }

  async function updateWithReview(name: string): Promise<void> {
    const review = await service.previewUpdate({ name });
    await service.update({
      name,
      consent: {
        fromSha: review.fromSha,
        toSha: review.toSha,
        reviewed: review.changes.flatMap((change) => change.component ?? []),
      },
    });
  }

  async function installedSkills(name: string): Promise<string[]> {
    return (await service.getComponents({ name })).skills.map((skill) => skill.name);
  }

  beforeEach(async () => {
    tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-marketplace-"));
    xumRoot = path.join(tmpRoot, "xum");
    marketDir = path.join(tmpRoot, "market");
    service = new AgentPluginInstallService(new Config(xumRoot), {});
    await initRepo(marketDir);
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        DOCS,
        EXAMPLES,
        { name: "pkg", source: { source: "npm", package: "@acme/pkg" } },
      ]),
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/xlsx/SKILL.md": skillMd("xlsx"),
      "skills/art/SKILL.md": skillMd("art"),
      // A generated marketplace package never loads Xum executable components.
      "hooks.js": "export default {};",
      "workflows/w.js": "export default async () => {};",
    });
    await commit(marketDir, "init");
  });

  afterEach(async () => {
    await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  });

  test("the preview lists the marketplace; two root entries install as two plugins", async () => {
    const listed = await service.previewSource({ input: marketDir });
    if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
    expect(listed.marketplace.name).toBe("acme-market");
    expect(listed.marketplace.methods).toEqual([{ kind: "skills" }]);
    expect(
      singleBuildRows(listed.marketplace).map((row) => [row.name, row.skillCount, row.installable])
    ).toEqual([
      ["docs", 2, true],
      ["examples", 1, true],
      ["pkg", undefined, false],
    ]);
    // The plugin-only API names the marketplace instead.
    await expect(service.preview({ input: marketDir })).rejects.toThrow(
      "is the plugin marketplace 'acme-market'"
    );

    const docs = await previewEntry("docs");
    expect(docs.method).toEqual({ kind: "claude-marketplace", entry: "docs" });
    expect(docs.methods).toEqual([docs.method]);
    expect(docs.skillsCliSkills).toEqual([]);
    expect(docs.source.subpath).toBeUndefined();
    expect(docs.skills.map((skill) => skill.name)).toEqual(["pdf", "xlsx"]);
    expect(docs.hook).toBeUndefined();
    expect(docs.workflows).toEqual([]);
    await install(docs);

    const examples = await previewEntry("examples");
    expect(examples.skills.map((skill) => skill.name)).toEqual(["art"]);
    await install(examples);

    expect(await installedSkills("docs")).toEqual(["pdf", "xlsx"]);
    expect(await installedSkills("examples")).toEqual(["art"]);
    const manifest = JSON.parse(
      await fsPromises.readFile(path.join(xumRoot, "plugins", "docs", "plugin.json"), "utf8")
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "docs",
      description: "Document skills",
      contributes: { skills: ["skills/pdf", "skills/xlsx"] },
      extensions: { mux: { generatedFrom: { kind: "claude-marketplace", entry: "docs" } } },
    });

    // A refused entry stays refused when picked directly.
    await expect(previewEntry("pkg")).rejects.toThrow("does not install npm packages");
    await expect(previewEntry("missing")).rejects.toThrow("does not list a plugin named 'missing'");
  });

  test("a marketplace.json above 1 MiB lists (real catalogs are that big); above the cap it refuses", async () => {
    // anthropics/claude-plugins-community's marketplace.json is about 1.49 MB.
    const write = async (bytes: number) => {
      const json = marketplace([DOCS]);
      await writeFiles(marketDir, {
        ".claude-plugin/marketplace.json": json + " ".repeat(bytes - json.length),
      });
      await commit(marketDir, `marketplace of ${bytes} bytes`);
    };
    await write(1_500_000);
    const listed = await service.previewSource({ input: marketDir });
    if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
    expect(listed.marketplace.entries.map((entry) => entry.name)).toEqual(["docs"]);

    await write(8 * 1024 * 1024 + 1);
    await expect(service.previewSource({ input: marketDir })).rejects.toThrow(
      "marketplace.json is larger than 8 MiB"
    );
  });

  test("a relative entry whose folder is missing is listed as not installable", async () => {
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        DOCS,
        { name: "gone", source: "./plugins/gone", skills: ["./skills/x"] },
      ]),
    });
    await commit(marketDir, "an entry without its folder");
    const listed = await service.previewSource({ input: marketDir });
    if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
    expect(
      singleBuildRows(listed.marketplace).map((row) => [row.name, row.installable, row.reason])
    ).toEqual([
      ["docs", true, undefined],
      ["gone", false, "Xum cannot install the entry's folder 'plugins/gone': it does not exist"],
    ]);
  });

  test("a skill that Xum rejects counts nowhere: not in the listing, not for the Skills CLI", async () => {
    // Like anthropics/skills `claude-api`: a description over 1024 characters.
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        DOCS,
        { name: "api", source: "./", strict: false, skills: ["./skills/api"] },
      ]),
      "skills/api/SKILL.md": `---\nname: api\ndescription: ${"x".repeat(1025)}\n---\nBody\n`,
    });
    await commit(marketDir, "add api");

    const listed = await service.previewSource({ input: marketDir });
    if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
    expect(singleBuildRows(listed.marketplace).map((row) => [row.name, row.skillCount])).toEqual([
      ["docs", 2],
      ["api", 0],
    ]);

    const asSkills = await service.preview({ input: marketDir, method: { kind: "skills" } });
    expect(asSkills.skills.map((skill) => skill.name)).toEqual(["art", "pdf", "xlsx"]);
    expect(asSkills.warnings.some((warning) => warning.includes("api"))).toBe(true);
    expect(asSkills.skillsCliSkills).toEqual(["art", "pdf", "xlsx"]);
  });

  test("Skills installs the whole marketplace repository instead", async () => {
    const preview = await service.preview({ input: marketDir, method: { kind: "skills" } });
    expect(preview.skills.map((skill) => skill.name)).toEqual(["art", "pdf", "xlsx"]);
  });

  test("an update regenerates from marketplace.json; a removed entry fails the update", async () => {
    await install(await previewEntry("docs"));
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        { ...DOCS, skills: [...DOCS.skills, "./skills/art"] },
        EXAMPLES,
      ]),
    });
    await commit(marketDir, "docs gets art");
    await updateWithReview("docs");
    expect(await installedSkills("docs")).toEqual(["pdf", "xlsx", "art"]);

    await writeFiles(marketDir, { ".claude-plugin/marketplace.json": marketplace([EXAMPLES]) });
    await commit(marketDir, "drop docs");
    await expect(service.previewUpdate({ name: "docs" })).rejects.toThrow(
      "does not list a plugin named 'docs'"
    );
    expect(await installedSkills("docs")).toEqual(["pdf", "xlsx", "art"]);
  });

  test("a folder entry is generated from the entry, then switches to its own manifest", async () => {
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        { name: "tool", source: "./plugins/tool", commands: ["./cmds"] },
      ]),
      "plugins/tool/skills/lint/SKILL.md": skillMd("lint"),
      "plugins/tool/cmds/fix.md": "Fix it\n",
      "plugins/tool/agents/helper.md": "---\nname: helper\ndescription: H\n---\n",
    });
    await commit(marketDir, "tool");
    const preview = await previewEntry("tool");
    expect(preview.source.subpath).toBe("plugins/tool");
    expect(preview.method).toEqual({ kind: "claude-marketplace", entry: "tool" });
    // A non-root entry keeps the default skills/ folder; commands load as skills too.
    expect(preview.skills.map((skill) => skill.name).sort()).toEqual(["fix", "lint"]);
    expect(preview.agents).toEqual(["helper.md"]);
    // Install reads marketplace.json from git: the sparse clone holds only plugins/tool.
    await install(preview);
    expect((await installedSkills("tool")).sort()).toEqual(["fix", "lint"]);

    await writeFiles(marketDir, {
      "plugins/tool/.claude-plugin/plugin.json": JSON.stringify({ name: "tool" }),
    });
    await commit(marketDir, "own manifest");
    await updateWithReview("tool");
    const { plugin } = await discoverAgentPluginAt({
      pluginDir: path.join(xumRoot, "plugins", "tool"),
      scope: "global",
    });
    // The Claude manifest wins now; Xum no longer writes a plugin.json.
    expect(plugin?.claudeFallback).toBe(true);
    expect(
      await fsPromises.lstat(path.join(xumRoot, "plugins", "tool", "plugin.json")).catch(() => null)
    ).toBeNull();
  });

  test("a generated entry loads only its listed agents, and older builds only its components", async () => {
    const agent = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        { name: "kit", source: "./plugins/kit", agents: ["./agents/a.md", "./agents/b.md"] },
        { name: "partial", source: "./plugins/kit", agents: ["./agents/a.md"] },
      ]),
      "plugins/kit/skills/lint/SKILL.md": skillMd("lint"),
      "plugins/kit/agents/a.md": agent("a"),
      "plugins/kit/agents/b.md": agent("b"),
      "plugins/kit/hooks.js": "export default {};",
      "plugins/kit/workflows/w.js": "export default async () => {};",
      "plugins/kit/mcp.json": "{}",
      "plugins/kit/.mcp.json": JSON.stringify({ mcpServers: {} }),
      "plugins/kit/hooks/hooks.json": JSON.stringify({ hooks: {} }),
    });
    await commit(marketDir, "kit");
    const partial = await previewEntry("partial");
    expect(partial.agents).toEqual([]);
    expect(partial.warnings.some((warning) => warning.includes("b.md"))).toBe(true);

    const kit = await previewEntry("kit");
    expect(kit.agents).toEqual(["a.md", "b.md"]);
    await install(kit);
    const installed = path.join(xumRoot, "plugins", "kit");
    const current = (await discoverAgentPluginAt({ pluginDir: installed, scope: "global" })).plugin;
    // This build: the Claude default .mcp.json, no hooks.js or workflows/.
    expect(current?.mcpConfigPath).toBe(path.join(current?.rootPath ?? "", ".mcp.json"));
    expect(current?.hooksPath).toBeUndefined();

    // An older build reads the marker as opaque: drop it to read the file as such a build does.
    const manifestPath = path.join(installed, "plugin.json");
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, "utf8")) as {
      extensions: Record<string, unknown>;
    };
    delete manifest.extensions.mux;
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));
    const older = (await discoverAgentPluginAt({ pluginDir: installed, scope: "global" })).plugin;
    expect(older?.hooksPath).toBeUndefined();
    expect(older?.workflowsDir).toBeUndefined();
    expect(older?.mcpConfigPath).toBeUndefined();
    expect(older?.openai?.hooks).toEqual([]);
    // The entry declared these agents, and the user reviewed them.
    expect(older?.agentsDir).toBe(path.join(older?.rootPath ?? "", "agents"));
  });

  test("a root entry with an empty skills list installs no skills", async () => {
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        { name: "none", source: "./", strict: false, skills: [] },
      ]),
    });
    await commit(marketDir, "none");
    const listed = await service.previewSource({ input: marketDir });
    if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
    expect(singleBuildRows(listed.marketplace).map((row) => row.skillCount)).toEqual([0]);
    expect((await previewEntry("none")).skills).toEqual([]);
  });

  test("an entry with its own plugin manifest uses it; strict entry components only warn", async () => {
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        { name: "own", source: "./plugins/own", skills: ["./extra"] },
        { name: "clash", source: "./plugins/own", strict: false, skills: ["./extra"] },
      ]),
      "plugins/own/.claude-plugin/plugin.json": JSON.stringify({ name: "own" }),
      "plugins/own/skills/base/SKILL.md": skillMd("base"),
      "plugins/own/extra/more/SKILL.md": skillMd("more"),
    });
    await commit(marketDir, "own");
    const preview = await previewEntry("own");
    expect(preview.method).toEqual({ kind: "claude-plugin" });
    expect(preview.skills.map((skill) => skill.name)).toEqual(["base"]);
    expect(
      preview.warnings.some((warning) => warning.includes("reads only the plugin manifest"))
    ).toBe(true);
    await expect(previewEntry("clash")).rejects.toThrow("conflicting manifests");
    // The install is a normal subpath install of the Claude plugin.
    await install(preview);
    expect(await installedSkills("own")).toEqual(["base"]);
  });

  test("an entry name with '_' installs under a plugin name and updates by the entry name", async () => {
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        { name: "Doc_Tools", source: "./", strict: false, skills: ["./skills/pdf"] },
      ]),
    });
    await commit(marketDir, "underscore");
    const preview = await previewEntry("Doc_Tools");
    expect(preview.manifest.name).toBe("doc-tools");
    await install(preview);
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        {
          name: "Doc_Tools",
          source: "./",
          strict: false,
          skills: ["./skills/pdf", "./skills/art"],
        },
      ]),
    });
    await commit(marketDir, "add art");
    await updateWithReview("doc-tools");
    expect(await installedSkills("doc-tools")).toEqual(["pdf", "art"]);
  });

  test("entry MCP servers are no conflict; a remote entry with components needs a manifest", async () => {
    const remoteDir = path.join(tmpRoot, "remote-skills");
    await initRepo(remoteDir);
    await writeFiles(remoteDir, { "skills/one/SKILL.md": skillMd("one") });
    await commit(remoteDir, "init");
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        {
          name: "own",
          source: "./plugins/own",
          strict: false,
          mcpServers: { x: { command: "x" } },
        },
        {
          name: "picked",
          source: { source: "url", url: remoteDir },
          skills: ["./skills/one"],
        },
      ]),
      "plugins/own/.claude-plugin/plugin.json": JSON.stringify({ name: "own" }),
      "plugins/own/skills/base/SKILL.md": skillMd("base"),
    });
    await commit(marketDir, "own and picked");
    expect((await previewEntry("own")).skills.map((skill) => skill.name)).toEqual(["base"]);
    await expect(previewEntry("picked")).rejects.toThrow("lists its own components");
  });

  test("a listing scans each shared folder once, a few folders at a time", async () => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      name: `e${index}`,
      source: "./",
      strict: false,
      // Twelve distinct skills lists, each listed by two entries.
      skills: [`./skills/s${index % 12}`],
    }));
    const files: Record<string, string> = {
      ".claude-plugin/marketplace.json": marketplace(entries),
    };
    for (let index = 0; index < 12; index++) {
      files[`skills/s${index}/SKILL.md`] = skillMd(`s${index}`);
    }
    await writeFiles(marketDir, files);
    await commit(marketDir, "many");
    interface Scanner {
      acceptedSkillNames: (...args: unknown[]) => Promise<Set<string>>;
    }
    const proto = AgentPluginInstallService.prototype as unknown as Scanner;
    const real = proto.acceptedSkillNames;
    let active = 0;
    let peak = 0;
    let calls = 0;
    const spy = spyOn(proto, "acceptedSkillNames").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        return await real.apply(this, args);
      } finally {
        active--;
      }
    });
    try {
      const listed = await service.previewSource({ input: marketDir });
      if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
      expect(singleBuildRows(listed.marketplace).every((row) => row.skillCount === 1)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(12);
    expect(peak).toBeLessThanOrEqual(8);
  });

  test("a url entry installs the other repository as a normal git source", async () => {
    const toolDir = path.join(tmpRoot, "tool-repo");
    await initRepo(toolDir);
    await writeFiles(toolDir, { "skills/remote/SKILL.md": skillMd("remote") });
    await commit(toolDir, "init");
    const bareDir = path.join(tmpRoot, "bare-repo");
    await initRepo(bareDir);
    await writeFiles(bareDir, { "README.md": "nothing here\n" });
    await commit(bareDir, "init");
    await writeFiles(marketDir, {
      ".claude-plugin/marketplace.json": marketplace([
        { name: "remote", source: { source: "url", url: toolDir } },
        { name: "empty", source: { source: "url", url: bareDir } },
      ]),
    });
    await commit(marketDir, "remote");
    const preview = await previewEntry("remote");
    expect(preview.source.url).toBe(toolDir);
    expect(preview.method satisfies AgentPluginInstallMethod).toEqual({ kind: "skills" });
    expect(preview.skills.map((skill) => skill.name)).toEqual(["remote"]);
    await install(preview);
    expect(await installedSkills("tool-repo")).toEqual(["remote"]);
    await expect(previewEntry("empty")).rejects.toThrow("no SKILL.md files");
  });

  test("both files list one row per name; a shared name has the Cursor build, then the Claude one", async () => {
    await writeCursorMarketplace();
    const listing = await listMarketplace();
    // The header is the Cursor file's.
    expect([listing.name, listing.owner]).toEqual(["cursor-market", "Cursor"]);
    expect(listing.warnings).toEqual([]);
    expect(
      listing.entries.map((entry) => [
        entry.name,
        entry.description,
        entry.builds.map((build) => [build.file, build.source, build.installable]),
      ])
    ).toEqual([
      [
        "pstack",
        "Cursor pstack",
        [
          ["cursor", "pstack", true],
          ["claude", "harness/pstack/claude-code", true],
        ],
      ],
      ["kit", undefined, [["cursor", "kit", true]]],
      ["bare", undefined, [["cursor", "bare", true]]],
    ]);
  });

  test("each build of a name previews its own file's folder through that folder's manifest", async () => {
    await writeCursorMarketplace();
    const cursor = await previewCursorEntry("pstack");
    expect(cursor.source.subpath).toBe("pstack");
    // The Cursor entry installs through its own manifest, never as a marketplace entry.
    expect(cursor.method).toEqual({ kind: "cursor-plugin" });
    expect(cursor.methods).toEqual([{ kind: "cursor-plugin" }]);
    expect(cursor.skills.map((skill) => skill.name)).toEqual(["go-deep"]);

    const claude = await previewEntry("pstack");
    expect(claude.source.subpath).toBe("harness/pstack/claude-code");
    expect(claude.method).toEqual({ kind: "claude-plugin" });
    expect(claude.skills.map((skill) => skill.name)).toEqual(["claude-only"]);
  });

  test("only one build of a name installs: the second is refused until the first is uninstalled", async () => {
    await writeCursorMarketplace();
    await install(await previewCursorEntry("pstack"));
    expect(await installedSkills("pstack")).toEqual(["go-deep"]);
    const collision = "A managed plugin named 'pstack' is already installed. Uninstall it first.";
    const claude = await previewEntry("pstack");
    expect(claude.installBlockedReason).toBe(collision);
    await expect(install(claude)).rejects.toThrow(collision);
    expect(await installedSkills("pstack")).toEqual(["go-deep"]);
  });

  test("a Cursor entry without a manifest in its folder is refused; install never takes a Cursor entry", async () => {
    await writeCursorMarketplace();
    await expect(previewCursorEntry("bare")).rejects.toThrow(
      "The Cursor marketplace entry 'bare' has no plugin manifest in its folder. Xum does not install it."
    );
    const preview = await previewCursorEntry("pstack");
    await expect(
      service.install({
        source: preview.source,
        method: { kind: "cursor-marketplace", entry: "pstack" },
        expectedSha: preview.lockedSha,
        expectedConsentDigest: preview.consentDigest,
      })
    ).rejects.toThrow("cannot be installed as Cursor marketplace entry");
    expect((await service.list()).map((item) => item.name)).toEqual([]);
  });

  test("an installed Cursor entry lists its not-applied parts and updates by its folder", async () => {
    await writeCursorMarketplace();
    const variables: AgentPluginNotApplied = {
      part: "field",
      name: "variables",
      reason: "not applied in Xum",
    };
    const preview = await previewCursorEntry("kit");
    expect(preview.notApplied).toEqual([variables]);
    await install(preview);
    const listed = (await service.list()).find((item) => item.name === "kit");
    expect(listed?.notApplied).toEqual([variables]);

    await writeFiles(marketDir, { "kit/skills/format/SKILL.md": skillMd("format") });
    await commit(marketDir, "kit gets format");
    const head = (await git(marketDir, "rev-parse", "HEAD")).trim();
    const review = await service.previewUpdate({ name: "kit" });
    expect(review.toSha).toBe(head);
    expect(review.notApplied).toEqual([variables]);
    await updateWithReview("kit");
    expect(await installedSkills("kit")).toEqual(["format", "lint"]);
    const updated = (await service.list()).find((item) => item.name === "kit");
    expect([updated?.lockedSha, updated?.source?.subpath]).toEqual([head, "kit"]);
  });

  test("a plugin without not-applied parts carries no list", async () => {
    await writeCursorMarketplace();
    const preview = await previewCursorEntry("pstack");
    expect(preview.notApplied).toEqual([]);
    await install(preview);
    const listed = (await service.list()).find((item) => item.name === "pstack");
    expect(listed?.notApplied).toBeUndefined();
  });

  test("rule skills carry their rule type; an ordinary skill never does", async () => {
    await writeCursorMarketplace();
    await writeFiles(marketDir, {
      "kit/rules/a.mdc": "---\nalwaysApply: true\n---\nAlways\n",
      "kit/rules/b.mdc": '---\nglobs: "*.ts"\n---\nTypeScript\n',
      // The rule type key in an ordinary skill's metadata is not a rule.
      "kit/skills/lint/SKILL.md":
        "---\nname: lint\ndescription: Lint\nmetadata:\n  cursor-rule-type: glob\n---\nBody\n",
    });
    await commit(marketDir, "kit rules");
    const preview = await previewCursorEntry("kit");
    const ruleTypes = (skills: Array<{ name: string; ruleType?: string }>) =>
      skills.map((skill) => [skill.name, skill.ruleType]).sort();
    const expected = [
      ["a", "always-apply"],
      ["b", "glob"],
      ["lint", undefined],
    ];
    expect(ruleTypes(preview.skills)).toEqual(expected);
    await install(preview);
    expect(ruleTypes((await service.getComponents({ name: "kit" })).skills)).toEqual(expected);
  });

  test("a readonly Cursor agent is listed as one", async () => {
    await writeCursorMarketplace();
    await writeFiles(marketDir, {
      "kit/agents/reviewer.md":
        "---\nname: reviewer\ndescription: R\nreadonly: true\n---\nReview\n",
      "kit/agents/writer.md": "---\nname: writer\ndescription: W\n---\nWrite\n",
      // Xum format: `readonly` is no Xum field, so the agent keeps its tools.
      "kit/agents/xum.md": "---\nname: xum\nbase: exec\nreadonly: true\n---\nXum\n",
    });
    await commit(marketDir, "kit agents");
    const preview = await previewCursorEntry("kit");
    expect(preview.agents).toEqual(["reviewer.md", "writer.md", "xum.md"]);
    expect(preview.readonlyAgents).toEqual(["reviewer.md"]);
  });

  test("a root with its own Cursor manifest previews that plugin, not the listing", async () => {
    await writeCursorMarketplace();
    await writeFiles(marketDir, {
      ".cursor-plugin/plugin.json": JSON.stringify({ name: "root-kit" }),
    });
    await commit(marketDir, "root manifest");
    const result = await service.previewSource({ input: marketDir });
    if (result.kind !== "plugin") throw new Error("expected a plugin preview");
    expect(result.preview.method).toEqual({ kind: "cursor-plugin" });
    expect(result.preview.manifest.name).toBe("root-kit");
  });

  test("a broken Cursor file beside a good Claude file lists the Claude entries and warns", async () => {
    await writeCursorMarketplace();
    await writeFiles(marketDir, { ".cursor-plugin/marketplace.json": "{ not json" });
    await commit(marketDir, "break the Cursor file");
    const listing = await listMarketplace();
    expect(listing.name).toBe("acme-market");
    expect(singleBuildRows(listing).map((row) => [row.name, row.file])).toEqual([
      ["pstack", "claude"],
    ]);
    expect(listing.warnings.length).toBe(1);
    expect(listing.warnings[0]).toStartWith(".cursor-plugin/marketplace.json is not valid JSON");
  });

  test("a refused Cursor build does not refuse the Claude build of the same name", async () => {
    await writeCursorMarketplace();
    await writeFiles(marketDir, {
      ".cursor-plugin/marketplace.json": JSON.stringify({
        name: "cursor-market",
        plugins: [{ name: "pstack", source: { source: "npm", package: "@cursor/pstack" } }],
      }),
    });
    await commit(marketDir, "an npm Cursor entry");
    const listing = await listMarketplace();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["pstack"]);
    expect(
      listing.entries[0].builds.map((build) => [build.file, build.installable, build.reason])
    ).toEqual([
      ["cursor", false, "Xum does not install npm packages. Only git sources install."],
      ["claude", true, undefined],
    ]);
  });

  test("an installed Cursor plugin read without its manifest stays a managed install that uninstalls", async () => {
    await writeCursorMarketplace();
    await install(await previewCursorEntry("pstack"));
    // An older build reads no Cursor manifest; this is the folder as it sees it.
    const installed = path.join(xumRoot, "plugins", "pstack");
    await fsPromises.rm(path.join(installed, ".cursor-plugin"), { recursive: true });
    const listed = (await service.list()).find((item) => item.name === "pstack");
    expect(listed?.managed).toBe(true);
    await service.uninstall({ name: "pstack", deletePluginData: true });
    expect(await service.list()).toEqual([]);
    expect(existsSync(installed)).toBe(false);
  });

  test.skipIf(!existsSync(CURSOR_PLUGINS_CLONE))(
    "cursor/plugins: 128 plugins, pstack and origin-apps with both builds",
    async () => {
      const copy = path.join(tmpRoot, "cursor-plugins");
      await fsPromises.cp(CURSOR_PLUGINS_CLONE, copy, {
        recursive: true,
        filter: (source) => path.basename(source) !== ".git",
      });
      await initRepo(copy);
      await commit(copy, "copy");
      const listed = await service.previewSource({ input: copy });
      if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
      const entries = listed.marketplace.entries;
      expect(entries.length).toBe(128);
      expect(
        entries
          .filter((entry) => entry.builds.length > 1)
          .map((entry) => [entry.name, entry.builds.map((build) => build.file)])
          .sort()
      ).toEqual([
        ["origin-apps", ["cursor", "claude"]],
        ["pstack", ["cursor", "claude"]],
      ]);
      expect(entries.every((entry) => entry.builds[0].file === "cursor")).toBe(true);
      expect(listed.marketplace.warnings).toEqual([]);
      // pstack's folder has a root plugin.json with $schema next to its Cursor manifest.
      const pstack = await service.preview({
        input: copy,
        method: { kind: "cursor-marketplace", entry: "pstack" },
      });
      expect([pstack.method, pstack.source.subpath]).toEqual([{ kind: "agent-plugin" }, "pstack"]);
    }
  );

  test.skipIf(!existsSync(ANTHROPIC_SKILLS_CLONE))(
    "anthropics/skills: document-skills previews /pdf",
    async () => {
      // A shallow clone cannot serve as a remote: copy its tree into a fresh repository.
      const copy = path.join(tmpRoot, "skills");
      await fsPromises.cp(ANTHROPIC_SKILLS_CLONE, copy, {
        recursive: true,
        filter: (source) => path.basename(source) !== ".git",
      });
      await initRepo(copy);
      await commit(copy, "copy");
      const listed = await service.previewSource({ input: copy });
      if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
      expect(listed.marketplace.entries.length).toBe(5);
      const preview = await service.preview({
        input: copy,
        method: { kind: "claude-marketplace", entry: "document-skills" },
      });
      expect(preview.skills.map((skill) => skill.name).sort()).toEqual([
        "docx",
        "pdf",
        "pptx",
        "xlsx",
      ]);
    }
  );
});
