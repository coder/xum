import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as devcontainerCli from "./devcontainerCli";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
import type { ExecOptions, ExecStream } from "./Runtime";
import { MISSING_CWD_COMMANDS, MULTI_LINE_COMMAND_CASES } from "./testRemoteRuntime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";

interface RuntimeState {
  remoteHomeDir?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
  currentWorkspacePath?: string;
}

function createRuntime(state: RuntimeState): DevcontainerRuntime {
  const runtime = new DevcontainerRuntime({
    srcBaseDir: "/tmp/mux",
    configPath: ".devcontainer/devcontainer.json",
  });
  const internal = runtime as unknown as RuntimeState;
  internal.remoteHomeDir = state.remoteHomeDir;
  internal.remoteUser = state.remoteUser;
  internal.remoteWorkspaceFolder = state.remoteWorkspaceFolder;
  internal.currentWorkspacePath = state.currentWorkspacePath;
  return runtime;
}

function createTextStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function createSinkStream(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>();
}

class RecordingDevcontainerRuntime extends DevcontainerRuntime {
  execOptions: ExecOptions | undefined;

  override exec(_command: string, options: ExecOptions): Promise<ExecStream> {
    this.execOptions = options;
    return Promise.resolve({
      stdout: createTextStream("123 456 regular file\n"),
      stderr: createTextStream(""),
      stdin: createSinkStream(),
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(0),
    });
  }
}

describe("DevcontainerRuntime.stat", () => {
  it("forwards abort signals to exec-backed container stats", async () => {
    const runtime = new RecordingDevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
    });
    const abortController = new AbortController();

    await runtime.stat("relative/file.txt", abortController.signal);

    expect(runtime.execOptions?.abortSignal).toBe(abortController.signal);
    expect(runtime.execOptions?.pathEnv).toEqual({
      XUM_INTERNAL_FILE_PATH: "relative/file.txt",
    });
  });
});

describe("DevcontainerRuntime.resolvePath", () => {
  it("resolves ~ to cached remoteHomeDir", async () => {
    const runtime = createRuntime({ remoteHomeDir: "/home/coder" });
    expect(await runtime.resolvePath("~")).toBe("/home/coder");
  });

  it("throws when home is unknown", async () => {
    const runtime = createRuntime({});
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test expect().rejects requires await
    await expect(runtime.resolvePath("~")).rejects.toThrow("container home directory unavailable");
  });

  it("resolves ~/path to cached remoteHomeDir", async () => {
    const runtime = createRuntime({ remoteHomeDir: "/opt/user" });
    expect(await runtime.resolvePath("~/.mux")).toBe("/opt/user/.mux");
  });

  it("falls back to /home/<user> without cached home", async () => {
    const runtime = createRuntime({ remoteUser: "node" });
    expect(await runtime.resolvePath("~")).toBe("/home/node");
  });

  it("falls back to /root for root user", async () => {
    const runtime = createRuntime({ remoteUser: "root" });
    expect(await runtime.resolvePath("~")).toBe("/root");
  });

  it("resolves relative paths against remoteWorkspaceFolder", async () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/demo" });
    expect(await runtime.resolvePath("./foo")).toBe("/workspaces/demo/foo");
    expect(await runtime.resolvePath("bar")).toBe("/workspaces/demo/bar");
  });

  it("resolves relative paths against / when no workspace set", async () => {
    const runtime = createRuntime({});
    expect(await runtime.resolvePath("foo")).toBe("/foo");
  });

  it("passes absolute paths through", async () => {
    const runtime = createRuntime({});
    expect(await runtime.resolvePath("/tmp/test")).toBe("/tmp/test");
  });
});

describe("DevcontainerRuntime.resolveContainerCwd", () => {
  // Access the private method for testing
  function resolveContainerCwd(
    runtime: DevcontainerRuntime,
    optionsCwd: string | undefined,
    workspaceFolder: string
  ): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).resolveContainerCwd(optionsCwd, workspaceFolder);
  }

  it("uses POSIX absolute path as cwd", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "/tmp/test", "/host/workspace")).toBe("/tmp/test");
  });

  it("rejects Windows drive letter paths and falls back to workspace", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "C:\\Users\\dev", "/host/workspace")).toBe(
      "/workspaces/project"
    );
  });

  it("rejects paths with backslashes and falls back to workspace", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, "some\\path", "/host/workspace")).toBe(
      "/workspaces/project"
    );
  });

  it("falls back to workspaceFolder when remoteWorkspaceFolder not set", () => {
    const runtime = createRuntime({});
    expect(resolveContainerCwd(runtime, "C:\\", "/host/workspace")).toBe("/host/workspace");
  });

  it("falls back when cwd is undefined", () => {
    const runtime = createRuntime({ remoteWorkspaceFolder: "/workspaces/project" });
    expect(resolveContainerCwd(runtime, undefined, "/host/workspace")).toBe("/workspaces/project");
  });
});

describe("DevcontainerRuntime.resolveHostPathForMounted", () => {
  function resolveHostPathForMounted(
    runtime: DevcontainerRuntime,
    filePath: string
  ): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).resolveHostPathForMounted(filePath);
  }

  it("accepts Windows host paths under the workspace root", () => {
    const runtime = createRuntime({ currentWorkspacePath: "C:\\ws\\proj" });
    const filePath = "C:\\ws\\proj\\.mux\\mcp.local.jsonc";
    expect(resolveHostPathForMounted(runtime, filePath)).toBe(filePath);
  });
});
describe("DevcontainerRuntime.exec pathEnv", () => {
  // Drive the real exec boundary against a fake `devcontainer` CLI on PATH that echoes its argv,
  // so the forwarded --remote-env values are observable without Docker.
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-devcontainer-"));
    await fs.writeFile(path.join(binDir, "devcontainer"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "uses the CLI workspace directory without starting the container to discover its path",
    async () => {
      const stream = await createRuntime({ currentWorkspacePath: binDir }).exec("./.xum/archive", {
        cwd: binDir,
        timeout: 10,
      });
      const [argv, exitCode] = await Promise.all([
        new Response(stream.stdout).text(),
        stream.exitCode,
      ]);
      expect(exitCode).toBe(0);
      expect(argv).toContain("exec\n--workspace-folder\n");
      expect(argv).toContain("cd '.' || exit; ./.xum/archive");
      expect(argv).not.toContain(`cd '${binDir}'`);
    }
  );

  async function remoteEnvFor(state: RuntimeState, pathEnv: Record<string, string>) {
    const stream = await createRuntime(state).exec("true", {
      cwd: state.currentWorkspacePath!,
      pathEnv,
      timeout: 10,
    });
    const [argv, exitCode] = await Promise.all([
      new Response(stream.stdout).text(),
      stream.exitCode,
    ]);
    expect(exitCode).toBe(0);
    const lines = argv.split("\n");
    return lines.flatMap((line, index) => (lines[index - 1] === "--remote-env" ? [line] : []));
  }

  it.skipIf(process.platform === "win32")(
    "maps workspace paths into the container and keeps unmappable paths unchanged",
    async () => {
      // exec spawns the CLI with the host workspace as cwd, so it must exist.
      const hostWorkspace = binDir;
      const mapped = await remoteEnvFor(
        { remoteWorkspaceFolder: "/workspaces/project", currentWorkspacePath: hostWorkspace },
        { XUM_TEST_INSIDE: `${hostWorkspace}/nested/file`, XUM_TEST_OUTSIDE: "/tmp/other" }
      );
      expect(mapped).toContain("XUM_TEST_INSIDE=/workspaces/project/nested/file");
      expect(mapped).toContain("XUM_TEST_OUTSIDE=/tmp/other");

      // Before the container workspace is known, host paths pass through unchanged (#3709).
      const unknown = await remoteEnvFor(
        { currentWorkspacePath: hostWorkspace },
        { XUM_TEST_INSIDE: `${hostWorkspace}/nested/file` }
      );
      expect(unknown).toContain(`XUM_TEST_INSIDE=${hostWorkspace}/nested/file`);
    }
  );
});

describe("DevcontainerRuntime.exec output streams", () => {
  // Bun 1.4.3: a child pipe can emit `data` after the caller cancelled its reader (the bash tool
  // does on output overflow). Readable.toWeb then enqueues on a closed controller and throws from
  // the emitter, an uncaught exception that ends the CLI (nodeReadableToWeb).
  it.skipIf(process.platform === "win32")(
    "drops output that arrives after the caller cancels its readers",
    async () => {
      let child: ChildProcess | undefined;
      const spawnSpy = spyOn(devcontainerCli, "spawnDevcontainer").mockImplementation(
        (_args, options) => {
          // A later spawn is the abort's in-container stop (#6923); nothing to stop here.
          if (child) return spawn("true", [], options);
          child = spawn("sleep", ["30"], options);
          return child;
        }
      );
      const abort = new AbortController();
      const runtime = createRuntime({ currentWorkspacePath: os.tmpdir() });
      try {
        const stream = await runtime.exec("sleep 30", {
          cwd: os.tmpdir(),
          abortSignal: abort.signal,
        });
        expect(child).toBeDefined();
        await stream.stdout.cancel();
        await stream.stderr.cancel();
        expect(() => child?.stdout?.emit("data", Buffer.from("late"))).not.toThrow();
        expect(() => child?.stderr?.emit("data", Buffer.from("late"))).not.toThrow();
        abort.abort();
        await stream.exitCode;
        await runtime.awaitPendingStops();
      } finally {
        spawnSpy.mockRestore();
        child?.kill("SIGKILL");
      }
    }
  );
});

describe("DevcontainerRuntime.exec stops the command in the container (#6923)", () => {
  // The stop is a second `devcontainer exec` with a 10 s timeout. A hung container engine makes
  // it time out too, and its own cleanup must not start yet another stop.
  it.skipIf(process.platform === "win32")(
    "a stop that times out starts no further stop",
    async () => {
      const spawned: ChildProcess[] = [];
      const spawnSpy = spyOn(devcontainerCli, "spawnDevcontainer").mockImplementation(
        (_args, options) => {
          const child = spawn("sleep", ["30"], options);
          spawned.push(child);
          return child;
        }
      );
      const abort = new AbortController();
      const runtime = createRuntime({ currentWorkspacePath: os.tmpdir() });
      try {
        const stream = await runtime.exec("sleep 30", {
          cwd: os.tmpdir(),
          abortSignal: abort.signal,
        });
        abort.abort();
        await stream.exitCode;
        expect(spawned).toHaveLength(2);
        // The stop hangs until its own 10 s timeout ends it.
        await runtime.awaitPendingStops();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(spawned).toHaveLength(2);
      } finally {
        spawnSpy.mockRestore();
        for (const child of spawned) child.kill("SIGKILL");
      }
    },
    { timeout: 20_000 }
  );

  // DevcontainerRuntime has no remote timeout wrapper: a timed-out command kept running in the
  // container too, so its timeout starts the same stop as an abort.
  it.skipIf(process.platform === "win32")(
    "a timed-out command starts one stop for its marker",
    async () => {
      const spawned: Array<{ args: string[]; child: ChildProcess }> = [];
      const spawnSpy = spyOn(devcontainerCli, "spawnDevcontainer").mockImplementation(
        (spawnArgs, options) => {
          const child = spawn(spawned.length === 0 ? "sleep" : "true", ["30"], options);
          spawned.push({ args: spawnArgs, child });
          return child;
        }
      );
      const runtime = createRuntime({ currentWorkspacePath: os.tmpdir() });
      try {
        const stream = await runtime.exec("sleep 30", { cwd: os.tmpdir(), timeout: 0.2 });
        expect(await stream.exitCode).toBe(EXIT_CODE_TIMEOUT);
        await runtime.awaitPendingStops();
        expect(spawned).toHaveLength(2);
        const marker = spawned[0].args.find((arg) => arg.startsWith("XUM_EXEC_ID="));
        expect(marker).toMatch(/^XUM_EXEC_ID=[0-9a-f-]{36}$/);
        expect(spawned[1].args.join(" ")).toContain(marker!);
      } finally {
        spawnSpy.mockRestore();
        for (const { child } of spawned) child.kill("SIGKILL");
      }
    }
  );

  // A caller's XUM_EXEC_ID would replace the marker and hide the command from the stop.
  it("passes the marker and drops a caller's value for its key", async () => {
    let args: string[] = [];
    const spawnSpy = spyOn(devcontainerCli, "spawnDevcontainer").mockImplementation(
      (spawnArgs, options) => {
        args = spawnArgs;
        return spawn("true", [], options);
      }
    );
    try {
      const stream = await createRuntime({ currentWorkspacePath: os.tmpdir() }).exec("true", {
        cwd: os.tmpdir(),
        env: { XUM_EXEC_ID: "spoofed", OTHER: "kept" },
      });
      await stream.exitCode;
      const remoteEnv = args.filter((_arg, i) => args[i - 1] === "--remote-env");
      expect(remoteEnv.filter((entry) => entry.startsWith("XUM_EXEC_ID="))).toHaveLength(1);
      expect(remoteEnv.find((entry) => entry.startsWith("XUM_EXEC_ID="))).toMatch(
        /^XUM_EXEC_ID=[0-9a-f-]{36}$/
      );
      expect(remoteEnv).toContain("OTHER=kept");
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

describe("DevcontainerRuntime.exec multi-line commands", () => {
  // A fake `devcontainer` CLI that runs the command after `--` from its own cwd. exec spawns it
  // with the host workspace as cwd, which stands in for the container's workspace folder, where
  // `devcontainer exec` starts commands.
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fake-devcontainer-")));
    await fs.writeFile(
      path.join(binDir, "devcontainer"),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o755 }
    );
    await fs.mkdir(path.join(binDir, "workspace"));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  const run = (command: string, cwd: string) =>
    execBuffered(createRuntime({ currentWorkspacePath: binDir }), command, {
      cwd,
      pathEnv: { XUM_TEST_PATH: "relative" },
      timeout: 10,
    });

  it.skipIf(process.platform === "win32")(
    "a missing cwd fails the command instead of running later lines in the workspace folder",
    async () => {
      for (const command of MISSING_CWD_COMMANDS) {
        const result = await run(command, `${binDir}/missing`);
        expect({ command, failed: result.exitCode !== 0, stdout: result.stdout }).toEqual({
          command,
          failed: true,
          stdout: "",
        });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "later lines run in the cwd with the exported path env",
    async () => {
      const cwd = `${binDir}/workspace`;
      const result = await run('true\npwd\necho "path=$XUM_TEST_PATH"', cwd);
      expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
        exitCode: 0,
        stdout: `${cwd}\npath=${cwd}/relative\n`,
      });
    }
  );

  for (const c of MULTI_LINE_COMMAND_CASES) {
    it.skipIf(process.platform === "win32")(`keeps output and exit code: ${c.name}`, async () => {
      const result = await run(c.command, `${binDir}/workspace`);
      expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
        exitCode: c.exitCode,
        stdout: c.stdout,
      });
    });
  }
});

describe("DevcontainerRuntime.mapHostPathToContainer", () => {
  // Access the private method for testing
  function mapHostPathToContainer(runtime: DevcontainerRuntime, hostPath: string): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (runtime as any).mapHostPathToContainer(hostPath);
  }

  it("maps host workspace root to container workspace", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/home/user/mux/project/branch")).toBe(
      "/workspaces/project"
    );
  });

  it("maps host subpath to container subpath", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/home/user/mux/project/branch/src/file.ts")).toBe(
      "/workspaces/project/src/file.ts"
    );
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "C:\\Users\\dev\\mux\\project\\branch",
    });
    // Windows-style path with backslashes should map correctly
    expect(
      mapHostPathToContainer(runtime, "C:\\Users\\dev\\mux\\project\\branch\\src\\file.ts")
    ).toBe("/workspaces/project/src/file.ts");
  });

  it("returns null for paths outside workspace", () => {
    const runtime = createRuntime({
      remoteWorkspaceFolder: "/workspaces/project",
      currentWorkspacePath: "/home/user/mux/project/branch",
    });
    expect(mapHostPathToContainer(runtime, "/tmp/other")).toBeNull();
  });

  it("returns null when workspace not set", () => {
    const runtime = createRuntime({});
    expect(mapHostPathToContainer(runtime, "/some/path")).toBeNull();
  });
});

interface RuntimeWithContainerRequirements {
  computeContainerRequirements(workspacePath: string, runtimeEnv?: Record<string, string>): void;
  containerMounts: Array<{ source: string; target: string }>;
}

describe("DevcontainerRuntime.getContainerEnv", () => {
  const trackedEnvKeys = ["GIT_ASKPASS"] as const;
  const tempDirs: string[] = [];
  let originalValues = new Map<string, string | undefined>();

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    originalValues = new Map(trackedEnvKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(async () => {
    for (const key of trackedEnvKeys) {
      const value = originalValues.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("returns empty by default", () => {
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
    });

    expect(runtime.getContainerEnv()).toEqual({});
  });

  it("returns cached env after computeContainerRequirements", async () => {
    process.env.GIT_ASKPASS = "/usr/bin/coder";
    const workspacePath = await createTempDir("mux-devcontainer-env-");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
      shareCredentials: true,
    });
    const internal = runtime as unknown as RuntimeWithContainerRequirements;

    internal.computeContainerRequirements(workspacePath);

    expect(runtime.getContainerEnv()).toMatchObject({ GIT_ASKPASS: "/usr/bin/coder" });
  });

  it("with shareCredentials=false keeps env empty and only adds gitdir mount when present", async () => {
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
    });
    const internal = runtime as unknown as RuntimeWithContainerRequirements;

    const workspaceWithoutGit = await createTempDir("mux-devcontainer-no-git-");
    internal.computeContainerRequirements(workspaceWithoutGit);
    expect(runtime.getContainerEnv()).toEqual({});
    expect(internal.containerMounts).toEqual([]);

    const workspaceWithGitdir = await createTempDir("mux-devcontainer-worktree-");
    const projectPath = await createTempDir("mux-devcontainer-project-");
    const gitdirPath = path.join(projectPath, ".git", "worktrees", "feature");
    const dotGitDir = path.join(projectPath, ".git");

    await fs.mkdir(gitdirPath, { recursive: true });
    await fs.writeFile(path.join(workspaceWithGitdir, ".git"), `gitdir: ${gitdirPath}\n`, "utf-8");

    internal.computeContainerRequirements(workspaceWithGitdir);

    expect(runtime.getContainerEnv()).toEqual({});
    expect(internal.containerMounts).toEqual([{ source: dotGitDir, target: dotGitDir }]);
  });

  it("returns credential env after setCurrentWorkspacePath with shareCredentials=true", async () => {
    process.env.GIT_ASKPASS = "/usr/bin/coder";
    const workspacePath = await createTempDir("mux-devcontainer-setpath-");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
      shareCredentials: true,
    });

    runtime.setCurrentWorkspacePath(workspacePath);

    // Env should be populated without calling ensureReady()
    expect(runtime.getContainerEnv()).toMatchObject({ GIT_ASKPASS: "/usr/bin/coder" });
  });

  it("keeps env empty after setCurrentWorkspacePath with shareCredentials=false", async () => {
    process.env.GIT_ASKPASS = "/usr/bin/coder";
    const workspacePath = await createTempDir("mux-devcontainer-setpath-nocred-");
    const runtime = new DevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
      // shareCredentials defaults to false
    });

    runtime.setCurrentWorkspacePath(workspacePath);

    expect(runtime.getContainerEnv()).toEqual({});
  });
});

/**
 * Put a fake `docker` first on PATH. Its `ps` lists "stopped1" only with -a and "running2" always;
 * `rm` succeeds. Every call is appended to the returned log.
 */
async function installFakeDocker(root: string) {
  const binDir = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  await fs.mkdir(binDir);
  await fs.writeFile(
    path.join(binDir, "docker"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${dockerLog}'`,
      'if [ "$1" = ps ]; then',
      '  case " $* " in *" -a "*|*" -aq "*) echo stopped1 ;; esac',
      "  echo running2",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return {
    dockerLog,
    restorePath: () => {
      process.env.PATH = originalPath;
    },
  };
}

describe("DevcontainerRuntime.deleteWorkspace", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devcontainer-delete-"));
  });
  afterEach(async () => {
    mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  // #4819: undoing a creation that reused a branch removes the host worktree but not the branch.
  it("keeps the branch on a forced delete with keepBranch", async () => {
    spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({ kind: "absent" });
    const projectPath = path.join(root, "repo");
    await fs.mkdir(projectPath);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: projectPath, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "--allow-empty",
      "-m",
      "init"
    );
    const tip = git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "own work"
    );
    git("branch", "reused", tip);
    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(root, "src"),
      configPath: ".devcontainer/devcontainer.json",
    });
    const workspacePath = runtime.getWorkspacePath(projectPath, "reused");
    git("worktree", "add", workspacePath, "reused");

    const result = await runtime.deleteWorkspace(projectPath, "reused", true, undefined, true, {
      keepBranch: true,
    });

    expect(result.success).toBe(true);
    expect(git("rev-parse", "reused")).toBe(tip);
    expect(await fs.stat(workspacePath).catch(() => null)).toBeNull();
  });

  // #5120: a container that could not be removed is a failure the caller can name, not a success.
  it("reports a failed container teardown and names the container", async () => {
    spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({
      kind: "error",
      message: "Docker is not available: spawn docker ENOENT",
    });
    const projectPath = path.join(root, "repo");
    await fs.mkdir(projectPath);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: projectPath, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "--allow-empty",
      "-m",
      "i"
    );
    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(root, "src"),
      configPath: ".devcontainer/devcontainer.json",
    });
    const workspacePath = runtime.getWorkspacePath(projectPath, "ws");
    git("worktree", "add", "-b", "ws", workspacePath);

    const result = await runtime.deleteWorkspace(projectPath, "ws", true, undefined, true);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("spawn docker ENOENT") as unknown as string,
      leftoverPaths: [`devcontainer container labeled devcontainer.local_folder=${workspacePath}`],
    });
    // A forced delete (rollbacks, forced removal) still removes the host worktree, as before.
    expect(await fs.stat(workspacePath).catch(() => null)).toBeNull();

    // A non-forced delete keeps the worktree, and with it the branch mapping a retry needs.
    git("worktree", "add", "-b", "ws2", runtime.getWorkspacePath(projectPath, "ws2"));
    const kept = await runtime.deleteWorkspace(projectPath, "ws2", false, undefined, true);
    expect(kept.success).toBe(false);
    expect(await fs.stat(runtime.getWorkspacePath(projectPath, "ws2"))).toBeTruthy();
    expect(git("branch", "--list", "ws2")).not.toBe("");
  });

  // #5124: a stopped container (after a daemon restart or a manual `docker stop`) still holds the
  // workspace's files, including its plan, and a later workspace at this path would reuse it.
  it("removes a stopped container as well as a running one", async () => {
    const { dockerLog, restorePath } = await installFakeDocker(root);
    try {
      const projectPath = path.join(root, "repo");
      await fs.mkdir(projectPath);
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: projectPath, encoding: "utf8" }).trim();
      git("init", "-b", "main");
      git(
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=T",
        "commit",
        "--allow-empty",
        "-m",
        "i"
      );
      const runtime = new DevcontainerRuntime({
        srcBaseDir: path.join(root, "src"),
        configPath: ".devcontainer/devcontainer.json",
      });
      const workspacePath = runtime.getWorkspacePath(projectPath, "ws");
      git("worktree", "add", "-b", "ws", workspacePath);

      const result = await runtime.deleteWorkspace(projectPath, "ws", false, undefined, true);

      expect(result.success).toBe(true);
      const removed = (await fs.readFile(dockerLog, "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("rm "));
      expect(removed).toEqual(["rm -f stopped1 running2"]);

      // "Stop runtime" (the same helper without the delete option) still matches running
      // containers only: it is not a deletion, and a stopped container is already stopped.
      await fs.rm(dockerLog);
      expect(await devcontainerCli.stopDevcontainer(workspacePath)).toEqual({ kind: "stopped" });
      expect(
        (await fs.readFile(dockerLog, "utf8")).split("\n").filter((l) => l.startsWith("rm "))
      ).toEqual(["rm -f running2"]);
    } finally {
      restorePath();
    }
  });
});

describe("DevcontainerRuntime.renameWorkspace", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devcontainer-rename-"));
  });
  afterEach(async () => {
    mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  const setupWorktree = async () => {
    const projectPath = path.join(root, "repo");
    await fs.mkdir(projectPath);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: projectPath, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "--allow-empty",
      "-m",
      "i"
    );
    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(root, "src"),
      configPath: ".devcontainer/devcontainer.json",
    });
    const oldPath = runtime.getWorkspacePath(projectPath, "old");
    git("worktree", "add", "-b", "old", oldPath);
    return { projectPath, runtime, oldPath, git };
  };

  // #5137: the container is labeled with the old path. A stopped one would survive the rename
  // with the renamed workspace's files, and a later workspace at the old path would reuse it.
  it("removes a stopped container labeled with the old path", async () => {
    const { dockerLog, restorePath } = await installFakeDocker(root);
    try {
      const { projectPath, runtime } = await setupWorktree();

      const result = await runtime.renameWorkspace(projectPath, "old", "new", undefined, true);

      expect(result.success).toBe(true);
      expect(
        (await fs.readFile(dockerLog, "utf8")).split("\n").filter((l) => l.startsWith("rm "))
      ).toEqual(["rm -f stopped1 running2"]);
    } finally {
      restorePath();
    }
  });

  it("refuses the rename before moving the worktree when the container cannot be removed", async () => {
    spyOn(devcontainerCli, "devcontainerDown").mockResolvedValue({
      kind: "error",
      message: "Failed to remove container: daemon down",
    });
    const { projectPath, runtime, oldPath, git } = await setupWorktree();

    const result = await runtime.renameWorkspace(projectPath, "old", "new", undefined, true, {
      renameBranch: true,
    });

    expect(result.success).toBe(false);
    const error = result.success ? "" : result.error;
    expect(error).toContain("daemon down");
    expect(error).toContain(`devcontainer container labeled devcontainer.local_folder=${oldPath}`);
    expect(await fs.stat(oldPath)).toBeTruthy();
    expect(
      await fs.stat(runtime.getWorkspacePath(projectPath, "new")).catch(() => null)
    ).toBeNull();
    expect(git("branch", "--list", "old")).not.toBe("");
  });
});

describe("DevcontainerRuntime scratch mount", () => {
  let tempDir: string;
  const savedDockerHost = process.env.DOCKER_HOST;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devcontainer-scratch-"));
  });

  afterEach(async () => {
    mock.restore();
    if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = savedDockerHost;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function upMounts(dockerHost: string, scratchMountDir: string | undefined) {
    process.env.DOCKER_HOST = dockerHost;
    const workspacePath = path.join(tempDir, "ws");
    await fs.mkdir(workspacePath, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: workspacePath });
    const up = spyOn(devcontainerCli, "devcontainerUp").mockResolvedValue({
      containerId: "c1",
      remoteUser: "root",
      remoteWorkspaceFolder: "/workspaces/ws",
    });
    const runtime = new DevcontainerRuntime({
      srcBaseDir: tempDir,
      configPath: ".devcontainer/devcontainer.json",
      scratchMountDir,
    });
    // $HOME lookup after `up` is best-effort; keep it off the real CLI.
    spyOn(runtime, "exec").mockRejectedValue(new Error("no devcontainer CLI in tests"));
    runtime.setCurrentWorkspacePath(workspacePath);
    expect((await runtime.ensureReady()).ready).toBe(true);
    return up.mock.calls[0]?.[0].additionalMounts ?? [];
  }

  it("bind-mounts the host scratch dir at the same path for a local daemon", async () => {
    const scratch = path.join(tempDir, "sessions", "ws1", "scratch");

    const mounts = await upMounts("unix:///var/run/docker.sock", scratch);

    expect(mounts).toContainEqual({ source: scratch, target: scratch });
    // Docker refuses a missing bind source: the dir exists before `up`.
    expect((await fs.stat(scratch)).isDirectory()).toBe(true);
  });

  it("starts without the scratch mount when the daemon refuses its source path", async () => {
    // Docker Desktop or Colima with restricted file sharing: the socket is local, but the VM
    // cannot see XUM_ROOT. Scratch is optional, so it must not fail the whole `up`.
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    const scratch = path.join(tempDir, "sessions", "ws1", "scratch");
    const workspacePath = path.join(tempDir, "ws");
    await fs.mkdir(workspacePath, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: workspacePath });
    const runtime = new DevcontainerRuntime({
      srcBaseDir: tempDir,
      configPath: ".devcontainer/devcontainer.json",
      scratchMountDir: scratch,
    });
    spyOn(runtime, "exec").mockRejectedValue(new Error("no devcontainer CLI in tests"));
    runtime.setCurrentWorkspacePath(workspacePath);

    const up = spyOn(devcontainerCli, "devcontainerUp")
      .mockRejectedValueOnce(
        new Error(
          `devcontainer up failed: docker: Error response from daemon: Mounts denied: The path ${scratch} is not shared from the host and is not known to Docker.`
        )
      )
      .mockResolvedValue({
        containerId: "c1",
        remoteUser: "root",
        remoteWorkspaceFolder: "/workspaces/ws",
      });
    expect((await runtime.ensureReady()).ready).toBe(true);
    expect(up).toHaveBeenCalledTimes(2);
    expect(up.mock.calls[0]?.[0].additionalMounts).toContainEqual({
      source: scratch,
      target: scratch,
    });
    expect(up.mock.calls[1]?.[0].additionalMounts ?? []).not.toContainEqual({
      source: scratch,
      target: scratch,
    });

    // A failure unrelated to the scratch mount (a build error) is not retried.
    up.mockReset();
    up.mockRejectedValue(new Error("devcontainer up failed: docker build exited with 1"));
    expect((await runtime.ensureReady()).ready).toBe(false);
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("adds no mount for a daemon that cannot see host paths, or without a workspace id", async () => {
    const scratch = path.join(tempDir, "sessions", "ws1", "scratch");

    expect(await upMounts("tcp://build-box:2376", scratch)).not.toContainEqual({
      source: scratch,
      target: scratch,
    });
    mock.restore();
    expect(
      (await upMounts("unix:///var/run/docker.sock", undefined)).some((m) =>
        m.target.includes("scratch")
      )
    ).toBe(false);
  });
});
