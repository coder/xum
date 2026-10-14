interface CatalogChangeOptions {
  relist: () => Promise<unknown>;
  report: () => void;
  minIntervalMs: number;
  maxRetries: number;
}

/**
 * Coalesce a server's notifications/tools/list_changed (MCP App entry points follow the
 * catalog). Each change needs a tools/list to that server and a re-list of the workspace's
 * entry points, so a server that floods the notification must not drive a loop: at most one
 * re-list starts per `minIntervalMs`. A change during a re-list or inside the interval gets
 * one trailing re-list, so the last change is never lost. A failed re-list is not reported
 * (the catalog did not change for Xum) and is retried after the interval, at most
 * `maxRetries` times in a row.
 */
export function coalesceCatalogChanges(options: CatalogChangeOptions): {
  notify: () => void;
  dispose: () => void;
} {
  const changes = new CatalogChanges(options);
  return { notify: () => changes.notify(), dispose: () => changes.dispose() };
}

class CatalogChanges {
  private lastStartAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending = false;
  private failures = 0;
  private disposed = false;

  constructor(private readonly options: CatalogChangeOptions) {}

  notify(): void {
    this.pending = true;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.disposed || this.running || this.timer !== null) return;
    const wait = this.lastStartAt + this.options.minIntervalMs - Date.now();
    if (wait <= 0) {
      this.start();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, wait);
    this.timer.unref?.();
  }

  /** `run` never rejects (it catches every failure), so starting it detached loses nothing. */
  private start(): void {
    this.run().catch(() => undefined);
  }

  private async run(): Promise<void> {
    this.running = true;
    this.pending = false;
    this.lastStartAt = Date.now();
    try {
      await this.options.relist();
      this.failures = 0;
      this.options.report();
    } catch {
      this.failed();
    } finally {
      this.running = false;
      if (this.pending) this.schedule();
    }
  }

  /** Retry after the interval; give up after maxRetries (the next notification starts over). */
  private failed(): void {
    this.failures += 1;
    if (this.failures <= this.options.maxRetries) this.pending = true;
    else this.failures = 0;
  }
}
