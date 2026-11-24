import assert from "@/common/utils/assert";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Longest synchronous stretch a yielding loop runs before it lets the event loop turn. Short
 * enough that timers and IPC keep flowing, long enough that the yield cost is negligible.
 */
export const EVENT_LOOP_YIELD_BUDGET_MS = 50;

/**
 * Lets long CPU-bound loops (parsing or replaying a multi-hundred-MB chat epoch) give the event
 * loop a turn. Without it the loop starves timers, so subscription heartbeats cannot fire and
 * the renderer's stall watchdog aborts a replay that is still progressing (#4506).
 *
 * Usage inside an async loop: `if (yielder.isDue()) await yielder.yield();`
 */
export class EventLoopYielder {
  private lastYieldAt = performance.now();

  constructor(private readonly budgetMs = EVENT_LOOP_YIELD_BUDGET_MS) {
    assert(budgetMs > 0, "EventLoopYielder budget must be positive");
  }

  /** True once the current synchronous stretch has used its budget. */
  isDue(): boolean {
    return performance.now() - this.lastYieldAt >= this.budgetMs;
  }

  /**
   * Resume on a later loop turn, after already-due timers and I/O callbacks have run. A timer
   * (not setImmediate) because an immediate can run before due timers, which would leave the
   * heartbeat starved for another stretch.
   */
  async yield(): Promise<void> {
    await sleep(0);
    this.lastYieldAt = performance.now();
  }
}
