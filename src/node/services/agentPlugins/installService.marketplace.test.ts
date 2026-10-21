/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
/**
 * Claude Code marketplaces through the install service, against real local git "remotes": the
 * preview lists the entries, the user installs one entry per install, and updates read the entry
 * again from marketplace.json at the new commit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
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

describe("AgentPluginInstallService Claude marketplaces", () => {
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
      listed.marketplace.entries.map((entry) => [entry.name, entry.skillCount, entry.installable])
    ).toEqual([
      ["docs", 2, true],
      ["examples", 1, true],
      ["pkg", undefined, false],
    ]);
    // The plugin-only API names the marketplace instead.
    await expect(service.preview({ input: marketDir })).rejects.toThrow(
      "is the Claude Code marketplace 'acme-market'"
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
    expect(listed.marketplace.entries.map((entry) => [entry.name, entry.skillCount])).toEqual([
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
