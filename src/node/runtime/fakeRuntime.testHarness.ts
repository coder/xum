/**
 * A Runtime on a memfs volume, for tests that must not touch the host (phase 5, claim 4.4).
 *
 * - `location` is absent, so tools take their host branch. That branch reads HostFiles, so a
 *   test builds this runtime and the memory HostFiles on one volume (createMemoryHost).
 * - readFile and stat of a missing path fail with a RuntimeError "file_io" whose cause has the
 *   fs code (isRuntimePathAbsentError), as LocalRuntime does.
 * - exec answers from a script table (scriptedCommands.testHarness.ts), with the command string
 *   as the line. One entry is built in: the stream temp-dir cleanup of streamManager.ts.
 *   createTempDirForStream makes `~/.xum-tmp/<token>`, and cleanupStreamTempDir runs
 *   `rm -rf '<token>'` with that folder's parent as cwd. So `rm -rf '<name>'` with the cwd
 *   `<userHome>/.xum-tmp` deletes that entry and exits 0. Any other command without an entry
 *   rejects with a RuntimeError "exec" that names it. An exec whose signal is already aborted
 *   rejects before it runs anything, as LocalRuntime does.
 * - idle() resolves when every exec has settled, so a test can drain fire-and-forget execs.
 * - The workspace lifecycle methods reject: loop tests do not create workspaces.
 */
import * as path from "node:path";
import type { MemFs } from "@/node/services/sessionFiles/memorySessionFiles.testHarness";
import {
  lookupScriptedCommand,
  type ScriptTable,
  type ScriptedOutcome,
} from "@/node/services/hostProcesses/scriptedCommands.testHarness";
import {
  RuntimeError,
  type EnsureReadyResult,
  type ExecOptions,
  type ExecStream,
  type FileStat,
  type Runtime,
  type WorkspaceCreationResult,
  type WorkspaceForkResult,
  type WorkspaceInitResult,
} from "./Runtime";

export interface FakeRuntimeOptions {
  /** The folder that `~` expands to. */
  userHome: string;
  /** What getXumHome() returns. */
  xumHome: string;
  /** What tempDir() returns. It must exist in the volume. */
  tempDir: string;
  commands?: ScriptTable;
}

const encoder = new TextEncoder();

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function fileError(action: string, target: string, error: unknown): RuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeError(`Failed to ${action} ${target}: ${message}`, "file_io", error);
}

function lifecycleRefusal(method: string): Promise<never> {
  return Promise.reject(new RuntimeError(`FakeRuntime has no ${method}`, "unknown"));
}

/** Matches the cleanup command of streamManager.ts: rm -rf of one shell-quoted name. */
const RM_RF_ONE_NAME = /^rm -rf '([^'/]+)'$/;
/** The folder under the home that createTempDirForStream (streamManager.ts) uses. */
const STREAM_TEMP_ROOT = ".xum-tmp";

export class FakeRuntime implements Runtime {
  /** Every exec command line, in order, answered or not. */
  readonly execs: string[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly fs: MemFs,
    private readonly options: FakeRuntimeOptions
  ) {}

  private expand(target: string): string {
    return target.replace(/^~(?=\/|$)/, this.options.userHome);
  }

  private async outcomeOf(command: string, cwd: string): Promise<ScriptedOutcome> {
    const removal = RM_RF_ONE_NAME.exec(command);
    if (removal && cwd === path.posix.join(this.options.userHome, STREAM_TEMP_ROOT)) {
      await this.fs.promises.rm(path.posix.join(cwd, removal[1]), { recursive: true, force: true });
      return { exitCode: 0 };
    }
    const outcome = await lookupScriptedCommand(this.options.commands ?? {}, {
      file: command,
      args: [],
      cwd,
    });
    if (outcome === undefined) {
      throw new RuntimeError(`FakeRuntime has no scripted command: ${command}`, "exec");
    }
    return outcome;
  }

  exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.execs.push(command);
    if (options.abortSignal?.aborted) {
      return Promise.reject(new RuntimeError("Operation aborted before execution", "exec"));
    }
    const started = this.outcomeOf(command, options.cwd).then((outcome) => ({
      stdout: streamOf(outcome.stdout ?? ""),
      stderr: streamOf(outcome.stderr ?? ""),
      stdin: new WritableStream<Uint8Array>(),
      exitCode: Promise.resolve(outcome.exitCode ?? 0),
      duration: Promise.resolve(0),
    }));
    const settled = started.then(
      () => undefined,
      () => undefined
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return started;
  }

  /** Resolves once every exec started so far has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  readFile(filePath: string): ReadableStream<Uint8Array> {
    const target = path.posix.resolve(this.expand(filePath));
    const files = this.fs.promises;
    return new ReadableStream({
      async start(controller) {
        try {
          const bytes = (await files.readFile(target)) as Buffer;
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        } catch (error) {
          controller.error(fileError("read file", filePath, error));
        }
      },
    });
  }

  writeFile(filePath: string): WritableStream<Uint8Array> {
    const target = path.posix.resolve(this.expand(filePath));
    const files = this.fs.promises;
    const chunks: Uint8Array[] = [];
    return new WritableStream({
      write(chunk) {
        // A copy: the writer may reuse its buffer once the write resolves.
        chunks.push(chunk.slice());
      },
      async close() {
        try {
          // As LocalRuntime: the parent folders are created.
          await files.mkdir(path.posix.dirname(target), { recursive: true });
          await files.writeFile(target, Buffer.concat(chunks));
        } catch (error) {
          throw fileError("write file", filePath, error);
        }
      },
    });
  }

  async stat(filePath: string): Promise<FileStat> {
    const target = path.posix.resolve(this.expand(filePath));
    try {
      const stats = await this.fs.promises.stat(target);
      return {
        size: Number(stats.size),
        modifiedTime: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      throw fileError("stat", filePath, error);
    }
  }

  async ensureDir(dirPath: string): Promise<void> {
    try {
      await this.fs.promises.mkdir(path.posix.resolve(this.expand(dirPath)), { recursive: true });
    } catch (error) {
      throw fileError("create directory", dirPath, error);
    }
  }

  resolvePath(filePath: string): Promise<string> {
    return Promise.resolve(path.posix.resolve(this.expand(filePath)));
  }

  normalizePath(targetPath: string, basePath: string): string {
    return path.posix.resolve(basePath, this.expand(targetPath.trim()));
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    return path.posix.join(projectPath, workspaceName);
  }

  tempDir(): Promise<string> {
    return Promise.resolve(this.options.tempDir);
  }

  getXumHome(): string {
    return this.options.xumHome;
  }

  ensureReady(): Promise<EnsureReadyResult> {
    return Promise.resolve({ ready: true });
  }

  createWorkspace(): Promise<WorkspaceCreationResult> {
    return lifecycleRefusal("createWorkspace");
  }

  initWorkspace(): Promise<WorkspaceInitResult> {
    return lifecycleRefusal("initWorkspace");
  }

  renameWorkspace(): Promise<never> {
    return lifecycleRefusal("renameWorkspace");
  }

  deleteWorkspace(): Promise<never> {
    return lifecycleRefusal("deleteWorkspace");
  }

  forkWorkspace(): Promise<WorkspaceForkResult> {
    return lifecycleRefusal("forkWorkspace");
  }
}
