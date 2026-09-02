import * as path from "node:path";

import { acquireProcessFileLock, type ProcessFileLock } from "@/node/utils/concurrency/fileLock";

/**
 * Serializes changes to the set of registered projects with a settings-backup restore that
 * writes project memory. The restore decides which local project each backed-up entry
 * belongs to at its write boundary, and neither an unregistration (restored notes would land
 * in a scope no project reads) nor a registration at a backed-up source path (the entry
 * would now belong to a different local project) may land underneath it before the memory
 * does.
 *
 * Two legs. The in-process mutex serializes this process's own windows and edits and has a
 * synchronous free path — `Config.editConfig` relies on that so an edit taken under it keeps
 * its place in the config edit queue relative to edits issued around it. The cross-process
 * file lock excludes other processes' registration writers: config.json is edited by the
 * desktop or server process, but also by standalone CLIs (`mux trust` creates a project entry
 * when the project was never added), each through its own `Config`. Every registration change
 * reaches config.json through `Config.editConfig`, which takes both legs itself whenever a
 * transform adds or removes a project key — so no writer has to know about them, whichever
 * process or service the write comes from. Restore and import windows hold both legs; edits
 * issued inside such a window pass `withinRegistrationLock` and take neither, since neither
 * leg is reentrant.
 *
 * Registration takes no memory lock and the restore takes this before the memory lock, so
 * the order is fixed.
 */
const held = new Map<string, Promise<void>>();

/**
 * Bound on waiting for another process's registration hold. A restore window covers the
 * local write phase only (snapshot, core files, matched memory), normally well under a
 * second; a CLI hold is a single config write. Generous, because the alternative for the
 * waiter is to fail an explicit user action.
 */
export const PROJECT_REGISTRATION_FILE_LOCK_TIMEOUT_MS = 60_000;

export function projectRegistrationLockFilePath(muxRoot: string): string {
  return path.join(muxRoot, "locks", "project-registration.lock");
}

export function isProjectRegistrationMutexHeld(muxRoot: string): boolean {
  return held.has(path.resolve(muxRoot));
}

/** In-process leg only; runs `fn` on the caller's stack when the mutex is free. */
export function withProjectRegistrationMutex<T>(muxRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(muxRoot);
  const previous = held.get(key);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Recorded before any await, so a second caller arriving meanwhile queues behind us.
  held.set(key, mine);
  const run = async (): Promise<T> => {
    try {
      return await fn();
    } finally {
      release();
      if (held.get(key) === mine) held.delete(key);
    }
  };
  return previous === undefined ? run() : previous.then(run);
}

/**
 * What a holder of the cross-process leg gets to work with. `assertStillOwned` re-reads the
 * lockfile and throws when this process no longer holds it: a holder frozen past the lease
 * (a suspended laptop, a stalled event loop) can be judged stale and displaced by another
 * process, and must not go on committing as if it still held the lock. Called immediately
 * before every irreversible write made under the lock — a config.json save that changes the
 * project set, the core restore, each project's memory write.
 */
export interface ProjectRegistrationLockHandle {
  assertStillOwned(): Promise<void>;
}

/** Cross-process leg only; the caller must already hold the in-process mutex. */
export async function withProjectRegistrationFileLock<T>(
  muxRoot: string,
  fn: (lock: ProjectRegistrationLockHandle) => Promise<T>
): Promise<T> {
  await using lock = await acquireProcessFileLock({
    lockPath: projectRegistrationLockFilePath(muxRoot),
    timeoutMs: PROJECT_REGISTRATION_FILE_LOCK_TIMEOUT_MS,
    label: "project registration lock",
  });
  return await fn(lock);
}

/**
 * The cross-process leg without waiting: the lock, or null when another process holds it.
 * `Config.editConfig` uses this inside its queue slot so an uncontended registration write
 * keeps its place in the edit queue, and only a contended one steps out of the queue to wait.
 */
export async function tryProjectRegistrationFileLock(
  muxRoot: string
): Promise<ProcessFileLock | null> {
  try {
    // The acquisition attempts the link before checking the deadline, so this is one attempt.
    return await acquireProcessFileLock({
      lockPath: projectRegistrationLockFilePath(muxRoot),
      timeoutMs: 1,
      label: "project registration lock",
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out acquiring")) return null;
    throw error;
  }
}

/** Both legs, in the fixed order: the window a restore or import runs in. */
export function withProjectRegistrationLock<T>(
  muxRoot: string,
  fn: (lock: ProjectRegistrationLockHandle) => Promise<T>
): Promise<T> {
  return withProjectRegistrationMutex(muxRoot, () => withProjectRegistrationFileLock(muxRoot, fn));
}
