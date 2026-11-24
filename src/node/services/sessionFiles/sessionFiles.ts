/**
 * The host file calls of the history layer, as one service (phase 2).
 *
 * The members are exactly the node:fs subset that the history files call today
 * (historyService.ts, historyAppendProvenance.ts, historyScanner.ts, historyReplacementRows.ts,
 * sendIds.ts, compactionPendingState.ts, compactionCancellation.ts,
 * continuousCompactionJournal.ts, and extractStagedAttachmentPathsFromFile), with their node:fs
 * signatures, plus the three helpers they use. Add a member only when one of those files starts
 * to call it. Type-only imports keep this module free of runtime dependencies, so di/tags.ts can
 * import it without a cycle.
 */
import type * as nodeFs from "node:fs";
import type * as nodeFsPromises from "node:fs/promises";
import type { Options as WriteFileAtomicOptions } from "@/node/utils/writeFileAtomic";

export interface SessionFiles {
  readonly promises: Pick<
    typeof nodeFsPromises,
    | "access"
    | "appendFile"
    | "mkdir"
    | "open"
    | "readdir"
    | "readFile"
    | "rename"
    | "rm"
    | "rmdir"
    | "stat"
    | "unlink"
    // The auto-retry preference of agentSession.ts, a plain write that tests spy on.
    | "writeFile"
  >;
  readonly constants: typeof nodeFs.constants;
  // Sync on purpose: the callers keep no await between an ownership check and the write.
  readonly fsyncSync: typeof nodeFs.fsyncSync;
  readonly renameSync: typeof nodeFs.renameSync;
  readonly rmdirSync: typeof nodeFs.rmdirSync;
  readonly rmSync: typeof nodeFs.rmSync;
  readonly unlinkSync: typeof nodeFs.unlinkSync;
  readonly writeSync: typeof nodeFs.writeSync;
  // The helpers of src/node/utils, which the history files call today.
  writeFileAtomic(
    path: string,
    data: string | Buffer,
    options?: WriteFileAtomicOptions
  ): Promise<void>;
  fsyncParentDirectory(target: string): Promise<void>;
  ensurePrivateDir(dirPath: string): Promise<void>;
}
