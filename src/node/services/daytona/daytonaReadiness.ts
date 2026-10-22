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

interface SandboxReadyRequest {
  promise: Promise<void>;
  onStarting: Set<() => void>;
  starting: boolean;
}

/** Register a waiter's onStarting, calling it at once when the shared start already began. */
function addStartingListener(
  request: SandboxReadyRequest,
  options: DaytonaEnsureReadyOptions
): (() => void) | undefined {
  const { onStarting, signal } = options;
  if (!onStarting || signal?.aborted) return undefined;
  // Per waiter, so the same callback passed twice is two waiters.
  const listener = () => onStarting();
  request.onStarting.add(listener);
  if (request.starting) listener();
  return listener;
}

/**
 * Which sandboxes passed a readiness check within DAYTONA_READY_CACHE_MS, and the readiness
 * request in flight per sandbox. The sandbox part runs the checks; a stop, a resize, a token
 * change or a release of ssh access voids them.
 */
export class DaytonaReadiness {
  private readonly readyAt = new Map<string, number>();
  private readonly readyRequests = new Map<string, SandboxReadyRequest>();

  constructor(private readonly now: () => number) {}

  /** Whether a readiness check for this sandbox passed within DAYTONA_READY_CACHE_MS. */
  isSandboxReady(sandboxId: string): boolean {
    const at = this.readyAt.get(sandboxId);
    return at !== undefined && this.now() - at < DAYTONA_READY_CACHE_MS;
  }

  markSandboxReady(sandboxId: string): void {
    this.readyAt.set(sandboxId, this.now());
  }

  /** An ssh connection failed: the sandbox may have stopped within the ready cache. */
  invalidateSandboxReady(sandboxId: string): void {
    this.readyAt.delete(sandboxId);
  }

  invalidateAll(): void {
    this.readyAt.clear();
  }

  /**
   * Wait for the sandbox's readiness request, starting `run` as that request when none is in
   * flight. Concurrent callers share a single request; each still gets its own `onStarting`
   * call. `run` reports a start through the callback it gets.
   */
  async join(
    sandboxId: string,
    options: DaytonaEnsureReadyOptions,
    run: (onStarting: () => void) => Promise<void>
  ): Promise<void> {
    const request = this.readyRequests.get(sandboxId) ?? this.startRequest(sandboxId, run);
    const listener = addStartingListener(request, options);
    try {
      const raced = await raceWithAbortAndTimeout(request.promise, { signal: options.signal });
      if (raced.kind !== "ok") throw new Error("Aborted");
    } finally {
      // A waiter that stopped waiting (cancelled) hears no later start: nothing would report its end.
      if (listener) request.onStarting.delete(listener);
    }
  }

  private startRequest(
    sandboxId: string,
    run: (onStarting: () => void) => Promise<void>
  ): SandboxReadyRequest {
    const request: SandboxReadyRequest = {
      promise: Promise.resolve(),
      onStarting: new Set(),
      starting: false,
    };
    request.promise = run(() => {
      request.starting = true;
      for (const listener of request.onStarting) listener();
    }).finally(() => {
      this.readyRequests.delete(sandboxId);
    });
    this.readyRequests.set(sandboxId, request);
    return request;
  }

  /**
   * Settle the readiness request in flight for this sandbox, if any. Its start and mint would
   * otherwise land after a stop or a release and undo it. Bounded by the start timeout; its
   * failure belongs to its own callers, so it is only logged here.
   */
  async waitForSandboxReadiness(sandboxId: string): Promise<void> {
    const request = this.readyRequests.get(sandboxId);
    if (!request) return;
    try {
      await request.promise;
    } catch (error) {
      log.warn("Daytona sandbox readiness failed while another operation waited for it", {
        sandboxId,
        error: getErrorMessage(error),
      });
    }
  }
}
