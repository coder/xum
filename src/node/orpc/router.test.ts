/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, local/no-sync-fs-methods */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";

import type { ORPCContext } from "./context";
import { router } from "./router";

describe("router agent skill routes", () => {
  test("subproject workspaces inherit parent skills with nearest precedence", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-skills-test-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const packagesRoot = path.join(checkoutRoot, "packages");
      const subProjectPath = path.join(packagesRoot, "app");
      const writeSkill = (root: string, name: string, description: string, body: string): void => {
        const skillDir = path.join(root, name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
        );
      };

      fs.mkdirSync(subProjectPath, { recursive: true });
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "parent-only",
        "from checkout",
        "parent body"
      );
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "shared",
        "from checkout",
        "checkout body"
      );
      writeSkill(
        path.join(packagesRoot, ".agents", "skills"),
        "shared",
        "from packages",
        "packages body"
      );

      const outsideRoot = path.join(tempDir, "outside-skills");
      writeSkill(outsideRoot, "escaped", "outside checkout", "outside body");
      fs.symlinkSync(
        path.join(outsideRoot, "escaped"),
        path.join(checkoutRoot, ".mux", "skills", "escaped"),
        "dir"
      );

      const context = {
        config: new Config(tempDir),
        aiService: {
          waitForInit: mock(async () => undefined),
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: { type: "local", srcBaseDir: tempDir },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      const skills = await client.agentSkills.list({ workspaceId: "workspace-1" });
      expect(skills.find((skill) => skill.name === "parent-only")).toMatchObject({
        description: "from checkout",
        scope: "project",
      });
      expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
        description: "from packages",
        scope: "project",
      });

      expect(skills.find((skill) => skill.name === "escaped")).toBeUndefined();
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "escaped" })
      ).rejects.toThrow("Agent skill not found");

      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "parent body\n" });
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "shared" })
      ).resolves.toMatchObject({ body: "packages body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("devcontainer workspaces read inherited skills from host-local storage", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-devcontainer-skills-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const subProjectPath = path.join(checkoutRoot, "packages", "app");
      const skillDir = path.join(checkoutRoot, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nHost parent body\n"
      );

      const context = {
        config: new Config(tempDir),
        aiService: {
          waitForInit: mock(async () => undefined),
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: {
                type: "devcontainer",
                configPath: ".devcontainer/devcontainer.json",
              },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(client.agentSkills.list({ workspaceId: "workspace-1" })).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "Host parent body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("project-path discovery inherits skills from a registered parent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-project-skills-test-"));
    try {
      const parentProjectPath = path.join(tempDir, "checkout");
      const subProjectPath = path.join(parentProjectPath, "packages", "app");
      const skillDir = path.join(parentProjectPath, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nParent body\n"
      );

      const config = new Config(tempDir);
      await config.editConfig((current) => {
        current.projects.set(parentProjectPath, { workspaces: [] });
        current.projects.set(subProjectPath, {
          workspaces: [],
          parentProjectPath,
        });
        return current;
      });
      const context = {
        config,
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(
        client.agentSkills.list({ projectPath: subProjectPath })
      ).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("router config transcript mutation", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(): ORPCContext {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Only Config is used by this route.
    return { config } as ORPCContext;
  }

  test("persists the full-width chat transcript config flag", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    await client.config.updateChatTranscriptFullWidth({ enabled: true });
    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(true);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);

    await client.config.updateChatTranscriptFullWidth({ enabled: false });
    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBeUndefined();
  });
});
