/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
/**
 * Install methods through the install service, against a real local git "remote": a plain
 * skills repository installs as a managed plugin with a generated plugin.json, install keeps the
 * previewed method, and updates regenerate the manifest until the repository ships its own.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import { execFileAsync } from "@/node/utils/disposableExec";
import type { McpOauthService } from "@/node/services/mcpOauthService";
import { getApprovedCopiesPath } from "./approvedCopies";
import { discoverAgentPluginAt, discoverAgentPlugins } from "./discovery";
import { listPluginAgentFiles } from "./agentFiles";
import { reviewedComponentConsent } from "./testFixtures";
import { AgentPluginInstallService } from "./installService";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { computePluginInstanceId } from "./mcpConfig";

async function git(cwd: string, ...args: string[]): Promise<string> {
  using proc = execFileAsync("git", [`-C`, cwd, ...args]);
  return (await proc.result).stdout;
}

const skillMd = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody\n`;

describe("AgentPluginInstallService install methods", () => {
  let tmpRoot: string;
  let xumRoot: string;
  /** The remote's folder name is the generated plugin name. */
  let remoteDir: string;
  let service: AgentPluginInstallService;
  const installedDir = () => path.join(xumRoot, "plugins", "acme-skills");

  async function write(files: Record<string, string>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      await fsPromises.mkdir(path.dirname(path.join(remoteDir, relative)), { recursive: true });
      await fsPromises.writeFile(path.join(remoteDir, relative), content);
    }
  }

  async function commit(message: string): Promise<string> {
    await git(remoteDir, "add", "-A");
    await git(remoteDir, "commit", "-q", "-m", message);
    return (await git(remoteDir, "rev-parse", "HEAD")).trim();
  }

  async function installedManifest(): Promise<Record<string, unknown>> {
    const raw = await fsPromises.readFile(path.join(installedDir(), "plugin.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  async function installAsSkills(skills: string[]): Promise<void> {
    const preview = await service.preview({ input: remoteDir, method: { kind: "skills" } });
    await service.install({
      source: preview.source,
      method: preview.method,
      expectedSha: preview.lockedSha,
      expectedConsentDigest: preview.consentDigest,
      importedComponents: { skills, mcpServers: [] },
    });
  }

  async function updateWithReview(): Promise<string[]> {
    const review = await service.previewUpdate({ name: "acme-skills" });
    await service.update({
      name: "acme-skills",
      consent: {
        fromSha: review.fromSha,
        toSha: review.toSha,
        reviewed: review.changes.flatMap((change) => change.component ?? []),
      },
    });
    return review.changes.map((change) => change.summary);
  }

  beforeEach(async () => {
    tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-install-methods-"));
    xumRoot = path.join(tmpRoot, "xum");
    remoteDir = path.join(tmpRoot, "acme-skills");
    await fsPromises.mkdir(remoteDir);
    service = new AgentPluginInstallService(new Config(xumRoot), {});
    await git(remoteDir, "init", "-q", "-b", "main");
    await git(remoteDir, "config", "user.email", "test@example.com");
    await git(remoteDir, "config", "user.name", "Test");
    await write({
      "skills/alpha/SKILL.md": skillMd("alpha"),
      "skills/beta/SKILL.md": skillMd("beta"),
      // A skills install never loads these.
      "hooks.js": "export default {};",
      "workflows/w.js": "export default async () => {};",
      "skills/alpha/workflow.js": "export default async () => {};",
      "mcp.json": "{}",
    });
    await commit("init");
  });

  afterEach(async () => {
    await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  });

  test("a skills repository installs only the checked skills, with a generated plugin.json", async () => {
    const preview = await service.preview({ input: remoteDir });
    expect(preview.method).toEqual({ kind: "skills" });
    expect(preview.methods).toEqual([{ kind: "skills" }]);
    expect(preview.skillsCliSkills).toEqual(["alpha", "beta"]);
    expect(preview.manifest.name).toBe("acme-skills");
    expect(preview.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
    expect(preview.hook).toBeUndefined();
    expect(preview.workflows).toEqual([]);
    // A skill's workflow.js is not offered for review: a skills install runs no scripts.
    expect(preview.reviewedComponents).toEqual([]);
    expect(preview.mcpServers).toEqual([]);

    // Install generates the same manifest from its own clone: the consent digest matches.
    await installAsSkills(["alpha"]);
    expect((await service.getComponents({ name: "acme-skills" })).importedComponents).toEqual({
      skills: ["alpha"],
      mcpServers: [],
    });
    expect(await installedManifest()).toMatchObject({
      name: "acme-skills",
      contributes: { skills: ["skills"] },
      extensions: { mux: { generatedFrom: { kind: "skills" } } },
    });

    // The generated name collides like any plugin name, but only the managed install: the
    // preview still lists the method and the Skills CLI names (the CLI creates no plugin).
    const again = await service.preview({ input: remoteDir });
    expect(again.methods).toEqual([{ kind: "skills" }]);
    expect(again.skillsCliSkills).toEqual(["alpha", "beta"]);
    expect(again.installBlockedReason).toBe(
      "A managed plugin named 'acme-skills' is already installed. Uninstall it first."
    );
    await expect(
      service.install({
        source: again.source,
        method: again.method,
        expectedSha: again.lockedSha,
        expectedConsentDigest: again.consentDigest,
      })
    ).rejects.toThrow("A managed plugin named 'acme-skills' is already installed");
  });

  test("the Skills CLI choice names each skill by its frontmatter name, also a root skill", async () => {
    // The CLI matches --skill against the frontmatter name, not the repository or folder name.
    await fsPromises.rm(path.join(remoteDir, "skills"), { recursive: true });
    await write({ "SKILL.md": skillMd("pdf") });
    await commit("root skill");
    expect((await service.preview({ input: remoteDir })).skillsCliSkills).toEqual(["pdf"]);

    // A name that is not a valid skill name cannot be passed safely: no CLI choice for it.
    await write({ "SKILL.md": skillMd("PDF Tools") });
    await commit("display name");
    expect((await service.preview({ input: remoteDir })).skillsCliSkills).toEqual([]);
  });

  test("two skill folders with one SKILL.md name are both left out of the Skills CLI choice", async () => {
    // --skill alpha would install both copies under one name: a later one could replace alpha.
    await write({ ".agents/skills/alpha-copy/SKILL.md": skillMd("alpha") });
    await commit("second alpha");
    const preview = await service.preview({ input: remoteDir });
    expect(preview.skillsCliSkills).toEqual(["beta"]);
    expect(preview.warnings).toContain(
      "Skills CLI: more than one skill folder has the SKILL.md name 'alpha', so the Skills CLI choice leaves it out"
    );
  });

  test("one skill folder found twice counts once for the Skills CLI choice", async () => {
    // skills/SKILL.md is both a root child folder and the skills container itself.
    await fsPromises.rm(path.join(remoteDir, "skills"), { recursive: true });
    await write({ "skills/SKILL.md": skillMd("skills") });
    await commit("one skill at skills/SKILL.md");
    const preview = await service.preview({ input: remoteDir });
    expect(preview.skillsCliSkills).toEqual(["skills"]);
    expect(preview.warnings.join("\n")).not.toContain("more than one skill folder");
  });

  test("install refuses a method that does not fit its clone", async () => {
    const preview = await service.preview({ input: remoteDir });
    await expect(
      service.install({
        source: preview.source,
        method: { kind: "claude-plugin" },
        expectedSha: preview.lockedSha,
      })
    ).rejects.toThrow("cannot be installed as Claude Code plugin; it fits: Skills");
    await expect(
      service.preview({ input: remoteDir, method: { kind: "agent-plugin" } })
    ).rejects.toThrow("cannot be installed as Agent Plugin");
    expect(await fsPromises.lstat(installedDir()).catch(() => null)).toBeNull();
  });

  test("a Claude plugin with skills offers claude-plugin and skills; an Agent Plugin only itself", async () => {
    await write({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "acme-skills" }),
      "agents/reviewer.md": "---\nname: reviewer\ndescription: R\n---\n",
    });
    await commit("claude manifest");
    const claude = await service.preview({ input: remoteDir });
    expect(claude.method).toEqual({ kind: "claude-plugin" });
    expect(claude.methods).toEqual([{ kind: "claude-plugin" }, { kind: "skills" }]);
    expect(claude.agents).toEqual(["reviewer.md"]);
    const asSkills = await service.preview({ input: remoteDir, method: { kind: "skills" } });
    expect(asSkills.method).toEqual({ kind: "skills" });
    expect(asSkills.agents).toEqual([]);

    await write({
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "acme-skills" }),
    });
    await commit("own manifest");
    const own = await service.preview({ input: remoteDir });
    expect(own.methods).toEqual([{ kind: "agent-plugin" }]);
    // The Skills CLI choice still gets the skill names.
    expect(own.skillsCliSkills).toEqual(["alpha", "beta"]);
  });

  test("an invalid Claude manifest is not offered: the preview names it, and install refuses it", async () => {
    await write({ ".claude-plugin/plugin.json": "{ not json" });
    await commit("broken claude manifest");
    const preview = await service.preview({ input: remoteDir });
    expect(preview.method).toEqual({ kind: "skills" });
    expect(preview.methods).toEqual([{ kind: "skills" }]);
    expect(preview.warnings.some((warning) => warning.startsWith("Claude Code plugin:"))).toBe(
      true
    );
    await expect(
      service.preview({ input: remoteDir, method: { kind: "claude-plugin" } })
    ).rejects.toThrow("Invalid plugin");
    await expect(
      service.install({
        source: preview.source,
        method: { kind: "claude-plugin" },
        expectedSha: preview.lockedSha,
      })
    ).rejects.toThrow("Invalid plugin");
    expect(await fsPromises.lstat(installedDir()).catch(() => null)).toBeNull();
  });

  test("a tree whose only manifest is a schema-less root plugin.json keeps the $schema error", async () => {
    await fsPromises.rm(path.join(remoteDir, "skills"), { recursive: true });
    await write({ "plugin.json": JSON.stringify({ name: "acme-skills" }) });
    await commit("schema-less root only");
    const failure = await service.preview({ input: remoteDir }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("'$schema' is required");
    expect((failure as Error).message).not.toContain("No plugin.json");
  });

  test("an update regenerates the manifest and reviews a new skill", async () => {
    await installAsSkills(["alpha", "beta"]);
    await write({ "skills/gamma/SKILL.md": skillMd("gamma") });
    await commit("add gamma");
    const changes = await updateWithReview();
    expect(changes.some((summary) => summary.includes("gamma"))).toBe(true);
    const { skills } = await service.getComponents({ name: "acme-skills" });
    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(await installedManifest()).toMatchObject({
      extensions: { mux: { generatedFrom: { kind: "skills" } } },
    });
  });

  test("a skills install from a Claude repository stays skills on update", async () => {
    await write({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "acme-skills" }),
      "agents/reviewer.md": "---\nname: reviewer\ndescription: R\n---\n",
    });
    await commit("claude manifest");
    await installAsSkills(["alpha"]);
    await write({ "skills/alpha/SKILL.md": `${skillMd("alpha")}More\n` });
    await commit("edit alpha");
    await updateWithReview();
    expect(await installedManifest()).toMatchObject({
      extensions: { mux: { generatedFrom: { kind: "skills" } } },
    });
    const { plugin } = await discoverAgentPluginAt({
      pluginDir: installedDir(),
      scope: "global",
      choice: { kind: "fixed-order" },
    });
    expect(plugin?.claudeFallback).toBeUndefined();
    expect(plugin?.agentsDir).toBeUndefined();
  });

  test("an update switches to the repository's own plugin.json once it has one", async () => {
    await installAsSkills(["alpha"]);
    await write({
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "acme-skills" }),
    });
    await commit("own manifest");
    const changes = await updateWithReview();
    // The repository's hooks.js and workflows now load, and the review shows them.
    expect(changes.length).toBeGreaterThan(0);
    const manifest = await installedManifest();
    expect(manifest.extensions).toBeUndefined();
    const { plugin } = await discoverAgentPluginAt({
      pluginDir: installedDir(),
      scope: "global",
      choice: { kind: "fixed-order" },
    });
    expect(plugin?.hooksPath).toBeDefined();

    // Without that plugin.json again, the update names the way out instead of claiming that
    // the repository has no SKILL.md files: the review carries the refusal, with nothing applied.
    await fsPromises.rm(path.join(remoteDir, "plugin.json"));
    await commit("drop own manifest");
    const refused = await service.previewUpdate({ name: "acme-skills" });
    expect(refused.changes).toEqual([]);
    expect(refused.refused).toContain(
      "Methods that fit this commit: Skills. To switch, uninstall the plugin and install it again."
    );
    await expect(service.update({ name: "acme-skills" })).rejects.toThrow(
      "Methods that fit this commit: Skills."
    );
  });

  test("a folder name that makes no valid plugin name stops the preview", async () => {
    const con = path.join(tmpRoot, "con");
    await fsPromises.rename(remoteDir, con);
    remoteDir = con;
    await expect(service.preview({ input: remoteDir })).rejects.toThrow(
      "cannot make a plugin name from 'con'"
    );
  });
});

/**
 * egm's layout (google/elephant-goldfish-model at 113a3afc): a schema-less root plugin.json beside
 * a Codex, a Claude and a Cursor manifest. Every manifest resolves the same 7 skills. The Claude
 * manifest lists 9 agents and the Cursor one 7.
 */
const EGM_SKILLS = [
  "egm-bootstrap",
  "egm-brainstorm",
  "egm-draft",
  "egm-drift-report",
  "egm-resolve",
  "egm-review-loop",
  "egm-review",
];
const EGM_CLAUDE_AGENTS = [
  "bootstrap_orchestrator",
  "codebase_details",
  "comprehension",
  "design_critic",
  "implementation_readiness",
  "structural",
  "style",
  "synthesizer",
  "zoom_out",
];
const EGM_CURSOR_AGENTS = EGM_CLAUDE_AGENTS.filter(
  (id) => id !== "bootstrap_orchestrator" && id !== "synthesizer"
);
const egmAgent = (id: string) =>
  `---\nname: egm-${id}\ndescription: The ${id} reviewer\ntools: [Read, Grep, Glob]\n---\nRead \`\${CLAUDE_PLUGIN_ROOT}/agents/${id}.md\` before reviewing.\n`;

function egmFiles(): Record<string, string> {
  const base = { name: "egm", version: "0.1.0", description: "Draft specs and review designs." };
  return {
    "plugin.json": JSON.stringify(base),
    ".codex-plugin/plugin.json": JSON.stringify({ ...base, skills: "./skills/" }),
    ".claude-plugin/plugin.json": JSON.stringify({
      ...base,
      agents: EGM_CLAUDE_AGENTS.map((id) => `./.claude-plugin/agents/${id}.md`),
    }),
    ".cursor-plugin/plugin.json": JSON.stringify({
      ...base,
      skills: "./skills/",
      agents: "./.cursor-plugin/agents/",
      rules: "./.cursor-plugin/rules/",
    }),
    ".cursor-plugin/rules/egm.mdc": "---\ndescription: egm rule\n---\nBody\n",
    ...Object.fromEntries(EGM_SKILLS.map((id) => [`skills/${id}/SKILL.md`, skillMd(id)])),
    ...Object.fromEntries(
      EGM_CLAUDE_AGENTS.map((id) => [`.claude-plugin/agents/${id}.md`, egmAgent(id)])
    ),
    ...Object.fromEntries(
      EGM_CURSOR_AGENTS.map((id) => [`.cursor-plugin/agents/${id}.md`, egmAgent(id)])
    ),
    ...Object.fromEntries(EGM_CLAUDE_AGENTS.map((id) => [`agents/${id}.md`, `Persona ${id}\n`])),
  };
}

describe("AgentPluginInstallService method choice (egm layout)", () => {
  let tmpRoot: string;
  let xumRoot: string;
  let remoteDir: string;
  let service: AgentPluginInstallService;
  const installedDir = () => path.join(xumRoot, "plugins", "egm");
  const registryFile = () => path.join(xumRoot, "plugins.json");

  async function write(files: Record<string, string>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      await fsPromises.mkdir(path.dirname(path.join(remoteDir, relative)), { recursive: true });
      await fsPromises.writeFile(path.join(remoteDir, relative), content);
    }
  }

  async function commit(message: string): Promise<string> {
    await git(remoteDir, "add", "-A");
    await git(remoteDir, "commit", "-q", "-m", message);
    return (await git(remoteDir, "rev-parse", "HEAD")).trim();
  }

  async function registryRows(): Promise<Array<Record<string, unknown>>> {
    const doc = JSON.parse(await fsPromises.readFile(registryFile(), "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    return doc.plugins;
  }

  async function rawRow(): Promise<Record<string, unknown>> {
    const row = (await registryRows()).find((entry) => entry.name === "egm");
    if (row === undefined) throw new Error("egm has no registry row");
    return row;
  }

  async function editRow(change: (row: Record<string, unknown>) => void): Promise<void> {
    const rows = await registryRows();
    for (const row of rows) change(row);
    await fsPromises.writeFile(registryFile(), JSON.stringify({ plugins: rows }));
  }

  async function installAs(kind: "agent-plugin" | "claude-plugin" | "cursor-plugin") {
    const preview = await service.preview({ input: remoteDir, method: { kind } });
    return service.install({
      source: preview.source,
      method: preview.method,
      expectedSha: preview.lockedSha,
      expectedConsentDigest: preview.consentDigest,
    });
  }

  async function updateWithReview(): Promise<string[]> {
    const review = await service.previewUpdate({ name: "egm" });
    await service.update({
      name: "egm",
      consent: {
        fromSha: review.fromSha,
        toSha: review.toSha,
        reviewed: review.changes.flatMap((change) => change.component ?? []),
      },
    });
    return review.changes.map((change) => change.summary);
  }

  async function installedState(): Promise<string> {
    const manifest = await fsPromises.readFile(
      path.join(installedDir(), ".claude-plugin", "plugin.json"),
      "utf8"
    );
    return JSON.stringify([await registryRows(), manifest]);
  }

  beforeEach(async () => {
    tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-install-egm-"));
    xumRoot = path.join(tmpRoot, "xum");
    remoteDir = path.join(tmpRoot, "egm");
    await fsPromises.mkdir(remoteDir);
    service = new AgentPluginInstallService(new Config(xumRoot), {});
    await git(remoteDir, "init", "-q", "-b", "main");
    await git(remoteDir, "config", "user.email", "test@example.com");
    await git(remoteDir, "config", "user.name", "Test");
    await write(egmFiles());
    await commit("egm layout");
  });

  afterEach(async () => {
    await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  });

  test("the preview offers each manifest, and preselects the first in the fixed order", async () => {
    const preview = await service.preview({ input: remoteDir });
    expect(preview.methods).toEqual([
      { kind: "agent-plugin" },
      { kind: "claude-plugin" },
      { kind: "cursor-plugin" },
    ]);
    // One click keeps installing what Xum installs today: the Codex manifest, with no agents.
    expect(preview.method).toEqual({ kind: "agent-plugin" });
    expect(preview.agents).toEqual([]);
    expect(preview.skills.map((skill) => skill.name)).toEqual([...EGM_SKILLS].sort());

    const claude = await service.preview({ input: remoteDir, method: { kind: "claude-plugin" } });
    expect(claude.agents).toHaveLength(9);
    expect(claude.skills).toHaveLength(7);
    const cursor = await service.preview({ input: remoteDir, method: { kind: "cursor-plugin" } });
    expect(cursor.agents).toHaveLength(7);
  });

  test("a root plugin.json with $schema is offered alone, and install refuses another method", async () => {
    await write({
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "egm" }),
    });
    await commit("native root");
    const preview = await service.preview({ input: remoteDir });
    expect(preview.methods).toEqual([{ kind: "agent-plugin" }]);
    await expect(
      service.install({
        source: preview.source,
        method: { kind: "claude-plugin" },
        expectedSha: preview.lockedSha,
      })
    ).rejects.toThrow("cannot be installed as Claude Code plugin; it fits: Agent Plugin");
  });

  test("installing as claude-plugin saves the method, and the plugin loads its manifest and 9 agents", async () => {
    await installAs("claude-plugin");
    expect((await rawRow()).installMethod).toBe("claude-plugin");

    const { plugins } = await discoverAgentPlugins([
      { path: path.join(xumRoot, "plugins"), scope: "global", registryPath: registryFile() },
    ]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].claudeFallback).toBe(true);
    expect(await listPluginAgentFiles(plugins[0].agentsDir)).toHaveLength(9);
    const consent = (await rawRow()).componentConsent as { agents: Record<string, string> };
    expect(Object.keys(consent.agents).sort()).toEqual(
      EGM_CLAUDE_AGENTS.map((id) => `${id}`).sort()
    );
  });

  test("component review, capability diff, runtime load and hook gate agree on one method's fingerprints", async () => {
    await installAs("claude-plugin");
    const consentAtInstall = (await rawRow()).componentConsent as {
      agents: Record<string, string>;
      skills: Record<string, string>;
    };
    const runtime = await reviewedComponentConsent({
      pluginDir: installedDir(),
      method: "claude-plugin",
    });
    expect(runtime.agents).toEqual(consentAtInstall.agents);
    expect(runtime.skills).toEqual(consentAtInstall.skills);

    // The component review reads the installed tree through the saved method: with the agent
    // records gone it lists the 9 agents, at the fingerprints that the install and the load use.
    await editRow((row) => {
      (row.componentConsent as { agents: Record<string, string> }).agents = {};
    });
    const review = await service.previewComponentReview({ name: "egm" });
    const agentRows = review.changes.flatMap((change) =>
      change.component?.kind === "agents" ? [change.component] : []
    );
    expect(Object.fromEntries(agentRows.map((ref) => [ref.name, ref.fingerprint]))).toEqual(
      runtime.agents
    );
    await editRow((row) => {
      (row.componentConsent as { agents: Record<string, string> }).agents = consentAtInstall.agents;
    });

    // The update capability diff compares the installed Claude manifest with the staged one: an
    // unrelated commit shows no change. Read as Codex, the installed tree would lack 9 agents.
    await write({ "README.md": "more\n" });
    await commit("readme");
    expect((await service.previewUpdate({ name: "egm" })).changes).toEqual([]);
  });

  test("install and update write installMethodSha with lockedSha, only for a row with a saved method", async () => {
    await installAs("claude-plugin");
    const installed = await rawRow();
    expect(installed.installMethodSha).toBe(installed.lockedSha);

    await write({ "README.md": "more\n" });
    const next = await commit("readme");
    await updateWithReview();
    const updated = await rawRow();
    expect([updated.lockedSha, updated.installMethodSha]).toEqual([next, next]);

    // A row without a saved method has no installMethodSha, at install or after an update.
    await service.uninstall({ name: "egm", deletePluginData: true });
    await installAs("agent-plugin");
    await editRow((row) => {
      delete row.installMethod;
      delete row.installMethodSha;
    });
    await write({ "README.md": "again\n" });
    await commit("readme again");
    await updateWithReview();
    expect((await rawRow()).installMethodSha).toBeUndefined();
  });

  /** What an older build leaves after its update: lockedSha moved on, installMethodSha did not. */
  async function olderBuildUpdates(): Promise<string> {
    const vouchedFor = (await rawRow()).installMethodSha as string;
    await write({ "README.md": `older build ${Math.random()}\n` });
    await commit("an upstream commit");
    await updateWithReview();
    await editRow((row) => {
      row.installMethodSha = vouchedFor;
    });
    return vouchedFor;
  }

  const loadedPlugins = async () =>
    (
      await discoverAgentPlugins([
        { path: path.join(xumRoot, "plugins"), scope: "global", registryPath: registryFile() },
      ])
    ).plugins;

  test("a Claude install that an older build updated loads nothing, says why, and refuses an update", async () => {
    await installAs("claude-plugin");
    await olderBuildUpdates();
    expect(await loadedPlugins()).toEqual([]);

    const row = await service.list().then((rows) => rows.find((item) => item.name === "egm"));
    expect(row).toMatchObject({ managed: true, present: false });
    const reason = row?.closedReason ?? "";
    expect(reason).toContain("An older Xum version updated this plugin");

    // Xum writes nothing to repair it: no registry field, no hook trust, no sign-out record.
    const registryBefore = await fsPromises.readFile(registryFile(), "utf8");
    await write({ "README.md": "newer\n" });
    await commit("another upstream commit");
    const review = await service.previewUpdate({ name: "egm" });
    expect(review.changes).toEqual([]);
    expect(review.refused).toBe(reason);
    await expect(service.update({ name: "egm" })).rejects.toThrow(reason);
    expect(await fsPromises.readFile(registryFile(), "utf8")).toBe(registryBefore);
    expect(await fsPromises.readdir(xumRoot)).not.toContain("plugin-hook-trust");

    // A reinstall reviews it again and vouches for the new commit.
    await service.uninstall({ name: "egm", deletePluginData: true });
    await installAs("claude-plugin");
    expect((await loadedPlugins()).map((plugin) => plugin.name)).toEqual(["egm"]);
    expect(
      (await service.list()).find((item) => item.name === "egm")?.closedReason
    ).toBeUndefined();
  });

  test("a saved Agent Plugin, or a saved manifest that the fixed order loads too, keeps loading after an older build's update", async () => {
    await installAs("agent-plugin");
    await olderBuildUpdates();
    expect((await loadedPlugins()).map((plugin) => plugin.name)).toEqual(["egm"]);
    expect((await service.list())[0]?.closedReason).toBeUndefined();
    await write({ "README.md": "an update\n" });
    const next = await commit("an update");
    await updateWithReview();
    expect((await rawRow()).installMethodSha).toBe((await rawRow()).lockedSha);
    expect((await rawRow()).lockedSha).toBe(next);
    await service.uninstall({ name: "egm", deletePluginData: true });

    // Only the Claude manifest is left: the fixed order loads it, so the older build reviewed it.
    await git(remoteDir, "rm", "-q", "-r", "plugin.json", ".codex-plugin", ".cursor-plugin");
    await commit("a Claude-only repository");
    await installAs("claude-plugin");
    await olderBuildUpdates();
    expect((await loadedPlugins()).map((plugin) => plugin.name)).toEqual(["egm"]);
    expect((await service.list())[0]?.closedReason).toBeUndefined();
  });

  test("an update whose commit fits the saved method keeps it", async () => {
    await installAs("claude-plugin");
    await write({ "README.md": "more\n" });
    const next = await commit("readme");
    await updateWithReview();
    const row = await rawRow();
    expect(row.installMethod).toBe("claude-plugin");
    expect(row.lockedSha).toBe(next);
    const { plugins } = await discoverAgentPlugins([
      { path: path.join(xumRoot, "plugins"), scope: "global", registryPath: registryFile() },
    ]);
    expect(plugins[0].claudeFallback).toBe(true);
  });

  test("an update is refused, and nothing applied, when the commit lacks or breaks the saved manifest", async () => {
    await installAs("claude-plugin");
    const before = await installedState();
    const sha = (await rawRow()).lockedSha;
    const switchHint = "To switch, uninstall the plugin and install it again.";

    await fsPromises.rm(path.join(remoteDir, ".claude-plugin"), { recursive: true });
    await commit("drop the Claude manifest");
    const gone = await service.previewUpdate({ name: "egm" });
    expect(gone.changes).toEqual([]);
    expect(gone.refused).toBe(
      `.claude-plugin/plugin.json is gone in this commit. Methods that fit this commit: Agent Plugin, Cursor plugin. ${switchHint}`
    );
    await expect(service.update({ name: "egm" })).rejects.toThrow(gone.refused);

    await write({ ".claude-plugin/plugin.json": "{ not json" });
    await commit("break the Claude manifest");
    const invalid = await service.previewUpdate({ name: "egm" });
    expect(invalid.refused).toContain("Claude Code plugin: Invalid plugin");
    expect(invalid.refused).toContain(".claude-plugin/plugin.json");
    expect(invalid.refused).toContain("Methods that fit this commit: Agent Plugin, Cursor plugin.");

    await write({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "egm" }),
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "egm" }),
    });
    await commit("a Xum-native root");
    const native = await service.previewUpdate({ name: "egm" });
    expect(native.refused).toContain("takes precedence over .claude-plugin/plugin.json");
    expect(native.refused).toContain("Methods that fit this commit: Agent Plugin.");
    await expect(service.update({ name: "egm" })).rejects.toThrow("takes precedence");

    await git(remoteDir, "rm", "-q", "-r", ".");
    await write({ "README.md": "nothing\n" });
    await commit("no plugin left");
    const nothing = await service.previewUpdate({ name: "egm" });
    expect(nothing.refused).toBe(
      ".claude-plugin/plugin.json is gone in this commit. No install method fits this commit."
    );

    expect(await installedState()).toBe(before);
    expect((await rawRow()).lockedSha).toBe(sha);
    expect((await rawRow()).source).toMatchObject({ ref: "main", refType: "branch" });
  });

  test("a saved Agent Plugin fits a commit whose root gains $schema, and the update goes through the review", async () => {
    await installAs("agent-plugin");
    await write({
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "egm" }),
    });
    const next = await commit("the root gains $schema");
    const review = await service.previewUpdate({ name: "egm" });
    expect(review.refused).toBeUndefined();
    expect(review.toSha).toBe(next);
    if (review.changes.length > 0) {
      await expect(service.update({ name: "egm" })).rejects.toThrow("review");
    }
    await updateWithReview();
    const row = await rawRow();
    expect([row.installMethod, row.lockedSha]).toEqual(["agent-plugin", next]);
    const { plugins } = await discoverAgentPlugins([
      { path: path.join(xumRoot, "plugins"), scope: "global", registryPath: registryFile() },
    ]);
    expect(plugins[0].codexFallback).toBeUndefined();
  });

  test("a saved Agent Plugin fits a commit whose root loses $schema while a Codex manifest exists, and is refused without one", async () => {
    await write({
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "egm" }),
    });
    await commit("a Xum-native root");
    await installAs("agent-plugin");

    await write({ "plugin.json": JSON.stringify({ name: "egm" }) });
    await commit("the root loses $schema");
    expect((await service.previewUpdate({ name: "egm" })).refused).toBeUndefined();
    await updateWithReview();
    const { plugins } = await discoverAgentPlugins([
      { path: path.join(xumRoot, "plugins"), scope: "global", registryPath: registryFile() },
    ]);
    expect(plugins[0].codexFallback).toBe(true);
    expect((await rawRow()).installMethod).toBe("agent-plugin");

    await git(remoteDir, "rm", "-q", "-r", ".codex-plugin");
    await commit("the Codex manifest goes");
    const refused = await service.previewUpdate({ name: "egm" });
    expect(refused.refused).toBe(
      "plugin.json has no $schema in this commit, and .codex-plugin/plugin.json is gone. Methods that fit this commit: Claude Code plugin, Cursor plugin. To switch, uninstall the plugin and install it again."
    );
    await expect(service.update({ name: "egm" })).rejects.toThrow("has no $schema");

    await git(remoteDir, "rm", "-q", "-r", ".claude-plugin", ".cursor-plugin");
    await commit("only the root is left");
    const alone = await service.previewUpdate({ name: "egm" });
    expect(alone.refused).toContain("Agent Plugin: Invalid plugin");
    expect(alone.refused).toContain("'$schema' is required");
    expect(alone.refused).toContain("No install method fits this commit.");
  });

  test("an install without a saved method keeps updating with the Codex manifest", async () => {
    await installAs("agent-plugin");
    await editRow((row) => {
      delete row.installMethod;
    });
    await write({ "README.md": "more\n" });
    await commit("readme");
    await updateWithReview();
    const row = await rawRow();
    expect(row.installMethod).toBeUndefined();
    const { plugins } = await discoverAgentPlugins([
      { path: path.join(xumRoot, "plugins"), scope: "global", registryPath: registryFile() },
    ]);
    expect(plugins[0].codexFallback).toBe(true);

    await git(remoteDir, "rm", "-q", "-r", "plugin.json", ".claude-plugin", ".cursor-plugin");
    await commit("Codex only");
    await updateWithReview();
    expect((await rawRow()).lockedSha).toBe((await git(remoteDir, "rev-parse", "HEAD")).trim());
  });

  /**
   * The readers below must follow the saved method, not the fixed order. With the Codex manifest
   * broken, the fixed order finds no plugin in the installed tree and only a reader that loads
   * `.claude-plugin/plugin.json` still does, so each test fails if its reader forgets the method.
   */
  async function breakCodexManifest(): Promise<void> {
    await fsPromises.writeFile(
      path.join(installedDir(), ".codex-plugin", "plugin.json"),
      "{ not json"
    );
    const discover = (choice: Parameters<typeof discoverAgentPluginAt>[0]["choice"]) =>
      discoverAgentPluginAt({ pluginDir: installedDir(), scope: "global", choice });
    expect((await discover({ kind: "fixed-order" })).plugin).toBeNull();
    expect((await discover({ kind: "method", method: "claude-plugin" })).plugin?.name).toBe("egm");
  }

  test("the component inventory reads the installed tree through the saved method", async () => {
    await installAs("claude-plugin");
    await breakCodexManifest();
    const inventory = await service.getComponents({ name: "egm" });
    expect(inventory.skills.map((skill) => skill.name).sort()).toEqual([...EGM_SKILLS].sort());
  });

  test("the hook gate lists and records a decision on hooks through the saved method", async () => {
    await write({
      "hooks/hooks.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "^bash$", hooks: [{ type: "mcp_tool", server: "scanner", tool: "scan" }] },
          ],
        },
      }),
    });
    await commit("a hooks file");
    await installAs("claude-plugin");
    await breakCodexManifest();

    const { hooks } = await service.getHooks({ name: "egm" });
    expect(hooks.map((hook) => [hook.event, hook.review])).toEqual([["PreToolUse", "new"]]);
    // Xum lists the hooks of a Claude plugin and never runs them: the user can only disable one.
    await service.setHookTrust({
      name: "egm",
      key: hooks[0].key,
      hash: hooks[0].hash,
      state: "disabled",
    });
    expect((await service.getHooks({ name: "egm" })).hooks[0]?.review).toBe("disabled");
  });

  test("the sign-out recovery lists the remote servers of a tree through its saved method", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    await write({
      ".mcp.json": JSON.stringify({ mcpServers: { remote: { type: "http", url: serverUrl } } }),
    });
    await commit("a remote MCP server");
    await installAs("claude-plugin");
    await breakCodexManifest();

    const loggedOut: string[] = [];
    service.setMcpOauthService({
      logout: (input: { serverUrl: string }) => {
        loggedOut.push(input.serverUrl);
        return Promise.resolve({ success: true });
      },
      credentialKey: (url: string) => url,
    } as unknown as McpOauthService);
    await (
      service as unknown as { settledSignOutPasses: () => Promise<void> }
    ).settledSignOutPasses();
    loggedOut.length = 0;
    // A record that cannot be read: the servers come from the installed plugin trees.
    await fsPromises.writeFile(path.join(xumRoot, "plugin-sign-outs-pending.json"), "{ not json");
    await service.signOutPluginServers();
    expect(loggedOut).toEqual([serverUrl]);
  });

  test("a restart saves the approved copies of a tree through its saved method", async () => {
    await installAs("claude-plugin");
    const copiesFile = getApprovedCopiesPath(
      xumRoot,
      computePluginInstanceId(path.join(xumRoot, "plugins", "egm"))
    );
    // An install approved by a build without copies: the startup sweep saves them.
    await fsPromises.rm(copiesFile);
    await breakCodexManifest();
    const restarted = new AgentPluginInstallService(new Config(xumRoot), {});
    const internals = restarted as unknown as {
      reconciliationState: Promise<boolean>;
      startupApprovedCopiesSweep: Promise<void> | undefined;
    };
    expect(await internals.reconciliationState).toBe(true);
    await internals.startupApprovedCopiesSweep;
    const copies = JSON.parse(await fsPromises.readFile(copiesFile, "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(Object.keys(copies.skills).sort()).toEqual([...EGM_SKILLS].sort());
  });

  test("crash recovery reconciles a promoted update through the saved method", async () => {
    await installAs("claude-plugin");
    await write({ "README.md": "more\n" });
    const next = await commit("readme");
    const review = await service.previewUpdate({ name: "egm" });
    // The update dies after the promote: the journal deletion and the registry write both fail.
    const internals = service as unknown as {
      consumeJournalFile: (journalPath: string) => Promise<void>;
      writeRegistry: (envelope: Record<string, unknown>, entries: unknown[]) => Promise<void>;
    };
    const consumeSpy = spyOn(internals, "consumeJournalFile").mockImplementationOnce(() =>
      Promise.reject(new Error("EBUSY: resource busy"))
    );
    const writeSpy = spyOn(internals, "writeRegistry").mockImplementationOnce(() =>
      Promise.reject(new Error("ENOSPC: no space left on device"))
    );
    try {
      await expect(
        service.update({
          name: "egm",
          consent: { fromSha: review.fromSha, toSha: review.toSha, reviewed: [] },
        })
      ).rejects.toThrow(/ENOSPC/);
    } finally {
      consumeSpy.mockRestore();
      writeSpy.mockRestore();
    }
    expect((await rawRow()).lockedSha).toBe(review.fromSha);
    await breakCodexManifest();

    // Section open runs recovery: it reads the promoted tree through the saved method.
    await service.list();
    expect((await rawRow()).lockedSha).toBe(next);
    expect((await rawRow()).installMethod).toBe("claude-plugin");
    // Recovery cannot tell which build promoted the tree, so it leaves installMethodSha alone.
    expect((await rawRow()).installMethodSha).toBe(review.fromSha);
  });
});
