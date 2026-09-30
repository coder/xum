import { spawn } from "node:child_process";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";

/**
 * Minimal concrete RemoteRuntime for tests: identity path resolution, throwing
 * spawn, and stubbed lifecycle. Subclasses override only what they exercise.
 */
export class TestRemoteRuntime extends RemoteRuntime {
  protected readonly commandPrefix: string = "TestRemote";

  protected getBasePath(): string {
    return "/workspace";
  }

  protected quoteForRemote(filePath: string): string {
    return `'${filePath.replaceAll("'", "'\\''")}'`;
  }

  protected cdCommand(cwd: string): string {
    return `cd ${this.quoteForRemote(cwd)}`;
  }

  protected spawnRemoteProcess(): Promise<SpawnResult> {
    throw new Error("spawn should not be called");
  }

  resolvePath(filePath: string): Promise<string> {
    return Promise.resolve(filePath);
  }

  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    return "/workspace";
  }

  createWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  initWorkspace() {
    return Promise.resolve({ success: true });
  }

  deleteWorkspace() {
    return Promise.resolve({ success: true as const, deletedPath: "/workspace" });
  }

  renameWorkspace() {
    return Promise.resolve({
      success: true as const,
      oldPath: "/workspace",
      newPath: "/workspace",
    });
  }

  forkWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  ensureReady() {
    return Promise.resolve({ ready: true as const });
  }
}

/**
 * Runs the real RemoteRuntime.exec command string (`timeout -s KILL ... bash -c 'cd <cwd> &&
 * export ... || exit; <command>'`) in a local shell. Its working directory stands in for the SSH login
 * directory, where lines outside the cd && export chain would run.
 */
export class ShellRemoteRuntime extends TestRemoteRuntime {
  private readonly loginDir: string;

  constructor(loginDir: string) {
    super();
    this.loginDir = loginDir;
  }

  // TestRemoteRuntime declares this without parameters; RemoteRuntime.exec passes the full
  // command first.
  protected override spawnRemoteProcess(...args: unknown[]): Promise<SpawnResult> {
    const [fullCommand] = args;
    if (typeof fullCommand !== "string") throw new Error("Expected the full remote command");
    return Promise.resolve({
      process: spawn("/bin/sh", ["-c", fullCommand], {
        cwd: this.loginDir,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });
  }
}

/**
 * Multi-line commands whose output and exit code must not change when a runtime wraps the
 * caller's command before running it (#5192). Each runs in an existing cwd.
 */
export const MULTI_LINE_COMMAND_CASES: ReadonlyArray<{
  name: string;
  command: string;
  stdout: string;
  exitCode: number;
}> = [
  {
    name: "heredoc on the last line",
    command: "cat <<'EOF'\nhello\nEOF",
    stdout: "hello\n",
    exitCode: 0,
  },
  {
    name: "heredoc followed by more lines",
    command: "X=world\ncat <<EOF\nhello $X\nEOF\necho done",
    stdout: "hello world\ndone\n",
    exitCode: 0,
  },
  {
    name: "trailing comment",
    command: "echo a\necho b # trailing comment",
    stdout: "a\nb\n",
    exitCode: 0,
  },
  { name: "comment-only last line", command: "echo a\n# done", stdout: "a\n", exitCode: 0 },
  { name: "trailing newline", command: "echo a\necho b\n", stdout: "a\nb\n", exitCode: 0 },
  {
    name: "exit in the middle",
    command: "echo before\nexit 3\necho after",
    stdout: "before\n",
    exitCode: 3,
  },
  { name: "failing last line", command: "echo x\nfalse", stdout: "x\n", exitCode: 1 },
  { name: "trailing backslash", command: "echo a\necho b \\", stdout: "a\nb \\\n", exitCode: 0 },
];

/**
 * Commands that must fail and print nothing when the cwd is missing (#5192). The second has a
 * stray `}`, which would close a `{ … }` group around the command early.
 */
export const MISSING_CWD_COMMANDS: readonly string[] = [
  'echo line1\npwd\necho "var=$XUM_TEST_VAR"',
  "echo line1\n}\npwd\n{ true",
];
