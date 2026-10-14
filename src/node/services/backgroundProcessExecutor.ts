/**
 * Unified executor for background bash processes.
 *
 * ALL bash commands are spawned through this executor with background-style
 * infrastructure (nohup, file output, exit code trap). This enables:
 *
 * 1. Uniform code path - one spawn mechanism for all bash commands
 * 2. Crash resilience - output always persisted to files
 * 3. Seamless fg→bg transition - "background this" = "stop waiting"
 *
 * Uses runtime.tempDir() for runtime-agnostic temp directory resolution.
 * Works identically for local and SSH runtimes.
 */

import type {
  Runtime,
  BackgroundHandle,
  BackgroundMonitorProbeResult,
  BackgroundOutputRead,
  ExecStream,
  OutputReadOptions,
} from "@/node/runtime/Runtime";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { log } from "./log";
import {
  buildWrapperScript,
  buildSpawnCommand,
  parsePid,
  parseExitCode,
  buildTerminateCommand,
  shellQuote,
} from "@/node/runtime/backgroundCommands";
import { execBuffered, writeFileString } from "@/node/utils/runtime/helpers";
import { LocalBaseRuntime, localRuntimeTempRoot } from "@/node/runtime/LocalBaseRuntime";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { toPosixPath } from "@/node/utils/paths";
import { isErrnoWithCode } from "@/node/utils/fs";
import { getErrorMessage } from "@/common/utils/errors";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import assert from "@/common/utils/assert";

/**
 * Quote a path for shell commands.
 * On Windows, first converts to POSIX format, then shell-quotes.
 * On Unix, just shell-quotes (handles spaces, special chars).
 */
export function quotePathForShell(p: string): string {
  const posixPath = toPosixPath(p);
  return shellQuote(posixPath);
}

/**
 * Whether this runtime's background spawn records live on the HOST filesystem at
 * localBgWorkspaceDir with host-namespace PIDs. Only such records can be probed via local fs
 * reads and process.kill (crash-orphan archive gating, restart-unique name allocation).
 * DevcontainerRuntime extends LocalBaseRuntime but execs inside the container: its records
 * live under the container-side tempDir() (host-visible only through the workspace bind
 * mount) and its recorded PIDs are container-namespace, so it must be treated like a remote
 * runtime everywhere a probe would otherwise trust host paths or host PID checks.
 */
export function spawnRecordsAreHostLocal(runtime: Runtime): boolean {
  return runtime instanceof LocalBaseRuntime && !(runtime instanceof DevcontainerRuntime);
}

/**
 * Safe fallback cwd for runtime.exec() calls that don't need a specific workspace cwd.
 *
 * NOTE: Local runtimes validate that cwd exists before spawning, so this must be a real directory.
 */
const FALLBACK_CWD = process.platform === "win32" ? (process.env.TEMP ?? "C:\\") : "/tmp";
const BACKGROUND_CWD_ENV = "XUM_INTERNAL_BACKGROUND_CWD";
// Upper bound on waiting for a killed migrated process to report its exit.
const MIGRATED_PROCESS_EXIT_JOIN_MS = 5_000;

/** Helper to extract error message for logging */
function errorMsg(error: unknown): string {
  return getErrorMessage(error);
}

/** Subdirectory under temp for background process output */
export const BG_OUTPUT_SUBDIR = "mux-bashes";

/** Output filename for combined stdout/stderr */
const OUTPUT_FILENAME = "output.log";

/** Exit code filename */
const EXIT_CODE_FILENAME = "exit_code";

/** Per-process spawn-record filenames that survive an app crash (see localBgWorkspaceDir). */
export const BG_META_FILENAME = "meta.json";
export const BG_EXIT_CODE_FILENAME = EXIT_CODE_FILENAME;

/**
 * Local-filesystem directory holding this workspace's background spawn records (one
 * subdirectory per process with meta.json, output.log, and the wrapper's exit_code trap
 * file). Mirrors LocalBaseRuntime.tempDir(), which spawnProcess resolves when the process
 * was spawned on a local runtime. Crash-orphan detection scans this layout because the
 * records outlive the app while nohup/setsid children keep running.
 */
export function localBgWorkspaceDir(workspaceId: string): string {
  return `${localBgRecordsRoot()}/${workspaceId}`;
}

/**
 * The one host-local background record root (`<localRuntimeTempRoot()>/mux-bashes`). Local
 * spawns write here (LocalBaseRuntime.tempDir()), production migrations write here (the
 * BackgroundProcessManager bgOutputDir in di/layers/core.ts), both take their name lock here,
 * and other backends' mutation gates scan it (hasOrphanedRunningBackgroundProcesses).
 */
export function localBgRecordsRoot(): string {
  return `${localRuntimeTempRoot()}/${BG_OUTPUT_SUBDIR}`;
}

/**
 * Where builds before the shared root wrote migrated records: path.join(os.tmpdir(),
 * "mux-bashes"), which differs from localBgRecordsRoot() on macOS or with TMPDIR set. Gates keep
 * scanning it so an older backend's live migrated command stays visible during an upgrade.
 */
export function legacyMigratedBgRecordsRoot(): string {
  return path.join(os.tmpdir(), BG_OUTPUT_SUBDIR);
}

/**
 * Compute paths for a background process output directory.
 * @param bgOutputDir Base directory (e.g., /tmp/mux-bashes or ~/.xum/sessions)
 * @param workspaceId Workspace identifier
 * @param processId Process identifier
 */
function computeOutputPaths(
  bgOutputDir: string,
  workspaceId: string,
  processId: string
): { outputDir: string; outputPath: string; exitCodePath: string } {
  const outputDir = `${bgOutputDir}/${workspaceId}/${processId}`;
  return {
    outputDir,
    outputPath: `${outputDir}/${OUTPUT_FILENAME}`,
    exitCodePath: `${outputDir}/${EXIT_CODE_FILENAME}`,
  };
}

/**
 * Options for spawning a process
 */
export interface SpawnOptions {
  /** Working directory for command execution */
  cwd: string;
  /** Workspace ID for output directory organization */
  workspaceId: string;
  /** Process ID (e.g., "bash_1") - generated by BackgroundProcessManager */
  processId: string;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Host-namespace paths to translate before injecting as environment variables. */
  pathEnv?: Record<string, string>;
  /**
   * The caller created the record directory for this spawn (BackgroundProcessManager's atomic
   * mkdir claim on non-host runtimes, #4889), so a failure before the spawn may remove it.
   */
  recordDirClaimed?: boolean;
}

/**
 * Result of spawning a process
 */
export type SpawnResult =
  | { success: true; handle: BackgroundHandle; pid: number; outputDir: string }
  | { success: false; error: string };

/**
 * Spawn a background process using runtime.exec (works for both local and SSH).
 *
 * All processes get the same infrastructure:
 * - nohup/setsid for process isolation
 * - stdout/stderr merged into single output.log with 2>&1
 * - Exit code captured via bash trap
 *
 * Uses runtime.tempDir() for output directory, making the code runtime-agnostic.
 *
 * @param runtime Runtime to spawn on
 * @param script Script to execute
 * @param options Spawn options
 */
export async function spawnProcess(
  runtime: Runtime,
  script: string,
  options: SpawnOptions
): Promise<SpawnResult> {
  log.debug(`BackgroundProcessExecutor.spawnProcess: Spawning in ${options.cwd}`);

  // Get temp directory from runtime (absolute path, runtime-agnostic)
  const tempDir = await runtime.tempDir();
  const bgOutputDir = `${tempDir}/${BG_OUTPUT_SUBDIR}`;

  // Use shell-safe quoting for paths (handles spaces, special chars)
  const quotePath = quotePathForShell;

  // Compute output paths (unified output.log instead of separate stdout/stderr)
  const { outputDir, outputPath, exitCodePath } = computeOutputPaths(
    bgOutputDir,
    options.workspaceId,
    options.processId
  );

  // A failed spawn must not leave a recordless process directory behind: the crash-orphan
  // probe fails closed on directories without readable metadata or an exit marker.
  const removeOutputDirBestEffort = async () => {
    try {
      await execBuffered(runtime, `rm -rf ${quotePath(outputDir)}`, {
        cwd: FALLBACK_CWD,
        timeout: 10,
      });
    } catch {
      // Best-effort: a leftover directory only over-refuses model-driven archives.
    }
  };

  // Verify working directory exists. Nothing is dispatched yet, so a directory the caller
  // claimed for this spawn (non-host runtimes, #4889) must not outlive a failure here, whether
  // the check fails or its exec throws (e.g. a transport error). Otherwise nothing was created.
  let cwdCheck: Awaited<ReturnType<typeof execBuffered>>;
  try {
    cwdCheck = await execBuffered(
      runtime,
      `printf '%s\n' "$${BACKGROUND_CWD_ENV}"; cd "$${BACKGROUND_CWD_ENV}"`,
      {
        cwd: FALLBACK_CWD,
        pathEnv: { [BACKGROUND_CWD_ENV]: options.cwd },
        timeout: 10,
      }
    );
  } catch (error) {
    if (options.recordDirClaimed === true) await removeOutputDirBestEffort();
    throw error;
  }
  if (cwdCheck.exitCode !== 0) {
    const execCwd = cwdCheck.stdout.trim() || options.cwd;
    if (options.recordDirClaimed === true) await removeOutputDirBestEffort();
    return { success: false, error: `Working directory does not exist: ${execCwd}` };
  }

  // Create output directory and empty file
  try {
    await runtime.ensureDir(outputDir);
    await writeFileString(runtime, outputPath, "");
    // Process IDs are display-name based and only deduplicated within one app session, so a
    // restart can reuse a previous session's directory. A stale exit_code from that prior
    // process would be trusted as proof that the NEW process exited — both by getExitCode()
    // and by crash-orphan archive gating — so it must be gone before the wrapper's trap owns
    // the file again.
    const rmResult = await execBuffered(runtime, `rm -f ${quotePath(exitCodePath)}`, {
      cwd: FALLBACK_CWD,
      timeout: 10,
    });
    if (rmResult.exitCode !== 0) {
      await removeOutputDirBestEffort();
      return {
        success: false,
        error: `Failed to clear stale exit_code file: ${rmResult.stderr}`,
      };
    }
  } catch (error) {
    await removeOutputDirBestEffort();
    return {
      success: false,
      error: `Failed to create output directory: ${errorMsg(error)}`,
    };
  }

  // The outer spawn shell exports the translated pathEnv (and cwd var) before
  // the wrapper runs; wrapper-level env exports would overwrite those
  // translations, so pathEnv-owned keys are stripped from the wrapper env.
  const wrapperEnv: Record<string, string> = { ...options.env, ...NON_INTERACTIVE_ENV_VARS };
  for (const key of [...Object.keys(options.pathEnv ?? {}), BACKGROUND_CWD_ENV]) {
    delete wrapperEnv[key];
  }

  const wrapperScript = buildWrapperScript({
    exitCodePath,
    cwd: options.cwd,
    cwdEnvVar: BACKGROUND_CWD_ENV,
    env: wrapperEnv,
    script,
  });

  const spawnCommand = buildSpawnCommand({
    wrapperScript,
    outputPath,
    quotePath,
  });

  try {
    // No timeout - the spawn command backgrounds the process and returns immediately
    const result = await execBuffered(runtime, spawnCommand, {
      cwd: FALLBACK_CWD,
      pathEnv: { ...options.pathEnv, [BACKGROUND_CWD_ENV]: options.cwd },
    });

    if (result.exitCode !== 0) {
      log.debug(`BackgroundProcessExecutor.spawnProcess: spawn command failed: ${result.stderr}`);
      await removeOutputDirBestEffort();
      return {
        success: false,
        error: `Failed to spawn background process: ${result.stderr}`,
      };
    }

    const pid = parsePid(result.stdout);
    if (!pid) {
      // Ambiguous launch: the spawn command succeeded (exit 0), so the detached shell is
      // likely running — only its PID echo was garbled (e.g. an SSH login banner prefixing
      // the output). Unlike the clean failures above, do NOT remove the directory: the
      // wrapper owns output.log/exit_code there, and on local runtimes a meta-less record
      // without an exit marker keeps hasOrphanedRunningBackgroundProcesses fail closed
      // until the trap writes the exit marker (self-healing). Deleting it would leave the
      // command running with no durable trace for archive gating to see. (Remote records
      // cannot feed the local probe; remote crash-orphan gating is tracked in #3944.)
      log.debug(`BackgroundProcessExecutor.spawnProcess: Invalid PID: ${result.stdout}`);
      return {
        success: false,
        error: `Failed to get valid PID from spawn: ${result.stdout}`,
      };
    }

    log.debug(`BackgroundProcessExecutor.spawnProcess: Spawned with PID ${pid}`);
    // Monitors poll this handle every 100ms on local runtimes. A shell probe there forks the
    // (multi-GB) main process for each wc/tail/cat, which profiled as the main thread spending
    // over half its time inside fork(); host-local records are plain files, so read them
    // with fs and keep the local poll path spawn-free. Remote/devcontainer records are only
    // reachable through runtime.exec.
    const probe: SpawnRecordProbe = spawnRecordsAreHostLocal(runtime)
      ? new LocalFsSpawnRecordProbe(outputPath, exitCodePath)
      : new ShellSpawnRecordProbe(runtime, outputPath, exitCodePath, quotePath);
    const handle = new RuntimeBackgroundHandle(runtime, pid, outputDir, quotePath, probe);
    return { success: true, handle, pid, outputDir };
  } catch (error) {
    const errorMessage = errorMsg(error);
    log.debug(`BackgroundProcessExecutor.spawnProcess: Error: ${errorMessage}`);
    // Post-dispatch ambiguity: a transport-level throw (an SSH/Coder channel or container
    // exec error after the spawn command was sent) cannot prove the detached shell never
    // started — a remote/container exec can reject after dispatch while the nohup job
    // survives. Keep the directory as durable evidence: the wrapper's trap settles it with
    // an exit marker if the job did run, and non-host crash-orphan gating (#3944, plus the
    // devcontainer bind-mount scan) consumes exactly these records. Host-local exec throws
    // happen before anything is dispatched (spawn syscall failures), so those directories
    // are still removed — keeping one would permanently over-refuse archives with a record
    // no process will ever settle.
    if (spawnRecordsAreHostLocal(runtime)) {
      await removeOutputDirBestEffort();
    }
    return {
      success: false,
      error: `Failed to spawn background process: ${errorMessage}`,
    };
  }
}

/**
 * Strict reads of a spawn record's output.log and exit_code files, polled on every monitor
 * tick. Every method throws on a missing/unreadable output file or an unreadable (including
 * dangling-symlink) exit marker so the monitor's failure policy can retire the monitor
 * instead of misreading the miss as "empty output" or "still running".
 */
interface SpawnRecordProbe {
  /** Byte size of output.log. */
  outputFileSize(): Promise<number>;
  /**
   * output.log contents from `offset` to (at least) `fileSize`, or about `maxBytes` of them (see
   * decodeOutputBytes), plus the offset read up to.
   */
  readOutputFrom(
    offset: number,
    fileSize: number,
    maxBytes?: number,
    options?: OutputReadOptions
  ): Promise<BackgroundOutputRead>;
  /** Raw exit marker contents; "" when the marker does not exist yet (process still running). */
  readExitCodeMarker(): Promise<string>;
}

/** Bytes a bounded read loads past its limit, to finish a UTF-8 character cut there. */
const UTF8_CHARACTER_MARGIN_BYTES = 3;

/** How many bytes of output.log to load at `offset`: up to `fileSize`, at most about `maxBytes`. */
function outputReadLength(offset: number, fileSize: number, maxBytes?: number): number {
  const available = Math.max(fileSize - offset, 0);
  if (maxBytes == null) return available;
  assert(Number.isInteger(maxBytes) && maxBytes > 0, `maxBytes must be a positive integer`);
  return Math.min(available, maxBytes + UTF8_CHARACTER_MARGIN_BYTES);
}

/**
 * Decode `bytes`, loaded from output.log at `offset`. A bounded read that stopped before the end
 * of the file returns `maxBytes` and then stops at the first place where decoding the bytes on
 * each side apart gives the same text as decoding them together: before a byte that is not a
 * UTF-8 continuation byte (10xxxxxx), or after 3 continuation bytes (no character needs more).
 * So the pages of a log decode to exactly the text of the whole log, invalid bytes included.
 *
 * A bounded read that is not `final` also stops before an incomplete character at its end: the
 * file size was sampled before the read, so a character the process is still writing would
 * otherwise decode to U+FFFD and the cursor would move past its first bytes.
 */
function decodeOutputBytes(
  bytes: Uint8Array,
  offset: number,
  fileSize: number,
  maxBytes?: number,
  options?: OutputReadOptions
): BackgroundOutputRead {
  const end =
    maxBytes == null
      ? bytes.length
      : boundedReadEnd(bytes, offset + bytes.length < fileSize, maxBytes, options);
  const newOffset = offset + end;
  return {
    // ignoreBOM: a read that starts at a U+FEFF must return it, not strip it as a byte-order mark.
    content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, end)),
    newOffset,
    fileSize: Math.max(fileSize, newOffset),
  };
}

/** Where a bounded read stops in the bytes it loaded (see decodeOutputBytes). */
function boundedReadEnd(
  bytes: Uint8Array,
  fileGoesOn: boolean,
  maxBytes: number,
  options?: OutputReadOptions
): number {
  const end = bytes.length > maxBytes && fileGoesOn ? safeCutAfter(bytes, maxBytes) : bytes.length;
  // Only the last loaded byte can end a character that more bytes may complete: a cut before
  // the last one sees the byte after it, so a sequence cut there is already known to be broken.
  if (end < bytes.length || options?.final === true) return end;
  return incompleteCharacterStart(bytes, end);
}

/** The first cut at or after `maxBytes` where the bytes decode the same apart as together. */
function safeCutAfter(bytes: Uint8Array, maxBytes: number): number {
  let end = maxBytes;
  const limit = maxBytes + UTF8_CHARACTER_MARGIN_BYTES;
  while (end < limit && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
  return end;
}

/**
 * Where an incomplete UTF-8 character at the end of `bytes[0, end)` starts (`end` when there is
 * none): a lead byte followed by fewer continuation bytes than it announces. Invalid leads
 * (0xC0, 0xC1, 0xF5 and above) announce nothing, so they decode at once.
 */
function incompleteCharacterStart(bytes: Uint8Array, end: number): number {
  for (let back = 1; back <= UTF8_CHARACTER_MARGIN_BYTES && back <= end; back++) {
    const byte = bytes[end - back];
    if ((byte & 0xc0) === 0x80) continue;
    return utf8SequenceLength(byte) > back ? end - back : end;
  }
  return end;
}

/** The length a UTF-8 lead byte announces; 1 for ASCII and for bytes that cannot start one. */
function utf8SequenceLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

/** Read output.log on the host from `offset` (see SpawnRecordProbe.readOutputFrom). */
async function readLocalOutputFile(
  outputPath: string,
  offset: number,
  fileSize: number,
  maxBytes?: number,
  options?: OutputReadOptions
): Promise<BackgroundOutputRead> {
  const fd = await fs.open(outputPath, "r");
  try {
    const buffer = Buffer.alloc(outputReadLength(offset, fileSize, maxBytes));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset);
    return decodeOutputBytes(buffer.subarray(0, bytesRead), offset, fileSize, maxBytes, options);
  } finally {
    await fd.close();
  }
}

/** All bytes of a stream, undecoded. */
async function readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Host-local records: plain Node fs calls, no child process per tick. */
class LocalFsSpawnRecordProbe implements SpawnRecordProbe {
  constructor(
    private readonly outputPath: string,
    private readonly exitCodePath: string
  ) {}

  async outputFileSize(): Promise<number> {
    return (await fs.stat(this.outputPath)).size;
  }

  readOutputFrom(
    offset: number,
    fileSize: number,
    maxBytes?: number,
    options?: OutputReadOptions
  ): Promise<BackgroundOutputRead> {
    return readLocalOutputFile(this.outputPath, offset, fileSize, maxBytes, options);
  }

  async readExitCodeMarker(): Promise<string> {
    // lstat does not follow symlinks: only a truly absent path means "still running". A
    // dangling-symlink marker passes lstat and then fails readFile (which follows the link),
    // surfacing as a probe failure exactly like the shell probe's `[ ! -L ]` guard.
    try {
      await fs.lstat(this.exitCodePath);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return "";
      throw error;
    }
    return fs.readFile(this.exitCodePath, "utf-8");
  }
}

/** What the remote read prints on stderr when tail fails (see readOutputFrom). */
const TAIL_FAILED_MARKER = "xum-tail-exit:";

/** Fail the remote read when tail failed before it sent all `length` bytes (see readOutputFrom). */
function assertTailSucceeded(bytesRead: number, length: number, stderr: string): void {
  if (bytesRead < length && stderr.includes(TAIL_FAILED_MARKER)) {
    throw new Error(`readOutput tail probe failed (${stderr.trim()})`);
  }
}

/** Remote/container records: reachable only through runtime.exec shell commands. */
class ShellSpawnRecordProbe implements SpawnRecordProbe {
  constructor(
    private readonly runtime: Runtime,
    private readonly outputPath: string,
    private readonly exitCodePath: string,
    private readonly quotePath: (p: string) => string
  ) {}

  private assertProbeSucceeded(operation: string, exitCode: number): void {
    if (exitCode !== 0) {
      throw new Error(`${operation} exited with code ${exitCode}`);
    }
  }

  async outputFileSize(): Promise<number> {
    const filePath = this.quotePath(this.outputPath);
    // No || fallback: a deleted or unreadable output file must fail the strict probe so the
    // monitor's failure policy can retire it instead of parsing the miss as an empty file.
    const sizeResult = await execBuffered(this.runtime, `wc -c < ${filePath} 2>/dev/null`, {
      cwd: FALLBACK_CWD,
      timeout: 10,
    });
    this.assertProbeSucceeded("readOutput file-size probe", sizeResult.exitCode);
    return parseInt(sizeResult.stdout.trim(), 10) || 0;
  }

  async readOutputFrom(
    offset: number,
    fileSize: number,
    maxBytes?: number,
    options?: OutputReadOptions
  ): Promise<BackgroundOutputRead> {
    const filePath = this.quotePath(this.outputPath);
    // Read from offset using tail -c (faster than dd bs=1); tail -c +N means "start at byte N"
    // (1-indexed). head -c stops at fileSize, or after one page for a bounded read.
    //
    // A pipeline exits with head's status, so tail reports its own failure on stderr (its
    // messages go to /dev/null). Plain POSIX sh, BusyBox ash included: no pipefail. A tail that
    // failed only because head stopped early (SIGPIPE, exit 141, or EPIPE where SIGPIPE is
    // ignored) still sent all `length` bytes, so only a short read with a tail failure fails.
    const length = outputReadLength(offset, fileSize, maxBytes);
    const command =
      `{ tail -c +${offset + 1} ${filePath} 2>/dev/null || echo "${TAIL_FAILED_MARKER}$?" >&2; }` +
      ` | head -c ${length}`;
    const stream = await this.runtime.exec(command, { cwd: FALLBACK_CWD, timeout: 30 });
    await stream.stdin.close();
    // Raw bytes, not execBuffered's text: the offset counts bytes, and a decoded U+FFFD or a
    // stripped byte-order mark has a different size than the bytes it came from.
    const [bytes, stderr, exitCode] = await Promise.all([
      readStreamBytes(stream.stdout),
      readStreamBytes(stream.stderr),
      stream.exitCode,
    ]);
    this.assertProbeSucceeded("readOutput tail probe", exitCode);
    assertTailSucceeded(bytes.length, length, stderr.toString("utf8"));
    return decodeOutputBytes(bytes, offset, fileSize, maxBytes, options);
  }

  async readExitCodeMarker(): Promise<string> {
    const exitCodePath = this.quotePath(this.exitCodePath);
    // Absent marker means still running (exit 0, empty). File operators other than -h/-L
    // follow symlinks, so a dangling-symlink marker reads as absent to -e; require -L to
    // also fail before declaring absence, letting cat surface the dangling link (like any
    // other unreadable/replaced marker) as a probe failure instead of "running" forever.
    const result = await execBuffered(
      this.runtime,
      `{ [ ! -e ${exitCodePath} ] && [ ! -L ${exitCodePath} ]; } || cat ${exitCodePath} 2>/dev/null`,
      {
        cwd: FALLBACK_CWD,
        timeout: 10,
      }
    );
    this.assertProbeSucceeded("getExitCode", result.exitCode);
    return result.stdout;
  }
}

/**
 * Unified handle to a background process.
 * Lifecycle operations (terminate, writeMeta) go through runtime.exec for every runtime;
 * per-tick record reads go through the SpawnRecordProbe selected at spawn time.
 *
 * Output files (output.log, exit_code) are on the runtime's filesystem.
 */
class RuntimeBackgroundHandle implements BackgroundHandle {
  private termination: Promise<void> | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly pid: number,
    public readonly outputDir: string,
    private readonly quotePath: (p: string) => string,
    private readonly probe: SpawnRecordProbe
  ) {}

  private async probeForMonitor<T>(
    probe: () => Promise<T>
  ): Promise<BackgroundMonitorProbeResult<T>> {
    try {
      return { success: true, value: await probe() };
    } catch (error) {
      return { success: false, error: errorMsg(error) };
    }
  }

  private async getExitCodeStrict(): Promise<number | null> {
    const marker = await this.probe.readExitCodeMarker();
    const parsed = parseExitCode(marker);
    // A nonempty marker that fails to parse is a corrupted write, not a still-running process.
    if (parsed == null && marker.trim().length > 0) {
      throw new Error(`getExitCode marker is not a number: ${marker.trim().slice(0, 32)}`);
    }
    return parsed;
  }

  /**
   * Get the exit code from the exit_code file.
   * Returns null if process is still running (file doesn't exist yet).
   */
  async getExitCode(): Promise<number | null> {
    try {
      return await this.getExitCodeStrict();
    } catch (error) {
      log.debug(`RuntimeBackgroundHandle.getExitCode: Error: ${errorMsg(error)}`);
      return null;
    }
  }

  getExitCodeForMonitor(): Promise<BackgroundMonitorProbeResult<number | null>> {
    return this.probeForMonitor(() => this.getExitCodeStrict());
  }

  /**
   * Terminate the process group.
   * Sends SIGTERM to process group, waits briefly, then SIGKILL if still running.
   */
  terminate(): Promise<void> {
    // Memoized synchronously, before the first await: concurrent callers (task_stop and the
    // timeout timer, cleanup) share one kill sequence instead of each running their own.
    this.termination ??= this.runTerminate();
    return this.termination;
  }

  private async runTerminate(): Promise<void> {
    try {
      const exitCodePath = `${this.outputDir}/${EXIT_CODE_FILENAME}`;
      const terminateCmd = buildTerminateCommand(this.pid, exitCodePath, this.quotePath);
      await execBuffered(this.runtime, terminateCmd, {
        cwd: FALLBACK_CWD,
        timeout: 15,
      });
      log.debug(`RuntimeBackgroundHandle: Terminated process group ${this.pid}`);
    } catch (error) {
      // Process may already be dead - that's fine
      log.debug(`RuntimeBackgroundHandle.terminate: Error: ${errorMsg(error)}`);
    }
  }

  /**
   * Clean up resources.
   * No resources to clean - process runs independently via nohup.
   */
  async dispose(): Promise<void> {
    // No resources to clean up
  }

  /**
   * Write meta.json to the output directory.
   */
  async writeMeta(metaJson: string): Promise<void> {
    // Persistence failures propagate: the initial spawn record is load-bearing for
    // crash-orphan archive gating (BackgroundProcessManager.spawn aborts the spawn when it
    // cannot be written); status-update callers wrap this in their own best-effort catch.
    const metaPath = this.quotePath(`${this.outputDir}/${BG_META_FILENAME}`);
    const result = await execBuffered(
      this.runtime,
      `cat > ${metaPath} << 'METAEOF'\n${metaJson}\nMETAEOF`,
      {
        cwd: FALLBACK_CWD,
        timeout: 10,
      }
    );
    if (result.exitCode !== 0) {
      throw new Error(`writeMeta failed with exit code ${result.exitCode}: ${result.stderr}`);
    }
  }

  async getOutputFileSize(): Promise<number> {
    try {
      return await this.probe.outputFileSize();
    } catch (error) {
      log.debug(`RuntimeBackgroundHandle.getOutputFileSize: Error: ${errorMsg(error)}`);
      return 0;
    }
  }

  private async readOutputStrict(
    offset: number,
    maxBytes?: number,
    options?: OutputReadOptions
  ): Promise<BackgroundOutputRead> {
    const fileSize = await this.probe.outputFileSize();

    if (offset >= fileSize) {
      return { content: "", newOffset: offset, fileSize: offset };
    }

    return this.probe.readOutputFrom(offset, fileSize, maxBytes, options);
  }

  /**
   * Read output from output.log at the given byte offset.
   */
  async readOutput(
    offset: number,
    maxBytes?: number,
    options?: OutputReadOptions
  ): Promise<BackgroundOutputRead> {
    try {
      return await this.readOutputStrict(offset, maxBytes, options);
    } catch (error) {
      log.debug(`RuntimeBackgroundHandle.readOutput: Error: ${errorMsg(error)}`);
      return { content: "", newOffset: offset, fileSize: offset };
    }
  }

  readOutputForMonitor(
    offset: number
  ): Promise<BackgroundMonitorProbeResult<{ content: string; newOffset: number }>> {
    return this.probeForMonitor(() => this.readOutputStrict(offset));
  }
}

/**
 * Options for migrating a foreground process to background
 */
export interface MigrateOptions {
  /** Working directory (for display in meta.json) */
  cwd: string;
  /** Workspace ID */
  workspaceId: string;
  /** Process ID (e.g., "bash_1") - generated by BackgroundProcessManager */
  processId: string;
  /** Original script being executed */
  script: string;
  /** Output already captured while running in foreground */
  existingOutput: string[];
  /** Human-readable name for the process */
  displayName?: string;
  /** Kills the running process tree (the foreground exec's abort); see MigratedBackgroundHandle.terminate */
  kill?: () => void;
}

/**
 * Result of migrating a foreground process
 */
export type MigrateResult =
  | { success: true; handle: BackgroundHandle; outputDir: string }
  | { success: false; error: string };

/**
 * Migrate a foreground process to background tracking.
 *
 * This is called when user clicks "Background" on a running foreground process.
 * The process continues running, but we:
 * 1. Create output directory and write existing output
 * 2. Continue consuming streams and writing to unified output.log
 * 3. Track exit code when process completes
 * 4. Return a BackgroundHandle for the manager to track
 *
 * Note: Output files are written locally (not via runtime), so this works
 * for SSH runtime where streams are already being piped to the local machine.
 *
 * @param execStream The running process's streams
 * @param options Migration options
 * @param bgOutputDir Base directory for output files
 */
export async function migrateToBackground(
  execStream: ExecStream,
  options: MigrateOptions,
  bgOutputDir: string
): Promise<MigrateResult> {
  // Use shared path computation (path.join for local filesystem)
  const { outputDir, outputPath } = computeOutputPaths(
    bgOutputDir,
    options.workspaceId,
    options.processId
  );

  try {
    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });

    // Write existing output to unified output.log
    await fs.writeFile(outputPath, options.existingOutput.join("\n") + "\n");

    // Create handle that will continue writing to file
    const handle = new MigratedBackgroundHandle(execStream, outputDir, outputPath, options.kill);

    // Start consuming remaining output in background
    handle.startConsuming();

    return { success: true, handle, outputDir };
  } catch (error) {
    const errorMessage = errorMsg(error);
    log.debug(`migrateToBackground: Error: ${errorMessage}`);
    return { success: false, error: `Failed to migrate process: ${errorMessage}` };
  }
}

/**
 * Handle for a migrated foreground process.
 *
 * Unlike RuntimeBackgroundHandle which uses runtime.exec for file operations,
 * this handle uses local filesystem directly because the streams are already
 * being piped to the local machine (even for SSH runtime).
 *
 * Both stdout and stderr are written to a unified output.log file.
 */
class MigratedBackgroundHandle implements BackgroundHandle {
  private exitCodeValue: number | null = null;
  private consuming = false;
  private outputFd: fs.FileHandle | null = null;

  constructor(
    private readonly execStream: ExecStream,
    public readonly outputDir: string,
    private readonly outputPath: string,
    private readonly kill?: () => void
  ) {}

  /**
   * Start consuming remaining output from streams and writing to unified file.
   * Called after handle is created to begin background file writing.
   */
  startConsuming(): void {
    if (this.consuming) return;
    this.consuming = true;

    // Open output file once, consume both streams to it
    void this.consumeStreams();

    // Track exit code
    void this.execStream.exitCode.then((code) => {
      this.exitCodeValue = code;
      // Write exit code to file
      void this.writeExitCode(code);
    });
  }

  /**
   * Consume both stdout and stderr streams and append to unified output file.
   */
  private async consumeStreams(): Promise<void> {
    try {
      this.outputFd = await fs.open(this.outputPath, "a");

      // Consume both streams concurrently, both writing to same file
      await Promise.all([
        this.consumeStream(this.execStream.stdout),
        this.consumeStream(this.execStream.stderr),
      ]);
    } catch (error) {
      log.debug(`MigratedBackgroundHandle.consumeStreams: ${errorMsg(error)}`);
    } finally {
      if (this.outputFd) {
        await this.outputFd.close();
        this.outputFd = null;
      }
    }
  }

  /**
   * Consume a stream and append to the shared output file.
   */
  private async consumeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      const reader = stream.getReader();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && this.outputFd) {
            await this.outputFd.write(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      // Stream may have been cancelled or process killed - that's fine
      log.debug(`MigratedBackgroundHandle.consumeStream: ${errorMsg(error)}`);
    }
  }

  /**
   * Write exit code to file.
   */
  private async writeExitCode(code: number): Promise<void> {
    try {
      const exitCodePath = path.join(this.outputDir, EXIT_CODE_FILENAME);
      await fs.writeFile(exitCodePath, String(code));
    } catch (error) {
      log.debug(`MigratedBackgroundHandle.writeExitCode: ${errorMsg(error)}`);
    }
  }

  getExitCode(): Promise<number | null> {
    return Promise.resolve(this.exitCodeValue);
  }

  async terminate(): Promise<void> {
    // ExecStream has no kill method, so the foreground exec's abort is passed in. Workspace
    // removal terminates processes before deleting the checkout (#4760), so kill the process
    // and join its exit (bounded: a remote exec may never report one) before returning.
    if (this.kill) {
      this.kill();
      await raceWithAbortAndTimeout(this.execStream.exitCode, {
        timeoutMs: MIGRATED_PROCESS_EXIT_JOIN_MS,
      }).catch(() => undefined);
    }
    try {
      await this.execStream.stdout.cancel();
      await this.execStream.stderr.cancel();
    } catch {
      // Streams may already be closed
    }
  }

  async dispose(): Promise<void> {
    // Close any open file handles
    await this.outputFd?.close().catch(() => {
      /* ignore */
    });
  }

  async getOutputFileSize(): Promise<number> {
    try {
      const stat = await fs.stat(this.outputPath);
      return stat.size;
    } catch (error) {
      log.debug(`MigratedBackgroundHandle.getOutputFileSize: ${errorMsg(error)}`);
      return 0;
    }
  }

  async writeMeta(metaJson: string): Promise<void> {
    // Swallowed on purpose (unlike RuntimeBackgroundHandle): registerMigratedProcess writes
    // fire-and-forget (a rethrow would surface as an unhandled rejection), and a missing
    // migrated record errs toward over-refusal, never under-refusal — the crash-orphan probe
    // fails closed on markerless pid-0 records and on unreadable ones alike.
    try {
      const metaPath = path.join(this.outputDir, BG_META_FILENAME);
      await fs.writeFile(metaPath, metaJson);
    } catch (error) {
      log.debug(`MigratedBackgroundHandle.writeMeta: ${errorMsg(error)}`);
    }
  }

  async readOutput(
    offset: number,
    maxBytes?: number,
    options?: OutputReadOptions
  ): Promise<BackgroundOutputRead> {
    try {
      const fileSize = await this.getOutputFileSize();

      if (offset >= fileSize) {
        return { content: "", newOffset: offset, fileSize: offset };
      }

      return await readLocalOutputFile(this.outputPath, offset, fileSize, maxBytes, options);
    } catch (error) {
      log.debug(`MigratedBackgroundHandle.readOutput: ${errorMsg(error)}`);
      return { content: "", newOffset: offset, fileSize: offset };
    }
  }
}
