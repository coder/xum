import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getPlanFilePath } from "@/common/utils/planStorage";
import { formatBranchWorkspaceNameConflict } from "@/common/utils/validation/workspaceValidation";
import type { RuntimeConfig } from "@/common/types/runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  withTempMuxRoot,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  );
}

/**
 * #5139: plans live at plans/<project basename>/<name>.md, so two projects with the same basename
 * share one plan directory on the same plan storage. A workspace name there is taken for both:
 * otherwise a fork (or new workspace) in one project writes, inherits, or loses the plan of a
 * same-named workspace in the other. Real Config, real git repositories, local runtime.
 */
describe("same-basename projects share the plan-directory name namespace (#5139)", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceService;
  // Both have the basename "project", so their plans share plans/project/.
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    service = harness.service;
    projectA = path.join(harness.rootDir, "a", "project");
    projectB = path.join(harness.rootDir, "b", "project");
    for (const projectPath of [projectA, projectB]) {
      await fs.mkdir(projectPath, { recursive: true });
      for (const args of [
        ["init", "-b", "main"],
        [
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=T",
          "commit",
          "--allow-empty",
          "-m",
          "i",
        ],
      ]) {
        execFileSync("git", args, { cwd: projectPath, stdio: "pipe" });
      }
    }
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectA, { workspaces: [], trusted: true });
      cfg.projects.set(projectB, { workspaces: [], trusted: true });
      return cfg;
    });
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  const addWorkspace = (
    projectPath: string,
    id: string,
    name: string,
    runtimeConfig: RuntimeConfig = { type: "local" }
  ) =>
    harness.config.editConfig((cfg) => {
      cfg.projects
        .get(projectPath)!
        .workspaces.push({ id, name, path: projectPath, runtimeConfig });
      return cfg;
    });
  const writePlan = async (root: string, name: string, content: string) => {
    const planPath = getPlanFilePath(name, "project", root);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, content);
    return planPath;
  };
  const persistedNames = () =>
    [...harness.config.loadConfigOrDefault().projects.values()].flatMap((project) =>
      project.workspaces.map((workspace) => workspace.name)
    );
  const takenIn = (name: string, projectPath: string) =>
    `Workspace with name "${name}" already exists in ${projectPath}, which keeps its plans in the same directory as this project`;

  // The race from the issue: the removal found no other workspace using plans/project/twin.md, and
  // a fork in the other project copies its plan there before the removal deletes the file.
  test("a cross-project fork inside a removal's scan-to-delete window is refused, and a fork after the removal keeps its plan", async () => {
    await withTempMuxRoot(async (root) => {
      await addWorkspace(projectA, "aaaaaaaa01", "twin");
      await addWorkspace(projectB, "bbbbbbbb01", "src");
      const twinPlan = await writePlan(root, "twin", "# A's twin plan\n");
      await writePlan(root, "src", "# B's source plan\n");
      const realRm = fs.rm;
      let inWindow: Awaited<ReturnType<WorkspaceService["fork"]>> | undefined;
      spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (inWindow === undefined && args[0] === twinPlan) {
          inWindow = await service.fork("bbbbbbbb01", "twin");
        }
        return realRm(...args);
      });

      const removed = await service.remove("aaaaaaaa01");

      expect(removed.success ? "" : removed.error).toBe("");
      if (inWindow === undefined) throw new Error("the removal never deleted the plan file");
      const inWindowOutcome = inWindow.success
        ? `fork succeeded; plan ${(await exists(twinPlan)) ? "present" : "missing"} after removal`
        : inWindow.error;
      expect(inWindowOutcome).toBe(takenIn("twin", projectA));

      const afterRemoval = await service.fork("bbbbbbbb01", "twin");

      expect(afterRemoval.success ? "" : afterRemoval.error).toBe("");
      expect(await fs.readFile(twinPlan, "utf8")).toBe("# B's source plan\n");
    });
  });

  test("a seamless fork skips a name a same-basename project uses on the same plan storage", async () => {
    await withTempMuxRoot(async (root) => {
      await addWorkspace(projectA, "aaaaaaaa02", "feature");
      await addWorkspace(projectB, "bbbbbbbb02", "feature-1");
      await writePlan(root, "feature", "# A's feature plan\n");
      const otherPlan = await writePlan(root, "feature-1", "# B's feature-1 plan\n");

      const result = await service.fork("aaaaaaaa02");

      expect(result.success ? result.data.metadata.name : result.error).toBe("feature-2");
      expect(await fs.readFile(otherPlan, "utf8")).toBe("# B's feature-1 plan\n");
      expect(await fs.readFile(getPlanFilePath("feature-2", "project", root), "utf8")).toBe(
        "# A's feature plan\n"
      );
    });
  });

  test("an explicit fork name a same-basename project uses on the same plan storage is refused before anything is created", async () => {
    await withTempMuxRoot(async (root) => {
      await addWorkspace(projectA, "aaaaaaaa03", "feature");
      await addWorkspace(projectB, "bbbbbbbb03", "src");
      const otherPlan = await writePlan(root, "feature", "# A's feature plan\n");
      await writePlan(root, "src", "# B's source plan\n");
      const copy = spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes");
      const namesBefore = persistedNames();

      const result = await service.fork("bbbbbbbb03", "feature");

      expect(result.success ? "" : result.error).toBe(takenIn("feature", projectA));
      expect(copy).not.toHaveBeenCalled();
      expect(await fs.readFile(otherPlan, "utf8")).toBe("# A's feature plan\n");
      expect(persistedNames()).toEqual(namesBefore);
    });
  });

  // Review of #5020: a same-named workspace whose plans live on another host or in a container
  // does not share the plan file, so it must not block the name.
  test("a same-named workspace whose plans live elsewhere does not block a fork name", async () => {
    await withTempMuxRoot(async (root) => {
      await addWorkspace(projectA, "aaaaaaaa04", "remote", {
        type: "ssh",
        host: "remote-box",
        srcBaseDir: "~/xum",
      });
      await addWorkspace(projectA, "aaaaaaaa05", "boxed", { type: "docker", image: "node:22" });
      await addWorkspace(projectB, "bbbbbbbb04", "src");
      await writePlan(root, "src", "# B's source plan\n");

      const forks = [
        await service.fork("bbbbbbbb04", "remote"),
        await service.fork("bbbbbbbb04", "boxed"),
      ];

      expect(forks.map((r) => (r.success ? r.data.metadata.name : r.error))).toEqual([
        "remote",
        "boxed",
      ]);
    });
  });

  // Both forks' early checks can pass before either registers; the locked registration write
  // re-checks the whole plan directory, and the loser leaves the winner's plan alone.
  test("the registration write refuses a name a same-basename project registered during the fork, and leaves that workspace's plan", async () => {
    await withTempMuxRoot(async (root) => {
      await addWorkspace(projectB, "bbbbbbbb05", "src");
      await writePlan(root, "src", "# B's source plan\n");
      const racePlan = getPlanFilePath("race", "project", root);
      const realCopy = runtimeHelpers.copyPlanFileAcrossRuntimes;
      spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockImplementation(async (...args) => {
        const copied = await realCopy(...args);
        // Another fork in project A takes "race" and writes its plan after this copy.
        await writePlan(root, "race", "# A's race plan\n");
        await addWorkspace(projectA, "aaaaaaaa06", "race");
        return copied;
      });
      const newIds = spyOn(harness.config, "generateStableId");

      const result = await service.fork("bbbbbbbb05", "race");

      expect(result.success ? "" : result.error).toBe(
        `Failed to fork workspace: ${takenIn("race", projectA)}`
      );
      expect(await fs.readFile(racePlan, "utf8")).toBe("# A's race plan\n");
      expect(persistedNames().filter((name) => name === "race")).toHaveLength(1);
      const forkId = newIds.mock.results[0]?.value as string;
      expect(await exists(path.join(harness.config.sessionsDir, forkId))).toBe(false);
    });
  });

  describe("create", () => {
    const createLocal = (projectPath: string, branchName: string | undefined) =>
      service.create(projectPath, branchName, "main", undefined, { type: "local" });

    test("/new skips a name a same-basename project uses on the same plan storage, so it inherits no plan", async () => {
      await withTempMuxRoot(async (root) => {
        await addWorkspace(projectA, "aaaaaaaa11", "workspace-1");
        const otherPlan = await writePlan(root, "workspace-1", "# A's workspace-1 plan\n");

        const result = await createLocal(projectB, undefined);

        expect(result.success ? result.data.metadata.name : result.error).toBe("workspace-2");
        expect(await exists(getPlanFilePath("workspace-2", "project", root))).toBe(false);
        expect(await fs.readFile(otherPlan, "utf8")).toBe("# A's workspace-1 plan\n");
      });
    });

    // Like a worktree whose checkout directory is occupied: the name gets the collision suffix.
    test.each([
      { label: "a same-basename project", owner: () => projectA },
      { label: "the same project", owner: () => projectB },
    ])(
      "an explicit create name a workspace in $label already uses for its plan gets the collision suffix",
      async (c) => {
        await withTempMuxRoot(async (root) => {
          await addWorkspace(c.owner(), "aaaaaaaa12", "shared");
          const otherPlan = await writePlan(root, "shared", "# the other workspace's plan\n");

          const result = await createLocal(projectB, "shared");

          const name = result.success ? result.data.metadata.name : result.error;
          expect(name).toMatch(/^shared-[a-z0-9]+$/);
          expect(await fs.readFile(otherPlan, "utf8")).toBe("# the other workspace's plan\n");
        });
      }
    );

    test("an explicit create keeps its name next to a same-named workspace on another host", async () => {
      await withTempMuxRoot(async () => {
        await addWorkspace(projectA, "aaaaaaaa13", "hosted", {
          type: "ssh",
          host: "remote-box",
          srcBaseDir: "~/xum",
        });

        const result = await createLocal(projectB, "hosted");

        expect(result.success ? result.data.metadata.name : result.error).toBe("hosted");
      });
    });

    test("a sanitized branch whose workspace name another workspace's plan uses is refused", async () => {
      await withTempMuxRoot(async () => {
        await addWorkspace(projectA, "aaaaaaaa14", "feat-x");
        const newIds = spyOn(harness.config, "generateStableId");

        const result = await createLocal(projectB, "feat/x");

        expect(result.success ? result.data.metadata.name : result.error).toBe(
          formatBranchWorkspaceNameConflict("feat/x")
        );
        // Refused before any per-workspace state (session, init state) is created.
        expect(newIds).not.toHaveBeenCalled();
      });
    });
  });
});
