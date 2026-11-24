/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
/**
 * Approved copies through the install service, against a real local git "remote": a skill or
 * workflow script that changes without approval keeps serving the version the user approved,
 * and the copies end with the install.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  discoverAgentSkills,
  readAgentSkill,
} from "@/node/services/agentSkills/agentSkillsService";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import { execFileAsync } from "@/node/utils/disposableExec";
import { getApprovedCopiesPath } from "./approvedCopies";
import { AgentPluginInstallService } from "./installService";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { computePluginInstanceId } from "./mcpConfig";
import { PLUGIN_REGISTRY_FILE_NAME } from "./registry";
// The Node layer: these tests read through host runtimes.
import { nodeRuntimeFactory as runtimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";

async function git(cwd: string, ...args: string[]): Promise<string> {
  using proc = execFileAsync("git", [`-C`, cwd, ...args]);
  return (await proc.result).stdout;
}

describe("AgentPluginInstallService approved copies", () => {
  let xumRoot: string;
  /** The configured Xum home: `xumRoot`, or a symlink to it. */
  let home: string;
  let remoteDir: string;
  let service: AgentPluginInstallService;
  const copiesFile = () =>
    getApprovedCopiesPath(home, computePluginInstanceId(path.join(home, "plugins", "demo")));

  async function writeFiles(pluginDir: string, version: string): Promise<void> {
    await fsPromises.writeFile(
      path.join(pluginDir, "skills", "greet", "SKILL.md"),
      `---\nname: greet\ndescription: ${version}\n---\n${version}-BODY\n`
    );
    await fsPromises.writeFile(
      path.join(pluginDir, "workflows", "hello.js"),
      `export default function workflow() { return "${version}"; }\n`
    );
  }

  async function writeVersion(version: string): Promise<void> {
    await writeFiles(remoteDir, version);
    await git(remoteDir, "add", "-A");
    await git(remoteDir, "commit", "-q", "-m", version);
  }

  /** An edit in the installed plugin folder: nobody approved it. */
  const editInstalled = (version: string) =>
    writeFiles(path.join(home, "plugins", "demo"), version);

  async function install(
    importedComponents?: Parameters<AgentPluginInstallService["install"]>[0]["importedComponents"]
  ): Promise<void> {
    const preview = await service.preview({ input: remoteDir });
    await service.install({
      source: preview.source,
      expectedSha: preview.lockedSha,
      ...(importedComponents !== undefined ? { importedComponents } : {}),
    });
  }

  /** What an agent gets now: the skill's description and the workflow's source. */
  async function served(): Promise<{ skill: string | undefined; workflow: string }> {
    const runtime = new LocalRuntime(home);
    const roots = {
      projectRoot: "",
      globalRoot: path.join(home, "skills"),
      universalRoot: "",
      globalPluginRoots: [path.join(home, "plugins")],
    };
    const { skills } = await discoverAgentSkills(runtime, home, { roots, runtimeFactory });
    const read = await readAgentSkill(runtime, home, SkillNameSchema.parse("greet"), {
      roots,
      runtimeFactory,
    });
    expect(skills.find((skill) => skill.name === "greet")?.description).toBe(
      read.package.frontmatter.description
    );
    const workflow = await resolveWorkflowScript({
      scriptPath: "plugin://demo/hello.js",
      runtime,
      workspacePath: home,
      projectTrusted: false,
      roots,
      runtimeFactory,
    });
    return { skill: read.package.frontmatter.description, workflow: workflow.source };
  }

  beforeEach(async () => {
    xumRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-approved-copies-"));
    home = xumRoot;
    remoteDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-approved-copies-remote-"));
    service = new AgentPluginInstallService(new Config(xumRoot), {});
    await git(remoteDir, "init", "-q", "-b", "main");
    await git(remoteDir, "config", "user.email", "test@example.com");
    await git(remoteDir, "config", "user.name", "Test");
    await fsPromises.writeFile(
      path.join(remoteDir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "demo", version: "1.0.0" })
    );
    await fsPromises.mkdir(path.join(remoteDir, "skills", "greet"), { recursive: true });
    await fsPromises.mkdir(path.join(remoteDir, "workflows"));
    await writeVersion("v1");
  });

  afterEach(async () => {
    await fsPromises.rm(`${xumRoot}-link`, { force: true });
    await fsPromises.rm(xumRoot, { recursive: true, force: true });
    await fsPromises.rm(remoteDir, { recursive: true, force: true });
  });

  test("an update that leaves changes unapproved keeps serving the approved version", async () => {
    await install();
    // An install from a build without copies: the update captures the old tree before its swap.
    await fsPromises.rm(copiesFile());
    await writeVersion("v2");
    const review = await service.previewUpdate({ name: "demo" });
    expect(review.changes.length).toBeGreaterThan(0);
    await service.update({
      name: "demo",
      consent: { fromSha: review.fromSha, toSha: review.toSha, reviewed: [] },
    });

    const approved = await served();
    expect(approved.skill).toBe("v1");
    expect(approved.workflow).toContain('"v1"');
    // The new version is still pending: counted, and its rows say the approved one stays in use.
    expect((await service.list())[0].reviewRequiredCount).toBe(2);
    const pending = await service.previewComponentReview({ name: "demo" });
    const before = (changes: typeof pending.changes) =>
      changes.map((change) => [change.component?.kind, change.before]);
    const withCopies = before(pending.changes);
    const copies = await fsPromises.readFile(copiesFile(), "utf8");
    await fsPromises.rm(copiesFile());
    const withoutCopies = before((await service.previewComponentReview({ name: "demo" })).changes);
    expect(withCopies.map(([kind]) => kind).sort()).toEqual(["skills", "workflows"]);
    expect(withCopies.every(([, text], index) => text !== withoutCopies[index]?.[1])).toBe(true);
    await fsPromises.writeFile(copiesFile(), copies);

    // Approving the new version serves it.
    await service.confirmComponentReview({
      name: "demo",
      expectedLockedSha: pending.fromSha,
      reviewed: pending.changes.flatMap((change) => (change.component ? [change.component] : [])),
    });
    const reviewed = await served();
    expect(reviewed.skill).toBe("v2");
    expect(reviewed.workflow).toContain('"v2"');

    // That approval saved v2: a later unapproved edit falls back to v2, not to v1.
    await editInstalled("v3");
    const afterEdit = await served();
    expect(afterEdit.skill).toBe("v2");
    expect(afterEdit.workflow).toContain('"v2"');
  });

  test("a skill imported after install keeps the version approved at import", async () => {
    await install({ skills: [], mcpServers: [] });
    const inventory = await service.getComponents({ name: "demo" });
    await service.setComponents({
      name: "demo",
      expectedLockedSha: inventory.lockedSha,
      expectedContentHash: inventory.contentHash,
      expectedImportedComponents: inventory.importedComponents ?? null,
      importedComponents: { skills: ["greet"], mcpServers: [] },
    });
    await editInstalled("v2");
    expect((await served()).skill).toBe("v1");
  });

  test("a skill moved to another directory gets no approved copy", async () => {
    await install();
    // An edit nobody approved: the skill moves to another skills root, its SKILL.md unchanged.
    const pluginDir = path.join(home, "plugins", "demo");
    await fsPromises.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "demo",
        version: "1.0.0",
        contributes: { skills: "moved" },
      })
    );
    await fsPromises.mkdir(path.join(pluginDir, "moved"));
    await fsPromises.rename(
      path.join(pluginDir, "skills", "greet"),
      path.join(pluginDir, "moved", "greet")
    );

    // The approved version was in skills/greet, a directory that is gone: like a removed skill.
    await expect(served()).rejects.toThrow("Agent skill not found: greet");
    const skillRows = async () =>
      (await service.previewComponentReview({ name: "demo" })).changes
        .filter((change) => change.component?.kind === "skills")
        .map((change) => change.before);
    const withCopies = await skillRows();
    await fsPromises.rm(copiesFile());
    expect(withCopies).toHaveLength(1);
    expect(withCopies).toEqual(await skillRows());
  });

  test("a restart saves the copies of an install approved by a build without them", async () => {
    await install();
    await fsPromises.rm(copiesFile());
    const restarted = new AgentPluginInstallService(new Config(xumRoot), {});
    const internals = restarted as unknown as {
      reconciliationState: Promise<boolean>;
      startupApprovedCopiesSweep: Promise<void> | undefined;
    };
    expect(await internals.reconciliationState).toBe(true);
    await internals.startupApprovedCopiesSweep;

    await editInstalled("v2");
    const approved = await served();
    expect(approved.skill).toBe("v1");
    expect(approved.workflow).toContain('"v1"');
  });

  test("a symlinked Xum home serves the approved version too", async () => {
    // Discovery reads the plugin through the home's realpath; both sides must still name the
    // same copies file.
    home = `${xumRoot}-link`;
    await fsPromises.symlink(xumRoot, home);
    service = new AgentPluginInstallService(new Config(home), {});
    await install();
    await editInstalled("v2");
    const approved = await served();
    expect(approved.skill).toBe("v1");
    expect(approved.workflow).toContain('"v1"');
  });

  test("uninstall removes the copies, and a reinstall saves its own", async () => {
    await install();
    const installedAt = () =>
      fsPromises
        .readFile(path.join(xumRoot, PLUGIN_REGISTRY_FILE_NAME), "utf8")
        .then((text) => (JSON.parse(text) as { plugins: Array<{ installedAt: string }> }).plugins);
    const copiesInstalledAt = async () =>
      (JSON.parse(await fsPromises.readFile(copiesFile(), "utf8")) as { installedAt: string })
        .installedAt;
    expect(await copiesInstalledAt()).toBe((await installedAt())[0].installedAt);

    await service.uninstall({ name: "demo", deletePluginData: true });
    await expect(fsPromises.stat(copiesFile())).rejects.toThrow("ENOENT");

    await install();
    expect(await copiesInstalledAt()).toBe((await installedAt())[0].installedAt);
  });
});
