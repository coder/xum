import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "@/common/types/runtime";
import { shellQuote } from "@/common/utils/shell";
import type { TerminalService } from "@/node/services/terminalService";
import type { EnsureReadyOptions, Runtime } from "@/node/runtime/Runtime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { DaytonaRuntimeService } from "@/node/runtime/DaytonaSSHRuntime";
import * as runtimeHelpers from "@/node/runtime/runtimeHelpers";
import { workspaceUseLeasesFor } from "@/node/services/workspaceUseLeases";
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

describe("WorkspaceService.getRuntimeStatuses for Daytona workspaces", () => {
  let harness: WorkspaceServiceHarness;
  let projectPath: string;
  let globalService: { mockRestore: () => void };
  const getSandboxState = mock((sandboxName: string) =>
    sandboxName === "sb-broken"
      ? Promise.reject(new Error("throttled"))
      : Promise.resolve({
          state: sandboxName === "sb-1" ? ("started" as const) : ("stopped" as const),
        })
  );

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    projectPath = path.join(harness.rootDir, "project");
    await fs.mkdir(projectPath);
    getSandboxState.mockClear();
    globalService = spyOn(runtimeFactory, "getGlobalDaytonaService").mockReturnValue({
      sandboxes: { getSandboxState },
    } as unknown as DaytonaRuntimeService);
  });

  afterEach(async () => {
    globalService.mockRestore();
    await harness.cleanup();
  });

  async function addDaytonaWorkspaces(sandboxByWorkspace: Record<string, string>): Promise<void> {
    await harness.config.editConfig((config) => {
      config.projects.set(projectPath, {
        trusted: true,
        workspaces: Object.entries(sandboxByWorkspace).map(([id, sandboxName]) => ({
          id,
          name: id,
          path: path.join(harness.rootDir, "checkouts", id),
          runtimeConfig: {
            type: "ssh",
            host: `${sandboxName}.xum--daytona`,
            srcBaseDir: "/home/daytona/xum",
            daytona: { sandboxName },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      });
      return config;
    });
  }

  // Forks and attachments share one sandbox: a large fork tree must not burst the control plane.
  test("reads each sandbox's state once and gives it to every workspace on it", async () => {
    await addDaytonaWorkspaces({
      parent: "sb-1",
      fork1: "sb-1",
      fork2: "sb-1",
      other: "sb-2",
      broken1: "sb-broken",
      broken2: "sb-broken",
    });

    expect(
      await harness.service.getRuntimeStatuses([
        "parent",
        "fork1",
        "fork2",
        "other",
        "broken1",
        "broken2",
      ])
    ).toEqual({
      parent: "running",
      fork1: "running",
      fork2: "running",
      other: "stopped",
      broken1: "unknown",
      broken2: "unknown",
    });
    expect(getSandboxState.mock.calls.map(([sandboxName]) => sandboxName).sort()).toEqual([
      "sb-1",
      "sb-2",
      "sb-broken",
    ]);
  });
});

describe("WorkspaceService.recordExternalEditorOpen for a Daytona workspace", () => {
  let harness: WorkspaceServiceHarness;
  let projectPath: string;
  let createRuntime: { mockRestore: () => void };
  /** The editor use leases held on the workspace while each readiness check ran. */
  let leasesDuringReadiness: number[];
  let readiness: { ready: true } | { ready: false; error: string };
  const ensureReady = mock((_options?: EnsureReadyOptions) => {
    leasesDuringReadiness.push(workspaceUseLeasesFor(harness.config).heldCount("dt", "editor"));
    return Promise.resolve(
      readiness.ready ? readiness : { ...readiness, errorType: "runtime_not_ready" as const }
    );
  });

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    projectPath = path.join(harness.rootDir, "project");
    await fs.mkdir(projectPath);
    ensureReady.mockClear();
    leasesDuringReadiness = [];
    readiness = { ready: true };
    createRuntime = spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue({
      ensureReady,
    } as unknown as Runtime);
  });

  afterEach(async () => {
    createRuntime.mockRestore();
    await harness.cleanup();
  });

  async function addDaytonaWorkspace(archivedAt?: string): Promise<void> {
    await harness.config.editConfig((config) => {
      config.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            id: "dt",
            name: "dt",
            path: path.join(harness.rootDir, "checkouts", "dt"),
            runtimeConfig: {
              type: "ssh",
              host: "sb-1.xum--daytona",
              srcBaseDir: "/home/daytona/xum",
              daytona: { sandboxName: "sb-1" },
            },
            createdAt: "2026-01-01T00:00:00.000Z",
            archivedAt,
          },
        ],
      });
      return config;
    });
  }

  // An archive cannot run while the editor use is held, so a sandbox started here cannot be
  // left running by an archive that saw it stopped.
  test("brings the sandbox up only once the editor use is admitted", async () => {
    await addDaytonaWorkspace();

    expect(await harness.service.recordExternalEditorOpen("dt", "tok-1")).toEqual({
      success: true,
      data: undefined,
    });
    expect(leasesDuringReadiness).toEqual([1]);
    // The editor reads the user's ssh config, which the ready cache does not cover.
    expect(ensureReady).toHaveBeenCalledWith({ externalSshClient: true });
  });

  test("refuses the open and releases the use when the sandbox cannot come up", async () => {
    await addDaytonaWorkspace();
    readiness = { ready: false, error: 'Daytona sandbox "sb-1" no longer exists' };

    expect(await harness.service.recordExternalEditorOpen("dt", "tok-1")).toEqual({
      success: false,
      error: 'Daytona sandbox "sb-1" no longer exists',
    });
    expect(leasesDuringReadiness).toEqual([1]);
    expect(workspaceUseLeasesFor(harness.config).heldCount("dt", "editor")).toBe(0);
  });

  // A workspace created with the default srcBaseDir keeps its ~ path (the sandbox did not exist
  // yet); the editor needs it absolute, which only the running sandbox can tell.
  test("resolves a checkout path under ~ on the sandbox once it is ready", async () => {
    await addDaytonaWorkspace();
    const markerPath = path.join(harness.config.sessionsDir, "dt", "external-editor-opened");
    const resolvePath = mock((p: string) => {
      // Only once the sandbox is ready under the editor use.
      expect(leasesDuringReadiness.length).toBeGreaterThan(0);
      return Promise.resolve(p.replace(/^~/, "/home/daytona"));
    });
    createRuntime.mockRestore();
    createRuntime = spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue({
      ensureReady,
      resolvePath,
    } as unknown as Runtime);

    // A path that cannot be resolved opens nothing and leaves no marker behind.
    resolvePath.mockImplementationOnce(() => Promise.reject(new Error("ssh: connection refused")));
    const refused = await harness.service.recordExternalEditorOpen("dt", "tok-1", "~/mux/x");
    expect(refused.success).toBe(false);
    expect(await Bun.file(markerPath).exists()).toBe(false);

    expect(
      await harness.service.recordExternalEditorOpen("dt", "tok-2", "~/mux/project/dt")
    ).toEqual({ success: true, data: { remotePath: "/home/daytona/mux/project/dt" } });
  });

  test("refuses an archived workspace without starting its sandbox", async () => {
    await addDaytonaWorkspace("2026-01-02T00:00:00.000Z");

    expect((await harness.service.recordExternalEditorOpen("dt", "tok-1")).success).toBe(false);
    expect(ensureReady).not.toHaveBeenCalled();
  });
});
