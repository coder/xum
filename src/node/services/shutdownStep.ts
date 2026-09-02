/**
 * Per-step `[shutdown]` timing for the hand-ordered teardown lists
 * (`ServiceContainer.dispose()`, the CLI roots' cleanup lists, `xum server`'s
 * signal handler). Each step writes its own debug line as it completes, so a
 * shutdown transcript shows where the time goes and — when a step hangs — the
 * last line before silence names the culprit. Debug level: production logs
 * stay quiet unless the log level is raised.
 *
 * A synchronous step is timed and logged before this returns and no Promise is
 * created, so wrapping one adds no suspension point: adjacent synchronous
 * teardown statements still run back-to-back on the same tick and their
 * interleaving with a concurrently running `shutdown()` is unchanged. The
 * Promise overload is listed first so an async step can never bind to the
 * synchronous signature (a `Promise<void>` return is assignable to `void`);
 * `@typescript-eslint/no-misused-promises` guards the reverse direction.
 *
 * Errors propagate unchanged after the line is written; containment (or not)
 * stays with the caller exactly as before.
 */
import { log } from "./log";

export function shutdownStep(name: string, run: () => Promise<void>): Promise<void>;
export function shutdownStep(name: string, run: () => void): void;
export function shutdownStep(name: string, run: () => void | Promise<void>): void | Promise<void> {
  const startedAt = performance.now();
  const done = () => {
    log.debug(`[shutdown] ${name}`, { ms: Math.round(performance.now() - startedAt) });
  };
  let result: void | Promise<void>;
  try {
    result = run();
  } catch (error) {
    done();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(done);
  }
  done();
}
