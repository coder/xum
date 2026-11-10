import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Opt-in directory: when it exists under the Xum root, `xum server` asks V8 for one heap
 * snapshot near the heap limit. The user creates it to opt in, and moves a written snapshot
 * into it by hand. A snapshot holds everything in server memory, secrets included.
 */
export const OOM_HEAP_SNAPSHOT_DIR_NAME = "heap-snapshots";

/** Longest that server startup waits for this check; it never holds startup longer. */
export const OOM_HEAP_SNAPSHOT_STARTUP_WAIT_MS = 5_000;

/** Node's own file names for near-heap-limit snapshots (Heap.<date>.<time>.<pid>.<tid>.<seq>). */
const NODE_HEAP_SNAPSHOT_NAME = /^Heap\.\d{8}\.\d{6}\.\d+\.\d+\.\d+\.heapsnapshot$/;

export type OomHeapSnapshotLogDetails = Record<string, string | string[]>;

export interface OomHeapSnapshotDeps {
  xumHome: string;
  /** Read inside the guarded path: process.cwd() throws when the launch directory is gone. */
  cwd: () => string;
  setHeapSnapshotNearHeapLimit: (limit: number) => void;
  /** The `log` helper: info keeps the status in mux.log, warn reports failures. */
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

/**
 * Prints like the `xum server` startup banner and also logs it. `xum server` (CLI mode) logs at
 * "error" by default, so log.info alone never reached the console and the live log could not
 * confirm arming; log.info still keeps the record in mux.log.
 */
function reportStatus(
  log: OomHeapSnapshotDeps["log"],
  message: string,
  details: OomHeapSnapshotLogDetails
): void {
  console.log(`${message} ${JSON.stringify(details)}`);
  log.info(message, details);
}

async function snapshotsIn(dir: string): Promise<string[]> {
  return (await fs.readdir(dir))
    .filter((name) => NODE_HEAP_SNAPSHOT_NAME.test(name))
    .map((name) => path.join(dir, name));
}

/**
 * Called once at `xum server` startup. Node writes a near-heap-limit snapshot into
 * process.cwd() (`--diagnostic-dir` is CLI-only, and the live server's NODE_OPTIONS come from
 * a shared template). Xum never moves or touches that file: the user moves it by hand. Any
 * snapshot already in cwd or the opt-in directory leaves the server unarmed, so a crash loop
 * writes at most one multi-GB file. Never throws: startup must not fail because of this.
 */
export async function prepareOomHeapSnapshots(deps: OomHeapSnapshotDeps): Promise<void> {
  const snapshotDir = path.join(deps.xumHome, OOM_HEAP_SNAPSHOT_DIR_NAME);
  try {
    if (!(await isDirectory(snapshotDir))) return;
    const cwd = path.resolve(deps.cwd());
    const existing = [...(await snapshotsIn(cwd)), ...(await snapshotsIn(snapshotDir))];
    if (existing.length > 0) {
      reportStatus(
        deps.log,
        "[heap-snapshot] Not armed: a heap snapshot already exists; remove it to arm",
        {
          files: existing,
        }
      );
      return;
    }
    // A CLI --heapsnapshot-near-heap-limit takes precedence; this call then changes nothing.
    deps.setHeapSnapshotNearHeapLimit(1);
    reportStatus(
      deps.log,
      "[heap-snapshot] Armed: Node writes a heap snapshot near the heap limit",
      {
        cwd,
      }
    );
  } catch (error) {
    deps.log.warn("[heap-snapshot] Near-heap-limit snapshot setup failed", {
      error: getErrorMessage(error),
    });
  }
}
