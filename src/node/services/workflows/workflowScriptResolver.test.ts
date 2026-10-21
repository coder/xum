/* eslint-disable @typescript-eslint/await-thenable */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import {
  createTestPluginInstallEntry,
  reviewedComponentConsent,
  saveApprovedCopies,
} from "@/node/services/agentPlugins/testFixtures";
import {
  TestTempDir,
  TrueRemotePathMappedRuntime,
  createIsolatedAgentSkillsRoots,
  writeGlobalSkill,
  writeProjectSkill,
} from "@/node/services/tools/testHelpers";
import { discoverWorkflowScripts } from "./workflowScriptDiscovery";
import { RuntimeError } from "@/node/runtime/Runtime";
import {
  assertStoredPluginWorkflowReviewed,
  resolveWorkflowScript,
} from "./workflowScriptResolver";

async function writeWorkflowFile(
  root: string,
  relativePath: string,
  source = "export default function workflow() {}"
) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, "utf-8");
  return target;
}

describe("resolveWorkflowScript", () => {
  test("resolves a trusted project skill workflow by explicit skill path", async () => {
    using tempDir = new TestTempDir("workflow-script-project-skill");
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export const meta = { name: 'Research' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("Research");
    expect(resolved.sourceKind).toBe("skill");
    expect(resolved.skillName).toBe("research");
    expect(resolved.scope).toBe("project");
    expect(resolved.relativePath).toBe("workflow.js");
    expect(resolved.canonicalScriptPath).toBe("skill://research/workflow.js");
  });

  test("resolves project skill workflow files through remote runtime containment", async () => {
    using tempDir = new TestTempDir("workflow-script-remote-project-skill");
    const remoteWorkspacePath = "/remote/workspace";
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export const meta = { name: 'RemoteResearch' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new TrueRemotePathMappedRuntime(tempDir.path, remoteWorkspacePath),
      workspacePath: remoteWorkspacePath,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("RemoteResearch");
    expect(resolved.scope).toBe("project");
    expect(resolved.resolvedPath).toBe(`${remoteWorkspacePath}/.xum/skills/research/workflow.js`);
  });

  test("resolves an inherited skill workflow through a remote checkout boundary", async () => {
    using tempDir = new TestTempDir("workflow-script-remote-inherited-skill");
    const localSubprojectPath = path.join(tempDir.path, "packages", "app");
    const remoteCheckoutPath = "/remote/workspace";
    const remoteSubprojectPath = "/remote/workspace/packages/app";
    await fs.mkdir(localSubprojectPath, { recursive: true });
    await writeProjectSkill(tempDir.path, "parent-flow", {
      files: { "workflow.js": "export const meta = { name: 'ParentFlow' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://parent-flow/workflow.js",
      runtime: new TrueRemotePathMappedRuntime(tempDir.path, remoteCheckoutPath),
      workspacePath: remoteSubprojectPath,
      projectSearchRoot: remoteCheckoutPath,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("ParentFlow");
    expect(resolved.resolvedPath).toBe("/remote/workspace/.xum/skills/parent-flow/workflow.js");
  });

  test("uses host-local skill storage for devcontainer workflow skills", async () => {
    using tempDir = new TestTempDir("workflow-script-devcontainer-inherited-skill");
    const checkoutRoot = path.join(tempDir.path, "checkout");
    const subprojectRoot = path.join(checkoutRoot, "packages", "app");
    await fs.mkdir(subprojectRoot, { recursive: true });
    await writeProjectSkill(checkoutRoot, "parent-flow", {
      files: { "workflow.js": "export const meta = { name: 'HostParentFlow' };" },
    });

    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(tempDir.path, "src-base"),
      configPath: path.join(tempDir.path, ".devcontainer", "devcontainer.json"),
    });
    const skillStorageContext = resolveSkillStorageContext({
      runtime,
      workspacePath: "/workspace/packages/app",
      xumScope: {
        type: "project",
        xumHome: path.join(tempDir.path, "mux-home"),
        projectRoot: subprojectRoot,
        projectStorageAuthority: "host-local",
        checkoutRoot,
      },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://parent-flow/workflow.js",
      runtime,
      workspacePath: "/workspace/packages/app",
      projectTrusted: true,
      skillStorageContext,
    });

    expect(resolved.source).toContain("HostParentFlow");
    expect(resolved.resolvedPath).toBe(
      path.join(checkoutRoot, ".xum", "skills", "parent-flow", "workflow.js")
    );
  });

  test("blocks project skill workflow scripts when the project is untrusted", async () => {
    using tempDir = new TestTempDir("workflow-script-untrusted-project-skill");
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export default function workflow() {}" },
    });

    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/workflow.js",
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });

  test("resolves a global skill workflow when no project skill shadows it", async () => {
    using tempDir = new TestTempDir("workflow-script-global-skill");
    const xumHome = path.join(tempDir.path, "mux-home");
    await writeGlobalSkill(xumHome, "research", {
      files: { "workflow.js": "export default function workflow() { return 'global'; }" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: false,
      roots: {
        projectRoot: path.join(tempDir.path, ".mux", "skills"),
        globalRoot: path.join(xumHome, "skills"),
      },
    });

    expect(resolved.source).toContain("global");
    expect(resolved.scope).toBe("global");
  });

  test("resolves a built-in skill workflow by explicit skill path", async () => {
    using tempDir = new TestTempDir("workflow-script-built-in-skill");

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://deep-research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: false,
      roots: createIsolatedAgentSkillsRoots(tempDir.path),
    });

    expect(resolved.source).toContain("Deep Research");
    expect(resolved.sourceKind).toBe("skill");
    expect(resolved.skillName).toBe("deep-research");
    expect(resolved.scope).toBe("built-in");
    expect(resolved.relativePath).toBe("workflow.js");
    expect(resolved.canonicalScriptPath).toBe("skill://deep-research/workflow.js");
  });

  test("resolves trusted inline workflow source with virtual hash provenance", async () => {
    using tempDir = new TestTempDir("workflow-script-inline");
    const source = "export default function workflow() { return { reportMarkdown: 'inline' }; }\n";
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");

    const resolved = await resolveWorkflowScript({
      scriptSource: source,
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved).toMatchObject({
      requestedScriptPath: `inline://workflow-${sourceHash.slice(0, 12)}.js`,
      canonicalScriptPath: `inline://workflow-${sourceHash.slice(0, 12)}.js`,
      source,
      sourceHash,
      sourceKind: "inline",
    });
  });

  test("rejects unsafe inline workflow source inputs", async () => {
    using tempDir = new TestTempDir("workflow-script-inline-invalid");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptSource: "export default function workflow() {}",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required to run inline workflow scripts");
    await expect(
      resolveWorkflowScript({
        scriptSource: " \n\t ",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("Inline workflow script source must not be blank");
    await expect(
      resolveWorkflowScript({
        scriptPath: "inline://workflow-deadbeef.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("use script_source instead");
    await expect(
      resolveWorkflowScript({
        scriptSource: "x".repeat(1024 * 1024 + 1),
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("Inline workflow script source is too large");
  });

  test("resolves an explicit trusted workspace JavaScript file", async () => {
    using tempDir = new TestTempDir("workflow-script-workspace-file");
    await writeWorkflowFile(
      tempDir.path,
      "workflows/smoke.js",
      "export default function workflow() { return 'ok'; }"
    );

    const resolved = await resolveWorkflowScript({
      scriptPath: "./workflows/smoke.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved.sourceKind).toBe("workspace-file");
    expect(resolved.source).toContain("ok");
    expect(resolved.resolvedPath).toBe(path.join(tempDir.path, "workflows", "smoke.js"));
    expect(resolved.canonicalScriptPath).toBe("./workflows/smoke.js");
  });

  test("rejects missing paths, directories, non-js files, traversal, and untrusted workspace files", async () => {
    using tempDir = new TestTempDir("workflow-script-invalid");
    await fs.mkdir(path.join(tempDir.path, "workflows", "dir.js"), { recursive: true });
    await writeWorkflowFile(tempDir.path, "workflows/readme.md", "not js");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptPath: "./missing.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow();
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/dir.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("regular JavaScript file");
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/readme.md",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow(".js");
    await expect(
      resolveWorkflowScript({
        scriptPath: "../outside.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("outside the workspace");
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/readme.md",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });

  test("rejects malformed skill script paths", async () => {
    using tempDir = new TestTempDir("workflow-script-malformed-skill");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("must include a relative .js file path");
    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/../workflow.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("path traversal");
    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/workflow.ts",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow(".js");
  });

  describe("plugin:// workflow scripts", () => {
    async function writePluginWithWorkflow(
      containerPath: string,
      pluginName: string,
      workflowFile: string,
      source = "export const meta = { name: 'plugin-flow' };"
    ): Promise<void> {
      const pluginDir = path.join(containerPath, pluginName);
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: pluginName,
        }),
        "utf-8"
      );
      await writeWorkflowFile(path.join(pluginDir, "workflows"), workflowFile, source);
    }

    function pluginRoots(tempDir: TestTempDir, containerPath: string) {
      return {
        ...createIsolatedAgentSkillsRoots(tempDir.path),
        projectPluginRoots: [containerPath],
      };
    }

    test("a skills-only plugin's skill runs no workflow script", async () => {
      using tempDir = new TestTempDir("workflow-script-skills-only");
      const container = path.join(tempDir.path, ".mux", "plugins");
      for (const [name, skillsOnly] of [
        ["plain-skills", false],
        ["generated-skills", true],
      ] as const) {
        const pluginDir = path.join(container, name);
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "plugin.json"),
          JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name,
            ...(skillsOnly ? { extensions: { mux: { generatedFrom: { kind: "skills" } } } } : {}),
          })
        );
        const skill = `${name}-flow`;
        await writeWorkflowFile(
          path.join(pluginDir, "skills", skill),
          "SKILL.md",
          `---\nname: ${skill}\ndescription: d\n---\nBody\n`
        );
        await writeWorkflowFile(path.join(pluginDir, "skills", skill), "workflow.js");
      }
      const resolve = (skill: string) =>
        resolveWorkflowScript({
          scriptPath: `skill://${skill}/workflow.js`,
          runtime: new LocalRuntime(tempDir.path),
          workspacePath: tempDir.path,
          projectTrusted: true,
          roots: pluginRoots(tempDir, container),
        });

      expect((await resolve("plain-skills-flow")).sourceKind).toBe("skill");
      await expect(resolve("generated-skills-flow")).rejects.toThrow("skills-only plugin");
    });

    test("resolves a plugin workflow", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");

      const resolved = await resolveWorkflowScript({
        scriptPath: "plugin://my-plugin/release.js",
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: true,
        roots: pluginRoots(tempDir, container),
      });

      expect(resolved.sourceKind).toBe("plugin");
      expect(resolved.pluginName).toBe("my-plugin");
      expect(resolved.scope).toBe("project");
      expect(resolved.canonicalScriptPath).toBe("plugin://my-plugin/release.js");
      expect(resolved.source).toContain("plugin-flow");
    });

    test("a Claude package runs no workflow code: no workflows/, command or skill script", async () => {
      using tempDir = new TestTempDir("workflow-script-claude-plugin");
      const container = path.join(tempDir.path, ".mux", "plugins");
      const pluginDir = path.join(container, "kit");
      await fs.mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "kit" })
      );
      await writeWorkflowFile(path.join(pluginDir, "workflows"), "release.js");
      // A script next to the command: the command's skill directory is the commands folder.
      await writeWorkflowFile(path.join(pluginDir, "commands"), "workflow.js");
      await fs.writeFile(path.join(pluginDir, "commands", "review.md"), "Review\n");
      const skillDir = path.join(pluginDir, "skills", "flow");
      await writeWorkflowFile(skillDir, "SKILL.md", "---\nname: flow\ndescription: d\n---\nBody\n");
      await writeWorkflowFile(skillDir, "workflow.js");
      const input = {
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: true,
        roots: pluginRoots(tempDir, container),
      };

      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "plugin://kit/release.js" })
      ).rejects.toThrow("not found");
      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "skill://review/workflow.js" })
      ).rejects.toThrow("is a Claude command");
      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "skill://flow/workflow.js" })
      ).rejects.toThrow("comes from a Claude Code plugin");
    });

    test("plugin workflows retain a global fallback after rejecting an outward project alias", async () => {
      using tempDir = new TestTempDir("workflow-plugin-global-alias");
      const project = path.join(tempDir.path, "checkout");
      const globalContainer = path.join(tempDir.path, "global", "plugins");
      const alias = path.join(project, ".xum", "plugins");
      await writePluginWithWorkflow(globalContainer, "fallback-plugin", "release.js");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(globalContainer, alias, "dir");
      const input = {
        scriptPath: "plugin://fallback-plugin/release.js",
        runtime: new LocalRuntime(project),
        workspacePath: project,
        projectTrusted: true,
        roots: {
          ...createIsolatedAgentSkillsRoots(tempDir.path),
          projectPluginRoots: [alias],
          globalPluginRoots: [globalContainer],
        },
      };
      const resolved = await resolveWorkflowScript(input);
      expect(resolved.scope).toBe("global");
      expect(resolved.resolvedPath).toBe(
        await fs.realpath(path.join(globalContainer, "fallback-plugin", "workflows", "release.js"))
      );
      await expect(
        resolveWorkflowScript({ ...input, roots: { ...input.roots, globalPluginRoots: [] } })
      ).rejects.toThrow("not found");
    });

    test("project plugin workflows are not resolvable for untrusted projects", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin-untrusted");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");

      await expect(
        resolveWorkflowScript({
          scriptPath: "plugin://my-plugin/release.js",
          runtime: new LocalRuntime(tempDir.path),
          workspacePath: tempDir.path,
          projectTrusted: false,
          roots: pluginRoots(tempDir, container),
        })
      ).rejects.toThrow("not found");
    });

    test("rejects traversal and non-js plugin workflow paths", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin-invalid");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");
      const input = {
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: true,
        roots: pluginRoots(tempDir, container),
      };

      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "plugin://my-plugin/../release.js" })
      ).rejects.toThrow("path traversal");
      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "plugin://my-plugin/release.ts" })
      ).rejects.toThrow(".js");
    });

    test("a changed managed plugin script runs the approved source until its review", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin-approved-copy");
      // The managed container of the Xum home that owns plugins.json (the skills roots' parent).
      const container = path.join(tempDir.path, "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js", "const v = 'plugin-v1';");
      const pluginDir = path.join(container, "my-plugin");
      const skillDir = path.join(pluginDir, "skills", "greet");
      await writeWorkflowFile(
        skillDir,
        "SKILL.md",
        "---\nname: greet\ndescription: g\n---\nBody\n"
      );
      await writeWorkflowFile(skillDir, "workflow.js", "const v = 'skill-v1';");
      const entry = createTestPluginInstallEntry(
        "my-plugin",
        undefined,
        await reviewedComponentConsent({ pluginDir })
      );
      await fs.writeFile(
        path.join(tempDir.path, "plugins.json"),
        JSON.stringify({ plugins: [entry] })
      );
      await saveApprovedCopies({ xumHome: tempDir.path, pluginDir, entry });
      const roots = {
        ...createIsolatedAgentSkillsRoots(tempDir.path),
        globalPluginRoots: [container],
      };
      const resolve = (scriptPath: string) =>
        resolveWorkflowScript({
          scriptPath,
          runtime: new LocalRuntime(tempDir.path),
          workspacePath: tempDir.path,
          projectTrusted: false,
          roots,
        });

      await fs.writeFile(path.join(pluginDir, "workflows", "release.js"), "const v = 'plugin-v2';");
      await fs.writeFile(path.join(skillDir, "workflow.js"), "const v = 'skill-v2';");
      expect((await resolve("plugin://my-plugin/release.js")).source).toContain("plugin-v1");
      expect((await resolve("skill://greet/workflow.js")).source).toContain("skill-v1");

      // The listing resolves each script on its own, yet opens the copies file once.
      const opens = spyOn(fs, "open");
      try {
        const listed = await discoverWorkflowScripts({
          runtime: new LocalRuntime(tempDir.path),
          workspacePath: tempDir.path,
          projectTrusted: false,
          skillStorageContext: {
            kind: "global-local",
            runtime: new LocalRuntime(tempDir.path),
            workspacePath: tempDir.path,
            roots,
            containment: { kind: "none" },
          },
        });
        const listedPaths = listed.map((workflow) => workflow.scriptPath);
        expect(listedPaths).toContain("plugin://my-plugin/release.js");
        expect(listedPaths).toContain("skill://greet/workflow.js");
        const copiesOpens = opens.mock.calls.filter(([file]) =>
          String(file).includes("plugin-approved-copies")
        );
        expect(copiesOpens).toHaveLength(1);
      } finally {
        opens.mockRestore();
      }

      // A removed script stays removed: its copy does not bring it back.
      await fs.rm(path.join(skillDir, "workflow.js"));
      await expect(resolve("skill://greet/workflow.js")).rejects.toThrow(/ENOENT|no such file/i);
      // An emptied script counts as removed too (review skips it), so its copy does not run.
      await fs.writeFile(path.join(pluginDir, "workflows", "release.js"), "");
      await expect(resolve("plugin://my-plugin/release.js")).rejects.toThrow(
        "has not been reviewed on this install"
      );
      await fs.writeFile(path.join(pluginDir, "workflows", "release.js"), "const v = 'plugin-v2';");
      // A copy that no longer matches its record does not run, and neither does no copy at all.
      const copiesDir = path.join(tempDir.path, "plugin-approved-copies");
      const [copiesFile] = await fs.readdir(copiesDir);
      const copies = path.join(copiesDir, copiesFile);
      await fs.writeFile(copies, (await fs.readFile(copies, "utf8")).replace("plugin-v1", "evil"));
      await expect(resolve("plugin://my-plugin/release.js")).rejects.toThrow(
        "has not been reviewed on this install"
      );
      await fs.rm(copiesDir, { recursive: true });
      await expect(resolve("plugin://my-plugin/release.js")).rejects.toThrow(
        "has not been reviewed on this install"
      );
    });

    test("rejects nested plugin workflow paths the consent surface never names", async () => {
      // The install preview and update capability comparison fingerprint
      // TOP-LEVEL workflows/*.js only: a resolvable nested file would be an
      // executable an upstream can add without re-consent.
      using tempDir = new TestTempDir("workflow-script-plugin-nested");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");
      const nestedDir = path.join(container, "my-plugin", "workflows", "private");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(nestedDir, "hidden.js"), "({})", "utf8");
      const input = {
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: true,
        roots: pluginRoots(tempDir, container),
      };

      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "plugin://my-plugin/private/hidden.js" })
      ).rejects.toThrow("top-level");
    });
  });

  // #6826: the stored-run gate of a skill:// run (resume, checkpoint retry, crash recovery).
  describe("assertStoredPluginWorkflowReviewed for skill:// runs", () => {
    const source = "export default function workflow() { return {}; }\n";
    const storedRun = (tempDir: TestTempDir, runtime = new LocalRuntime(tempDir.path)) => ({
      scriptPath: "skill://research/workflow.js",
      source,
      scope: "project" as const,
      runtime,
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    test("a plain (non-plugin) skill's run resumes: no consent record applies", async () => {
      using tempDir = new TestTempDir("stored-skill-run-plain");
      await writeProjectSkill(tempDir.path, "research", { files: { "workflow.js": source } });

      await expect(assertStoredPluginWorkflowReviewed(storedRun(tempDir))).resolves.toBeUndefined();
    });

    test("a deleted skill's run refuses to resume", async () => {
      using tempDir = new TestTempDir("stored-skill-run-deleted");

      await expect(assertStoredPluginWorkflowReviewed(storedRun(tempDir))).rejects.toThrow(
        "Skill 'research' is no longer available in its project scope"
      );
    });

    test("a transient read failure refuses as retryable, not as a missing skill", async () => {
      using tempDir = new TestTempDir("stored-skill-run-transport");
      await writeProjectSkill(tempDir.path, "research", { files: { "workflow.js": source } });
      const runtime = new LocalRuntime(tempDir.path);
      spyOn(runtime, "stat").mockRejectedValue(
        new RuntimeError("ssh: connect to host example port 22: Connection refused", "network")
      );

      const refusal = await assertStoredPluginWorkflowReviewed(storedRun(tempDir, runtime)).then(
        () => "resumed",
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );

      expect(refusal).toContain("could not be read");
      expect(refusal).toContain("Connection refused");
      expect(refusal).not.toContain("no longer available");
    });
  });
});
