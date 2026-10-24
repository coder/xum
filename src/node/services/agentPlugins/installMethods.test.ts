/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { DisposableTempDir } from "@/node/services/tempDir";
import { discoverAgentPluginAt } from "./discovery";
import {
  chooseInstallMethod,
  detectInstallMethods,
  findSkillsPackageRoots,
  generatedPluginName,
  toPluginName,
  writeGeneratedManifest,
} from "./installMethods";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0, INERT_COMPONENT_PATH, MAX_SKILLS_ROOTS } from "./manifest";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;

/** Write `<relative>/SKILL.md` for each folder, and any extra files (relative path → content). */
async function writeTree(
  dir: string,
  skillFolders: string[],
  files: Record<string, string> = {}
): Promise<void> {
  for (const folder of skillFolders) {
    await fs.mkdir(path.join(dir, folder), { recursive: true });
    await fs.writeFile(path.join(dir, folder, "SKILL.md"), SKILL(path.basename(folder)));
  }
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), content);
  }
}

const source = { url: "https://github.com/acme/skills.git" };

describe("findSkillsPackageRoots", () => {
  test("flat and catalog layouts give skill parent folders; depth stops at three levels", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, [
      "skills/flat",
      "skills/group/nested",
      "skills/g1/g2/deep",
      // Four levels below the container: the CLI does not look there.
      "skills/g1/g2/g3/too-deep",
      ".claude/skills/claude-one",
      // Not a container of the skills CLI.
      "examples/skill",
    ]);
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([
      { root: "skills", skills: ["flat"] },
      { root: "skills/g1/g2", skills: ["deep"] },
      { root: "skills/group", skills: ["nested"] },
      { root: ".claude/skills", skills: ["claude-one"] },
    ]);
  });

  test("a shallower SKILL.md shadows deeper ones, and a root SKILL.md is one skill", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, ["skills/outer", "skills/outer/inner", "skills/.curated/curated"]);
    // skills/.curated is reached once, although it is also a container of its own.
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([
      { root: "skills", skills: ["outer"] },
      { root: "skills/.curated", skills: ["curated"] },
    ]);

    await writeTree(tmp.path, ["."]);
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([{ root: ".", skills: [] }]);
  });

  test("mirrors the pinned CLI roots: the root one level deep, then its containers in order", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, [
      "root-skill",
      // The root is walked one level deep only.
      "examples/too-deep",
      ".github/skills/gh",
      ".codex/skills/cx",
      // Not a folder of skills@1.7.4.
      ".aider-desk/skills/aider",
    ]);
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([
      { root: ".", skills: ["root-skill"] },
      { root: ".codex/skills", skills: ["cx"] },
      { root: ".github/skills", skills: ["gh"] },
    ]);
  });

  test("an invalid root SKILL.md does not hide the skills below it", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, ["skills/foo"], { "SKILL.md": "# No frontmatter\n" });
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([{ root: "skills", skills: ["foo"] }]);
    // The CLI also skips a root SKILL.md without a description.
    await fs.writeFile(path.join(tmp.path, "SKILL.md"), "---\nname: repo\n---\n");
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([{ root: "skills", skills: ["foo"] }]);
  });

  test("a nested SKILL.md that does not parse is no skill, so no Skills install fits", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, [], {
      "skills/foo/SKILL.md": "# No frontmatter\n",
      "skills/foo/inner/SKILL.md": SKILL("inner"),
      ".claude/skills/SKILL.md": "---\nname: claude\n---\n",
    });
    // The CLI skips both and does not look below them.
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([]);
    expect((await detectInstallMethods(tmp.path)).methods).toEqual([]);
  });

  test("a nested container restarts its own three levels", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, ["skills/a", "skills/.curated/g1/g2/deep"]);
    expect(await findSkillsPackageRoots(tmp.path)).toEqual([
      { root: "skills", skills: ["a"] },
      { root: "skills/.curated/g1/g2", skills: ["deep"] },
    ]);
  });

  test("symlinks that leave the tree are not followed", async () => {
    using tmp = new DisposableTempDir("install-methods");
    const repo = path.join(tmp.path, "repo");
    const outside = path.join(tmp.path, "outside");
    await writeTree(outside, ["escaped"]);
    await writeTree(repo, ["skills/inside", "shared/linked"]);
    await fs.symlink(path.join(outside, "escaped"), path.join(repo, "skills", "escaped"));
    await fs.symlink(outside, path.join(repo, ".agents"));
    // A link that stays inside the tree is followed.
    await fs.symlink(path.join(repo, "shared", "linked"), path.join(repo, "skills", "linked"));
    expect(await findSkillsPackageRoots(repo)).toEqual([
      { root: "skills", skills: ["inside", "linked"] },
    ]);
  });
});

describe("detectInstallMethods", () => {
  test("lists every method that fits, in order", async () => {
    using tmp = new DisposableTempDir("install-methods");
    const claude = path.join(tmp.path, "claude");
    await writeTree(claude, ["skills/a"], { ".claude-plugin/plugin.json": "{}" });
    expect((await detectInstallMethods(claude)).methods).toEqual([
      { kind: "claude-plugin" },
      { kind: "skills" },
    ]);

    // Xum never shadows a root or Codex manifest, so skills does not fit next to one.
    for (const manifest of ["plugin.json", ".codex-plugin/plugin.json"]) {
      const own = path.join(tmp.path, manifest.replaceAll("/", "-"));
      await writeTree(own, ["skills/a"], { [manifest]: "{}" });
      const detected = await detectInstallMethods(own);
      expect(detected.methods).toEqual([{ kind: "agent-plugin" }]);
      // The Skills CLI choice still sees the skills.
      expect(detected.skillsRoots).toEqual([{ root: "skills", skills: ["a"] }]);
    }

    const nothing = path.join(tmp.path, "nothing");
    await writeTree(nothing, [], { "README.md": "hi" });
    expect((await detectInstallMethods(nothing)).methods).toEqual([]);
  });

  test("a dangling plugin.json symlink counts as a manifest, so Xum never writes through it", async () => {
    using tmp = new DisposableTempDir("install-methods");
    const repo = path.join(tmp.path, "repo");
    await writeTree(repo, ["skills/a"]);
    await fs.symlink(path.join(tmp.path, "target.json"), path.join(repo, "plugin.json"));
    expect((await detectInstallMethods(repo)).methods).toEqual([{ kind: "agent-plugin" }]);
    await expect(writeGeneratedManifest(repo, { kind: "skills" }, source)).rejects.toThrow(
      /EEXIST/
    );
    expect(await fs.lstat(path.join(tmp.path, "target.json")).catch(() => null)).toBeNull();
  });

  test("a root plugin.json with no $schema yields to a Claude manifest, as in discovery", async () => {
    using tmp = new DisposableTempDir("install-methods");
    const schemaLess = JSON.stringify({ name: "ponytail" });
    const claudeManifest = JSON.stringify({ name: "ponytail" });

    const claude = path.join(tmp.path, "claude");
    await writeTree(claude, ["skills/a"], {
      "plugin.json": schemaLess,
      ".claude-plugin/plugin.json": claudeManifest,
    });
    // No skills: the root entry still blocks a generated plugin.json.
    expect((await detectInstallMethods(claude)).methods).toEqual([{ kind: "claude-plugin" }]);
    const { plugin } = await discoverAgentPluginAt({ pluginDir: claude, scope: "global" });
    expect(plugin?.claudeFallback).toBe(true);

    const codex = path.join(tmp.path, "codex");
    await writeTree(codex, [], {
      "plugin.json": schemaLess,
      ".codex-plugin/plugin.json": JSON.stringify({ name: "ponytail" }),
      ".claude-plugin/plugin.json": claudeManifest,
    });
    expect((await detectInstallMethods(codex)).methods).toEqual([{ kind: "agent-plugin" }]);

    // Alone, discovery validates the root file and reports its error.
    const alone = path.join(tmp.path, "alone");
    await writeTree(alone, ["skills/a"], { "plugin.json": schemaLess });
    expect((await detectInstallMethods(alone)).methods).toEqual([{ kind: "agent-plugin" }]);

    const withSchema = path.join(tmp.path, "with-schema");
    await writeTree(withSchema, [], {
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "ponytail" }),
      ".claude-plugin/plugin.json": claudeManifest,
    });
    expect((await detectInstallMethods(withSchema)).methods).toEqual([{ kind: "agent-plugin" }]);
  });

  test("a root plugin.json that is a symlink or not JSON stays the own manifest", async () => {
    using tmp = new DisposableTempDir("install-methods");
    const linked = path.join(tmp.path, "linked");
    await writeTree(linked, [], {
      "other.json": JSON.stringify({ name: "ponytail" }),
      ".claude-plugin/plugin.json": JSON.stringify({ name: "ponytail" }),
    });
    await fs.symlink(path.join(linked, "other.json"), path.join(linked, "plugin.json"));
    expect((await detectInstallMethods(linked)).methods).toEqual([{ kind: "agent-plugin" }]);

    const invalid = path.join(tmp.path, "invalid");
    await writeTree(invalid, [], {
      "plugin.json": "{ not json",
      ".claude-plugin/plugin.json": JSON.stringify({ name: "ponytail" }),
    });
    expect((await detectInstallMethods(invalid)).methods).toEqual([{ kind: "agent-plugin" }]);
  });
});

describe("chooseInstallMethod", () => {
  const claudeAndSkills = [{ kind: "claude-plugin" as const }, { kind: "skills" as const }];

  test("preview takes the first method; install refuses a method that does not fit", () => {
    expect(chooseInstallMethod(claudeAndSkills, { mode: "first" })).toEqual({
      kind: "claude-plugin",
    });
    expect(chooseInstallMethod([], { mode: "first" })).toBeUndefined();
    expect(
      chooseInstallMethod(claudeAndSkills, { mode: "exact", method: { kind: "skills" } })
    ).toEqual({ kind: "skills" });
    expect(() =>
      chooseInstallMethod(claudeAndSkills, { mode: "exact", method: { kind: "agent-plugin" } })
    ).toThrow("cannot be installed as Agent Plugin; it fits: Claude Code plugin, Skills");
  });

  test("update keeps a generated install on skills unless the repository has its own manifest", () => {
    const generatedFrom = { kind: "skills" as const };
    expect(chooseInstallMethod(claudeAndSkills, { mode: "update", generatedFrom })).toEqual({
      kind: "skills",
    });
    expect(
      chooseInstallMethod([{ kind: "agent-plugin" }], { mode: "update", generatedFrom })
    ).toEqual({ kind: "agent-plugin" });
    // Not generated: a tree with only SKILL.md files does not update it.
    expect(
      chooseInstallMethod([{ kind: "skills" }], { mode: "update", generatedFrom: undefined })
    ).toBeUndefined();
    expect(
      chooseInstallMethod(claudeAndSkills, { mode: "update", generatedFrom: undefined })
    ).toEqual({ kind: "claude-plugin" });
  });
});

describe("generated plugin names", () => {
  test("lowercase, other characters become '-', runs collapse; invalid names throw", () => {
    expect(toPluginName("My Skills_Repo")).toBe("my-skills-repo");
    expect(toPluginName("--a..b--")).toBe("a.b");
    expect(toPluginName("x".repeat(80))).toBe("x".repeat(64));
    expect(() => toPluginName("con")).toThrow("cannot make a plugin name from 'con'");
    expect(() => toPluginName("___")).toThrow("cannot make a plugin name");
    expect(generatedPluginName({ url: "git@github.com:acme/Team.Skills.git" })).toBe("team.skills");
    expect(generatedPluginName({ url: source.url, subpath: "packs/PDF Tools" })).toBe("pdf-tools");
    // A Windows path: the last segment, not the whole path.
    expect(generatedPluginName({ url: "C:\\Users\\me\\Repo\\" })).toBe("repo");
  });
});

describe("writeGeneratedManifest", () => {
  test("writes a manifest discovery reads as a skills-only plugin", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, ["skills/a", ".agents/skills/b"], {
      // Never loaded for a skills install.
      "hooks.js": "export default {};",
      "agents/x.md": SKILL("x"),
    });
    expect(await writeGeneratedManifest(tmp.path, { kind: "skills" }, source)).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(tmp.path, "plugin.json"), "utf8"))).toEqual({
      $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
      name: "skills",
      description: "Skills from github.com/acme/skills",
      contributes: {
        skills: ["skills", ".agents/skills"],
        hooks: INERT_COMPONENT_PATH,
        agents: INERT_COMPONENT_PATH,
        workflows: INERT_COMPONENT_PATH,
        mcp: INERT_COMPONENT_PATH,
      },
      extensions: { mux: { generatedFrom: { kind: "skills" } }, "com.openai": { hooks: [] } },
    });
    const { plugin } = await discoverAgentPluginAt({ pluginDir: tmp.path, scope: "global" });
    expect(plugin?.skillsOnly).toBe(true);
    expect(plugin?.hooksPath).toBeUndefined();
    expect(plugin?.agentsDir).toBeUndefined();
  });

  test("root skill folders install through a declared root that discovery reads as a folder", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, ["pdf", "skills/a"]);
    await writeGeneratedManifest(tmp.path, { kind: "skills" }, source);
    const { plugin } = await discoverAgentPluginAt({ pluginDir: tmp.path, scope: "global" });
    if (plugin === null) throw new Error("the generated manifest is not a plugin");
    expect(plugin.skillsDirs).toEqual([
      { dir: plugin.rootPath },
      { dir: path.join(plugin.rootPath, "skills") },
    ]);
  });

  test("a build that ignores the marker still loads only the listed skills", async () => {
    using tmp = new DisposableTempDir("install-methods");
    await writeTree(tmp.path, ["skills/a"], {
      "hooks.js": "export default {};",
      "agents/x.md": SKILL("x"),
      "workflows/run.js": "export {};",
      "mcp.json": "{}",
      "hooks/hooks.json": JSON.stringify({ hooks: {} }),
    });
    await fs.mkdir(path.join(tmp.path, ".git"));
    await writeGeneratedManifest(tmp.path, { kind: "skills" }, source);
    // An older build treats extensions.mux as opaque: drop the marker to read the file as one.
    const manifestPath = path.join(tmp.path, "plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      extensions: Record<string, unknown>;
    };
    delete manifest.extensions.mux;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const { plugin, diagnostics } = await discoverAgentPluginAt({
      pluginDir: tmp.path,
      scope: "global",
    });

    expect(plugin?.skillsOnly).toBeUndefined();
    expect(plugin?.skillsDirs).toEqual([{ dir: path.join(plugin?.rootPath ?? "", "skills") }]);
    expect(plugin?.hooksPath).toBeUndefined();
    expect(plugin?.agentsDir).toBeUndefined();
    expect(plugin?.workflowsDir).toBeUndefined();
    expect(plugin?.mcpConfigPath).toBeUndefined();
    // An empty Codex hooks list turns hooks/hooks.json off.
    expect(plugin?.openai?.hooks).toEqual([]);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("names every skill past the root cap", async () => {
    using tmp = new DisposableTempDir("install-methods");
    const groups = Array.from(
      { length: MAX_SKILLS_ROOTS + 2 },
      (_, index) => `skills/g${String(index).padStart(2, "0")}/s${index}`
    );
    await writeTree(tmp.path, groups);
    const warnings = await writeGeneratedManifest(tmp.path, { kind: "skills" }, source);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("skills/g16/s16, skills/g17/s17");
    const manifest = JSON.parse(await fs.readFile(path.join(tmp.path, "plugin.json"), "utf8")) as {
      contributes: { skills: string[] };
    };
    expect(manifest.contributes.skills).toHaveLength(MAX_SKILLS_ROOTS);
  });
});
