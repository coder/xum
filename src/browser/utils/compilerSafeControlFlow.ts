/**
 * Control-flow helpers for React components and hooks.
 *
 * React Compiler 1.0 skips a whole component when its body, including nested
 * callbacks, contains `try/finally`, `try/catch/finally`, or `try` without
 * `catch`. Skipped components get no memoization at all (AGENTS.md forbids hand
 * memoization), so hot components call these plain functions instead: the
 * compiler only compiles components and hooks, so the `try` lives here.
 * `runWithCatch` exists because the compiler also rejects conditional, logical,
 * and optional-chaining expressions inside a try/catch.
 * scripts/check_react_compiler_coverage.ts guards the hot components.
 */

/** `try { return await body(); } catch (error) { return onError(error); }` */
export async function runWithCatch<T>(
  body: () => Promise<T>,
  onError: (error: unknown) => T | Promise<T>
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    return await onError(error);
  }
}

/** `try { return await body(); } finally { cleanup(); }` */
export async function runWithFinally<T>(body: () => Promise<T>, cleanup: () => void): Promise<T> {
  try {
    return await body();
  } finally {
    cleanup();
  }
}

/** `try { return await body(); } catch (error) { return onError(error); } finally { cleanup(); }` */
export async function runWithCatchFinally<T>(
  body: () => Promise<T>,
  onError: (error: unknown) => T | Promise<T>,
  cleanup: () => void
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    return await onError(error);
  } finally {
    cleanup();
  }
}
