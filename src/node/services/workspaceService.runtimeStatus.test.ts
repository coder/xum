import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "@/common/types/runtime";
import { shellQuote } from "@/common/utils/shell";
import type { TerminalService } from "@/node/services/terminalService";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

// Runtime stop and status read Docker container labels. A fake `docker` on PATH answers like
// the real CLI and logs each call, so config, path resolution and result mapping stay real.
describe.skipIf(process.platform === "win32")(
  "WorkspaceService devcontainer runtime control",
  () => {
    let harness: WorkspaceServiceHarness;
    let projectPath: string;
    let dockerDir: string;
    let previousPath: string | undefined;

    const devcontainerRuntime: RuntimeConfig = {
      type: "devcontainer",
      configPath: ".devcontainer/devcontainer.json",
    };

    beforeEach(async () => {
      harness = await createWorkspaceServiceHarness();
      projectPath = path.join(harness.rootDir, "project");
      await fs.mkdir(projectPath);
      dockerDir = path.join(harness.rootDir, "docker");
      await fs.mkdir(dockerDir);
      // `ps -q` (stop) prints the files' ids, `ps --format` (status probe) prints "id<TAB>path"
      // rows, and a ps-fail file makes every `ps` fail the way an unreachable daemon does.
      const dir = shellQuote(dockerDir);
      await fs.writeFile(
        path.join(dockerDir, "docker"),
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$*" >> ${dir}/calls`,
          'if [ "$1" = ps ]; then',
          `  if [ -f ${dir}/ps-fail ]; then cat ${dir}/ps-fail >&2; exit 1; fi`,
          `  if [ "$2" = -q ]; then cat ${dir}/ids 2>/dev/null; else cat ${dir}/rows 2>/dev/null; fi`,
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      previousPath = process.env.PATH;
      process.env.PATH = `${dockerDir}${path.delimiter}${previousPath ?? ""}`;
    });

    afterEach(async () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await harness.cleanup();
    });

    async function addWorkspace(
      id: string,
      runtimeConfig: RuntimeConfig
    ): Promise<{ workspacePath: string }> {
      const workspacePath = path.join(harness.rootDir, "checkouts", id);
      await fs.mkdir(workspacePath, { recursive: true });
      await harness.config.editConfig((config) => {
        const project = config.projects.get(projectPath) ?? { trusted: true, workspaces: [] };
        project.workspaces.push({
          id,
          name: id,
          path: workspacePath,
          runtimeConfig,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        config.projects.set(projectPath, project);
        return config;
      });
      return { workspacePath };
    }

    async function dockerCalls(): Promise<string[]> {
      const calls = await fs.readFile(path.join(dockerDir, "calls"), "utf8").catch(() => "");
      return calls.split("\n").filter((line) => line.length > 0);
    }

    function openTerminals(totalSessions: number): void {
      harness.service.setTerminalService({
        getWorkspaceActivity: () => ({ activeCount: 0, totalSessions }),
        setWorkspaceArchiveGuard: () => undefined,
      } as unknown as TerminalService);
    }

    describe("stopRuntime", () => {
      test("removes every container labeled with the persisted checkout path", async () => {
        const { workspacePath } = await addWorkspace("dev", devcontainerRuntime);
        await fs.writeFile(path.join(dockerDir, "ids"), "c1\nc2\n");

        const result = await harness.service.stopRuntime("dev");

        expect(result).toEqual({ success: true, data: undefined });
        expect(await dockerCalls()).toEqual([
          `ps -q --filter label=devcontainer.local_folder=${workspacePath}`,
          "rm -f c1 c2",
        ]);
      });

      test("succeeds without removing anything when no container is running", async () => {
        await addWorkspace("dev", devcontainerRuntime);

        expect((await harness.service.stopRuntime("dev")).success).toBe(true);
        expect((await dockerCalls()).some((call) => call.startsWith("rm"))).toBe(false);
      });

      test("reports a Docker query failure", async () => {
        await addWorkspace("dev", devcontainerRuntime);
        await fs.writeFile(path.join(dockerDir, "ps-fail"), "Cannot connect to the Docker daemon");

        // Docker's own message reaches the caller.
        const result = await harness.service.stopRuntime("dev");
        expect(result.success).toBe(false);
        expect(result.success ? "" : result.error).toContain("Cannot connect to the Docker daemon");
      });

      test("refuses an unknown workspace without calling Docker", async () => {
        expect((await harness.service.stopRuntime("missing")).success).toBe(false);
        expect(await dockerCalls()).toEqual([]);
      });

      test("refuses while an AI stream is active", async () => {
        await addWorkspace("dev", devcontainerRuntime);
        spyOn(harness.aiService, "isStreaming").mockImplementation((id) => id === "dev");

        expect((await harness.service.stopRuntime("dev")).success).toBe(false);
        expect(await dockerCalls()).toEqual([]);
      });

      test("refuses while a terminal is open, even an idle one", async () => {
        await addWorkspace("dev", devcontainerRuntime);
        openTerminals(1);

        expect((await harness.service.stopRuntime("dev")).success).toBe(false);
        expect(await dockerCalls()).toEqual([]);
      });

      test("stops when the terminal service reports no sessions", async () => {
        await addWorkspace("dev", devcontainerRuntime);
        openTerminals(0);

        expect((await harness.service.stopRuntime("dev")).success).toBe(true);
      });

      test("refuses runtimes that have no container to stop", async () => {
        await addWorkspace("wt", { type: "worktree", srcBaseDir: harness.config.srcDir });

        expect((await harness.service.stopRuntime("wt")).success).toBe(false);
        expect(await dockerCalls()).toEqual([]);
      });
    });

    describe("getRuntimeStatuses", () => {
      test("maps each requested workspace with one Docker probe", async () => {
        const running = await addWorkspace("running", devcontainerRuntime);
        await addWorkspace("stopped", devcontainerRuntime);
        await addWorkspace("worktree", { type: "worktree", srcBaseDir: harness.config.srcDir });
        // A container for a workspace nobody asked about must not leak into the answer.
        await fs.writeFile(
          path.join(dockerDir, "rows"),
          `c1\t${running.workspacePath}\nc9\t/elsewhere\n`
        );

        const statuses = await harness.service.getRuntimeStatuses([
          "running",
          "stopped",
          "worktree",
          "missing",
        ]);

        expect(statuses).toEqual({
          running: "running",
          stopped: "stopped",
          worktree: "unsupported",
          missing: "unknown",
        });
        expect((await dockerCalls()).filter((call) => call.startsWith("ps"))).toHaveLength(1);
      });

      test("reports devcontainers as unknown when Docker fails", async () => {
        await addWorkspace("dev", devcontainerRuntime);
        await addWorkspace("local", { type: "local" });
        await fs.writeFile(path.join(dockerDir, "ps-fail"), "daemon down");

        expect(await harness.service.getRuntimeStatuses(["dev", "local"])).toEqual({
          dev: "unknown",
          local: "unsupported",
        });
      });

      test("does not call Docker when no devcontainer is requested", async () => {
        await addWorkspace("local", { type: "local" });

        expect(await harness.service.getRuntimeStatuses([])).toEqual({});
        expect(await harness.service.getRuntimeStatuses(["local"])).toEqual({
          local: "unsupported",
        });
        expect(await dockerCalls()).toEqual([]);
      });

      test("reports every workspace as unknown when workspace metadata cannot load", async () => {
        await addWorkspace("dev", devcontainerRuntime);
        const load = spyOn(harness.config, "getAllWorkspaceMetadata").mockRejectedValueOnce(
          new Error("config unreadable")
        );

        expect(await harness.service.getRuntimeStatuses(["dev", "missing"])).toEqual({
          dev: "unknown",
          missing: "unknown",
        });
        expect(load).toHaveBeenCalledTimes(1);
        expect(await dockerCalls()).toEqual([]);
      });
    });
  }
);
