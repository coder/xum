import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as devcontainerCli from "./devcontainerCli";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import {
  createRuntime,
  IncompatibleRuntimeError,
  setDevcontainerScratchMountGate,
} from "./runtimeFactory";
import {
  isLocalProjectRuntime,
  isWorktreeRuntime,
  type RuntimeConfig,
} from "@/common/types/runtime";
import { LocalRuntime } from "./LocalRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { CoderSSHRuntime } from "./CoderSSHRuntime";
import type { CoderService } from "@/node/services/coderService";

describe("isIncompatibleRuntimeConfig", () => {
  it("returns false for undefined config", () => {
    expect(isIncompatibleRuntimeConfig(undefined)).toBe(false);
  });

  it("returns false for local config with srcBaseDir (legacy worktree)", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "~/.xum/src",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for local config without srcBaseDir (project-dir mode)", () => {
    // Local without srcBaseDir is now supported as project-dir mode
    const config: RuntimeConfig = { type: "local" };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for worktree config", () => {
    const config: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "~/.xum/src",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns false for SSH config", () => {
    const config: RuntimeConfig = {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/home/user/mux",
    };
    expect(isIncompatibleRuntimeConfig(config)).toBe(false);
  });

  it("returns true for unknown runtime type from future versions", () => {
    // Simulate a config from a future version with new type
    const config = { type: "future-runtime" } as unknown as RuntimeConfig;
    expect(isIncompatibleRuntimeConfig(config)).toBe(true);
  });
});

describe("createRuntime", () => {
  it("creates WorktreeRuntime for local config with srcBaseDir (legacy)", () => {
    const config: RuntimeConfig = {
      type: "local",
      srcBaseDir: "/tmp/test-src",
    };
    const runtime = createRuntime(config);
    expect(runtime).toBeInstanceOf(WorktreeRuntime);
  });

  it("creates LocalRuntime for local config without srcBaseDir (project-dir)", () => {
    const config: RuntimeConfig = { type: "local" };
    const runtime = createRuntime(config, { projectPath: "/tmp/my-project" });
    expect(runtime).toBeInstanceOf(LocalRuntime);
  });

  it("creates WorktreeRuntime for explicit worktree config", () => {
    const config: RuntimeConfig = {
      type: "worktree",
      srcBaseDir: "/tmp/test-src",
    };
    const runtime = createRuntime(config);
    expect(runtime).toBeInstanceOf(WorktreeRuntime);
  });

  it("throws error for local project-dir without projectPath option", () => {
    const config: RuntimeConfig = { type: "local" };
    expect(() => createRuntime(config)).toThrow(/projectPath/);
  });

  it("throws IncompatibleRuntimeError for unknown runtime type", () => {
    const config = { type: "future-runtime" } as unknown as RuntimeConfig;
    expect(() => createRuntime(config)).toThrow(IncompatibleRuntimeError);
    expect(() => createRuntime(config)).toThrow(/newer version/);
  });

  // Callers pick delete-vs-keep of a checkout with these predicates, so they must classify every
  // legacy "local" form the way the factory builds it (#5118): an empty srcBaseDir is a worktree.
  it("runtime predicates agree with the factory for every legacy local config", () => {
    const configs: RuntimeConfig[] = [
      { type: "local" },
      { type: "local", srcBaseDir: "/tmp/test-src" },
      { type: "local", srcBaseDir: "" },
    ];
    for (const config of configs) {
      const runtime = createRuntime(config, { projectPath: "/tmp/my-project" });
      expect({ config, worktree: isWorktreeRuntime(config) }).toEqual({
        config,
        worktree: runtime instanceof WorktreeRuntime,
      });
      expect({ config, projectDir: isLocalProjectRuntime(config) }).toEqual({
        config,
        projectDir: runtime instanceof LocalRuntime,
      });
    }
  });
});

describe("createRuntime - devcontainer scratch mount", () => {
  const savedDockerHost = process.env.DOCKER_HOST;
  const savedXumRoot = process.env.XUM_ROOT;

  afterEach(() => {
    mock.restore();
    setDevcontainerScratchMountGate(() => false);
    if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = savedDockerHost;
    if (savedXumRoot === undefined) delete process.env.XUM_ROOT;
    else process.env.XUM_ROOT = savedXumRoot;
  });

  it("bind-mounts the scratch dir only with the Artifacts experiment on", async () => {
    // Users who never enable Artifacts must not have `devcontainer up` depend on the daemon
    // accepting the scratch mount source (Docker Desktop / Colima file sharing).
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-factory-scratch-"));
    try {
      process.env.XUM_ROOT = tempDir;
      process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
      const workspacePath = path.join(tempDir, "ws");
      await fs.mkdir(workspacePath, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: workspacePath });
      const up = spyOn(devcontainerCli, "devcontainerUp").mockResolvedValue({
        containerId: "c1",
        remoteUser: "root",
        remoteWorkspaceFolder: "/workspaces/ws",
      });
      const upMounts = async () => {
        up.mockClear();
        const runtime = createRuntime(
          { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
          { projectPath: workspacePath, workspaceId: "ws1", workspacePath }
        );
        // $HOME lookup after `up` is best-effort; keep it off the real CLI.
        spyOn(runtime, "exec").mockRejectedValue(new Error("no devcontainer CLI in tests"));
        expect((await runtime.ensureReady()).ready).toBe(true);
        return (up.mock.calls[0]?.[0].additionalMounts ?? []).filter((mount) =>
          mount.target.endsWith(path.join("ws1", "scratch"))
        );
      };

      setDevcontainerScratchMountGate(() => false);
      expect(await upMounts()).toEqual([]);
      setDevcontainerScratchMountGate(() => true);
      expect(await upMounts()).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("createRuntime - Coder host normalization", () => {
  it("uses normalized mux--coder host for both runtime and transport", () => {
    // Legacy persisted config: host still has old .coder suffix,
    // but coder.workspaceName is present for normalization.
    const config: RuntimeConfig = {
      type: "ssh",
      host: "legacy.coder",
      srcBaseDir: "~/src",
      coder: {
        existingWorkspace: true,
        workspaceName: "legacy",
        template: "default-template",
      },
    };

    const runtime = createRuntime(config, {
      coderService: {} as unknown as CoderService,
    });

    expect(runtime).toBeInstanceOf(CoderSSHRuntime);

    // Both runtime config and underlying transport must use the
    // canonical host — the P1 bug was transport keeping raw config.host.
    const sshRuntime = runtime as unknown as {
      getConfig(): { host: string };
      transport: { getConfig(): { host: string } };
    };

    expect(sshRuntime.getConfig().host).toBe("legacy.mux--coder");
    expect(sshRuntime.transport.getConfig().host).toBe("legacy.mux--coder");
  });
});
