import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getLegacyPlanFilePath } from "@/common/utils/planStorage";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { WorkspaceService } from "./workspaceService";
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
});
