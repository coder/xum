import {
  RuntimeError,
  isRuntimeTransportError,
  type Runtime,
  type ExecOptions,
  type ReadFileOptions,
} from "@/node/runtime/Runtime";
import { streamToString, streamToStringCapped } from "@/node/runtime/streamUtils";
import { PlatformPaths } from "@/node/utils/paths.main";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { getAtomicWriteTempPath } from "@/node/runtime/atomicWriteTempPath";

/**
 * Convenience helpers for working with streaming Runtime APIs.
 * These provide simple string-based APIs on top of the low-level streaming primitives.
 */

/**
 * Extract project name from a project path
 * Works for both local paths and remote paths
 */
export function getProjectName(projectPath: string): string {
  return PlatformPaths.getProjectName(projectPath);
}

/**
 * Result from executing a command with buffered output
 */
export interface ExecResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code (0 = success) */
  exitCode: number;
  /** Wall clock duration in milliseconds */
  duration: number;
}

/**
 * Execute a command and buffer all output into strings
 */
export async function execBuffered(
  runtime: Runtime,
  command: string,
  options: ExecOptions & {
    stdin?: string;
    /**
     * When set, stdout and stderr are each capped at this many raw bytes while
     * reading (excess is drained and discarded), bounding memory on commands
     * with unbounded output. Pair with `timeout` to also bound duration.
     */
    maxOutputBytes?: number;
  }
): Promise<ExecResult> {
  const stream = await runtime.exec(command, options);

  // Write stdin if provided
  if (options.stdin !== undefined) {
    const writer = stream.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    } catch (err) {
      writer.releaseLock();
      throw err;
    }
  } else {
    // Close stdin immediately if no input
    await stream.stdin.close();
  }

  // Read stdout and stderr concurrently
  const readStream =
    options.maxOutputBytes !== undefined
      ? (s: ReadableStream<Uint8Array>) => streamToStringCapped(s, options.maxOutputBytes!)
      : streamToString;
  const [stdout, stderr, exitCode, duration] = await Promise.all([
    readStream(stream.stdout),
    readStream(stream.stderr),
    stream.exitCode,
    stream.duration,
  ]);

  return { stdout, stderr, exitCode, duration };
}

/**
 * Read file contents as a UTF-8 string
 */
/**
 * Throw a transport failure when a buffered exec probe failed because the host
 * was unreachable, so callers never read it as an empty listing or a missing
 * path (#4438). Other non-zero exits are left to the caller's handling.
 */
export function throwIfTransportFailure(
  runtime: Runtime,
  result: { exitCode: number; stderr: string },
  action: string
): void {
  if (result.exitCode !== 0 && runtime.isTransportFailureExit?.(result.exitCode, result.stderr)) {
    throw new RuntimeError(`${action}: ${result.stderr.trim()}`, "network");
  }
}

export async function readFileString(
  runtime: Runtime,
  path: string,
  abortSignal?: AbortSignal,
  options?: ReadFileOptions
): Promise<string> {
  const stream = runtime.readFile(path, abortSignal, options);
  return streamToString(stream);
}

/**
 * Write string contents to a file atomically
 */
export async function writeFileString(
  runtime: Runtime,
  path: string,
  content: string,
  abortSignal?: AbortSignal
): Promise<void> {
  const stream = runtime.writeFile(path, abortSignal);
  const writer = stream.getWriter();
  try {
    await writer.write(new TextEncoder().encode(content));
    await writer.close();
  } catch (err) {
    writer.releaseLock();
    throw err;
  }
}

/**
 * Result from reading a plan file with legacy migration support
 */
export interface ReadPlanResult {
  /** Plan file content (empty string if file doesn't exist) */
  content: string;
  /** Whether a plan file exists */
  exists: boolean;
  /** The canonical plan file path (new format) */
  path: string;
}

/**
 * Read plan file content, checking new path first then legacy, migrating if needed.
 * This handles the transparent migration from {runtimeHome}/plans/{id}.md to
 * {runtimeHome}/plans/{projectName}/{workspaceName}.md
 */
export async function readPlanFile(
  runtime: Runtime,
  workspaceName: string,
  projectName: string,
  workspaceId: string
): Promise<ReadPlanResult> {
  const xumHome = runtime.getXumHome();
  const planPath = getPlanFilePath(workspaceName, projectName, xumHome);
  const legacyPath = getLegacyPlanFilePath(workspaceId, xumHome);

  // Resolve tilde to absolute path for client use (editor deep links, etc.)
  // For local runtimes this expands ~ to /home/user; for SSH it resolves remotely
  const resolvedPath = await runtime.resolvePath(planPath);

  // The plan path is user/agent-writable: a FIFO (or other special file) there
  // must not block the reader, so only regular files count as a plan. Anything
  // else is reported as missing (the callers' existing "no plan file" path).
  const planReadOptions: ReadFileOptions = { requireRegularFile: true };

  // Try new path first
  try {
    const content = await readFileString(runtime, planPath, undefined, planReadOptions);
    return { content, exists: true, path: resolvedPath };
  } catch (error) {
    // An unreachable runtime is not a missing plan (#4826): callers must fail
    // visibly, not act as if no plan exists or fall back to a stale legacy one.
    if (isRuntimeTransportError(error)) throw error;
    // Fall back to legacy path
    try {
      const content = await readFileString(runtime, legacyPath, undefined, planReadOptions);
      // Migrate: move to new location.
      try {
        const planDir = planPath.substring(0, planPath.lastIndexOf("/"));
        await execBuffered(
          runtime,
          'mkdir -p "$XUM_PLAN_DIR" && mv "$XUM_LEGACY_PLAN" "$XUM_PLAN"',
          {
            cwd: "/tmp",
            pathEnv: {
              XUM_PLAN_DIR: planDir,
              XUM_LEGACY_PLAN: legacyPath,
              XUM_PLAN: planPath,
            },
            timeout: 5,
          }
        );
      } catch {
        // Migration failed, but we have the content
      }
      return { content, exists: true, path: resolvedPath };
    } catch (error) {
      if (isRuntimeTransportError(error)) throw error;
      // File doesn't exist at either location
      return { content: "", exists: false, path: resolvedPath };
    }
  }
}

/**
 * Move a plan file from one workspace name to another (e.g., during rename).
 * Silently succeeds if source file doesn't exist. Throws when the source could
 * not be probed in transport or the move itself failed, so a caller never
 * reports a moved plan that stayed behind (#4826).
 */
export async function movePlanFile(
  runtime: Runtime,
  oldWorkspaceName: string,
  newWorkspaceName: string,
  projectName: string
): Promise<void> {
  const xumHome = runtime.getXumHome();
  const oldPath = getPlanFilePath(oldWorkspaceName, projectName, xumHome);
  const newPath = getPlanFilePath(newWorkspaceName, projectName, xumHome);

  try {
    await runtime.stat(oldPath);
  } catch (error) {
    if (isRuntimeTransportError(error)) throw error;
    // No plan file to move, that's fine
    return;
  }
  const result = await execBuffered(runtime, 'mv "$XUM_OLD_PLAN" "$XUM_NEW_PLAN"', {
    cwd: "/tmp",
    pathEnv: {
      XUM_OLD_PLAN: oldPath,
      XUM_NEW_PLAN: newPath,
    },
    timeout: 5,
  });
  throwIfTransportFailure(runtime, result, "Failed to move plan file");
  if (result.exitCode !== 0) {
    throw new RuntimeError(
      `Failed to move plan file ${oldPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      "file_io"
    );
  }
}

/** Exit status of LINK_PLAN_NO_CLOBBER when the destination already exists. */
const PLAN_TARGET_EXISTS_EXIT = 17;

/**
 * A plan file is already at the target of a fork's plan copy, so the copy left it alone. The
 * fork's registration holds the name in the plan directory, so it is an orphan of a removed
 * workspace or a plan this installation's name checks cannot see (another installation on the
 * same host); it is never replaced, as replacing it could destroy a live plan (#5175).
 */
export class PlanFileTargetExistsError extends RuntimeError {
  constructor(readonly targetPath: string) {
    super(`a file already exists at ${targetPath}`, "file_io");
    this.name = "PlanFileTargetExistsError";
  }
}

/**
 * Shell fragment (run it in a subshell: it exits): hard-link "$XUM_PLAN_FROM", a uniquely named
 * staging file, to exactly "$XUM_PLAN_TO" unless something is there, exiting
 * PLAN_TARGET_EXISTS_EXIT if it is. link(2) refuses an existing destination atomically, so a plan
 * that appears concurrently is never replaced (`mv` and `cp` replace it). `-n` keeps ln from
 * following a symlink to a directory. A real directory at the destination makes ln link inside
 * it instead; the -ef check catches that, also when the directory appeared after any earlier
 * check, and removes the stray link, which only the staging file's unique name can match.
 */
const LINK_PLAN_NO_CLOBBER = [
  'if ! err=$(ln -n "$XUM_PLAN_FROM" "$XUM_PLAN_TO" 2>&1); then',
  `  if [ -e "$XUM_PLAN_TO" ] || [ -L "$XUM_PLAN_TO" ]; then exit ${PLAN_TARGET_EXISTS_EXIT}; fi`,
  '  echo "$err" >&2',
  "  exit 1",
  "fi",
  'if [ ! "$XUM_PLAN_TO" -ef "$XUM_PLAN_FROM" ]; then',
  '  stray="$XUM_PLAN_TO/${XUM_PLAN_FROM##*/}"',
  '  if [ "$stray" -ef "$XUM_PLAN_FROM" ]; then rm -f "$stray"; fi',
  `  exit ${PLAN_TARGET_EXISTS_EXIT}`,
  "fi",
].join("\n");

/**
 * Copy a plan file across runtimes (e.g., during fork where source/target may be
 * different containers). Uses separate runtime handles to avoid the identity mutation
 * bug where DockerRuntime.forkWorkspace() changes this.containerName to the target.
 * Silently succeeds if no regular source file exists at either location. Throws
 * when a source read fails in transport or the target write fails, so a fork
 * never proceeds without a plan it could not copy (#4826). Never replaces a file at
 * the target (PlanFileTargetExistsError), so the target path it returns after a copy
 * is a file this copy created, and a rollback deletes only a file it made (#4775).
 */
export async function copyPlanFileAcrossRuntimes(
  sourceRuntime: Runtime,
  targetRuntime: Runtime,
  sourceWorkspaceName: string,
  sourceWorkspaceId: string,
  targetWorkspaceName: string,
  projectName: string
): Promise<string | undefined> {
  const sourceMuxHome = sourceRuntime.getXumHome();
  const targetXumHome = targetRuntime.getXumHome();
  const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
  const legacySourcePath = getLegacyPlanFilePath(sourceWorkspaceId, sourceMuxHome);
  const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetXumHome);

  for (const candidatePath of [sourcePath, legacySourcePath]) {
    let content: string;
    try {
      // Same guard as readPlanFile: every fork reads this user/agent-writable path, so a FIFO
      // there must be skipped (as missing) instead of parking a reader per fork.
      content = await readFileString(sourceRuntime, candidatePath, undefined, {
        requireRegularFile: true,
      });
    } catch (error) {
      // An unreadable canonical plan must not be replaced by a stale legacy copy.
      if (isRuntimeTransportError(error)) throw error;
      continue; // Missing (or not a regular file): try the next candidate.
    }
    // Staged next to the target, then linked into place without replacing anything there (#5175):
    // fork() copies only once its registration holds the name, so no live workspace it can see
    // owns the target, but a file there may still be a plan it cannot see. Orphans of removed
    // workspaces (older builds, failed or skipped deletions) are kept too; the fork fails with
    // PlanFileTargetExistsError and the user removes the file.
    const stagingPath = getAtomicWriteTempPath(targetPath);
    const action = `Failed to copy plan file to ${targetPath}`;
    // The shell below removes the staging file whatever the link does. A failure that leaves its
    // status unknown (the staging write, exec itself, a transport exit or timeout) cleans up here:
    // while the staging file exists, the link script has not finished, so a target that is the
    // staging file (-ef) is this copy's link and goes too. Once the staging file is gone, the
    // script finished with an unknown status, so a file at the target may be this copy; it is
    // named, never deleted. A failed fork thus never leaves a plan copy behind unreported, and a
    // retry that then refuses the target names the file to remove.
    const failCleaningUp = async (error: unknown): Promise<never> => {
      const cleanup = await execBuffered(
        targetRuntime,
        [
          'if [ -e "$XUM_PLAN_FROM" ]; then',
          '  if [ "$XUM_PLAN_TO" -ef "$XUM_PLAN_FROM" ]; then rm -f "$XUM_PLAN_TO" || exit 1; fi',
          '  rm -f "$XUM_PLAN_FROM" || exit 1',
          "  exit 0",
          "fi",
          `if [ -e "$XUM_PLAN_TO" ] || [ -L "$XUM_PLAN_TO" ]; then exit ${PLAN_TARGET_EXISTS_EXIT}; fi`,
        ].join("\n"),
        {
          cwd: "/tmp",
          pathEnv: { XUM_PLAN_FROM: stagingPath, XUM_PLAN_TO: targetPath },
          timeout: 5,
        }
      ).catch(() => undefined);
      if (cleanup?.exitCode === 0) throw error;
      const leftover =
        cleanup?.exitCode === PLAN_TARGET_EXISTS_EXIT
          ? `the plan copy may have reached ${targetPath}; delete it if it is this fork's copy`
          : `a copy of the plan may remain at ${stagingPath} or ${targetPath}; delete what this fork left`;
      throw new RuntimeError(
        `${error instanceof Error ? error.message : String(error)}; ${leftover}`,
        error instanceof RuntimeError ? error.type : "unknown",
        error
      );
    };
    let result: ExecResult;
    try {
      await writeFileString(targetRuntime, stagingPath, content);
      result = await execBuffered(
        targetRuntime,
        // The staging file goes whatever the link did: on success the target holds the content.
        `(\n${LINK_PLAN_NO_CLOBBER}\n)\nstatus=$?\nrm -f "$XUM_PLAN_FROM"\nexit $status`,
        {
          cwd: "/tmp",
          pathEnv: { XUM_PLAN_FROM: stagingPath, XUM_PLAN_TO: targetPath },
          timeout: 5,
        }
      );
      throwIfTransportFailure(targetRuntime, result, action);
    } catch (error) {
      return failCleaningUp(error);
    }
    if (result.exitCode === PLAN_TARGET_EXISTS_EXIT) {
      throw new PlanFileTargetExistsError(targetPath);
    }
    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `${action}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        "file_io"
      );
    }
    return targetPath;
  }
  return undefined;
}
