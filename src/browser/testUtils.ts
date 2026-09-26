import { createRequire } from "node:module";
import type { APIClient } from "@/browser/contexts/API";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import { DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR } from "@/common/config/worktreeArchiveBehavior";
import { getDefaultAutoModelRoutingConfig } from "@/common/types/autoModelRouting";
import { DEFAULT_RUNTIME_ENABLEMENT } from "@/common/types/runtime";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";

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
// streaming double may resolve to any AsyncIterable of the same item type (e.g. an async
// generator). Every other procedure keeps its real Promise result.
type TestApiResult<R> =
  Awaited<R> extends AsyncIterable<infer Item> ? Promise<AsyncIterable<Item>> : Promise<Awaited<R>>;

/** RecursivePartial for APIClient doubles, with the streaming relaxation above. */
export type TestApiOverrides<T> = {
  [P in keyof T]?: T[P] extends (...args: infer A) => infer R
    ? (...args: A) => TestApiResult<R>
    : T[P] extends object
      ? TestApiOverrides<T[P]>
      : T[P];
};

/**
 * Typed partial APIClient double. Procedures are checked against the real procedure types (wrong
 * return types fail typecheck); omitted procedures are simply absent, exactly as with the old
 * cast. Misspelled procedure names fail typecheck only for inline object literals, so annotate
 * predeclared override objects as `TestApiOverrides<APIClient>` to get the same excess-key check.
 */
export function createTestApiClient(overrides: TestApiOverrides<APIClient> = {}): APIClient {
  // The single cast: tests supply only the procedures they exercise.
  return overrides as unknown as APIClient;
}

export type TestClientConfig = Awaited<ReturnType<APIClient["config"]["getConfig"]>>;

/**
 * Complete `config.getConfig` result for API doubles: the defaults `Config.getClientConfig()`
 * reports for an empty config file, plus the fields a test cares about.
 */
export function createTestConfig(overrides: Partial<TestClientConfig> = {}): TestClientConfig {
  return {
    userPreferencesInitialized: false,
    taskSettings: DEFAULT_TASK_SETTINGS,
    autoModelRouting: getDefaultAutoModelRoutingConfig(),
    advisorModelString: null,
    advisorThinkingLevel: null,
    advisorReasoningMode: null,
    coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
    worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    runtimeEnablement: { ...DEFAULT_RUNTIME_ENABLEMENT },
    defaultRuntime: null,
    agentAiDefaults: {},
    muxGovernorUrl: null,
    muxGovernorEnrolled: false,
    chatTranscriptFullWidth: false,
    llmDebugLogs: false,
    keepScreenAwake: false,
    goalDefaults: DEFAULT_GOAL_DEFAULTS,
    ...overrides,
  };
}

export type TestExecuteBashResult = Awaited<ReturnType<APIClient["workspace"]["executeBash"]>>;

/**
 * Successful `workspace.executeBash` result: the RPC succeeded and the script ran. Omit
 * `exitCode` (or pass 0) for a zero exit; a non-zero `exitCode` builds the script-failure shape
 * with an `error` message, as the backend reports it.
 */
export function createTestBashResult(options: {
  output: string;
  exitCode?: number;
  truncated?: { reason: string; totalLines: number };
}): TestExecuteBashResult {
  const exitCode = options.exitCode ?? 0;
  const truncated = options.truncated == null ? {} : { truncated: options.truncated };
  if (exitCode === 0) {
    return {
      success: true,
      data: {
        success: true,
        output: options.output,
        exitCode: 0,
        wall_duration_ms: 0,
        ...truncated,
      },
    };
  }
  return {
    success: true,
    data: {
      success: false,
      output: options.output,
      exitCode,
      error: `Command exited with code ${exitCode}`,
      wall_duration_ms: 0,
      ...truncated,
    },
  };
}
