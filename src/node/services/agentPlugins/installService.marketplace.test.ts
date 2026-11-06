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
          { name: "attio", source: "third_party/attio" },
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
      "third_party/attio/.cursor-plugin/plugin.json": JSON.stringify({ name: "attio" }),
      "third_party/attio/skills/crm/SKILL.md": skillMd("crm"),
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

  test("a folder that fits no method names every manifest Xum looked for, the Cursor one too", async () => {
    const plain = path.join(tmpRoot, "plain");
    await initRepo(plain);
    await writeFiles(plain, { "README.md": "Not a plugin\n" });
    await commit(plain, "no manifest and no skills");
    const error = await service.previewSource({ input: plain }).then(
      () => "previewed",
      (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))
    );
    for (const manifest of [
      "plugin.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
    ]) {
      expect(error).toContain(manifest);
    }
  });

  test("a marketplace file that is not a regular file fails only a listing that needs it", async () => {
    await writeFiles(marketDir, {
      "elsewhere.json": marketplace([DOCS]),
      ".claude-plugin/marketplace.json": marketplace([DOCS]),
      "skills/pdf/SKILL.md": skillMd("pdf"),
    });
    await fsPromises.mkdir(path.join(marketDir, ".cursor-plugin"), { recursive: true });
    await fsPromises.symlink(
      "../elsewhere.json",
      path.join(marketDir, ".cursor-plugin/marketplace.json")
    );
    await commit(marketDir, "a symlinked Cursor marketplace beside a Claude one");
    const listing = await listMarketplace();
    expect(singleBuildRows(listing).map((row) => [row.name, row.file])).toEqual([
      ["docs", "claude"],
    ]);
    expect(listing.warnings).toContain(".cursor-plugin/marketplace.json is not a regular file.");

    await writeFiles(marketDir, {
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "root-plugin",
      }),
    });
    await commit(marketDir, "a root plugin");
    const rooted = await service.previewSource({ input: marketDir });
    expect(rooted.kind === "plugin" ? rooted.preview.manifest.name : rooted.kind).toBe(
      "root-plugin"
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
    // A generated entry saves no install method: the plugin.json that Xum wrote fixes its method.
    const savedMethod = async () => {
      const doc = JSON.parse(
        await fsPromises.readFile(path.join(xumRoot, "plugins.json"), "utf8")
      ) as { plugins: Array<Record<string, unknown>> };
      return doc.plugins.find((row) => row.name === "tool")?.installMethod;
    };
    expect(await savedMethod()).toBeUndefined();

    await writeFiles(marketDir, {
      "plugins/tool/.claude-plugin/plugin.json": JSON.stringify({ name: "tool" }),
    });
    await commit(marketDir, "own manifest");
    await updateWithReview("tool");
    const { plugin } = await discoverAgentPluginAt({
      pluginDir: path.join(xumRoot, "plugins", "tool"),
      scope: "global",
      choice: { kind: "fixed-order" },
    });
    // The Claude manifest wins now; Xum no longer writes a plugin.json.
    expect(plugin?.claudeFallback).toBe(true);
    // The update switched to the folder's own manifest and still saves no method: it reads the
    // fixed order, as every entry install does.
    expect(await savedMethod()).toBeUndefined();
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
    const current = (
      await discoverAgentPluginAt({
        pluginDir: installed,
        scope: "global",
        choice: { kind: "fixed-order" },
      })
    ).plugin;
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
    const older = (
      await discoverAgentPluginAt({
        pluginDir: installed,
        scope: "global",
        choice: { kind: "fixed-order" },
      })
    ).plugin;
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
      ["attio", undefined, [["cursor", "third_party/attio", true]]],
    ]);
  });

  test("each build counts the skills that its own file's entry lists", async () => {
    await writeFiles(marketDir, {
      ".cursor-plugin/marketplace.json": JSON.stringify({
        name: "cursor-market",
        plugins: [{ name: "kit", source: "kit", skills: ["./extra/a"] }],
      }),
      ".claude-plugin/marketplace.json": marketplace([
        { name: "kit", source: "./claude/kit", skills: ["./skills/x", "./skills/y"] },
      ]),
      "kit/.cursor-plugin/plugin.json": JSON.stringify({ name: "kit" }),
      "kit/extra/a/SKILL.md": skillMd("a"),
      "claude/kit/skills/x/SKILL.md": skillMd("x"),
      "claude/kit/skills/y/SKILL.md": skillMd("y"),
    });
    await commit(marketDir, "both files list kit with their own skills");
    const listing = await listMarketplace();
    expect(
      listing.entries.map((entry) => [
        entry.name,
        entry.builds.map((build) => [build.file, build.skillCount]),
      ])
    ).toEqual([
      [
        "kit",
        [
          ["cursor", 1],
          ["claude", 2],
        ],
      ],
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

    // cursor/plugins lists most entries as nested paths without "./".
    const nested = await previewCursorEntry("attio");
    expect([nested.source.subpath, nested.method]).toEqual([
      "third_party/attio",
      { kind: "cursor-plugin" },
    ]);
    expect(nested.skills.map((skill) => skill.name)).toEqual(["crm"]);
  });

  // The flake behind "failed to copy file to ...: No such file or directory": git runs a detached
  // `git maintenance` after each commit, and once that repacks the fixture it deletes loose
  // objects while a local-path clone copies the same files one by one. A background repack cannot
  // be paused from a test, so this plants what that copy cannot take: a symlink in `objects/`
  // ("symlink ... exists, refusing to clone with --local"). `git upload-pack` never reads it.
  test("a local source is cloned through git's transport, not by copying its object files", async () => {
    await fsPromises.symlink(
      "missing-target",
      path.join(marketDir, ".git", "objects", "info", "stale-link")
    );
    expect((await listMarketplace()).name).toBe("acme-market");
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

  test("not-applied names show invisible characters as marks", async () => {
    await writeCursorMarketplace();
    await writeFiles(marketDir, {
      "kit/rules/Bad\u202eName.mdc": "---\nalwaysApply: true\n---\nX\n",
    });
    await commit(marketDir, "a rule file name with a bidi control");
    const names = (items: AgentPluginNotApplied[] | undefined) =>
      (items ?? []).filter((item) => item.part === "rule").map((item) => item.name);
    const preview = await previewCursorEntry("kit");
    expect(names(preview.notApplied)).toEqual(["Bad<U+202E>Name.mdc"]);
    await install(preview);
    const listed = (await service.list()).find((item) => item.name === "kit");
    expect(names(listed?.notApplied)).toEqual(["Bad<U+202E>Name.mdc"]);
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
      // Xum format on Explore that adds the edit tools back: no readonly label.
      "kit/agents/editor.md":
        '---\nname: editor\nbase: explore\nreadonly: true\ntools:\n  add: ["file_edit_.*"]\n---\nEdit\n',
    });
    await commit(marketDir, "kit agents");
    const preview = await previewCursorEntry("kit");
    expect(preview.agents).toEqual(["editor.md", "reviewer.md", "writer.md", "xum.md"]);
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

  // The catalog of anthropics/skills at its present scale: five entries that share "./" and list
  // 4, 12, 1, 1 and 1 skills. The names and lists follow its marketplace.json, the text is ours.
  // This test used to copy a local clone of that repository (445 files, 13 MB) and ran only on
  // the one machine that had it, so CI skipped it. On the real data Xum counts 0 skills for
  // `claude-api` (its description is over 1024 characters: see "a skill that Xum rejects counts
  // nowhere"), and the generated skill has a short one, so it counts 1 here.
  test("a catalog shaped like anthropics/skills lists five entries; document-skills previews its four skills", async () => {
    const catalog: Record<string, string[]> = {
      "document-skills": ["xlsx", "docx", "pptx", "pdf"],
      "example-skills": [
        "algorithmic-art",
        "brand-guidelines",
        "canvas-design",
        "doc-coauthoring",
        "frontend-design",
        "internal-comms",
        "mcp-builder",
        "skill-creator",
        "slack-gif-creator",
        "theme-factory",
        "web-artifacts-builder",
        "webapp-testing",
      ],
      "claude-api": ["claude-api"],
      "academy-guide": ["academy-guide"],
      "discernment-nudge": ["discernment-nudge"],
    };
    const skills = Object.values(catalog).flat();
    const catalogDir = path.join(tmpRoot, "skills");
    await initRepo(catalogDir);
    await writeFiles(catalogDir, {
      ".claude-plugin/marketplace.json": marketplace(
        Object.entries(catalog).map(([name, listed]) => ({
          name,
          source: "./",
          strict: false,
          skills: listed.map((skill) => `./skills/${skill}`),
        }))
      ),
      ...Object.fromEntries(skills.map((skill) => [`skills/${skill}/SKILL.md`, skillMd(skill)])),
    });
    await commit(catalogDir, "catalog");

    const listed = await service.previewSource({ input: catalogDir });
    if (listed.kind !== "marketplace") throw new Error("expected a marketplace listing");
    expect(singleBuildRows(listed.marketplace).map((row) => [row.name, row.skillCount])).toEqual(
      Object.entries(catalog).map(([name, listedSkills]) => [name, listedSkills.length])
    );
    const preview = await service.preview({
      input: catalogDir,
      method: { kind: "claude-marketplace", entry: "document-skills" },
    });
    expect(preview.skills.map((skill) => skill.name).sort()).toEqual([
      "docx",
      "pdf",
      "pptx",
      "xlsx",
    ]);
  });
});
