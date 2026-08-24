/**
 * Abstract base class for remote execution runtimes (SSH, Docker).
 *
 * Provides shared implementation for:
 * - exec() with streaming I/O, timeout/abort handling
 * - readFile(), writeFile(), stat() via exec
 * - normalizePath() for POSIX paths
 * - tempDir() returning /tmp
 *
 * Subclasses implement:
 * - spawnRemoteProcess() - how to spawn the external process (ssh/docker)
 * - getBasePath() - base directory for workspace operations
 * - quoteForRemote() - path quoting strategy
 */

import type { ChildProcess } from "child_process";
import { Readable } from "stream";
import type {
  Runtime,
  ExecOptions,
  ExecStream,
  FileStat,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  EnsureReadyResult,
} from "./Runtime";
import { RuntimeError } from "./Runtime";
import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { log } from "@/node/services/log";
import { attachStreamErrorHandler } from "@/node/utils/streamErrors";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { DisposableProcess } from "@/node/utils/disposableExec";
import { streamToString, shescape } from "./streamUtils";
import { getErrorMessage } from "@/common/utils/errors";
import { getAtomicWriteTempPath } from "./atomicWriteTempPath";
import { buildShellExport } from "./shellEnv";

// Cap for the stderr side-buffer kept purely for error reporting on process
// failure. 16KB comfortably covers SSH/launch diagnostics while bounding memory
// on stderr-flooding commands.
const STDERR_ERROR_REPORTING_CAP_BYTES = 16 * 1024;

/**
 * Result from spawning a remote process.
 */
export interface SpawnResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Optional transport-scoped exit handling (e.g., master-pool health accounting). */
  onExit?: (exitCode: number, stderr: string) => void;
  /** Optional close handling that must run even for synthetic abort/timeout exits. */
  onClose?: () => void;
  /** Optional transport-scoped spawn error handling. */
  onError?: (error: Error) => void;
}

/**
 * Abstract base class for remote execution runtimes.
 */
export abstract class RemoteRuntime implements Runtime {
  /**
   * Spawn the external process for command execution.
   * SSH spawns `ssh`, Docker spawns `docker exec`.
   *
   * @param fullCommand The full shell command to execute (already wrapped in bash -c)
   * @param options Original exec options
   * @returns The spawned process and optional transport lifecycle hooks
   */
  protected abstract spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult>;

  /**
   * Get the base path for file operations (used as cwd for file commands).
   * SSH returns srcBaseDir, Docker returns /src.
   */
  protected abstract getBasePath(): string;

  /**
   * Quote a path for use in remote shell commands.
   * SSH uses expandTildeForSSH (handles ~ expansion), Docker uses shescape.quote.
   */
  protected abstract quoteForRemote(path: string): string;

  /**
   * Build the cd command for the given cwd.
   * SSH needs special handling for ~, Docker uses simple quoting.
   */
  protected abstract cdCommand(cwd: string): string;

  /**
   * Command prefix (e.g., "SSH" or "Docker") for logging.
   */
  protected abstract readonly commandPrefix: string;

  /**
   * Execute command with streaming I/O.
   * Shared implementation that delegates process spawning to subclass.
   */
  async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Short-circuit if already aborted
    if (options.abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before execution", "exec");
    }

    // Build command parts
    const parts: string[] = [];

    // Add cd command
    parts.push(this.cdCommand(options.cwd));

    // Add environment variable exports (user env first, then non-interactive overrides)
    const envVars = { ...options.env, ...NON_INTERACTIVE_ENV_VARS };
    for (const [key, value] of Object.entries(envVars)) {
      parts.push(buildShellExport(key, value, (envValue) => shescape.quote(envValue)));
    }

    // Add the actual command
    parts.push(command);

    // Join all parts with && to ensure each step succeeds before continuing
    let fullCommand = parts.join(" && ");

    // Wrap in bash for consistent shell behavior
    fullCommand = `bash -c ${shescape.quote(fullCommand)}`;

    // Optionally wrap with timeout
    if (options.timeout !== undefined) {
      const remoteTimeout = Math.ceil(options.timeout) + 1;
      fullCommand = `timeout -s KILL ${remoteTimeout} ${fullCommand}`;
    }

    // Spawn the remote process (SSH or Docker)
    const timeoutMs = options.timeout !== undefined ? options.timeout * 1000 : undefined;
    const deadlineMs = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    const spawnResult = await this.spawnRemoteProcess(fullCommand, {
      ...options,
      deadlineMs,
    });
    const { process: childProcess } = spawnResult;

    // Short-lived commands can close stdin before writes/close complete.
    if (childProcess.stdin) {
      attachStreamErrorHandler(childProcess.stdin, `${this.commandPrefix} stdin`, {
        logger: log,
      });
    }

    // Wrap in DisposableProcess for cleanup
    const disposable = new DisposableProcess(childProcess);

    // Track if we killed the process due to timeout or abort
    let timedOut = false;
    let aborted = false;

    // Declared here so it's captured by the exitCode promise closure,
    // but the data listener is added AFTER Readable.toWeb() to avoid
    // putting the stream in flowing mode prematurely.
    let stderrForErrorReporting = "";

    // Create promises for exit code and duration immediately.
    const exitCode = new Promise<number>((resolve, reject) => {
      childProcess.on("close", (code, signal) => {
        const finalExitCode =
          aborted || options.abortSignal?.aborted
            ? EXIT_CODE_ABORTED
            : timedOut
              ? EXIT_CODE_TIMEOUT
              : (code ?? (signal ? -1 : 0));

        if (finalExitCode !== EXIT_CODE_ABORTED && finalExitCode !== EXIT_CODE_TIMEOUT) {
          spawnResult.onExit?.(finalExitCode, stderrForErrorReporting);
        }
        spawnResult.onClose?.();

        resolve(finalExitCode);
      });

      childProcess.on("error", (err) => {
        spawnResult.onError?.(err);
        reject(
          new RuntimeError(
            `Failed to execute ${this.commandPrefix} command: ${err.message}`,
            "exec",
            err
          )
        );
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);

    // Handle abort signal
    if (options.abortSignal) {
      const abortSignal = options.abortSignal;
      const onAbort = () => {
        aborted = true;

        // For SSH/Docker, killing the local client too aggressively (SIGKILL) can leave the
        // remote command running. Prefer SIGTERM first so the runtime can tear down cleanly,
        // then hard-kill if it doesn't exit promptly.
        //
        // Note: SSH2's ChildProcess shim only sends a remote signal when an explicit signal
        // string is provided, so always pass SIGTERM.
        try {
          childProcess.kill("SIGTERM");
        } catch {
          // ignore
        }

        const hardKillHandle = setTimeout(() => {
          const hasExited = childProcess.exitCode !== null || childProcess.signalCode !== null;
          if (hasExited) {
            return;
          }
          disposable[Symbol.dispose]();
        }, 1000);
        hardKillHandle.unref();
      };

      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
      }

      // Avoid retaining closures on long-lived abort signals once the process exits.
      void exitCode
        .catch(() => undefined)
        .finally(() => abortSignal.removeEventListener("abort", onAbort));
    }

    // Handle timeout. Include connection acquisition time in the local deadline so
    // user-configured timeouts do not silently stretch while the runtime waits for SSH capacity.
    if (timeoutMs !== undefined) {
      const remainingTimeoutMs = Math.max(0, (deadlineMs ?? Date.now()) - Date.now());
      const timeoutHandle = setTimeout(() => {
        timedOut = true;

        try {
          childProcess.kill("SIGTERM");
        } catch {
          // ignore
        }

        const hardKillHandle = setTimeout(() => {
          const hasExited = childProcess.exitCode !== null || childProcess.signalCode !== null;
          if (hasExited) {
            return;
          }
          disposable[Symbol.dispose]();
        }, 1000);
        hardKillHandle.unref();
      }, remainingTimeoutMs);

      void exitCode.catch(() => undefined).finally(() => clearTimeout(timeoutHandle));
    }

    // Convert Node.js streams to Web Streams
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stdout = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const stderr = Readable.toWeb(childProcess.stderr!) as unknown as ReadableStream<Uint8Array>;

    // Capture stderr for error reporting (e.g., SSH exit code 255 failures).
    // Must be AFTER Readable.toWeb() to avoid putting the stream in flowing mode prematurely.
    // Bounded: this side-buffer exists only for error diagnostics, and connection/launch
    // failures surface at the start of stderr. Without a cap, a command that floods stderr
    // (e.g. `yes >&2`) would grow this string without bound even when the caller reads the
    // stderr stream through a capped reader (execBuffered maxOutputBytes).
    childProcess.stderr?.on("data", (data: Buffer) => {
      if (stderrForErrorReporting.length < STDERR_ERROR_REPORTING_CAP_BYTES) {
        stderrForErrorReporting += data.toString(
          "utf-8",
          0,
          STDERR_ERROR_REPORTING_CAP_BYTES - stderrForErrorReporting.length
        );
      }
    });

    // Writable.toWeb(childProcess.stdin) is surprisingly easy to get into an invalid state
    // for short-lived remote commands (notably via SSH) where stdin may already be closed
    // by the time callers attempt `await stream.stdin.close()`.
    //
    // Wrap stdin ourselves so close() is idempotent.
    const stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const nodeStdin = childProcess.stdin;
        if (!nodeStdin || nodeStdin.destroyed) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            nodeStdin.off("error", onError);
            reject(err);
          };
          nodeStdin.on("error", onError);

          nodeStdin.write(Buffer.from(chunk), (err) => {
            nodeStdin.off("error", onError);
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      },
      close: async () => {
        const nodeStdin = childProcess.stdin;
        if (!nodeStdin || nodeStdin.destroyed || nodeStdin.writableEnded) {
          return;
        }

        await new Promise<void>((resolve) => {
          const onError = () => {
            cleanup();
            resolve();
          };

          const onFinish = () => {
            cleanup();
            resolve();
          };

          const cleanup = () => {
            nodeStdin.removeListener("error", onError);
            nodeStdin.removeListener("finish", onFinish);
          };

          nodeStdin.once("error", onError);
          nodeStdin.once("finish", onFinish);

          try {
            nodeStdin.end();
          } catch {
            onError();
          }
        });
      },
      abort: () => {
        childProcess.stdin?.destroy();
      },
    });

    log.debug(`${this.commandPrefix} command: ${fullCommand}`);

    return { stdout, stderr, stdin, exitCode, duration };
  }

  /**
   * Read file contents as a stream via exec.
   */
  readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    // Internal controller so CANCELLING the returned stream kills the remote
    // cat: the eager pump below has no other path to the exec, and without
    // it a cancelled wrapper (e.g. mux.load's byte ceiling) left cat blocked
    // until its 300s timeout, accumulating remote processes (r18). The
    // caller's abortSignal forwards into the same controller.
    const readAbort = new AbortController();
    const forwardAbort = () => readAbort.abort();
    if (abortSignal?.aborted) {
      readAbort.abort();
    } else {
      abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    }
    const cleanupAbortForwarder = () => {
      abortSignal?.removeEventListener("abort", forwardAbort);
    };

    return new ReadableStream<Uint8Array>({
      cancel: () => {
        readAbort.abort();
        cleanupAbortForwarder();
      },
      start: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        try {
          const stream = await this.exec(`cat ${this.quoteForRemote(filePath)}`, {
            cwd: this.getBasePath(),
            timeout: 300,
            abortSignal: readAbort.signal,
          });

          const reader = stream.stdout.getReader();
          const exitCodePromise = stream.exitCode;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }

          const code = await exitCodePromise;
          if (code !== 0) {
            const stderr = await streamToString(stream.stderr);
            throw new RuntimeError(`Failed to read file ${filePath}: ${stderr}`, "file_io");
          }

          controller.close();
        } catch (err) {
          if (err instanceof RuntimeError) {
            controller.error(err);
          } else {
            controller.error(
              new RuntimeError(
                `Failed to read file ${filePath}: ${getErrorMessage(err)}`,
                "file_io",
                err instanceof Error ? err : undefined
              )
            );
          }
        } finally {
          // Natural completion/error: stop listening on the caller's signal
          // so long-lived signals don't accumulate forwarders.
          cleanupAbortForwarder();
        }
      },
    });
  }

  /**
   * Write file contents atomically via exec.
   * Uses temp file + mv for atomic write.
   */
  writeFile(filePath: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    const quotedPath = this.quoteForRemote(filePath);
    const tempPath = getAtomicWriteTempPath(filePath);
    const quotedTempPath = this.quoteForRemote(tempPath);

    // Build write command - subclasses can override buildWriteCommand for special handling
    const writeCommand = this.buildWriteCommand(quotedPath, quotedTempPath);

    let execPromise: Promise<ExecStream> | null = null;
    const writeAbortController = new AbortController();
    const abortWrite = () => writeAbortController.abort();
    if (abortSignal?.aborted) {
      writeAbortController.abort();
    } else {
      abortSignal?.addEventListener("abort", abortWrite, { once: true });
    }
    const cleanupAbortForwarder = () => {
      abortSignal?.removeEventListener("abort", abortWrite);
    };

    const getExecStream = () => {
      execPromise ??= this.exec(writeCommand, {
        cwd: this.getBasePath(),
        timeout: 300,
        abortSignal: writeAbortController.signal,
      });
      return execPromise;
    };

    return new WritableStream<Uint8Array>({
      write: async (chunk: Uint8Array) => {
        const stream = await getExecStream();
        const writer = stream.stdin.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
      close: async () => {
        try {
          const stream = await getExecStream();
          await stream.stdin.close();
          const exitCode = await stream.exitCode;

          if (exitCode !== 0) {
            const stderr = await streamToString(stream.stderr);
            throw new RuntimeError(`Failed to write file ${filePath}: ${stderr}`, "file_io");
          }
        } finally {
          cleanupAbortForwarder();
        }
      },
      abort: async (reason?: unknown) => {
        writeAbortController.abort();
        if (execPromise) {
          try {
            const stream = await execPromise;
            await stream.stdin.abort(reason).catch(() => undefined);
            await stream.exitCode.catch(() => undefined);
          } finally {
            cleanupAbortForwarder();
          }
        } else {
          cleanupAbortForwarder();
        }
        throw new RuntimeError(`Failed to write file ${filePath}: ${String(reason)}`, "file_io");
      },
    });
  }

  /**
   * Build the write command for atomic file writes.
   * Can be overridden by subclasses for special handling (e.g., SSH symlink preservation).
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    return `mkdir -p $(dirname ${quotedPath}) && cat > ${quotedTempPath} && mv ${quotedTempPath} ${quotedPath}`;
  }

  /**
   * Ensure a directory exists (mkdir -p semantics).
   */
  async ensureDir(dirPath: string, abortSignal?: AbortSignal): Promise<void> {
    const stream = await this.exec(`mkdir -p ${this.quoteForRemote(dirPath)}`, {
      cwd: "/",
      timeout: 10,
      abortSignal,
    });

    await stream.stdin.close();

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(stream.stdout),
      streamToString(stream.stderr),
      stream.exitCode,
    ]);

    if (exitCode !== 0) {
      const extra = stderr.trim() || stdout.trim();
      throw new RuntimeError(
        `Failed to create directory ${dirPath}: exit code ${exitCode}${extra ? `: ${extra}` : ""}`,
        "file_io"
      );
    }
  }

  /**
   * Get file statistics via exec.
   * Uses stat -L to follow symlinks (report target's type, not "symbolic link").
   */
  async stat(filePath: string, abortSignal?: AbortSignal): Promise<FileStat> {
    const stream = await this.exec(`stat -L -c '%s %Y %F' ${this.quoteForRemote(filePath)}`, {
      cwd: this.getBasePath(),
      timeout: 10,
      abortSignal,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(stream.stdout),
      streamToString(stream.stderr),
      stream.exitCode,
    ]);

    if (exitCode !== 0) {
      throw new RuntimeError(`Failed to stat ${filePath}: ${stderr}`, "file_io");
    }

    const parts = stdout.trim().split(" ");
    if (parts.length < 3) {
      throw new RuntimeError(`Failed to parse stat output for ${filePath}: ${stdout}`, "file_io");
    }

    const size = parseInt(parts[0], 10);
    const mtime = parseInt(parts[1], 10);
    const fileType = parts.slice(2).join(" ");

    return {
      size,
      modifiedTime: new Date(mtime * 1000),
      isDirectory: fileType === "directory",
    };
  }

  /**
   * Normalize path for comparison (POSIX semantics).
   * Shared between SSH and Docker.
   */
  normalizePath(targetPath: string, basePath: string): string {
    const target = targetPath.trim();
    let base = basePath.trim();

    // Normalize base path - remove trailing slash (except for root "/")
    if (base.length > 1 && base.endsWith("/")) {
      base = base.slice(0, -1);
    }

    // Handle special case: current directory
    if (target === ".") {
      return base;
    }

    // Handle absolute paths and tilde
    if (target.startsWith("/") || target === "~" || target.startsWith("~/")) {
      let normalizedTarget = target;
      // Remove trailing slash for comparison (except for root "/")
      if (normalizedTarget.length > 1 && normalizedTarget.endsWith("/")) {
        normalizedTarget = normalizedTarget.slice(0, -1);
      }
      return normalizedTarget;
    }

    // Relative path - resolve against base
    const normalizedTarget = base.endsWith("/") ? base + target : base + "/" + target;

    // Remove trailing slash
    if (normalizedTarget.length > 1 && normalizedTarget.endsWith("/")) {
      return normalizedTarget.slice(0, -1);
    }

    return normalizedTarget;
  }

  /**
   * Return /tmp as the temp directory for remote runtimes.
   */
  tempDir(): Promise<string> {
    return Promise.resolve("/tmp");
  }

  getXumHome(): string {
    // Remote hosts cannot be migrated safely from local startup. Keep their established
    // home path centralized as a compatibility exception until remote provisioning owns it.
    return LEGACY_REMOTE_MUX_HOME;
  }

  // Abstract methods that subclasses must implement

  /**
   * Remote runtimes are always ready (SSH connections are re-established as needed).
   * Subclasses (CoderSSHRuntime, DockerRuntime) may override for provisioning checks.
   */
  ensureReady(): Promise<EnsureReadyResult> {
    return Promise.resolve({ ready: true });
  }

  abstract resolvePath(path: string): Promise<string>;
  abstract getWorkspacePath(projectPath: string, workspaceName: string): string;
  abstract createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult>;
  abstract initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult>;
  abstract renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  >;
  abstract deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }>;
  abstract forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult>;
}
