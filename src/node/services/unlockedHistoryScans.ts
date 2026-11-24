import * as path from "node:path";

/**
 * History files that scans running after the history lock is released hold open
 * (HistoryService.getStatusHistorySuffix).
 *
 * Windows rename cannot replace a destination another handle holds open. The history
 * publications rename synchronously with their ownership/isCurrent check and receipt, so they
 * cannot retry, and truncations also unlink and rename these files; both wait here first. They
 * hold the in-process history mutex, so no new scan can register while they wait, and in-flight
 * scans release on close without needing the mutex.
 */
interface TrackedPath {
  readers: number;
  waiters: Array<() => void>;
}

const tracked = new Map<string, TrackedPath>();

export const unlockedHistoryScans = {
  /** Registers open descriptors on `paths`; the returned release is idempotent. */
  track(paths: readonly string[]): () => void {
    const keys = paths.map((filePath) => path.resolve(filePath));
    for (const key of keys) {
      const entry = tracked.get(key) ?? { readers: 0, waiters: [] };
      entry.readers += 1;
      tracked.set(key, entry);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const entry = tracked.get(key);
        if (!entry || --entry.readers > 0) continue;
        tracked.delete(key);
        for (const wake of entry.waiters) wake();
      }
    };
  },

  /** Resolves once no tracked scan holds `filePath` open. */
  waitForClose(filePath: string): Promise<void> {
    const entry = tracked.get(path.resolve(filePath));
    if (!entry) return Promise.resolve();
    return new Promise((resolve) => entry.waiters.push(resolve));
  },
};
