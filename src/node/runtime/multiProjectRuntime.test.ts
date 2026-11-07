import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import type { Runtime, RuntimeStatusEvent } from "./Runtime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { MultiProjectRuntime } from "./multiProjectRuntime";
import { setAgentSandboxTargets } from "./sandbox/agentSandboxTargets";

const SANDBOX_SETTINGS: ResolvedAgentSandboxSettings = {
  enabled: true,
  network: "loopback",
  allowedHosts: [],
  extraWritePaths: [],
  extraReadPaths: [],
};

async function initGitRepo(projectPath: string): Promise<void> {
  await fs.mkdir(projectPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: projectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: projectPath, stdio: "ignore" });

  await fs.writeFile(path.join(projectPath, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectPath, stdio: "ignore" });
}

async function createWorkspaceWorktree(
  projectPath: string,
  srcBaseDir: string,
  workspaceName: string
): Promise<string> {
  const workspacePath = path.join(srcBaseDir, path.basename(projectPath), workspaceName);
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", workspaceName, workspacePath, "main"], {
    cwd: projectPath,
    stdio: "ignore",
  });
  return workspacePath;
}

describe("MultiProjectRuntime", () => {
  let rootDir: string;
  let srcBaseDir: string;
  let projectAPath: string;
  let projectBPath: string;
  let workspaceName: string;
  let projectAWorkspacePath: string;
  let projectBWorkspacePath: string;
  let containerManager: ContainerManager;
  let runtime: MultiProjectRuntime;

  beforeEach(async () => {
    rootDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "multi-project-runtime-")));
    srcBaseDir = path.join(rootDir, "src");
    await fs.mkdir(srcBaseDir, { recursive: true });

    workspaceName = "shared-workspace";
    projectAPath = path.join(rootDir, "project-a");
    projectBPath = path.join(rootDir, "project-b");

    await initGitRepo(projectAPath);
    await initGitRepo(projectBPath);

    projectAWorkspacePath = await createWorkspaceWorktree(projectAPath, srcBaseDir, workspaceName);
    projectBWorkspacePath = await createWorkspaceWorktree(projectBPath, srcBaseDir, workspaceName);

    containerManager = new ContainerManager(srcBaseDir);
    runtime = new MultiProjectRuntime(
      containerManager,
      [
        {
          projectPath: projectAPath,
          projectName: "project-a",
          runtime: new WorktreeRuntime(srcBaseDir, {
            projectPath: projectAPath,
            workspaceName,
          }),
        },
        {
          projectPath: projectBPath,
          projectName: "project-b",
          runtime: new WorktreeRuntime(srcBaseDir, {
            projectPath: projectBPath,
            workspaceName,
          }),
        },
      ],
      workspaceName
    );
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("ensureReady succeeds when all project runtimes are ready", async () => {
    const events: RuntimeStatusEvent[] = [];

    const result = await runtime.ensureReady({
      statusSink: (event) => events.push(event),
    });

    expect(result).toEqual({ ready: true });
    expect(events.filter((event) => event.phase === "checking")).toHaveLength(2);
    expect(events.filter((event) => event.phase === "ready")).toHaveLength(2);
  });

  it("initWorkspace delegates initialization to every project runtime", async () => {
    const logStepMock = vi.fn();
    const logStdoutMock = vi.fn();
    const logStderrMock = vi.fn();
    const logCompleteMock = vi.fn();
    const initLogger = {
      logStep: logStepMock,
      logStdout: logStdoutMock,
      logStderr: logStderrMock,
      logComplete: logCompleteMock,
    };

    const projectOneGetWorkspacePathMock = vi.fn(() => "/tmp/project-one-workspace");
    const projectOneInitWorkspaceMock = vi.fn().mockResolvedValue({ success: true });
    const projectOneRuntime = {
      getWorkspacePath: projectOneGetWorkspacePathMock,
      initWorkspace: projectOneInitWorkspaceMock,
    } as unknown as Runtime;

    const projectTwoGetWorkspacePathMock = vi.fn(() => "/tmp/project-two-workspace");
    const projectTwoInitWorkspaceMock = vi.fn().mockResolvedValue({ success: true });
    const projectTwoRuntime = {
      getWorkspacePath: projectTwoGetWorkspacePathMock,
      initWorkspace: projectTwoInitWorkspaceMock,
    } as unknown as Runtime;

    const multiRuntime = new MultiProjectRuntime(
      containerManager,
      [
        {
          projectPath: projectAPath,
          projectName: "project-a",
          runtime: projectOneRuntime,
        },
        {
          projectPath: projectBPath,
          projectName: "project-b",
          runtime: projectTwoRuntime,
        },
      ],
      workspaceName
    );

    const result = await multiRuntime.initWorkspace({
      projectPath: projectAPath,
      branchName: workspaceName,
      trunkBranch: "main",
      workspacePath: containerManager.getContainerPath(workspaceName),
      initLogger,
    });

    expect(result).toEqual({ success: true });
    expect(projectOneGetWorkspacePathMock).toHaveBeenCalledWith(projectAPath, workspaceName);
    expect(projectTwoGetWorkspacePathMock).toHaveBeenCalledWith(projectBPath, workspaceName);
    expect(projectOneInitWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: projectAPath,
        workspacePath: "/tmp/project-one-workspace",
      })
    );
    expect(projectTwoInitWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: projectBPath,
        workspacePath: "/tmp/project-two-workspace",
      })
    );
    expect(logCompleteMock).toHaveBeenCalledTimes(1);
    expect(logCompleteMock).toHaveBeenCalledWith(0);
  });

  it("initWorkspace resolves env per project when envResolver is provided", async () => {
    const initLogger = {
      logStep: vi.fn(),
      logStdout: vi.fn(),
      logStderr: vi.fn(),
      logComplete: vi.fn(),
    };

    const projectOneInitWorkspaceMock = vi.fn().mockResolvedValue({ success: true });
    const projectOneRuntime = {
      getWorkspacePath: vi.fn(() => "/tmp/project-one-workspace"),
      initWorkspace: projectOneInitWorkspaceMock,
    } as unknown as Runtime;

    const projectTwoInitWorkspaceMock = vi.fn().mockResolvedValue({ success: true });
    const projectTwoRuntime = {
      getWorkspacePath: vi.fn(() => "/tmp/project-two-workspace"),
      initWorkspace: projectTwoInitWorkspaceMock,
    } as unknown as Runtime;

    const multiRuntime = new MultiProjectRuntime(
      containerManager,
      [
        {
          projectPath: projectAPath,
          projectName: "project-a",
          runtime: projectOneRuntime,
        },
        {
          projectPath: projectBPath,
          projectName: "project-b",
          runtime: projectTwoRuntime,
        },
      ],
      workspaceName
    );

    const envResolverMock = vi.fn((projectPath: string) =>
      Promise.resolve({
        PROJECT_SECRET: `secret-${path.basename(projectPath)}`,
      })
    );
    multiRuntime.envResolver = envResolverMock;

    const result = await multiRuntime.initWorkspace({
      projectPath: projectAPath,
      branchName: workspaceName,
      trunkBranch: "main",
      workspacePath: containerManager.getContainerPath(workspaceName),
      initLogger,
      env: { SHARED_SECRET: "shared" },
    });

    expect(result).toEqual({ success: true });
    expect(envResolverMock).toHaveBeenCalledTimes(2);
    expect(envResolverMock).toHaveBeenNthCalledWith(1, projectAPath);
    expect(envResolverMock).toHaveBeenNthCalledWith(2, projectBPath);
    expect(projectOneInitWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: projectAPath,
        env: { PROJECT_SECRET: `secret-${path.basename(projectAPath)}` },
      })
    );
    expect(projectTwoInitWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: projectBPath,
        env: { PROJECT_SECRET: `secret-${path.basename(projectBPath)}` },
      })
    );
  });

  it("initWorkspace returns the first failure after all project init hooks run", async () => {
    const logStepMock = vi.fn();
    const logStdoutMock = vi.fn();
    const logStderrMock = vi.fn();
    const logCompleteMock = vi.fn();
    const initLogger = {
      logStep: logStepMock,
      logStdout: logStdoutMock,
      logStderr: logStderrMock,
      logComplete: logCompleteMock,
    };

    const firstFailure = { success: false, error: "project one init failed" };

    const projectOneGetWorkspacePathMock = vi.fn(() => "/tmp/project-one-workspace");
    const projectOneInitWorkspaceMock = vi.fn().mockResolvedValue(firstFailure);
    const projectOneRuntime = {
      getWorkspacePath: projectOneGetWorkspacePathMock,
      initWorkspace: projectOneInitWorkspaceMock,
    } as unknown as Runtime;

    const projectTwoGetWorkspacePathMock = vi.fn(() => "/tmp/project-two-workspace");
    const projectTwoInitWorkspaceMock = vi.fn().mockResolvedValue({ success: true });
    const projectTwoRuntime = {
      getWorkspacePath: projectTwoGetWorkspacePathMock,
      initWorkspace: projectTwoInitWorkspaceMock,
    } as unknown as Runtime;

    const multiRuntime = new MultiProjectRuntime(
      containerManager,
      [
        {
          projectPath: projectAPath,
          projectName: "project-a",
          runtime: projectOneRuntime,
        },
        {
          projectPath: projectBPath,
          projectName: "project-b",
          runtime: projectTwoRuntime,
        },
      ],
      workspaceName
    );

    const result = await multiRuntime.initWorkspace({
      projectPath: projectAPath,
      branchName: workspaceName,
      trunkBranch: "main",
      workspacePath: containerManager.getContainerPath(workspaceName),
      initLogger,
    });

    expect(result).toEqual(firstFailure);
    expect(projectOneInitWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(projectTwoInitWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(logCompleteMock).toHaveBeenCalledTimes(1);
    expect(logCompleteMock).toHaveBeenCalledWith(-1);
  });

  it("getWorkspacePath returns the shared container path", () => {
    const workspacePath = runtime.getWorkspacePath(projectAPath, workspaceName);

    expect(workspacePath).toBe(containerManager.getContainerPath(workspaceName));
    expect(workspacePath).toContain(path.join("_workspaces", workspaceName));
  });

  it("exec runs in container directory when cwd is not set", async () => {
    const containerPath = await containerManager.createContainer(workspaceName, [
      {
        projectName: "project-a",
        workspacePath: projectAWorkspacePath,
      },
      {
        projectName: "project-b",
        workspacePath: projectBWorkspacePath,
      },
    ]);

    const result = await execBuffered(runtime, "pwd", {
      cwd: "",
      timeout: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(containerPath);
  });

  // The container is the cwd, a write root, so a sandboxed command can point a link anywhere.
  it.skipIf(process.platform !== "darwin")(
    "opens each project's checkout in the sandbox, not where the container links to it",
    async () => {
      const containerPath = await containerManager.createContainer(workspaceName, [
        { projectName: "project-a", workspacePath: projectAWorkspacePath },
        { projectName: "project-b", workspacePath: projectBWorkspacePath },
      ]);
      const elsewhere = path.join(rootDir, "elsewhere");
      await fs.mkdir(elsewhere);
      await fs.rm(path.join(containerPath, "project-a"));
      await fs.symlink(elsewhere, path.join(containerPath, "project-a"));
      setAgentSandboxTargets({ fallback: SANDBOX_SETTINGS, byProject: new Map() });
      try {
        const writeRoots = runtime.agentSandboxPolicy({ cwd: containerPath })?.writeRoots;

        expect(writeRoots).toContain(projectAWorkspacePath);
        expect(writeRoots).not.toContain(elsewhere);
      } finally {
        setAgentSandboxTargets(null);
      }
    }
  );
});
