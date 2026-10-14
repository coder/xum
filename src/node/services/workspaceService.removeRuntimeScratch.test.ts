import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RuntimeConfig } from "@/common/types/runtime";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  withTempMuxRoot,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

/**
 * SSH workspaces keep $XUM_SCRATCH_DIR on the remote host (runtimeScratchDir.ts), outside the
 * host session dir that removal deletes, so removal deletes it over exec. Other runtimes need
 * no exec: Docker's scratch is in the removed container, and a Coder workspace Xum created is
 * deleted with its scratch.
 */
describe("WorkspaceService removal deletes the runtime scratch dir", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceService;
  let projectPath: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    service = harness.service;
    projectPath = path.join(harness.rootDir, "project");
    await fs.mkdir(projectPath, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "pipe" });
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

  /** Spy on exec'd deletions; returns the scratch paths `rm -rf` was asked to delete. */
  const spyScratchDeletion = () => {
    const exec = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });
    return () =>
      exec.mock.calls.flatMap(([, , options]) =>
        options.pathEnv?.XUM_SCRATCH != null ? [options.pathEnv.XUM_SCRATCH] : []
      );
  };

  const addWorkspace = (id: string, runtimeConfig: RuntimeConfig) =>
    harness.config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push({
        id,
        name: `ws-${id}`,
        path: `~/xum/project/ws-${id}`,
        runtimeConfig,
      });
      return cfg;
    });

  test("an SSH removal deletes <xumHome>/workspace-scratch/<id> on the host", async () => {
    await withTempMuxRoot(async () => {
      await addWorkspace("ffffffff30", { type: "ssh", host: "box", srcBaseDir: "~/xum" });
      spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
        success: true,
        deletedPath: "~/xum/project/ws-ffffffff30",
      });
      const deletedScratch = spyScratchDeletion();

      const result = await service.remove("ffffffff30");

      expect(result.success ? "" : result.error).toBe("");
      expect(deletedScratch()).toEqual(["~/.mux/workspace-scratch/ffffffff30"]);
    });
  });

  test("an unreachable host never fails the removal", async () => {
    await withTempMuxRoot(async () => {
      await addWorkspace("ffffffff31", { type: "ssh", host: "box", srcBaseDir: "~/xum" });
      spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
        success: true,
        deletedPath: "~/xum/project/ws-ffffffff31",
      });
      spyOn(runtimeHelpers, "execBuffered").mockRejectedValue(new Error("ssh: connect refused"));

      const result = await service.remove("ffffffff31");

      expect(result.success ? "" : result.error).toBe("");
      expect(await service.getInfo("ffffffff31")).toBeNull();
    });
  });

  test("Docker and Xum-created Coder removals run no scratch deletion", async () => {
    await withTempMuxRoot(async () => {
      await addWorkspace("ffffffff32", { type: "docker", image: "img" });
      await addWorkspace("ffffffff33", {
        type: "ssh",
        host: "coder://",
        srcBaseDir: "~/xum",
        coder: { workspaceName: "cw" },
      });
      spyOn(DockerRuntime.prototype, "deleteWorkspace").mockResolvedValue({
        success: true,
        deletedPath: "/src",
      });
      const deletedScratch = spyScratchDeletion();

      // The Coder deletion itself needs a CoderService; only the scratch exec matters here.
      await service.remove("ffffffff32");
      await service.remove("ffffffff33", true);

      expect(deletedScratch()).toEqual([]);
    });
  });
});
