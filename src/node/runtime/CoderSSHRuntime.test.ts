import { describe, expect, it, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import type { CoderService } from "@/node/services/coderService";
import type { RuntimeConfig } from "@/common/types/runtime";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};
import type { InitLogger, RuntimeStatusEvent, WorkspaceInitParams } from "./Runtime";

import { CoderSSHRuntime, type CoderSSHRuntimeConfig } from "./CoderSSHRuntime";
import { SSHRuntime } from "./SSHRuntime";
import { createSSHTransport } from "./transports";

/**
 * Create a minimal mock CoderService for testing.
 * Only mocks methods used by the tested code paths.
 */
function createMockCoderService(overrides?: Partial<CoderService>): CoderService {
  const provisioningSession = {
    token: "token",
    dispose: mock(() => Promise.resolve()),
  };

  return {
    createWorkspace: mock(() => asyncLines([])),
    deleteWorkspace: mock(() => Promise.resolve()),
    deleteWorkspaceEventually: mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    ),
    ensureProvisioningSession: mock(() => Promise.resolve(provisioningSession)),
    verifyAuthenticatedSession: mock(() => Promise.resolve()),
    takeProvisioningSession: mock(() => provisioningSession),
    disposeProvisioningSession: mock(() => Promise.resolve()),
    ensureMuxCoderSSHConfig: mock(() => Promise.resolve()),
    getWorkspaceStatus: mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "running" as const })
    ),
    listWorkspaces: mock(() => Promise.resolve({ ok: true, workspaces: [] })),
    waitForStartupScripts: mock(() => asyncLines([])),
    workspaceExists: mock(() => Promise.resolve(false)),
    ...overrides,
  } as unknown as CoderService;
}

/**
 * Create a CoderSSHRuntime with minimal config for testing.
 */
function createRuntime(
  coderConfig: {
    existingWorkspace?: boolean;
    workspaceName?: string;
    template?: string;
  },
  coderService: CoderService
): CoderSSHRuntime {
  const template = "template" in coderConfig ? coderConfig.template : "default-template";

  const config: CoderSSHRuntimeConfig = {
    host: "placeholder.mux--coder",
    srcBaseDir: "~/src",
    coder: {
      existingWorkspace: coderConfig.existingWorkspace ?? false,
      workspaceName: coderConfig.workspaceName,
      template,
    },
  };
  const transport = createSSHTransport(config, false);
  return new CoderSSHRuntime(config, transport, coderService);
}

/**
 * Create an SSH+Coder RuntimeConfig for finalizeConfig tests.
 */
function createSSHCoderConfig(coder: {
  existingWorkspace?: boolean;
  workspaceName?: string;
}): RuntimeConfig {
  return {
    type: "ssh",
    host: "placeholder.mux--coder",
    srcBaseDir: "~/src",
    coder: {
      existingWorkspace: coder.existingWorkspace ?? false,
      workspaceName: coder.workspaceName,
      template: "default-template",
    },
  };
}

describe("CoderSSHRuntime cleanup availability", () => {
  // The control-plane fake avoids a real Coder deployment. The probe must never open SSH or start a workspace.
  it.each(["running", "stopped", "starting", "stopping", "deleting", "deleted"] as const)(
    "permits cleanup only when the workspace is running (%s)",
    async (status) => {
      const getWorkspaceStatus = mock(() => Promise.resolve({ kind: "ok" as const, status }));
      const createWorkspace = mock(() => asyncLines([]));
      const service = createMockCoderService({ getWorkspaceStatus, createWorkspace });
      const runtime = createRuntime({ workspaceName: "mux-cleanup" }, service);
      const signal = new AbortController().signal;
      expect(await runtime.isRunningWithoutStart(signal)).toBe(status === "running");
      expect(getWorkspaceStatus).toHaveBeenCalledWith("mux-cleanup", { signal });
      expect(createWorkspace).not.toHaveBeenCalled();
    }
  );

  it("skips cleanup when the control plane cannot find the workspace", async () => {
    const service = createMockCoderService({
      getWorkspaceStatus: mock(() => Promise.resolve({ kind: "not_found" as const })),
    });
    const runtime = createRuntime({ workspaceName: "mux-missing" }, service);
    expect(await runtime.isRunningWithoutStart(new AbortController().signal)).toBe(false);
  });
});

function asyncLines(lines: string[], error?: Error): AsyncGenerator<string, void, unknown> {
  return (async function* (): AsyncGenerator<string, void, unknown> {
    await Promise.resolve();
    for (const line of lines) {
      yield line;
    }
    if (error) {
      throw error;
    }
  })();
}

function createInitLogger(overrides: Partial<InitLogger> = {}): InitLogger {
  return {
    logStep: noop,
    logStdout: noop,
    logStderr: noop,
    logComplete: noop,
    ...overrides,
  };
}

function createPostCreateSetupParams(
  workspaceName: string,
  initLogger: InitLogger = createInitLogger()
): WorkspaceInitParams {
  return {
    initLogger,
    projectPath: "/project",
    branchName: "branch",
    trunkBranch: "main",
    workspacePath: `/home/user/src/my-project/${workspaceName}`,
  };
}

describe("CoderSSHRuntime constructor", () => {
  it("normalizes host to .mux--coder when workspaceName is present", () => {
    const coderService = createMockCoderService();
    const config: CoderSSHRuntimeConfig = {
      host: "ws.coder",
      srcBaseDir: "~/src",
      coder: {
        existingWorkspace: true,
        workspaceName: "ws",
        template: "default-template",
      },
    };
    const transport = createSSHTransport(config, false);
    const runtime = new CoderSSHRuntime(config, transport, coderService);

    expect(runtime.getConfig().host).toBe("ws.mux--coder");
  });
});

// =============================================================================
// Test Suite 1: finalizeConfig (name/host derivation)
// =============================================================================

describe("CoderSSHRuntime.finalizeConfig", () => {
  let coderService: CoderService;
  let runtime: CoderSSHRuntime;

  beforeEach(() => {
    coderService = createMockCoderService();
    runtime = createRuntime({}, coderService);
  });

  describe("new workspace mode", () => {
    it("derives Coder name from branch name when not provided", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("my-feature", config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("ssh");
        if (result.data.type === "ssh") {
          expect(result.data.coder?.workspaceName).toBe("mux-my-feature");
          expect(result.data.host).toBe("mux-my-feature.mux--coder");
        }
      }
    });

    it("converts underscores to hyphens", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("my_feature_branch", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("mux-my-feature-branch");
        expect(result.data.host).toBe("mux-my-feature-branch.mux--coder");
      }
    });

    it("collapses multiple hyphens and trims leading/trailing", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("--my--feature--", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("mux-my-feature");
      }
    });

    it("rejects names that fail regex after conversion", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: false });
      // Name with special chars that can't form a valid Coder name (only hyphens/underscores become invalid)
      const result = await runtime.finalizeConfig("@#$%", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cannot be converted to a valid Coder name");
      }
    });

    it("returns error when provisioning session creation fails", async () => {
      const verifyAuthenticatedSession = mock(() => Promise.resolve());
      const ensureProvisioningSession = mock(() => Promise.reject(new Error("nope")));

      coderService = createMockCoderService({
        verifyAuthenticatedSession,
        ensureProvisioningSession,
      });
      runtime = createRuntime({}, coderService);

      const config = createSSHCoderConfig({ existingWorkspace: false });
      const result = await runtime.finalizeConfig("branch", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to prepare Coder provisioning session");
        expect(result.error).toContain("nope");
      }
      expect(ensureProvisioningSession).toHaveBeenCalledWith("mux-branch");
    });
    it("uses provided workspaceName over branch name", async () => {
      const config = createSSHCoderConfig({
        existingWorkspace: false,
        workspaceName: "custom-name",
      });
      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("custom-name");
        expect(result.data.host).toBe("custom-name.mux--coder");
      }
    });
  });

  describe("existing workspace mode", () => {
    it("requires workspaceName to be provided", async () => {
      const config = createSSHCoderConfig({ existingWorkspace: true });
      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("required for existing workspaces");
      }
    });

    it("keeps provided workspaceName and sets host", async () => {
      const config = createSSHCoderConfig({
        existingWorkspace: true,
        workspaceName: "existing-ws",
      });
      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "ssh") {
        expect(result.data.coder?.workspaceName).toBe("existing-ws");
        expect(result.data.host).toBe("existing-ws.mux--coder");
      }
    });

    it("returns Err when Coder auth verification fails for existing workspace", async () => {
      const verifyAuthenticatedSession = mock(() => Promise.reject(new Error("not logged in")));

      coderService = createMockCoderService({ verifyAuthenticatedSession });
      runtime = createRuntime({}, coderService);

      const config = createSSHCoderConfig({
        existingWorkspace: true,
        workspaceName: "existing-ws",
      });

      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to verify Coder authentication");
      }
      expect(verifyAuthenticatedSession).toHaveBeenCalledTimes(1);
    });

    it("does not call ensureProvisioningSession for existing workspace even when auth succeeds", async () => {
      const verifyAuthenticatedSession = mock(() => Promise.resolve());
      const ensureProvisioningSession = mock(() =>
        Promise.resolve({ token: "token", dispose: mock(() => Promise.resolve()) })
      );

      coderService = createMockCoderService({
        verifyAuthenticatedSession,
        ensureProvisioningSession,
      });
      runtime = createRuntime({}, coderService);

      const config = createSSHCoderConfig({
        existingWorkspace: true,
        workspaceName: "existing-ws",
      });

      const result = await runtime.finalizeConfig("branch-name", config);

      expect(result.success).toBe(true);
      expect(verifyAuthenticatedSession).toHaveBeenCalledTimes(1);
      expect(ensureProvisioningSession).not.toHaveBeenCalled();
    });
  });

  it("passes through non-SSH configs unchanged", async () => {
    const config: RuntimeConfig = { type: "local" };
    const result = await runtime.finalizeConfig("branch", config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(config);
    }
  });

  it("passes through SSH configs without coder unchanged", async () => {
    const config: RuntimeConfig = { type: "ssh", host: "example.com", srcBaseDir: "/src" };
    const result = await runtime.finalizeConfig("branch", config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(config);
    }
  });
});

// =============================================================================
// Test Suite 2: deleteWorkspace behavior
// =============================================================================

describe("CoderSSHRuntime.deleteWorkspace", () => {
  /**
   * For deleteWorkspace tests, we mock SSHRuntime.prototype.deleteWorkspace
   * to control the parent class behavior.
   */
  let sshDeleteSpy: Mock<typeof SSHRuntime.prototype.deleteWorkspace>;

  beforeEach(() => {
    sshDeleteSpy = spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: "/path",
    });
  });

  afterEach(() => {
    sshDeleteSpy.mockRestore();
  });

  it("never calls coderService.deleteWorkspaceEventually when existingWorkspace=true", async () => {
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "existing-ws" },
      coderService
    );

    await runtime.deleteWorkspace("/project", "ws", false);
    expect(deleteWorkspaceEventually).not.toHaveBeenCalled();
  });

  it("skips Coder deletion when workspaceName is not set", async () => {
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ deleteWorkspaceEventually });

    // No workspaceName provided
    const runtime = createRuntime({ existingWorkspace: false }, coderService);

    const result = await runtime.deleteWorkspace("/project", "ws", false);
    expect(deleteWorkspaceEventually).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("skips Coder deletion when SSH delete fails and force=false", async () => {
    sshDeleteSpy.mockResolvedValue({ success: false, error: "dirty workspace" });

    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);
    expect(deleteWorkspaceEventually).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("calls Coder deletion (no SSH) when force=true", async () => {
    sshDeleteSpy.mockResolvedValue({ success: false, error: "dirty workspace" });

    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    await runtime.deleteWorkspace("/project", "ws", true);
    expect(sshDeleteSpy).not.toHaveBeenCalled();
    expect(deleteWorkspaceEventually).toHaveBeenCalledWith(
      "my-ws",
      expect.objectContaining({ waitForExistence: true, waitForExistenceTimeoutMs: 10_000 })
    );
  });

  it("returns combined error when SSH succeeds but Coder delete fails", async () => {
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: false as const, error: "Coder API error" })
    );
    const coderService = createMockCoderService({ deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("SSH delete succeeded");
      expect(result.error).toContain("Coder API error");
    }
  });

  it("succeeds immediately when Coder workspace is already deleted", async () => {
    // getWorkspaceStatus returns { kind: "not_found" } when workspace doesn't exist
    const getWorkspaceStatus = mock(() => Promise.resolve({ kind: "not_found" as const }));
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);

    // Should succeed without calling SSH delete or Coder delete
    expect(result.success).toBe(true);
    expect(sshDeleteSpy).not.toHaveBeenCalled();
    expect(deleteWorkspaceEventually).not.toHaveBeenCalled();
  });

  it("passes abort signal to the Coder status check during delete", async () => {
    const getWorkspaceStatus = mock(() => Promise.resolve({ kind: "not_found" as const }));
    const coderService = createMockCoderService({ getWorkspaceStatus });
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );
    const abortController = new AbortController();

    await runtime.deleteWorkspace("/project", "ws", false, abortController.signal);

    expect(getWorkspaceStatus).toHaveBeenCalledWith(
      "my-ws",
      expect.objectContaining({ signal: abortController.signal })
    );
  });

  it("proceeds with SSH cleanup when status check fails with API error", async () => {
    // API error (auth, network) - should NOT treat as "already deleted"
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "error" as const, error: "coder timed out" })
    );
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);

    // Should proceed with SSH cleanup (which succeeds), then Coder delete
    expect(sshDeleteSpy).toHaveBeenCalled();
    expect(deleteWorkspaceEventually).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("deletes stopped Coder workspace without SSH cleanup", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "stopped" as const })
    );
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);

    expect(result.success).toBe(true);
    expect(sshDeleteSpy).not.toHaveBeenCalled();
    expect(deleteWorkspaceEventually).toHaveBeenCalledWith(
      "my-ws",
      expect.objectContaining({ waitForExistence: false })
    );
  });
  it("succeeds immediately when Coder workspace status is 'deleting'", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "deleting" as const })
    );
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, deleteWorkspaceEventually });

    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws" },
      coderService
    );

    const result = await runtime.deleteWorkspace("/project", "ws", false);

    // Should succeed without calling SSH delete or Coder delete (workspace already dying)
    expect(result.success).toBe(true);
    expect(sshDeleteSpy).not.toHaveBeenCalled();
    expect(deleteWorkspaceEventually).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite 3: validateBeforePersist (collision detection)
// =============================================================================

describe("CoderSSHRuntime.validateBeforePersist", () => {
  it("returns error when Coder workspace already exists", async () => {
    const workspaceExists = mock(() => Promise.resolve(true));
    const coderService = createMockCoderService({ workspaceExists });
    const runtime = createRuntime({}, coderService);

    const config = createSSHCoderConfig({
      existingWorkspace: false,
      workspaceName: "my-ws",
    });

    const result = await runtime.validateBeforePersist("branch", config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("already exists");
    }
    expect(workspaceExists).toHaveBeenCalledWith("my-ws");
  });

  it("skips collision check for existingWorkspace=true", async () => {
    const workspaceExists = mock(() => Promise.resolve(true));
    const coderService = createMockCoderService({ workspaceExists });
    const runtime = createRuntime({}, coderService);

    const config = createSSHCoderConfig({
      existingWorkspace: true,
      workspaceName: "existing-ws",
    });

    const result = await runtime.validateBeforePersist("branch", config);
    expect(result.success).toBe(true);
    expect(workspaceExists).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite 4: postCreateSetup (provisioning)
// =============================================================================

describe("CoderSSHRuntime.postCreateSetup", () => {
  let execBufferedSpy: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">>;

  beforeEach(() => {
    execBufferedSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      duration: 0,
    });
  });

  afterEach(() => {
    execBufferedSpy.mockRestore();
  });

  it("creates a new Coder workspace and prepares the directory", async () => {
    const createWorkspace = mock(() => asyncLines(["build line 1", "build line 2"]));
    const ensureMuxCoderSSHConfig = mock(() => Promise.resolve());
    const provisioningSession = {
      token: "token",
      dispose: mock(() => Promise.resolve()),
    };
    const takeProvisioningSession = mock(() => provisioningSession);

    // Start with workspace not found, then return running after creation
    let workspaceCreated = false;
    const getWorkspaceStatus = mock(() =>
      Promise.resolve(
        workspaceCreated
          ? { kind: "ok" as const, status: "running" as const }
          : { kind: "not_found" as const }
      )
    );

    const coderService = createMockCoderService({
      createWorkspace,
      ensureMuxCoderSSHConfig,
      getWorkspaceStatus,
      takeProvisioningSession,
    });
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws", template: "my-template" },
      coderService
    );

    // Before postCreateSetup, ensureReady should fail (workspace doesn't exist on server)
    const beforeReady = await runtime.ensureReady();
    expect(beforeReady.ready).toBe(false);
    if (!beforeReady.ready) {
      expect(beforeReady.errorType).toBe("runtime_not_ready");
    }

    // Simulate workspace being created by postCreateSetup
    workspaceCreated = true;

    const steps: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const initLogger = {
      logStep: (s: string) => {
        steps.push(s);
      },
      logStdout: (s: string) => {
        stdout.push(s);
      },
      logStderr: (s: string) => {
        stderr.push(s);
      },
      logComplete: noop,
    };

    await runtime.postCreateSetup(createPostCreateSetupParams("my-ws", initLogger));

    expect(takeProvisioningSession).toHaveBeenCalledWith("my-ws");
    expect(createWorkspace).toHaveBeenCalledWith(
      "my-ws",
      "my-template",
      undefined,
      undefined,
      undefined,
      provisioningSession
    );
    expect(provisioningSession.dispose).toHaveBeenCalled();
    expect(ensureMuxCoderSSHConfig).toHaveBeenCalled();
    expect(execBufferedSpy).toHaveBeenCalled();

    // After postCreateSetup, ensureReady should succeed (workspace exists on server)
    const afterReady = await runtime.ensureReady();
    expect(afterReady.ready).toBe(true);

    expect(stdout).toEqual(["build line 1", "build line 2"]);
    expect(stderr).toEqual([]);
    expect(steps.join("\n")).toContain("Creating Coder workspace");
    expect(steps.join("\n")).toContain("Configuring SSH");
    expect(steps.join("\n")).toContain("Preparing workspace directory");
  });

  it("disposes provisioning session when workspace creation fails", async () => {
    const createWorkspace = mock(() => asyncLines(["Starting workspace..."], new Error("boom")));
    const provisioningSession = {
      token: "token",
      dispose: mock(() => Promise.resolve()),
    };
    const takeProvisioningSession = mock(() => provisioningSession);

    const coderService = createMockCoderService({
      createWorkspace,
      takeProvisioningSession,
    });
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws", template: "my-template" },
      coderService
    );

    let caughtError: Error | undefined;
    try {
      await runtime.postCreateSetup(createPostCreateSetupParams("my-ws"));
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError?.message).toContain("Failed to create Coder workspace");
    expect(takeProvisioningSession).toHaveBeenCalledWith("my-ws");
    expect(createWorkspace).toHaveBeenCalledWith(
      "my-ws",
      "my-template",
      undefined,
      undefined,
      undefined,
      provisioningSession
    );
    expect(provisioningSession.dispose).toHaveBeenCalled();
  });

  it("skips workspace creation when existingWorkspace=true and workspace is running", async () => {
    const createWorkspace = mock(() => asyncLines(["should not happen"]));
    const waitForStartupScripts = mock(() => asyncLines(["Already running"]));
    const ensureMuxCoderSSHConfig = mock(() => Promise.resolve());
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "running" as const })
    );

    const coderService = createMockCoderService({
      createWorkspace,
      waitForStartupScripts,
      ensureMuxCoderSSHConfig,
      getWorkspaceStatus,
    });
    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "existing-ws" },
      coderService
    );

    await runtime.postCreateSetup(createPostCreateSetupParams("existing-ws"));

    expect(createWorkspace).not.toHaveBeenCalled();
    // waitForStartupScripts is called (it handles running workspaces quickly)
    expect(waitForStartupScripts).toHaveBeenCalled();
    expect(ensureMuxCoderSSHConfig).toHaveBeenCalled();
    expect(execBufferedSpy).toHaveBeenCalled();
  });

  it("uses waitForStartupScripts for existing stopped workspace (auto-starts via coder ssh)", async () => {
    const createWorkspace = mock(() => asyncLines(["should not happen"]));
    const waitForStartupScripts = mock(() =>
      asyncLines(["Starting workspace...", "Build complete", "Startup scripts finished"])
    );
    const ensureMuxCoderSSHConfig = mock(() => Promise.resolve());
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "stopped" as const })
    );

    const coderService = createMockCoderService({
      createWorkspace,
      waitForStartupScripts,
      ensureMuxCoderSSHConfig,
      getWorkspaceStatus,
    });
    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "existing-ws" },
      coderService
    );

    const loggedStdout: string[] = [];
    await runtime.postCreateSetup(
      createPostCreateSetupParams(
        "existing-ws",
        createInitLogger({ logStdout: (line) => loggedStdout.push(line) })
      )
    );

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(waitForStartupScripts).toHaveBeenCalled();
    expect(loggedStdout).toContain("Starting workspace...");
    expect(loggedStdout).toContain("Startup scripts finished");
    expect(ensureMuxCoderSSHConfig).toHaveBeenCalled();
  });

  it("polls until stopping workspace becomes stopped before connecting", async () => {
    let pollCount = 0;
    const getWorkspaceStatus = mock(() => {
      pollCount++;
      // First 2 calls return "stopping", then "stopped"
      if (pollCount <= 2) {
        return Promise.resolve({ kind: "ok" as const, status: "stopping" as const });
      }
      return Promise.resolve({ kind: "ok" as const, status: "stopped" as const });
    });
    const waitForStartupScripts = mock(() => asyncLines(["Ready"]));
    const ensureMuxCoderSSHConfig = mock(() => Promise.resolve());

    const coderService = createMockCoderService({
      getWorkspaceStatus,
      waitForStartupScripts,
      ensureMuxCoderSSHConfig,
    });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "stopping-ws" },
      coderService
    );

    // Avoid real sleeps in this polling test
    interface RuntimeWithSleep {
      sleep: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
    }
    spyOn(runtime as unknown as RuntimeWithSleep, "sleep").mockResolvedValue(undefined);

    const loggedSteps: string[] = [];
    await runtime.postCreateSetup(
      createPostCreateSetupParams(
        "stopping-ws",
        createInitLogger({ logStep: (step) => loggedSteps.push(step) })
      )
    );

    // Should have polled status multiple times
    expect(pollCount).toBeGreaterThan(2);
    expect(loggedSteps.some((s) => s.includes("Waiting for Coder workspace"))).toBe(true);
    expect(waitForStartupScripts).toHaveBeenCalled();
  });

  it("throws when workspaceName is missing", () => {
    const coderService = createMockCoderService();
    const runtime = createRuntime({ existingWorkspace: false, template: "tmpl" }, coderService);

    return expect(runtime.postCreateSetup(createPostCreateSetupParams("ws"))).rejects.toThrow(
      "Coder workspace name is required"
    );
  });

  it("throws when template is missing for new workspaces", () => {
    const coderService = createMockCoderService();
    const runtime = createRuntime(
      { existingWorkspace: false, workspaceName: "my-ws", template: undefined },
      coderService
    );

    return expect(runtime.postCreateSetup(createPostCreateSetupParams("ws"))).rejects.toThrow(
      "Coder template is required"
    );
  });
});

// =============================================================================
// Test Suite 5: ensureReady (runtime readiness + status events)
// =============================================================================

describe("CoderSSHRuntime.ensureReady", () => {
  it("returns ready when workspace is already running", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "running" as const })
    );
    const waitForStartupScripts = mock(() => asyncLines(["should not be called"]));
    const coderService = createMockCoderService({ getWorkspaceStatus, waitForStartupScripts });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws" },
      coderService
    );

    const events: RuntimeStatusEvent[] = [];
    const result = await runtime.ensureReady({
      statusSink: (e) => events.push(e),
    });

    expect(result).toEqual({ ready: true });
    expect(getWorkspaceStatus).toHaveBeenCalled();
    // Short-circuited because status is already "running"
    expect(waitForStartupScripts).not.toHaveBeenCalled();
    expect(events.map((e) => e.phase)).toEqual(["checking", "ready"]);
    expect(events[0]?.runtimeType).toBe("ssh");
  });

  it("reuses recent activity across recreated runtime instances", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "running" as const })
    );
    const coderService = createMockCoderService({ getWorkspaceStatus });

    const firstRuntime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws-recreated" },
      coderService
    );
    const secondRuntime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws-recreated" },
      coderService
    );

    expect(await firstRuntime.ensureReady()).toEqual({ ready: true });
    expect(await secondRuntime.ensureReady()).toEqual({ ready: true });

    expect(getWorkspaceStatus).toHaveBeenCalledTimes(1);
  });

  it("expires the cross-runtime activity cache after the fast-path window", async () => {
    let now = 1_700_000_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const getWorkspaceStatus = mock(() =>
        Promise.resolve({ kind: "ok" as const, status: "running" as const })
      );
      const coderService = createMockCoderService({ getWorkspaceStatus });

      const firstRuntime = createRuntime(
        { existingWorkspace: true, workspaceName: "my-ws-expiring" },
        coderService
      );
      expect(await firstRuntime.ensureReady()).toEqual({ ready: true });

      const cachedRuntime = createRuntime(
        { existingWorkspace: true, workspaceName: "my-ws-expiring" },
        coderService
      );
      expect(await cachedRuntime.ensureReady()).toEqual({ ready: true });
      expect(getWorkspaceStatus).toHaveBeenCalledTimes(1);

      now += 5 * 60 * 1000 + 1;
      const expiredRuntime = createRuntime(
        { existingWorkspace: true, workspaceName: "my-ws-expiring" },
        coderService
      );
      expect(await expiredRuntime.ensureReady()).toEqual({ ready: true });
      expect(getWorkspaceStatus).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("connects via waitForStartupScripts when status is stopped (auto-starts)", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "stopped" as const })
    );
    const waitForStartupScripts = mock(() =>
      asyncLines(["Starting workspace...", "Workspace started"])
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, waitForStartupScripts });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws" },
      coderService
    );

    const events: RuntimeStatusEvent[] = [];
    const result = await runtime.ensureReady({
      statusSink: (e) => events.push(e),
    });

    expect(result).toEqual({ ready: true });
    expect(waitForStartupScripts).toHaveBeenCalled();
    // We should see checking, then starting, then ready
    expect(events[0]?.phase).toBe("checking");
    expect(events.some((e) => e.phase === "starting")).toBe(true);
    expect(events.at(-1)?.phase).toBe("ready");
  });

  it("returns runtime_start_failed when waitForStartupScripts fails", async () => {
    const getWorkspaceStatus = mock(() =>
      Promise.resolve({ kind: "ok" as const, status: "stopped" as const })
    );
    const waitForStartupScripts = mock(() =>
      asyncLines(["Starting workspace..."], new Error("connection failed"))
    );
    const coderService = createMockCoderService({ getWorkspaceStatus, waitForStartupScripts });

    const runtime = createRuntime(
      { existingWorkspace: true, workspaceName: "my-ws" },
      coderService
    );

    const events: RuntimeStatusEvent[] = [];
    const result = await runtime.ensureReady({
      statusSink: (e) => events.push(e),
    });

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_start_failed");
      expect(result.error).toContain("Failed to connect");
    }

    expect(events.at(-1)?.phase).toBe("error");
  });
});
