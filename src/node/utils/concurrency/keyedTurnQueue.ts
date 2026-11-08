import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

/**
 * Runs jobs one at a time per key, in call order; jobs of different keys do not wait for each
 * other. Unlike `MutexMap`, a waiter can be cancelled: when its `signal` aborts before its turn,
 * its job never starts and `run` returns null.
 *
 * Callers pass a `signal` that is not their job's own timeout, and build that timeout inside
 * the job, so a timeout covers the job and never the wait behind other jobs.
 */
export class KeyedTurnQueue {
  /**
   * Per key, settles once the last queued job has ended or was cancelled and everything ahead of
   * it has settled. Never rejects, so a failed job cannot wedge the keys behind it.
   */
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, signal: AbortSignal, job: () => Promise<T>): Promise<T | null> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Linked before the first await so queue order is call order. A cancelled waiter still
    // releases its link, but the tail chains onto `previous`, so nothing behind it passes the
    // job that is still running ahead of it.
    const tail = previous.then(() => turnDone);
    this.tails.set(key, tail);
    // Drop the key once it is idle, so keys that never run again do not pile up.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    try {
      const turn = await raceWithAbortAndTimeout(previous, { signal });
      if (turn.kind === "aborted") return null;
      return await job();
    } finally {
      release();
    }
  }
}
