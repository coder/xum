/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
/**
 * Install methods through the install service, against a real local git "remote": a plain
 * skills repository installs as a managed plugin with a generated plugin.json, install keeps the
 * previewed method, and updates regenerate the manifest until the repository ships its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import { execFileAsync } from "@/node/utils/disposableExec";
import { discoverAgentPluginAt } from "./discovery";
import { AgentPluginInstallService } from "./installService";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";

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
    expect(preview.manifest.name).toBe("acme-skills");
    expect(preview.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
    expect(preview.hook).toBeUndefined();
    expect(preview.workflows).toEqual([]);
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

    // The generated name collides like any plugin name: the preview names the collision, and
    // install refuses it.
    const again = await service.preview({ input: remoteDir });
    expect(again.methods).toEqual([{ kind: "skills" }]);
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
  });

  test("a preview without a method skips an invalid Claude manifest and names it", async () => {
    await write({ ".claude-plugin/plugin.json": "{ not json" });
    await commit("broken claude manifest");
    const preview = await service.preview({ input: remoteDir });
    expect(preview.method).toEqual({ kind: "skills" });
    expect(preview.methods).toEqual([{ kind: "claude-plugin" }, { kind: "skills" }]);
    expect(preview.warnings.some((warning) => warning.startsWith("Claude Code plugin:"))).toBe(
      true
    );
    await expect(
      service.preview({ input: remoteDir, method: { kind: "claude-plugin" } })
    ).rejects.toThrow("Invalid plugin");
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
    const { plugin } = await discoverAgentPluginAt({ pluginDir: installedDir(), scope: "global" });
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
    const { plugin } = await discoverAgentPluginAt({ pluginDir: installedDir(), scope: "global" });
    expect(plugin?.hooksPath).toBeDefined();

    // Without that plugin.json again, the update names the way out instead of claiming that
    // the repository has no SKILL.md files.
    await fsPromises.rm(path.join(remoteDir, "plugin.json"));
    await commit("drop own manifest");
    await expect(service.previewUpdate({ name: "acme-skills" })).rejects.toThrow(
      "it fits: Skills. Uninstall the plugin and install it again"
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
