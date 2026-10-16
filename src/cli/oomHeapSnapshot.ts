import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Opt-in directory: when it exists under the Xum root, `xum server` asks V8 for one heap
 * snapshot near the heap limit, and keeps snapshots there. The user creates it to opt in.
 * A snapshot holds everything in server memory, secrets included, so the directory is
 * expected to be 0700 and every moved file is set to 0600.
 */
export const OOM_HEAP_SNAPSHOT_DIR_NAME = "heap-snapshots";

/** Node's own file names for near-heap-limit snapshots (Heap.<date>.<time>.<pid>.<tid>.<seq>). */
const NODE_HEAP_SNAPSHOT_NAME = /^Heap\.\d{8}\.\d{6}\.\d+\.\d+\.\d+\.heapsnapshot$/;

export type OomHeapSnapshotLogDetails = Record<string, string | string[]>;

export interface OomHeapSnapshotDeps {
  xumHome: string;
  cwd: string;
  setHeapSnapshotNearHeapLimit: (limit: number) => void;
  /** Same shape as the `log` helper's info/warn: a message plus structured details. */
  log: {
    info: (message: string, details: OomHeapSnapshotLogDetails) => void;
    warn: (message: string, details: OomHeapSnapshotLogDetails) => void;
  };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Moves one snapshot; never deletes a file and never overwrites one already kept. */
async function moveSnapshot(source: string, target: string): Promise<void> {
  if (await exists(target)) throw new Error(`${target} already exists`);
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Another device: copy, and keep the source (a snapshot is never deleted).
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
  await fs.chmod(target, 0o600);
}

/**
 * Called once at `xum server` startup. Node writes a near-heap-limit snapshot into
 * process.cwd() (`--diagnostic-dir` is CLI-only, and the live server's NODE_OPTIONS come from
 * a shared template), so a snapshot from the OOM that caused this restart is moved first.
 * Never throws: startup must not fail because of this diagnostic.
 */
export async function prepareOomHeapSnapshots(deps: OomHeapSnapshotDeps): Promise<void> {
  const snapshotDir = path.join(deps.xumHome, OOM_HEAP_SNAPSHOT_DIR_NAME);
  try {
    if (!(await isDirectory(snapshotDir))) return;
    const moved: string[] = [];
    for (const name of await fs.readdir(deps.cwd)) {
      if (!NODE_HEAP_SNAPSHOT_NAME.test(name)) continue;
      try {
        await moveSnapshot(path.join(deps.cwd, name), path.join(snapshotDir, name));
        moved.push(name);
      } catch (error) {
        deps.log.warn("[heap-snapshot] Could not move a heap snapshot", {
          name,
          error: getErrorMessage(error),
        });
      }
    }
    if (moved.length > 0) {
      deps.log.info("[heap-snapshot] Moved heap snapshots", { snapshotDir, files: moved });
    }
    // A CLI --heapsnapshot-near-heap-limit takes precedence; this call then changes nothing.
    deps.setHeapSnapshotNearHeapLimit(1);
    deps.log.info("[heap-snapshot] A heap snapshot will be written near the heap limit", {
      cwd: deps.cwd,
      snapshotDir,
    });
  } catch (error) {
    deps.log.warn("[heap-snapshot] Near-heap-limit snapshot setup failed", {
      error: getErrorMessage(error),
    });
  }
}
