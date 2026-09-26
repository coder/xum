import { createRequire } from "node:module";
import type { APIClient } from "@/browser/contexts/API";

// Shared test utilities for browser tests

const requireForTest = createRequire(import.meta.url);

/**
 * Load a test module without busting Bun's cache.
 *
 * Use this when a suite only needs mock.module registrations to be active before
 * the first load, but the module's normal specifier resolution must stay intact.
 */
export function requireTestModule<T>(modulePath: string): T {
  return requireForTest(modulePath) as T;
}

/**
 * Helper type for recursive partial mocks.
 * Allows partial mocking of nested objects and async functions.
 */
export type RecursivePartial<T> = {
  [P in keyof T]?: T[P] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>> | R
    : T[P] extends object
      ? RecursivePartial<T[P]>
      : T[P];
};

export interface ControllableAsyncIterable<T> {
  iterable: AsyncIterableIterator<T>;
  push(value: T): void;
  close(): void;
}

export function createControllableAsyncIterable<T>(
  options: {
    onReturn?: () => void;
  } = {}
): ControllableAsyncIterable<T> {
  const buffered: T[] = [];
  const pending: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const doneResult = (): IteratorResult<T> => ({
    value: undefined as T,
    done: true,
  });

  const flushDone = () => {
    while (pending.length > 0) {
      pending.shift()?.(doneResult());
    }
  };

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    flushDone();
  };

  const iterable: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return iterable;
    },
    next() {
      if (closed) {
        return Promise.resolve(doneResult());
      }

      if (buffered.length > 0) {
        return Promise.resolve({ value: buffered.shift() as T, done: false });
      }

      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    return() {
      options.onReturn?.();
      close();
      return Promise.resolve(doneResult());
    },
  };

  return {
    iterable,
    push(value: T) {
      if (closed) {
        return;
      }

      const resolve = pending.shift();
      if (resolve) {
        resolve({ value, done: false });
        return;
      }

      buffered.push(value);
    },
    close,
  };
}

// oRPC types streaming procedures as `Promise<AsyncIteratorClass<T>>`, a class with private
// fields that no test double can satisfy structurally. Consumers only iterate the stream, so a
// test may return any AsyncIterable of the same item type (e.g. an async generator).
type TestApiResult<R> =
  Awaited<R> extends AsyncIterable<infer Item> ? AsyncIterable<Item> : Awaited<R>;

/** RecursivePartial for APIClient doubles, with the streaming relaxation above. */
export type TestApiOverrides<T> = {
  [P in keyof T]?: T[P] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<TestApiResult<R>> | TestApiResult<R>
    : T[P] extends object
      ? TestApiOverrides<T[P]>
      : T[P];
};

/** Typed partial APIClient double: overrides are checked against the real procedure types (typos and wrong return types fail typecheck); omitted procedures are simply absent, exactly as with the old cast. */
export function createTestApiClient(overrides: TestApiOverrides<APIClient> = {}): APIClient {
  // The single cast: tests supply only the procedures they exercise.
  return overrides as unknown as APIClient;
}
