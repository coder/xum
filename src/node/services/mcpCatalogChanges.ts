/**
 * Coalesce a server's notifications/tools/list_changed (MCP App entry points follow the
 * catalog). Each change needs a tools/list to that server and a re-list of the workspace's
 * entry points, so a server that floods the notification must not drive a loop: at most one
 * re-list starts per `minIntervalMs`. A change during a re-list or inside the interval gets
 * one trailing re-list, so the last change is never lost. A failed re-list is not reported
 * (the catalog did not change for Xum) and is retried after the interval, at most
 * `maxRetries` times in a row.
 */
export function coalesceCatalogChanges(options: {
  relist: () => Promise<unknown>;
  report: () => void;
  minIntervalMs: number;
  maxRetries: number;
}): { notify: () => void; dispose: () => void } {
  let lastStartAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let failures = 0;
  let disposed = false;

  const run = async () => {
    running = true;
    pending = false;
    lastStartAt = Date.now();
    try {
      await options.relist();
      failures = 0;
      options.report();
    } catch {
      failures += 1;
      // Give up after maxRetries; the next notification starts over.
      if (failures <= options.maxRetries) pending = true;
      else failures = 0;
    } finally {
      running = false;
      if (pending) schedule();
    }
  };

  // `run` never rejects (it catches every failure), so starting it detached loses nothing.
  const start = () => {
    run().catch(() => undefined);
  };

  function schedule() {
    if (disposed || running || timer !== null) return;
    const wait = lastStartAt + options.minIntervalMs - Date.now();
    if (wait <= 0) {
      start();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      start();
    }, wait);
    timer.unref?.();
  }

  return {
    notify: () => {
      pending = true;
      schedule();
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
