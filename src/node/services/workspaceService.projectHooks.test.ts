import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SecretsStore } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { runProjectLifecycleHook } from "./projectLifecycleHooks";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Ok } from "@/common/types/result";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { shellQuote } from "@/common/utils/shell";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import { createTestProject } from "./taskService.testHarness";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

// The harness replaces provider/stream plumbing. Hooks, config, checkout deletion, and files remain real.
describe("WorkspaceService project lifecycle scripts", () => {
  let harness: WorkspaceServiceHarness;
  let projectPath: string;
  let workspacePath: string;
  let markerPath: string;
  const workspaceId = "hook-workspace";
  const workspaceName = "hook-branch";

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    projectPath = await createTestProject(harness.rootDir);
    workspacePath = new WorktreeRuntime(harness.config.srcDir).getWorkspacePath(
      projectPath,
      workspaceName
    );
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    execFileSync("git", ["worktree", "add", "-b", workspaceName, workspacePath], {
      cwd: projectPath,
      stdio: "ignore",
    });
    markerPath = path.join(harness.rootDir, "hook-output");
    await harness.config.editConfig((config) => {
      config.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            id: workspaceId,
            name: workspaceName,
            path: workspacePath,
            runtimeConfig: { type: "worktree", srcBaseDir: harness.config.srcDir },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      return config;
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function writeHook(hook: string, script: string, mode = 0o755): Promise<void> {
    const filename = path.join(workspacePath, hook);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `#!/usr/bin/env bash\n${script}\n`, { mode });
  }

  function appendMarker(value: string): string {
    return `printf '%s\\n' ${shellQuote(value)} >> ${shellQuote(markerPath)}`;
  }

  test("awaits archive cleanup before runtime shutdown and runs again only after unarchive", async () => {
    // A non-canonical path proves hooks use the persisted checkout, not a reconstructed path.
    const movedPath = path.join(harness.rootDir, "checkout with spaces");
    execFileSync("git", ["worktree", "move", workspacePath, movedPath], { cwd: projectPath });
    workspacePath = movedPath;
    await harness.config.editConfig((config) => {
      config.projects.get(projectPath)!.workspaces[0].path = workspacePath;
      return config;
    });
    await writeHook(
      ".xum/archive",
      `printf '%s\\n' "$PWD" "$XUM_PROJECT_PATH" "$XUM_WORKSPACE_NAME" "$XUM_WORKSPACE_ID" "$XUM_RUNTIME" >> ${shellQuote(markerPath)}`
    );
    const hooks = new WorkspaceLifecycleHooks();
    let shutdownCalls = 0;
    hooks.registerBeforeArchive(async () => {
      expect(await fs.readFile(markerPath, "utf8")).toContain(workspaceId);
      shutdownCalls += 1;
      return Ok(undefined);
    });
    harness.service.setWorkspaceLifecycleHooks(hooks);

    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    const output = await fs.readFile(markerPath, "utf8");
    expect(output.trim().split("\n")).toEqual([
      workspacePath,
      projectPath,
      workspaceName,
      workspaceId,
      "worktree",
    ]);
    expect(shutdownCalls).toBe(1);
    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe(output);
    expect((await harness.service.unarchive(workspaceId)).success).toBe(true);
    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe(output + output);
  });

  test("runs only delete cleanup before removing the checkout", async () => {
    await writeHook(".xum/archive", appendMarker("archive"));
    await writeHook(".xum/delete", `test -f README.md && ${appendMarker("delete")}`);
    expect((await harness.service.remove(workspaceId, true)).success).toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe("delete\n");
    expect(
      await fs.access(workspacePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(harness.config.findWorkspace(workspaceId)).toBeNull();
  });

  test.each(["archive", "delete"] as const)("%s failure does not block cleanup", async (hook) => {
    await writeHook(`.xum/${hook}`, `${appendMarker(hook)}\necho failed >&2\nexit 7`);
    const result =
      hook === "archive"
        ? await harness.service.archive(workspaceId)
        : await harness.service.remove(workspaceId, true);
    expect(result.success).toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe(`${hook}\n`);
  });

  test.each(["archive", "delete"] as const)("%s skips untrusted projects", async (hook) => {
    await writeHook(`.xum/${hook}`, appendMarker("unexpected"));
    await harness.config.editConfig((config) => {
      config.projects.get(projectPath)!.trusted = false;
      return config;
    });
    const result =
      hook === "archive"
        ? await harness.service.archive(workspaceId)
        : await harness.service.remove(workspaceId, true);
    expect(result.success).toBe(true);
    expect(
      await fs.access(markerPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("skips hooks when project automation is disabled", async () => {
    await writeHook(".xum/archive", appendMarker("archive"));
    await writeHook(".xum/delete", appendMarker("delete"));
    const previous = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
    process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
    try {
      expect((await harness.service.archive(workspaceId)).success).toBe(true);
      expect((await harness.service.remove(workspaceId, true)).success).toBe(true);
      expect(
        await fs.access(markerPath).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      else process.env[DISABLE_PROJECT_AUTOMATION_ENV] = previous;
    }
  });

  test("prefers executable canonical hooks and falls back to legacy hooks", async () => {
    await writeHook(".mux/archive", appendMarker("legacy"));
    await writeHook(".xum/archive", appendMarker("canonical"));
    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe("canonical\n");
    expect((await harness.service.unarchive(workspaceId)).success).toBe(true);
    await fs.chmod(path.join(workspacePath, ".xum/archive"), 0o644);
    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe("canonical\nlegacy\n");
  });

  test("skips absent and non-executable scripts", async () => {
    await writeHook(".xum/archive", appendMarker("unexpected"), 0o644);
    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    expect((await harness.service.remove(workspaceId, true)).success).toBe(true);
    expect(
      await fs.access(markerPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("does not run parent cleanup for shared-checkout tasks", async () => {
    await writeHook(".xum/archive", appendMarker("archive"));
    await writeHook(".xum/delete", appendMarker("delete"));
    await harness.config.editConfig((config) => {
      const workspace = config.projects.get(projectPath)!.workspaces[0];
      workspace.taskIsolation = "none";
      workspace.parentWorkspaceId = "parent";
      workspace.taskStatus = "reported";
      return config;
    });
    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    expect((await harness.service.remove(workspaceId, true)).success).toBe(true);
    expect(
      await fs.access(markerPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(
      await fs.access(workspacePath).then(
        () => true,
        () => false
      )
    ).toBe(true);
  });

  test("runs every project hook with separate secrets even after one hook fails", async () => {
    const secondProjectPath = await createTestProject(harness.rootDir, "second-project");
    const secondCheckout = new WorktreeRuntime(harness.config.srcDir).getWorkspacePath(
      secondProjectPath,
      workspaceName
    );
    await fs.mkdir(path.join(secondCheckout, ".xum"), { recursive: true });
    const script = `printf '%s:%s\\n' "$XUM_PROJECT_PATH" "$CLEANUP_TOKEN" >> ${shellQuote(markerPath)}`;
    await writeHook(".xum/delete", `${script}\nexit 7`);
    await fs.writeFile(
      path.join(secondCheckout, ".xum/delete"),
      `#!/usr/bin/env bash\n${script}\n`,
      {
        mode: 0o755,
      }
    );
    await harness.config.editConfig((config) => {
      config.projects.set(secondProjectPath, { trusted: true, workspaces: [] });
      return config;
    });
    const metadata = await harness.config.getWorkspaceMetadataById(workspaceId);
    if (!metadata) throw new Error("Missing workspace fixture");
    metadata.projects = [
      { projectPath, projectName: "repo" },
      { projectPath: secondProjectPath, projectName: "second-project" },
    ];
    const secretsStore = new SecretsStore(harness.rootDir);
    await secretsStore.saveSecretsConfig({
      [projectPath]: [{ key: "CLEANUP_TOKEN", value: "first-token" }],
      [secondProjectPath]: [{ key: "CLEANUP_TOKEN", value: "second-token" }],
    });
    await runProjectLifecycleHook({
      hook: "delete",
      workspaceId,
      workspacePath,
      metadata,
      config: harness.config,
      secretsStore,
    });
    expect((await fs.readFile(markerPath, "utf8")).trim().split("\n")).toEqual([
      `${projectPath}:first-token`,
      `${secondProjectPath}:second-token`,
    ]);
  });

  test("uses fresh metadata after the persisted checkout path changes", async () => {
    await writeHook(".xum/archive", appendMarker("fresh checkout"));
    const metadata = await harness.config.getWorkspaceMetadataById(workspaceId);
    if (!metadata) throw new Error("Missing workspace fixture");
    await runProjectLifecycleHook({
      hook: "archive",
      workspaceId,
      workspacePath: path.join(harness.rootDir, "old checkout"),
      metadata,
      config: harness.config,
      secretsStore: new SecretsStore(harness.rootDir),
    });
    expect(await fs.readFile(markerPath, "utf8")).toBe("fresh checkout\n");
  });

  test("runs devcontainer cleanup from its persisted checkout without starting the container", async () => {
    // The CLI fake records real runtime arguments without requiring Docker or a devcontainer installation.
    const binDir = path.join(harness.rootDir, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(
      path.join(binDir, "devcontainer"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${shellQuote(markerPath)}\n`,
      { mode: 0o755 }
    );
    await harness.config.editConfig((config) => {
      config.projects.get(projectPath)!.workspaces[0].runtimeConfig = {
        type: "devcontainer",
        configPath: ".devcontainer/devcontainer.json",
      };
      return config;
    });
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      expect((await harness.service.archive(workspaceId)).success).toBe(true);
      const argv = await fs.readFile(markerPath, "utf8");
      expect(argv).toContain(`exec\n--workspace-folder\n${workspacePath}\n`);
      expect(argv).toContain("cd '.' && if");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("skips shell execution when the runtime is not running", async () => {
    await writeHook(".xum/archive", appendMarker("unexpected"));
    // Replace only the passive remote probe. A real local runtime exposes any accidental shell execution.
    let availabilityChecks = 0;
    const runtime = Object.assign(new LocalRuntime(workspacePath), {
      isRunningWithoutStart: () => {
        availabilityChecks += 1;
        return Promise.resolve(false);
      },
    });
    const exec = spyOn(runtime, "exec");
    const factory = spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
    try {
      expect((await harness.service.archive(workspaceId)).success).toBe(true);
      expect(availabilityChecks).toBe(1);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
      factory.mockRestore();
    }
  });

  test("missing archived checkouts do not prevent deletion", async () => {
    expect((await harness.service.archive(workspaceId)).success).toBe(true);
    execFileSync("git", ["worktree", "remove", "--force", workspacePath], { cwd: projectPath });
    expect((await harness.service.remove(workspaceId, true)).success).toBe(true);
    expect(harness.config.findWorkspace(workspaceId)).toBeNull();
  });
});
