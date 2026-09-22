import * as fs from "node:fs";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/**
 * Drain readers parked on a writer-less FIFO until every OWNED read attempt has settled.
 *
 * On a RED run of the regular-file regression every libuv worker is parked in a blocking FIFO
 * open(), so async fs calls (lstat, fs.promises.open) would queue behind the very readers they are
 * meant to release. The write-open here is synchronous and O_NONBLOCK: it never touches the pool
 * and either succeeds (a reader holds/awaits the FIFO — the parked open() returns, the reader then
 * reads EOF and frees its worker) or fails with ENXIO (nobody is there right now). Between
 * attempts the loop yields to the event loop so the released readers' JS callbacks can run and
 * the reads still queued behind pinned workers can reach open(). Termination is the actual
 * settlement of `attempts`, not a quiet period; `deadlineMs` is only a failure bound.
 *
 * `writerOpens` counts successful write-opens (a diagnostic, not a reader count: a write-open also
 * succeeds while an already-released reader still holds its descriptor).
 */
export async function drainFifoReaders(
  fifoPath: string,
  attempts: ReadonlyArray<Promise<unknown>>,
  deadlineMs = 30_000
): Promise<{ settled: boolean; writerOpens: number }> {
  let settled = false;
  const allSettled = Promise.allSettled(attempts).then(() => {
    settled = true;
  });
  const deadline = Date.now() + deadlineMs;
  let writerOpens = 0;
  let releasable = true;
  while (!settled) {
    if (Date.now() > deadline) return { settled: false, writerOpens };
    if (releasable) {
      try {
        fs.closeSync(fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        writerOpens++;
      } catch (err) {
        // ENXIO: nothing waiting at this instant — keep yielding. Anything else (ENOENT, not a
        // FIFO) means write-opens cannot release anyone; just wait for settlement or the deadline.
        if ((err as NodeJS.ErrnoException).code !== "ENXIO") releasable = false;
      }
    }
    await yieldToEventLoop();
  }
  await allSettled;
  return { settled: true, writerOpens };
}
