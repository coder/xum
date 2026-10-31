/**
 * A Runtime on a memfs volume, for tests that must not touch the host (phase 5, claim 4.4).
 *
 * - `location` is absent unless the options set it, so tools take their host branch. That branch
 *   reads HostFiles, so a test builds this runtime and the memory HostFiles on one volume
 *   (createMemoryHost). A test of code that branches on the runtime family sets it.
 * - readFile and stat of a missing path fail with a RuntimeError "file_io" whose cause has the
 *   fs code (isRuntimePathAbsentError), as LocalRuntime does.
 * - exec answers from a script table (scriptedCommands.testHarness.ts), with the command string
 *   as the line. One entry is built in: the stream temp-dir cleanup of streamManager.ts.
 *   createTempDirForStream makes `~/.xum-tmp/<token>`, and cleanupStreamTempDir runs
 *   `rm -rf '<token>'` with that folder's parent as cwd. So `rm -rf '<name>'` with the cwd
 *   `<userHome>/.xum-tmp` deletes that entry and exits 0 (not for the names . and ..). Any other command without an entry
 *   rejects with a RuntimeError "exec" that names it. An exec whose signal is already aborted
 *   rejects before it runs anything, as LocalRuntime does.
 *   An option that the entry cannot honor is refused by name (refuseSetOptions): pathEnv and
 *   forcePTY always, and timeout, env, hostEnv and abortSignal for a function entry.
 * - `execCalls` records each exec's options and the text written to its stdin.
 * - readFile and ensureDir honor an aborted signal as LocalBaseRuntime does.
 * - idle() resolves when every exec has settled, so a test can drain fire-and-forget execs.
 * - The workspace lifecycle methods reject: loop tests do not create workspaces.
 */
import * as path from "node:path";
import type { MemFs } from "@/node/services/sessionFiles/memorySessionFiles.testHarness";
import {
  lookupScriptedCommand,
  refuseSetOptions,
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
  type RuntimeLocation,
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
  /** Runtime.location; absent by default. */
  location?: RuntimeLocation;
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

/** One exec as the caller made it: its options and everything it wrote to stdin so far. */
export interface FakeExecCall {
  command: string;
  options: ExecOptions;
  stdin: string;
}

export class FakeRuntime implements Runtime {
  /** Every exec command line, in order, answered or not. */
  readonly execs: string[] = [];
  /** Every exec, in order, with its options and stdin. */
  readonly execCalls: FakeExecCall[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly fs: MemFs,
    private readonly options: FakeRuntimeOptions
  ) {}

  get location(): RuntimeLocation | undefined {
    return this.options.location;
  }

  private expand(target: string): string {
    return target.replace(/^~(?=\/|$)/, this.options.userHome);
  }

  // The option rules of refuseSetOptions: the built-in rule and a fixed outcome settle at once
  // and read no environment, so timeout, env and hostEnv hold for them. A function entry refuses
  // them, and abortSignal too.
  private async outcomeOf(command: string, options: ExecOptions): Promise<ScriptedOutcome> {
    const { cwd } = options;
    refuseSetOptions(command, options, ["pathEnv", "forcePTY"]);
    const removal = RM_RF_ONE_NAME.exec(command);
    // "." and ".." name the folder itself and its parent, never one stream folder.
    if (
      removal &&
      removal[1] !== "." &&
      removal[1] !== ".." &&
      cwd === path.posix.join(this.options.userHome, STREAM_TEMP_ROOT)
    ) {
      await this.fs.promises.rm(path.posix.join(cwd, removal[1]), { recursive: true, force: true });
      return { exitCode: 0 };
    }
    const outcome = await lookupScriptedCommand(
      this.options.commands ?? {},
      command,
      { file: command, args: [], cwd },
      options,
      // The fake checks abortSignal only before the start, which a slow entry outlives.
      ["timeout", "env", "hostEnv", "abortSignal"]
    );
    if (outcome === undefined) {
      throw new RuntimeError(`FakeRuntime has no scripted command: ${command}`, "exec");
    }
    return outcome;
  }

  exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.execs.push(command);
    const call: FakeExecCall = { command, options, stdin: "" };
    this.execCalls.push(call);
    if (options.abortSignal?.aborted) {
      return Promise.reject(new RuntimeError("Operation aborted before execution", "exec"));
    }
    const decoder = new TextDecoder();
    const started = this.outcomeOf(command, options).then((outcome) => ({
      stdout: streamOf(outcome.stdout ?? ""),
      stderr: streamOf(outcome.stderr ?? ""),
      stdin: new WritableStream<Uint8Array>({
        write(chunk) {
          call.stdin += decoder.decode(chunk, { stream: true });
        },
      }),
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

  // As LocalBaseRuntime.readFile: an abort before the consumer reads the end errors the stream.
  readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    const target = path.posix.resolve(this.expand(filePath));
    const files = this.fs.promises;
    const aborted = () => new RuntimeError(`Read of ${filePath} aborted`, "file_io");
    let bytes: Uint8Array | undefined;
    return new ReadableStream<Uint8Array>(
      {
        async start(controller) {
          if (abortSignal?.aborted) {
            controller.error(aborted());
            return;
          }
          try {
            bytes = new Uint8Array((await files.readFile(target)) as Buffer);
          } catch (error) {
            // As LocalBaseRuntime: an abort during the read wins over its failure.
            controller.error(
              abortSignal?.aborted ? aborted() : fileError("read file", filePath, error)
            );
          }
        },
        // Each read of the consumer checks the signal first, as LocalBaseRuntime's pull does
        // after each chunk: the bytes, then the end.
        pull(controller) {
          if (abortSignal?.aborted) {
            controller.error(aborted());
            return;
          }
          if (bytes === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(bytes);
          bytes = undefined;
        },
      },
      // No read ahead: a pull runs only for a read of the consumer, so the end waits for it.
      { highWaterMark: 0 }
    );
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

  // As LocalBaseRuntime.ensureDir: an aborted signal rejects before the folder is made.
  // writeFile and stat take no signal here, because LocalBaseRuntime ignores theirs.
  async ensureDir(dirPath: string, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before directory creation", "file_io");
    }
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
