import { Layer } from "effect";
import { SessionLocksTag } from "@/node/services/di/tags";
import { workspaceUseLeasesFor } from "@/node/services/workspaceUseLeases";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import {
  acquireCrossProcessLock,
  inspectCrossProcessLock,
} from "@/node/utils/main/crossProcessLock";
import type { SessionLocks } from "./sessionLocks";

/**
 * The real session locks: today's lock functions themselves. The arrow
 * functions read each import at call time, so spies on the lock modules (the
 * call record, older tests) still reach the call.
 */
export const nodeSessionLocks: SessionLocks = {
  // The one MutexMap that every session-file service shares: a second map would
  // let two writers of one workspace run at once.
  workspaceFiles: workspaceFileLocks,
  acquireProcessFileLock: (options) => acquireProcessFileLock(options),
  acquireCrossProcessLock: (options) => acquireCrossProcessLock(options),
  inspectCrossProcessLock: (lockPath) => inspectCrossProcessLock(lockPath),
  useLeasesFor: (config) => workspaceUseLeasesFor(config),
};

/** StoresLive provides it, so the app always gets the Node layer. */
export const SessionLocksNode = Layer.succeed(SessionLocksTag)(nodeSessionLocks);
