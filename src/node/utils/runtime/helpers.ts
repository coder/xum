import {
  RuntimeError,
  isRuntimeTransportError,
  type Runtime,
  type ExecOptions,
  type ReadFileOptions,
} from "@/node/runtime/Runtime";
import { streamToString, streamToStringCapped } from "@/node/runtime/streamUtils";
import { PlatformPaths } from "@/node/utils/paths.main";
// Type-only: planLocation imports remoteProjectLayout, which imports getProjectName from here.
import type { PlanFileLocation } from "@/node/utils/runtime/planLocation";
import { log } from "@/node/services/log";

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
 * Every path that holds a workspace's plan (see PlanFileLocation), in read order: the shared
 * legacy path only while the row's fallback is not retired, read fresh.
 */
export function planReadPaths(location: PlanFileLocation): string[] {
  return [
    location.planPath,
    location.legacyIdPath,
    ...(location.sharedLegacy && !location.sharedLegacy.isRetired()
      ? [location.sharedLegacy.path]
      : []),
  ];
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
 * Read a workspace's plan from its location (planLocation.ts): planPath, else the legacy-by-id
 * path (moved to planPath, it is provably this workspace's), else, for an SSH row whose fallback
 * is not retired, the shared legacy path, copied into planPath (adoptSharedLegacyPlan).
 */
export async function readPlanFile(
  runtime: Runtime,
  location: PlanFileLocation
): Promise<ReadPlanResult> {
  const { planPath, legacyIdPath: legacyPath } = location;

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
  }
  // Fall back to legacy path
  try {
    const content = await readFileString(runtime, legacyPath, undefined, planReadOptions);
    // Migrate: move to new location.
    try {
      const planDir = planPath.substring(0, planPath.lastIndexOf("/"));
      await execBuffered(runtime, 'mkdir -p "$XUM_PLAN_DIR" && mv "$XUM_LEGACY_PLAN" "$XUM_PLAN"', {
        cwd: "/tmp",
        pathEnv: {
          XUM_PLAN_DIR: planDir,
          XUM_LEGACY_PLAN: legacyPath,
          XUM_PLAN: planPath,
        },
        timeout: 5,
      });
    } catch {
      // Migration failed, but we have the content
    }
    return { content, exists: true, path: resolvedPath };
  } catch (error) {
    if (isRuntimeTransportError(error)) throw error;
  }
  const adopted = await adoptSharedLegacyPlan(runtime, location);
  return adopted === undefined
    ? { content: "", exists: false, path: resolvedPath }
    : { content: adopted, exists: true, path: resolvedPath };
}

/**
 * Copy the shared legacy plan into planPath (#5174), under the workspace's legacy-plan lock.
 * "copied" and "exists" mean planPath now holds the plan as a regular file ("exists": a plan was
 * already there, a concurrent adoption or the agent's write, and it wins); "absent" means no
 * regular legacy file. Throws when the copy fails, or when something other than a regular file
 * squats at planPath (a reader would not take it as the plan), leaving planPath untouched.
 *
 * Copied, never moved: another installation on the host, or an older build of this one, may use
 * the legacy file, so Xum never deletes or writes it. The copy is hard-linked into place from a
 * temp file, so it never overwrites a plan already at planPath and never leaves a partial file.
 */
async function copySharedLegacyPlan(
  runtime: Runtime,
  legacyPath: string,
  planPath: string
): Promise<"copied" | "exists" | "absent"> {
  const result = await execBuffered(
    runtime,
    'mkdir -p "$XUM_PLAN_DIR" || exit 1; [ -f "$XUM_PLAN" ] && exit 3; ' +
      '{ [ -e "$XUM_PLAN" ] || [ -L "$XUM_PLAN" ]; } && exit 5; ' +
      '[ -f "$XUM_SHARED_LEGACY_PLAN" ] || exit 4; t="$XUM_PLAN.adopt.$$"; ' +
      'if cp -- "$XUM_SHARED_LEGACY_PLAN" "$t"; then ln -- "$t" "$XUM_PLAN"; r=$?; else r=1; fi; ' +
      'rm -f -- "$t"; [ "$r" -eq 0 ] && exit 0; [ -f "$XUM_PLAN" ] && exit 3; exit 1',
    {
      cwd: "/tmp",
      pathEnv: {
        XUM_PLAN_DIR: planPath.substring(0, planPath.lastIndexOf("/")),
        XUM_SHARED_LEGACY_PLAN: legacyPath,
        XUM_PLAN: planPath,
      },
      timeout: 5,
    }
  );
  throwIfTransportFailure(runtime, result, "Failed to copy the legacy plan file");
  if (result.exitCode === 0) return "copied";
  if (result.exitCode === 3) return "exists";
  if (result.exitCode === 4) return "absent";
  throw new RuntimeError(
    result.exitCode === 5
      ? `Cannot copy the legacy plan file ${legacyPath}: ${planPath} exists and is not a regular file`
      : `Failed to copy the legacy plan file ${legacyPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    "file_io"
  );
}

/**
 * For an SSH row from an older build whose plan sits at the shared legacy path
 * plans/<basename>/<name>.md (#5174): copy it into planPath (copySharedLegacyPlan), then retire the
 * row's fallback, and return the plan now at planPath; undefined when there is no fallback or no
 * regular file there.
 *
 * The copy and the retirement run under the workspace's legacy-plan lock, re-checking the flag
 * first, so a full clear (which retires under that lock before deleting planPath) cannot be undone
 * by a read that started before it. The copy comes before the retirement: the copy shadows the
 * legacy file from the moment it exists, so a crash between the two cannot revive anything, while
 * retiring first would make a failed copy lose the plan. The content is read back from planPath
 * before the retirement, so it is the plan on disk even if the legacy file changed during the copy.
 * A copy or read back that fails returns the legacy content read-only and retires nothing, so the
 * next read tries again.
 */
export async function adoptSharedLegacyPlan(
  runtime: Runtime,
  location: PlanFileLocation
): Promise<string | undefined> {
  const fallback = location.sharedLegacy;
  if (fallback === undefined || fallback.isRetired()) return undefined;
  const readOptions: ReadFileOptions = { requireRegularFile: true };
  // A cheap probe outside the lock: rows with no legacy plan never take it.
  let content: string;
  try {
    content = await readFileString(runtime, fallback.path, undefined, readOptions);
  } catch (error) {
    if (isRuntimeTransportError(error)) throw error;
    return undefined;
  }
  const planPath = location.planPath;
  try {
    return await fallback.exclusive(async () => {
      // A clear may have retired the fallback (and deleted planPath) since the check above.
      if (fallback.isRetired()) return undefined;
      if ((await copySharedLegacyPlan(runtime, fallback.path, planPath)) === "absent") {
        return undefined;
      }
      // Retire only once the plan at planPath reads back: a failed read keeps the fallback open.
      const plan = await readFileString(runtime, planPath, undefined, readOptions);
      // planPath now shadows the legacy file, so a failed flag write only leaves the retirement
      // to the next read or clear; the plan is still the file just read.
      await fallback.retire().catch((error: unknown) => {
        log.warn("Failed to retire the legacy plan fallback after adopting it", {
          planPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return plan;
    });
  } catch (error) {
    if (isRuntimeTransportError(error)) throw error;
    // The lock, the copy or the read back failed: the legacy content, read-only, nothing retired.
    return content;
  }
}

/**
 * Retire a row's shared legacy fallback (#5174) for an operation after which the row no longer
 * reads it (a rename: under the new name the legacy path is another file), first copying the
 * legacy plan into planPath so the operation carries it on. Under the legacy-plan lock with the
 * flag re-checked, like adoptSharedLegacyPlan. Throws, retiring nothing, when the copy fails:
 * the caller must refuse rather than retire a fallback whose plan it could not keep.
 */
export async function retireSharedLegacyPlan(
  runtime: Runtime,
  location: PlanFileLocation
): Promise<void> {
  const fallback = location.sharedLegacy;
  if (fallback === undefined || fallback.isRetired()) return;
  await fallback.exclusive(async () => {
    if (fallback.isRetired()) return;
    await copySharedLegacyPlan(runtime, fallback.path, location.planPath);
    await fallback.retire();
  });
}

/**
 * Move a plan file from one workspace name to another (e.g., during rename).
 * Silently succeeds if source file doesn't exist. Throws when the source could
 * not be probed in transport or the move itself failed, so a caller never
 * reports a moved plan that stayed behind (#4826).
 *
 * Both paths are plan paths (planLocation.ts, one directory). A shared legacy SSH plan must already
 * be in the old plan path (retireSharedLegacyPlan): this moves only that file.
 */
export async function movePlanFile(
  runtime: Runtime,
  oldPath: string,
  newPath: string
): Promise<void> {
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

/**
 * Copy a plan file across runtimes (e.g., during fork where source/target may be
 * different containers). Uses separate runtime handles to avoid the identity mutation
 * bug where DockerRuntime.forkWorkspace() changes this.containerName to the target.
 * Silently succeeds if no regular source file exists at either location. Throws
 * when a source read fails in transport or the target write fails, so a fork
 * never proceeds without a plan it could not copy (#4826). Returns the target path
 * only when this copy created it, so a rollback deletes only a file it made (#4775).
 */
export async function copyPlanFileAcrossRuntimes(
  sourceRuntime: Runtime,
  targetRuntime: Runtime,
  sourceLocation: PlanFileLocation,
  targetPath: string
): Promise<string | undefined> {
  // Every path that holds the source's plan, the shared legacy one (read-only) included.
  for (const candidatePath of planReadPaths(sourceLocation)) {
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
    // A plan already at the target is not this copy's. fork() copies only after its registration
    // write holds the name in its plan directory (#5175), so no live workspace this installation's
    // config knows owns the target: the overwrite can replace only an orphan of a removed workspace
    // (older builds, failed or skipped deletions) or the plan of a row this installation cannot see
    // (another installation on the same SSH host, #5174). A filesystem-level no-clobber copy is
    // #5487. A probe that fails in transport counts as existing.
    const targetExisted = await targetRuntime.stat(targetPath).then(
      () => true,
      (error: unknown) => isRuntimeTransportError(error)
    );
    await writeFileString(targetRuntime, targetPath, content);
    return targetExisted ? undefined : targetPath;
  }
  return undefined;
}
