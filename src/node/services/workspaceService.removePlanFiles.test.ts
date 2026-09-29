import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getLegacyPlanFilePath } from "@/common/utils/planStorage";
import type { RuntimeConfig } from "@/common/types/runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import * as devcontainerCli from "@/node/runtime/devcontainerCli";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { sharesPlanStorage, type WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  withTempMuxRoot,
  writePlanFile,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  );
}

/**
 * #5019: plan files key on project and workspace name, so a removed workspace's plan was inherited
 * by the next workspace that took its name. A successful removal deletes them; a failed or refused
 * one keeps them (the workspace is still registered and still owns its plan).
 * Real Config, real git repository, local (project-dir) runtime.
 */
describe("WorkspaceService removal deletes plan files (#5019)", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceService;
  let projectPath: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    service = harness.service;
    projectPath = path.join(harness.rootDir, "project");
    await fs.mkdir(projectPath, { recursive: true });
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "i"],
    ]) {
      execFileSync("git", args, { cwd: projectPath, stdio: "pipe" });
    }
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [], trusted: true });
      return cfg;
    });
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  const addLocalWorkspace = (id: string, name: string, inProject = projectPath) =>
    harness.config.editConfig((cfg) => {
      cfg.projects.get(inProject)!.workspaces.push({
        id,
        name,
        path: inProject,
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

  /** Both plan paths of a workspace, written with distinct content. */
  const writePlans = async (root: string, id: string, name: string) => {
    const current = await writePlanFile(root, "project", name);
    const legacy = getLegacyPlanFilePath(id, root);
    await fs.writeFile(legacy, `# ${name} legacy plan\n`);
    return [current, legacy];
  };

  test("a successful removal deletes the current and legacy plan files", async () => {
    await withTempMuxRoot(async (root) => {
      await addLocalWorkspace("ffffffff01", "gone");
      const plans = await writePlans(root, "ffffffff01", "gone");
      const kept = await writePlanFile(root, "project", "other-ws");

      const result = await service.remove("ffffffff01");

      expect(result.success ? "" : result.error).toBe("");
      expect(await Promise.all(plans.map(exists))).toEqual([false, false]);
      expect(await exists(kept)).toBe(true);
    });
  });

  test("a refused checkout deletion keeps the plan files", async () => {
    await withTempMuxRoot(async (root) => {
      await addLocalWorkspace("ffffffff02", "refused");
      const plans = await writePlans(root, "ffffffff02", "refused");
      spyOn(LocalRuntime.prototype, "deleteWorkspace").mockResolvedValueOnce({
        success: false,
        error: "EBUSY",
      });

      const result = await service.remove("ffffffff02");

      expect(result.success ? "" : result.error).toBe("EBUSY");
      expect(await Promise.all(plans.map(exists))).toEqual([true, true]);
    });
  });

  // A fork refuses a registered name, so deleting before deregistration means no fork can copy a
  // plan to this path first and then lose it to the deletion.
  test("the plan files are gone before deregistration frees the name", async () => {
    await withTempMuxRoot(async (root) => {
      await addLocalWorkspace("ffffffff03", "ordered");
      const plans = await writePlans(root, "ffffffff03", "ordered");
      const atDeregistration: boolean[] = [];
      const realRemove = harness.config.removeWorkspace.bind(harness.config);
      spyOn(harness.config, "removeWorkspace").mockImplementation(async (...args) => {
        atDeregistration.push(...(await Promise.all(plans.map(exists))));
        return realRemove(...args);
      });

      const result = await service.remove("ffffffff03");

      expect(result.success ? "" : result.error).toBe("");
      expect(atDeregistration).toEqual([false, false]);
    });
  });

  test("a fork that reuses a removed workspace's name does not inherit its plan", async () => {
    await withTempMuxRoot(async (root) => {
      await addLocalWorkspace("ffffffff04", "fork-src");
      await addLocalWorkspace("ffffffff05", "reused");
      const reusedPlan = await writePlanFile(root, "project", "reused");
      expect((await service.remove("ffffffff05")).success).toBe(true);

      // The source has no plan, so any plan at the fork's path would be the removed one's.
      const forked = await service.fork("ffffffff04", "reused");

      expect(forked.success ? "" : forked.error).toBe("");
      expect(await exists(reusedPlan)).toBe(false);
    });
  });

  // Plans key on the project basename, so a same-named workspace in another project with the
  // same basename shares this plan path; removing this workspace must not delete that plan.
  test("a removal keeps a plan path that a same-named workspace in a same-basename project uses", async () => {
    await withTempMuxRoot(async (root) => {
      const twinProjectPath = path.join(harness.rootDir, "elsewhere", "project");
      await fs.mkdir(twinProjectPath, { recursive: true });
      await harness.config.editConfig((cfg) => {
        cfg.projects.set(twinProjectPath, { workspaces: [], trusted: true });
        return cfg;
      });
      await addLocalWorkspace("ffffffff06", "twin");
      await addLocalWorkspace("ffffffff07", "twin", twinProjectPath);
      const sharedPlan = await writePlanFile(root, "project", "twin");

      const result = await service.remove("ffffffff06");

      expect(result.success ? "" : result.error).toBe("");
      expect(await exists(sharedPlan)).toBe(true);
    });
  });

  test("a same-named workspace on another host does not keep the local plan", async () => {
    await withTempMuxRoot(async (root) => {
      const twinProjectPath = path.join(harness.rootDir, "remote", "project");
      await harness.config.editConfig((cfg) => {
        cfg.projects.set(twinProjectPath, {
          workspaces: [
            {
              id: "ffffffff09",
              name: "hosted",
              path: "~/xum/project/hosted",
              runtimeConfig: { type: "ssh", host: "remote-box", srcBaseDir: "~/xum" },
            },
          ],
          trusted: true,
        });
        return cfg;
      });
      await addLocalWorkspace("ffffffff08", "hosted");
      const localPlan = await writePlanFile(root, "project", "hosted");

      const result = await service.remove("ffffffff08");

      expect(result.success ? "" : result.error).toBe("");
      expect(await exists(localPlan)).toBe(false);
    });
  });

  /** Spy on the remote plan deletion (exec'd rm) and return the plan paths it was asked to delete. */
  const spyRemotePlanDeletion = () => {
    const exec = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });
    return () =>
      exec.mock.calls.flatMap(([, , options]) =>
        options.pathEnv?.XUM_PLAN != null ? [options.pathEnv.XUM_PLAN] : []
      );
  };

  const addWorkspaceIn = (
    inProject: string,
    entry: { id: string; name: string; path: string; runtimeConfig: RuntimeConfig } & Record<
      string,
      unknown
    >
  ) =>
    harness.config.editConfig((cfg) => {
      const project = cfg.projects.get(inProject) ?? { workspaces: [], trusted: true };
      project.workspaces.push(entry);
      cfg.projects.set(inProject, project);
      return cfg;
    });

  // #5043 item 1: the shared-plan-storage check keys by the endpoint the runtime connects to.
  // Another port on the same host is another sshd (often another machine or container), so its
  // plan path is not this one; an unset port may be the same one, so the plan is kept.
  test.each([
    { label: "another port", twinPort: 2200, deleted: true },
    { label: "an unset port", twinPort: undefined, deleted: false },
  ])(
    "an SSH removal next to a same-named workspace on the same host with $label",
    async ({ twinPort, deleted }) => {
      await withTempMuxRoot(async () => {
        const ssh = (port: number | undefined): RuntimeConfig => ({
          type: "ssh",
          host: "box",
          srcBaseDir: "~/xum",
          ...(port !== undefined ? { port } : {}),
        });
        await addWorkspaceIn(projectPath, {
          id: "ffffffff10",
          name: "hosted",
          path: "~/xum/project/hosted",
          runtimeConfig: ssh(2222),
        });
        await addWorkspaceIn(path.join(harness.rootDir, "remote", "project"), {
          id: "ffffffff11",
          name: "hosted",
          path: "~/xum/project/hosted",
          runtimeConfig: ssh(twinPort),
        });
        spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
          success: true,
          deletedPath: "~/xum/project/hosted",
        });
        const deletedPlans = spyRemotePlanDeletion();

        const result = await service.remove("ffffffff10");

        expect(result.success ? "" : result.error).toBe("");
        expect(deletedPlans()).toEqual(deleted ? ["~/.mux/plans/project/hosted.md"] : []);
      });
    }
  );

  test("Coder workspaces share plan storage only when they are the same Coder workspace", () => {
    const coder = (workspaceName: string): RuntimeConfig => ({
      type: "ssh",
      host: "coder://",
      srcBaseDir: "~/xum",
      coder: { workspaceName, existingWorkspace: true },
    });
    expect(sharesPlanStorage(coder("alpha"), coder("beta"))).toBe(false);
    expect(sharesPlanStorage(coder("alpha"), coder("alpha"))).toBe(true);
  });

  // #5043 item 2: a devcontainer's plan is inside its container. A removal that confirmed the
  // container gone has nothing left to delete; otherwise the container survives with the plan,
  // and a later workspace at this path would reconnect to it, so the plan is deleted in there.
  // Never on the host: the same host path is not this workspace's (#4775).
  const devcontainerCases: Array<{
    label: string;
    force: boolean;
    deleteResult: Awaited<ReturnType<DevcontainerRuntime["deleteWorkspace"]>>;
    entry: Record<string, unknown>;
    inContainer: boolean;
  }> = [
    {
      label: "whose container the removal confirmed gone",
      force: false,
      deleteResult: { success: true, deletedPath: "/dc" },
      entry: {},
      inContainer: false,
    },
    {
      label: "whose forced removal left its container",
      force: true,
      deleteResult: {
        success: false,
        error: "Failed to remove the devcontainer: daemon down",
        leftoverPaths: ["devcontainer container labeled devcontainer.local_folder=/dc"],
      },
      entry: {},
      inContainer: true,
    },
    {
      label: "that shares its parent's container",
      force: false,
      deleteResult: { success: true, deletedPath: "/dc" },
      entry: { taskIsolation: "none" },
      inContainer: true,
    },
  ];
  test.each(devcontainerCases)(
    "a devcontainer $label",
    async ({ force, deleteResult, entry, inContainer }) => {
      await withTempMuxRoot(async (root) => {
        await addWorkspaceIn(projectPath, {
          id: "ffffffff20",
          name: "dc",
          path: path.join(harness.rootDir, "dc"),
          runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
          ...entry,
        });
        const hostPlan = await writePlanFile(root, "project", "dc");
        spyOn(DevcontainerRuntime.prototype, "deleteWorkspace").mockResolvedValue(deleteResult);
        const deletedPlans = spyRemotePlanDeletion();

        const result = await service.remove("ffffffff20", force);

        expect(result.success ? "" : result.error).toBe("");
        expect(deletedPlans()).toEqual(inContainer ? ["~/.xum/plans/project/dc.md"] : []);
        expect(await exists(hostPlan)).toBe(true);
      });
    }
  );

  // #5143: a forced removal whose container teardown fails deletes the workspace but leaves the
  // container, and the plan inside it cannot be deleted once the worktree is gone. The failed
  // non-forced removal, which the user sees before choosing to force it, names that container.
  test("a failed devcontainer teardown names the container a forced removal would leave", async () => {
    await withTempMuxRoot(async () => {
      await addWorkspaceIn(projectPath, {
        id: "ffffffff21",
        name: "dcleft",
        path: path.join(harness.rootDir, "dcleft"),
        runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
      });
      spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({
        kind: "error",
        message: "Failed to remove container: daemon down",
      });

      const result = await service.remove("ffffffff21");

      expect(result.success ? "" : result.error).toMatch(
        /devcontainer container labeled devcontainer\.local_folder=\S+\/dcleft\b/
      );
      expect(await service.getInfo("ffffffff21")).not.toBeNull();
    });
  });
});
