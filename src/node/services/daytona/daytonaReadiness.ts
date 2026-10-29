import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

/**
 * How long a successful readiness check is trusted. Runtimes are recreated per stream start, so
 * the cache lives here, keyed by sandbox, rather than on a runtime instance.
 */
export const DAYTONA_READY_CACHE_MS = 60_000;

export interface DaytonaEnsureReadyOptions {
  /** Called when the sandbox has to be started (it was stopped or archived). */
  onStarting?: () => void;
  /** Stops this caller's wait (and its onStarting calls); the shared request goes on. */
  signal?: AbortSignal;
}

/**
 * Which sandboxes passed a readiness check within DAYTONA_READY_CACHE_MS, and the readiness
 * request in flight per sandbox. The sandbox part runs the checks; a stop, a resize, a token
 * change or a release of ssh access voids them.
 */
export class DaytonaReadiness {
  private readonly readyAt = new Map<string, number>();
  private readonly readyRequests = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number) {}

  /** Whether a readiness check for this sandbox passed within DAYTONA_READY_CACHE_MS. */
  isSandboxReady(sandboxName: string): boolean {
    const at = this.readyAt.get(sandboxName);
    return at !== undefined && this.now() - at < DAYTONA_READY_CACHE_MS;
  }

  markSandboxReady(sandboxName: string): void {
    this.readyAt.set(sandboxName, this.now());
  }

  /** An ssh connection failed: the sandbox may have stopped within the ready cache. */
  invalidateSandboxReady(sandboxName: string): void {
    this.readyAt.delete(sandboxName);
  }

  invalidateAll(): void {
    this.readyAt.clear();
  }

  /**
   * Wait for the sandbox's readiness request, starting `run` as that request when none is in
   * flight. Concurrent callers share a single request; only the caller that started it hears
   * `onStarting`, through the callback `run` gets.
   */
  async join(
    sandboxName: string,
    options: DaytonaEnsureReadyOptions,
    run: (onStarting: () => void) => Promise<void>
  ): Promise<void> {
    let request = this.readyRequests.get(sandboxName);
    if (!request) {
      // A cancelled caller hears no later start: nothing would report its end.
      request = run(() => {
        if (!options.signal?.aborted) options.onStarting?.();
      }).finally(() => this.readyRequests.delete(sandboxName));
      this.readyRequests.set(sandboxName, request);
    }
    const raced = await raceWithAbortAndTimeout(request, { signal: options.signal });
    if (raced.kind !== "ok") throw new Error("Aborted");
  }

  /**
   * Settle the readiness request in flight for this sandbox, if any. Its start and mint would
   * otherwise land after a stop or a release and undo it. Bounded by the start timeout; its
   * failure belongs to its own callers, so it is only logged here.
   */
  async waitForSandboxReadiness(sandboxName: string): Promise<void> {
    const request = this.readyRequests.get(sandboxName);
    if (!request) return;
    try {
      await request;
    } catch (error) {
      log.warn("Daytona sandbox readiness failed while another operation waited for it", {
        sandboxName,
        error: getErrorMessage(error),
      });
    }
  }
}
