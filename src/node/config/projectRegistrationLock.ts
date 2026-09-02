import * as path from "node:path";

/**
 * Serializes changes to the set of registered projects with a settings-backup restore that
 * writes project memory. The restore decides which local project each backed-up entry
 * belongs to at its write boundary, and neither an unregistration (restored notes would land
 * in a scope no project reads) nor a registration at a backed-up source path (the entry
 * would now belong to a different local project) may land underneath it before the memory
 * does.
 *
 * Every registration change reaches config.json through `Config.editConfig`, which takes
 * this lock itself — so no writer has to know about it, whichever service the write comes
 * from. The restore and the import hold it around their windows; `ProjectService.create`
 * holds it so an import can register inside its own window (`Config.editConfig`'s
 * `withinRegistrationLock` option marks those edits). Registration takes no memory lock and
 * the restore takes this before the memory lock, so the order is fixed.
 *
 * Not a `MutexMap`: when the lock is free, `fn` runs on the caller's stack. `Config.editConfig`
 * relies on that so an edit taken under the lock keeps its place in the config edit queue
 * relative to edits issued around it; a microtask hop here would reorder them.
 *
 * In-process only, deliberately: config.json is owned by one main process per root, so
 * there is no cross-process writer to exclude, and a restore window can outlast a fail-fast
 * cross-process lock timeout — a registration change should wait for it, not fail.
 */
const held = new Map<string, Promise<void>>();

export function isProjectRegistrationLockHeld(muxRoot: string): boolean {
  return held.has(path.resolve(muxRoot));
}

export function withProjectRegistrationLock<T>(muxRoot: string, fn: () => Promise<T>): Promise<T> {
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
