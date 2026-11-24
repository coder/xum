/**
 * SSH+None (`workspaceIsolation: "none"`): workspaces run directly in an existing directory on
 * the host, the SSH analogue of project-dir LocalRuntime. The directory is the user's project, so
 * these tests pin that no lifecycle operation syncs into it, checks out a branch, moves it or
 * deletes it, and that a missing directory fails with an error that names it.
 *
 * A real SSHRuntime runs against a mocked exec() that records every remote command.
 */

import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecStream, InitLogger } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import type { PtyHandle, PtySessionParams, SSHTransport } from "./transports";

const PROJECT_DIR = "/home/me/code/app";
const PROJECT_PATH = "/Users/me/code/app";
const HOST = "devbox.test";

const noop = (): void => undefined;
const noopAsync = (): Promise<void> => Promise.resolve();
const noopInitLogger: InitLogger = {
  logStep: noop,
  logStdout: noop,
  logStderr: noop,
  logComplete: noop,
};

function createMockTransport(config: SSHRuntimeConfig): SSHTransport {
  return {
    spawnRemoteProcess() {
      return Promise.reject(new Error("Unexpected transport use"));
    },
    isConnectionFailure() {
      return false;
    },
    acquireConnection() {
      return Promise.resolve();
    },
    getConfig() {
      return config;
    },
    createPtySession(_params: PtySessionParams): Promise<PtyHandle> {
      return Promise.reject(new Error("Unexpected PTY creation"));
    },
    openReverseForward(): Promise<never> {
      return Promise.reject(new Error("Unexpected reverse forward"));
    },
  };
}

function createTextStream(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.byteLength > 0) controller.enqueue(encoded);
      controller.close();
    },
  });
}

function createExecStream(exitCode: number): ExecStream {
  return {
    stdout: createTextStream(""),
    stderr: createTextStream(""),
    stdin: new WritableStream<Uint8Array>({ write: noopAsync, close: noopAsync, abort: noopAsync }),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

/** Exit code of the directory probe: 0 = directory, 10 = missing, 11 = not a directory. */
type DirState = 0 | 10 | 11;

class SharedDirTestSSHRuntime extends SSHRuntime {
  readonly calls: Array<{ command: string; cwd: string }> = [];
  dirState: DirState = 0;
  initHookPresent = false;

  constructor(options?: { projectPath: string; workspaceName: string }) {
    const config: SSHRuntimeConfig = {
      host: HOST,
      srcBaseDir: "~/xum",
      workspaceIsolation: "none",
      projectDir: PROJECT_DIR,
    };
    super(config, createMockTransport(config), options);
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.calls.push({ command, cwd: options.cwd });
    if (command.includes("test -d") || command.includes("[ -d")) {
      return Promise.resolve(createExecStream(this.dirState));
    }
    if (command.startsWith("test -x")) {
      return Promise.resolve(createExecStream(this.initHookPresent ? 0 : 1));
    }
    return Promise.resolve(createExecStream(0));
  }

  get commands(): string[] {
    return this.calls.map((call) => call.command);
  }
}

/** Any command that would sync, check out, move or delete a checkout. */
function touchesCheckout(command: string): boolean {
  return /\bgit\b|worktree|rm -rf|\bmv\b|bundle|rsync|mkdir/.test(command);
}

describe("SSHRuntime with workspaceIsolation none", () => {
  it("uses projectDir as every workspace's path", () => {
    const runtime = new SharedDirTestSSHRuntime();
    expect(runtime.getWorkspacePath(PROJECT_PATH, "feature-a")).toBe(PROJECT_DIR);
    expect(runtime.getWorkspacePath(PROJECT_PATH, "feature-b")).toBe(PROJECT_DIR);
  });

  it("rejects a none config without a projectDir", () => {
    const config: SSHRuntimeConfig = {
      host: HOST,
      srcBaseDir: "~/xum",
      workspaceIsolation: "none",
      projectDir: "  ",
    };
    expect(() => new SSHRuntime(config, createMockTransport(config))).toThrow(/projectDir/);
  });

  describe("createWorkspace", () => {
    const params = {
      projectPath: PROJECT_PATH,
      branchName: "feature-a",
      trunkBranch: "",
      directoryName: "feature-a",
      initLogger: noopInitLogger,
    };

    it("returns projectDir after checking it, without touching a checkout", async () => {
      const runtime = new SharedDirTestSSHRuntime();
      const result = await runtime.createWorkspace(params);
      expect(result).toEqual({ success: true, workspacePath: PROJECT_DIR });
      expect(runtime.commands).toHaveLength(1);
      expect(runtime.commands.some(touchesCheckout)).toBe(false);
    });

    it("fails naming the directory and host when it does not exist", async () => {
      const runtime = new SharedDirTestSSHRuntime();
      runtime.dirState = 10;
      const result = await runtime.createWorkspace(params);
      expect(result.success).toBe(false);
      expect(result.error).toBe(`Directory ${PROJECT_DIR} does not exist on host ${HOST}`);
    });

    it("fails when the path is not a directory", async () => {
      const runtime = new SharedDirTestSSHRuntime();
      runtime.dirState = 11;
      const result = await runtime.createWorkspace(params);
      expect(result.success).toBe(false);
      expect(result.error).toContain("is not a directory");
    });
  });

  describe("initWorkspace", () => {
    const params = {
      projectPath: PROJECT_PATH,
      branchName: "feature-a",
      trunkBranch: "",
      workspacePath: PROJECT_DIR,
      initLogger: noopInitLogger,
      trusted: true,
    };

    // params.trusted is project trust AND the user's trust of this directory (workspaceService).
    it("does no sync or checkout and runs the init hook in projectDir when trusted", async () => {
      const runtime = new SharedDirTestSSHRuntime();
      runtime.initHookPresent = true;
      const result = await runtime.initWorkspace(params);
      expect(result.success).toBe(true);
      expect(runtime.commands.some(touchesCheckout)).toBe(false);
      const hookCall = runtime.calls.find(
        (call) => call.command.includes("/init") && !call.command.startsWith("test -x")
      );
      expect(hookCall?.cwd).toBe(PROJECT_DIR);
    });

    it("never runs the init hook of an untrusted directory", async () => {
      const runtime = new SharedDirTestSSHRuntime();
      runtime.initHookPresent = true;
      const result = await runtime.initWorkspace({ ...params, trusted: false });
      expect(result.success).toBe(true);
      expect(runtime.commands.some(touchesCheckout)).toBe(false);
      expect(runtime.commands.some((command) => command.includes("/init"))).toBe(false);
    });

    it("fails when the directory went missing after create", async () => {
      const runtime = new SharedDirTestSSHRuntime();
      runtime.dirState = 10;
      const result = await runtime.initWorkspace(params);
      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist on host");
    });
  });

  it("deleteWorkspace never touches the directory, even forced", async () => {
    const runtime = new SharedDirTestSSHRuntime();
    const result = await runtime.deleteWorkspace(PROJECT_PATH, "feature-a", true);
    expect(result).toEqual({ success: true, deletedPath: PROJECT_DIR });
    expect(runtime.commands).toEqual([]);
  });

  it("renameWorkspace keeps the shared path and moves nothing", async () => {
    const runtime = new SharedDirTestSSHRuntime();
    const result = await runtime.renameWorkspace(PROJECT_PATH, "feature-a", "feature-b");
    expect(result).toEqual({ success: true, oldPath: PROJECT_DIR, newPath: PROJECT_DIR });
    expect(runtime.commands).toEqual([]);
  });

  it("forkWorkspace shares the source's directory without a new checkout", async () => {
    const runtime = new SharedDirTestSSHRuntime();
    const result = await runtime.forkWorkspace({
      projectPath: PROJECT_PATH,
      sourceWorkspaceName: "feature-a",
      newWorkspaceName: "feature-b",
      initLogger: noopInitLogger,
      trusted: true,
    });
    expect(result).toEqual({ success: true, workspacePath: PROJECT_DIR });
    expect(runtime.commands.some(touchesCheckout)).toBe(false);
  });

  describe("ensureReady", () => {
    it("accepts a directory that is not a git repository", async () => {
      const runtime = new SharedDirTestSSHRuntime({
        projectPath: PROJECT_PATH,
        workspaceName: "feature-a",
      });
      const result = await runtime.ensureReady();
      expect(result).toEqual({ ready: true });
      expect(runtime.commands.some((command) => command.includes("git"))).toBe(false);
    });

    it("reports a missing directory by name instead of a missing repository", async () => {
      const runtime = new SharedDirTestSSHRuntime({
        projectPath: PROJECT_PATH,
        workspaceName: "feature-a",
      });
      runtime.dirState = 10;
      const result = await runtime.ensureReady();
      expect(result).toEqual({
        ready: false,
        error: `Directory ${PROJECT_DIR} does not exist on host ${HOST}`,
        errorType: "runtime_not_ready",
      });
    });
  });
});
