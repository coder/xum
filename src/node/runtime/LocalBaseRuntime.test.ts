import { describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { getSelfIdentity, linuxBirth } from "@/node/utils/concurrency/processLiveness";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { LocalRuntime } from "./LocalRuntime";
import { setAgentCgroupEnrollmentTargets } from "./agentCgroupEnrollment";
import type { AgentSandboxPolicy } from "./sandbox/agentSandboxTargets";
import * as macosSandbox from "./sandbox/macosSandbox";
import type {
  InitLogger,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
} from "./Runtime";

class TestLocalRuntime extends LocalBaseRuntime {
  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    return "/tmp/workspace";
  }

  createWorkspace(_params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return Promise.resolve({ success: true, workspacePath: "/tmp/workspace" });
  }

  initWorkspace(_params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    return Promise.resolve({ success: true });
  }

  renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    return Promise.resolve({ success: true, oldPath: "/tmp/workspace", newPath: "/tmp/workspace" });
  }

  deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    return Promise.resolve({ success: true, deletedPath: "/tmp/workspace" });
  }

  forkWorkspace(_params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    return Promise.resolve({
      success: true,
      workspacePath: "/tmp/workspace",
      sourceBranch: "main",
    });
  }
}

class InitHookTestRuntime extends TestLocalRuntime {
  runHook(workspacePath: string, hookPath: string, logger: InitLogger): Promise<void> {
    return this.runInitHook(workspacePath, hookPath, {}, logger);
  }
}

async function readStreamAsString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return output;
    }

    output += decoder.decode(value, { stream: true });
  }
}

describe("LocalBaseRuntime.resolvePath", () => {
  it("should expand tilde to home directory", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("~");
    expect(resolved).toBe(os.homedir());
  });

  it("should expand tilde with path", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("~/..");
    const expected = path.dirname(os.homedir());
    expect(resolved).toBe(expected);
  });

  it("should resolve absolute paths", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("/tmp");
    expect(resolved).toBe("/tmp");
  });

  it("should resolve non-existent paths without checking existence", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("/this/path/does/not/exist/12345");
    // Should resolve to absolute path without checking if it exists
    expect(resolved).toBe("/this/path/does/not/exist/12345");
  });

  it("should resolve relative paths from cwd", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath(".");
    // Should resolve to absolute path
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe("LocalBaseRuntime.exec process identity", () => {
  it("keeps the child identity after exit", async () => {
    const stream = await new TestLocalRuntime().exec('printf "%s" "$$"; read -r _; exit 7', {
      cwd: os.tmpdir(),
      timeout: 5,
    });
    const stdout = readStreamAsString(stream.stdout);
    const stderr = readStreamAsString(stream.stderr);
    try {
      const evidence = stream.localProcess;
      expect(evidence).toBeDefined();
      if (!evidence) throw new Error("Missing local process identity");
      expect(evidence.pid).not.toBe(process.pid);
      expect(evidence.identity).toEqual({ ...getSelfIdentity(), birth: linuxBirth(evidence.pid) });
      if (process.platform === "linux") {
        expect(evidence.identity?.birth).toStartWith("linux-ticks:");
      }
      await stream.stdin.close();
      expect(await stream.exitCode).toBe(7);
      const shellPid = await stdout;
      if (process.platform !== "win32") expect(shellPid).toBe(String(evidence.pid));
      expect(stream.localProcess).toBe(evidence);
    } finally {
      await stream.stdin.close().catch(() => undefined);
      await Promise.all([stream.exitCode, stdout, stderr]);
    }
  });
});

describe("LocalBaseRuntime.exec PATH handling", () => {
  it("canonicalizes pathEnv values with file I/O semantics (tilde and product home)", async () => {
    const xumRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xum-root-"));
    const originalRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = xumRoot;
    try {
      const runtime = new TestLocalRuntime();
      const stream = await runtime.exec('printf "%s\\n%s" "$XUM_TEST_PATH" "$XUM_TEST_HOME"', {
        cwd: os.tmpdir(),
        pathEnv: { XUM_TEST_PATH: "~/runtime-path", XUM_TEST_HOME: "~/.xum/plans" },
        timeout: 5,
      });
      await stream.stdin.close();

      expect(await readStreamAsString(stream.stdout)).toBe(
        `${path.join(os.homedir(), "runtime-path")}\n${path.join(xumRoot, "plans")}`
      );
      expect(await stream.exitCode).toBe(0);
    } finally {
      if (originalRoot === undefined) {
        delete process.env.XUM_ROOT;
      } else {
        process.env.XUM_ROOT = originalRoot;
      }
      await fs.rm(xumRoot, { recursive: true, force: true });
    }
  });

  it("strips mux browser shims and leaked browser env from child shells", async () => {
    const runtime = new TestLocalRuntime();
    const tempBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-path-probe-"));
    const vendoredBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-vendored-bin-"));
    const commandPath = path.join(tempBinDir, "mux-path-probe");
    const vendoredCommandPath = path.join(vendoredBinDir, "mux-path-probe");
    const originalVendoredBinDir = process.env.MUX_VENDORED_BIN_DIR;
    const originalAgentBrowserSession = process.env.AGENT_BROWSER_SESSION;

    try {
      await fs.writeFile(commandPath, "#!/bin/sh\necho caller-path\n", "utf8");
      await fs.chmod(commandPath, 0o755);
      await fs.writeFile(vendoredCommandPath, "#!/bin/sh\necho vendored-path\n", "utf8");
      await fs.chmod(vendoredCommandPath, 0o755);
      process.env.MUX_VENDORED_BIN_DIR = vendoredBinDir;
      process.env.AGENT_BROWSER_SESSION = "mux-leaked-session";

      // #6509: the minimal host env drops the vendored-bin pointer, but PATH
      // sanitization must still see it.
      for (const hostEnv of ["inherit", "minimal"] as const) {
        const stream = await runtime.exec(
          'printf "%s\\n" "${AGENT_BROWSER_SESSION-unset}" && mux-path-probe',
          {
            cwd: os.tmpdir(),
            timeout: 5,
            env: { PATH: `${vendoredBinDir}:${tempBinDir}:/usr/bin:/bin` },
            hostEnv,
          }
        );
        const [stdout, exitCode] = await Promise.all([
          readStreamAsString(stream.stdout),
          stream.exitCode,
        ]);

        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe("unset\ncaller-path");
      }
    } finally {
      if (originalVendoredBinDir == null) {
        delete process.env.MUX_VENDORED_BIN_DIR;
      } else {
        process.env.MUX_VENDORED_BIN_DIR = originalVendoredBinDir;
      }
      if (originalAgentBrowserSession == null) {
        delete process.env.AGENT_BROWSER_SESSION;
      } else {
        process.env.AGENT_BROWSER_SESSION = originalAgentBrowserSession;
      }
      await fs.rm(tempBinDir, { recursive: true, force: true });
      await fs.rm(vendoredBinDir, { recursive: true, force: true });
    }
  });
});

describe("LocalBaseRuntime.exec hostEnv", () => {
  // #6509: plugin stdio MCP servers must not inherit the user's shell secrets.
  async function runEnvProbe(hostEnv: "inherit" | "minimal" | undefined) {
    const runtime = new TestLocalRuntime();
    const stream = await runtime.exec(
      'printf "%s|%s|%s" "${XUM_TEST_HOST_SECRET-unset}" "${XUM_TEST_DECLARED-unset}" "${HOME-unset}"',
      {
        cwd: os.tmpdir(),
        timeout: 5,
        env: { XUM_TEST_DECLARED: "declared" },
        ...(hostEnv !== undefined ? { hostEnv } : {}),
      }
    );
    await stream.stdin.close();
    const [stdout, exitCode] = await Promise.all([
      readStreamAsString(stream.stdout),
      stream.exitCode,
    ]);
    expect(exitCode).toBe(0);
    return stdout;
  }

  it("keeps only allowlisted host variables plus the declared env for minimal", async () => {
    const original = process.env.XUM_TEST_HOST_SECRET;
    process.env.XUM_TEST_HOST_SECRET = "leaked";
    try {
      expect(await runEnvProbe("minimal")).toBe(`unset|declared|${process.env.HOME ?? "unset"}`);
      // Default exec (user MCP servers, the bash tool) still inherits the host env.
      expect(await runEnvProbe(undefined)).toBe(`leaked|declared|${process.env.HOME ?? "unset"}`);
    } finally {
      if (original === undefined) {
        delete process.env.XUM_TEST_HOST_SECRET;
      } else {
        process.env.XUM_TEST_HOST_SECRET = original;
      }
    }
  });
});

describe("LocalBaseRuntime.exec sandbox opt-out", () => {
  const POLICY: AgentSandboxPolicy = {
    writeRoots: [],
    gitCommonDirs: [],
    denyWrite: [],
    denyRead: [],
    allowRead: [],
    network: "loopback",
    allowedHosts: [],
    allowLocalBinding: true,
  };

  /** A runtime whose agent sandbox applies (or not), so the test runs on every platform. */
  class SandboxedRuntime extends TestLocalRuntime {
    constructor(private readonly sandboxed: boolean) {
      super();
    }

    override agentSandboxPolicy(): AgentSandboxPolicy | null {
      return this.sandboxed ? POLICY : null;
    }
  }

  // A sandboxed command can write the file that BASH_ENV names in the workspace.
  it("does not source BASH_ENV in a call that opts out of a sandbox that applies", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-bash-env-"));
    try {
      const startup = path.join(dir, "startup.sh");
      await fs.writeFile(startup, "echo sourced\n");
      const run = async (runtime: LocalBaseRuntime) => {
        const stream = await runtime.exec("echo ran", {
          cwd: dir,
          timeout: 5,
          env: { BASH_ENV: startup },
          sandbox: "off",
        });
        await stream.stdin.close();
        return readStreamAsString(stream.stdout);
      };

      expect(await run(new SandboxedRuntime(true))).toBe("ran\n");
      expect(await run(new SandboxedRuntime(false))).toBe("sourced\nran\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // An inherited PATH can hold a folder that sandboxed commands write, such as a .venv/bin.
  it("runs Xum's own opt-out commands with system tools, and approved calls with the PATH", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-opt-out-path-"));
    try {
      const planted = path.join(dir, "rm");
      await fs.writeFile(planted, "#!/bin/sh\necho planted\n", { mode: 0o755 });
      const resolve = async (runtime: LocalBaseRuntime, sandbox: "off" | "internal") => {
        const stream = await runtime.exec('command -v rm; echo "$BASH"; echo "$PATH"', {
          cwd: dir,
          timeout: 5,
          env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
          sandbox,
        });
        await stream.stdin.close();
        return (await readStreamAsString(stream.stdout)).trim().split("\n");
      };

      const [internalRm, internalBash, internalPath] = await resolve(
        new SandboxedRuntime(true),
        "internal"
      );
      expect(internalRm).not.toBe(planted);
      expect(internalBash).toBe("/bin/bash");
      // Only root can write a folder on it (an Intel Homebrew owns /usr/local/bin).
      for (const folder of internalPath.split(":")) {
        const stat = await fs.stat(folder);
        expect({ folder, uid: stat.uid, groupOrOtherWrite: stat.mode & 0o022 }).toEqual({
          folder,
          uid: 0,
          groupOrOtherWrite: 0,
        });
      }
      expect((await resolve(new SandboxedRuntime(true), "off"))[0]).toBe(planted);
      expect((await resolve(new SandboxedRuntime(false), "internal"))[0]).toBe(planted);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LocalBaseRuntime.exec sandbox wrap", () => {
  // No process starts after the abort, so nothing else frees the wrap's network registration.
  it("frees the sandbox wrap when the call is aborted while the wrap is set up", async () => {
    const controller = new AbortController();
    const dispose = mock(() => undefined);
    const wrap = spyOn(macosSandbox, "wrapForAgentSandbox").mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        command: "/usr/bin/true",
        args: [],
        env: {},
        commandId: "c",
        dispose,
      });
    });
    try {
      const run = new TestLocalRuntime().exec("echo ran", {
        cwd: os.tmpdir(),
        timeout: 5,
        abortSignal: controller.signal,
      });

      const error = await run.then(
        () => null,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(Error);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      wrap.mockRestore();
    }
  });
});

describe("LocalBaseRuntime agent cgroup enrollment", () => {
  it("moves each command's shell into the agent cgroup before the command runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-enroll-"));
    const procsFile = path.join(dir, "cgroup.procs");
    setAgentCgroupEnrollmentTargets({ fallback: procsFile, byProject: new Map() });
    try {
      const stream = await new TestLocalRuntime().exec("echo $$", { cwd: dir, timeout: 5 });
      await stream.stdin.close();
      const [stdout, exitCode] = await Promise.all([
        readStreamAsString(stream.stdout),
        stream.exitCode,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/^\d+\n$/);
      expect(await fs.readFile(procsFile, "utf-8")).toBe(stdout);
    } finally {
      setAgentCgroupEnrollmentTargets(null);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("moves a command into the cgroup of its project, and others into the shared one", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-enroll-"));
    const sharedProcs = path.join(dir, "shared.procs");
    const projectProcs = path.join(dir, "project.procs");
    const otherProject = path.join(dir, "other");
    await fs.mkdir(otherProject);
    setAgentCgroupEnrollmentTargets({
      fallback: sharedProcs,
      byProject: new Map([[dir, projectProcs]]),
    });
    const run = async (projectPath: string) => {
      const stream = await new LocalRuntime(projectPath).exec("echo $$", {
        cwd: projectPath,
        timeout: 5,
      });
      await stream.stdin.close();
      return readStreamAsString(stream.stdout);
    };
    try {
      const projectPid = await run(dir);
      const otherPid = await run(otherProject);

      expect(await fs.readFile(projectProcs, "utf-8")).toBe(projectPid);
      expect(await fs.readFile(sharedProcs, "utf-8")).toBe(otherPid);
    } finally {
      setAgentCgroupEnrollmentTargets(null);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("moves the init hook's shell into the agent cgroup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-enroll-"));
    const procsFile = path.join(dir, "cgroup.procs");
    const hookPath = path.join(dir, "init");
    await fs.writeFile(hookPath, '#!/usr/bin/env bash\necho "$$ $PPID"\n', { mode: 0o755 });
    const stdoutLines: string[] = [];
    const exitCodes: number[] = [];
    const logger = {
      logStep: () => undefined,
      logStdout: (line: string) => stdoutLines.push(line),
      logStderr: () => undefined,
      logComplete: (exitCode: number) => exitCodes.push(exitCode),
    };
    setAgentCgroupEnrollmentTargets({ fallback: procsFile, byProject: new Map() });
    try {
      await new InitHookTestRuntime().runHook(dir, hookPath, logger);

      expect(exitCodes).toEqual([0]);
      // bash may run the hook as its own child or exec it in place.
      const [hookPid, hookParentPid] = (stdoutLines[0] ?? "").split(" ");
      expect([hookPid, hookParentPid]).toContain((await fs.readFile(procsFile, "utf-8")).trim());
    } finally {
      setAgentCgroupEnrollmentTargets(null);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LocalBaseRuntime.exec timeout", () => {
  it("should resolve exitCode with EXIT_CODE_TIMEOUT when command exceeds timeout", async () => {
    const runtime = new TestLocalRuntime();
    const stream = await runtime.exec("sleep 30", {
      cwd: os.tmpdir(),
      timeout: 1,
    });
    const exitCode = await stream.exitCode;
    expect(exitCode).toBe(EXIT_CODE_TIMEOUT);
  });

  it("should close stdout/stderr streams on timeout so readers don't hang", async () => {
    const runtime = new TestLocalRuntime();
    const stream = await runtime.exec("sleep 30", {
      cwd: os.tmpdir(),
      timeout: 1,
    });
    // This mimics what bash.ts does: read streams AND await exitCode concurrently.
    // Without the fix, consumeStream hangs on Windows because the reader never sees EOF.
    const [exitCode] = await Promise.all([
      stream.exitCode,
      stream.stdout
        .getReader()
        .read()
        .then(({ done }) => done),
      stream.stderr
        .getReader()
        .read()
        .then(({ done }) => done),
    ]);
    expect(exitCode).toBe(EXIT_CODE_TIMEOUT);
  });
});
