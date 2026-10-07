import { describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";

import {
  canPrunePreferenceScopes,
  createMergePatch,
  createUserPreferenceSaveQueue,
  mirrorBackendPreferences,
  mirrorUserPreferencesLocalCache,
  prunePreferenceScopes,
} from "./UserPreferencesContext";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import {
  LAUNCH_BEHAVIOR_KEY,
  TERMINAL_FONT_CONFIG_KEY,
  UI_THEME_KEY,
  VIM_ENABLED_KEY,
  getAutoCompactionThresholdKey,
} from "@/common/constants/storage";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { removeStoredUserPreference } from "@/common/preferences/userPreferencesStorage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  setJSON(key: string, value: unknown): void {
    this.setItem(key, JSON.stringify(value));
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** saveConfig double whose attempts settle only when the test releases them. */
function createControllableSaveConfig() {
  const attempts: Deferred[] = [];
  const saveConfig = () => {
    const attempt = createDeferred();
    attempts.push(attempt);
    return attempt.promise;
  };
  return { attempts, saveConfig };
}

/** Tracks a waitForPersisted promise without leaving unhandled rejections behind. */
function observe(promise: Promise<void>) {
  const state = { settled: false, error: undefined as unknown };
  const tracked = promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    }
  );
  return { state, tracked };
}

async function waitUntil(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  throw lastError;
}

describe("UserPreferencesProvider bridge helpers", () => {
  // Production passes no storage: writes must be routed to the helpers because the default storage
  // is the (write-refusing) persisted-state view, recognized by identity.
  test("mirrors the store into the real localStorage through the default persisted-state view", () => {
    const cleanupDom = installDom();
    try {
      getAppConfigStore().updateOptimistically({
        userPreferences: { navigation: { launchBehavior: "last-workspace" } },
      });
      mirrorUserPreferencesLocalCache();

      expect(JSON.parse(window.localStorage.getItem(LAUNCH_BEHAVIOR_KEY) ?? "null")).toBe(
        "last-workspace"
      );
    } finally {
      getAppConfigStore().updateOptimistically({ userPreferences: undefined });
      cleanupDom();
    }
  });

  test("removes stale local cache entries on a backend refresh", () => {
    const storage = new MemoryStorage();
    storage.setJSON(UI_THEME_KEY, "dark");
    storage.setJSON(VIM_ENABLED_KEY, true);

    mirrorBackendPreferences({
      backendPreferences: { appearance: { theme: "light" } },
      storage,
    });

    expect(JSON.parse(storage.getItem(UI_THEME_KEY) ?? "null")).toBe("light");
    expect(storage.getItem(VIM_ENABLED_KEY)).toBeNull();
  });

  test("removing the last known value of a section deletes only that stored value", () => {
    const remove = (before: UserPreferences, key: string) =>
      createMergePatch(before, removeStoredUserPreference(before, key) ?? {});

    expect(remove({ appearance: { theme: "dark" } }, UI_THEME_KEY)).toEqual({
      appearance: { theme: null },
    });
    expect(
      remove(
        { appearance: { terminalFontConfig: { fontFamily: "Menlo", fontSize: 13 } } },
        TERMINAL_FONT_CONFIG_KEY
      )
    ).toEqual({ appearance: { terminalFontConfig: null } });
  });

  test("only prunes scoped preferences after successful project and workspace loads", () => {
    const ready = {
      hydrated: true,
      projectLoading: false,
      projectLoaded: true,
      projectLoadError: null,
      workspaceLoading: false,
      workspaceLoaded: true,
      workspaceLoadError: null,
    };

    expect(canPrunePreferenceScopes(ready)).toBe(true);
    expect(canPrunePreferenceScopes({ ...ready, projectLoaded: false })).toBe(false);
    expect(canPrunePreferenceScopes({ ...ready, workspaceLoaded: false })).toBe(false);
    expect(canPrunePreferenceScopes({ ...ready, projectLoadError: "failed" })).toBe(false);
    expect(canPrunePreferenceScopes({ ...ready, workspaceLoadError: "failed" })).toBe(false);
  });

  test("prunes project and workspace scoped preferences that no longer exist", () => {
    const projects = new Map([
      ["/repo/a", { workspaces: [] }],
      ["/repo/c", { workspaces: [] }],
    ]);

    expect(
      prunePreferenceScopes({
        preferences: {
          navigation: { projectOrder: ["/repo/b", "/repo/a"] },
          ai: {
            projectDefaults: {
              "/repo/a": { agentId: "exec" },
              "/repo/b": { agentId: "plan" },
            },
          },
          workspaceCreation: {
            byProject: {
              "/repo/b": { trunkBranch: "origin/main" },
            },
          },
          notifications: {
            notifyOnResponseByWorkspace: { "ws-keep": true, "ws-drop": true },
          },
          review: {
            defaultBaseByProject: { "/repo/b": "origin/main" },
          },
        },
        projectPaths: new Set(["/repo/a", "/repo/c"]),
        workspaceIds: new Set(["ws-keep"]),
        userProjects: projects,
      })
    ).toEqual({
      navigation: { projectOrder: ["/repo/c", "/repo/a"] },
      ai: { projectDefaults: { "/repo/a": { agentId: "exec" } } },
      notifications: { notifyOnResponseByWorkspace: { "ws-keep": true } },
    });
  });

  test("keeps scratch AI defaults while pruning removed projects", () => {
    const projects = new Map([["/repo/a", { workspaces: [] }]]);

    expect(
      prunePreferenceScopes({
        preferences: {
          ai: {
            projectDefaults: {
              _scratch: { agentId: "plan", model: "anthropic:claude-x", thinkingLevel: "high" },
              "/repo/removed": { agentId: "plan" },
            },
          },
        },
        // The scratch system project is never part of the valid project paths.
        projectPaths: new Set(["/repo/a"]),
        workspaceIds: new Set(),
        userProjects: projects,
      })
    ).toEqual({
      ai: {
        projectDefaults: {
          _scratch: { agentId: "plan", model: "anthropic:claude-x", thinkingLevel: "high" },
        },
      },
    });
  });

  test("save queue retries failed saves without dropping pending preferences", async () => {
    const controller = new AbortController();
    const saves: Array<UserPreferences | null | undefined> = [];
    const currentPreferences: UserPreferences | undefined = { appearance: { theme: "dark" } };
    let saveAttempts = 0;
    let dirtyClears = 0;
    const errors: string[] = [];

    const queue = createUserPreferenceSaveQueue({
      signal: controller.signal,
      configClient: {
        saveConfig: (input) => {
          saveAttempts += 1;
          if (saveAttempts === 1) {
            return Promise.reject(new Error("temporary failure"));
          }
          saves.push(input.userPreferences);
          return Promise.resolve();
        },
      },
      getCurrentPreferences: () => currentPreferences,
      clearDirtyKeys: () => {
        dirtyClears += 1;
      },
      onError: (message) => {
        errors.push(message);
      },
    });

    queue.enqueue(currentPreferences);

    await waitUntil(() => expect(saves).toEqual([currentPreferences]));
    expect(saveAttempts).toBe(2);
    expect(dirtyClears).toBe(1);
    expect(errors[0]).toContain("retrying");
  });

  test("save queue stops retrying after abort", async () => {
    const controller = new AbortController();
    const currentPreferences: UserPreferences | undefined = { appearance: { theme: "dark" } };
    let saveAttempts = 0;
    const errors: string[] = [];

    const queue = createUserPreferenceSaveQueue({
      signal: controller.signal,
      configClient: {
        saveConfig: () => {
          saveAttempts += 1;
          return Promise.reject(new Error("temporary failure"));
        },
      },
      getCurrentPreferences: () => currentPreferences,
      clearDirtyKeys: () => {
        throw new Error("dirty keys should not clear after an aborted save");
      },
      onError: (message) => {
        errors.push(message);
      },
    });

    queue.enqueue(currentPreferences);

    await waitUntil(() => expect(errors).toHaveLength(1));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(saveAttempts).toBe(1);
  });

  test("save queue serializes in-flight saves and persists the latest pending preferences", async () => {
    const controller = new AbortController();
    const saves: Array<UserPreferences | null | undefined> = [];
    const firstSave = { release: undefined as (() => void) | undefined };
    let saveCalls = 0;
    let currentPreferences: UserPreferences | undefined = { appearance: { theme: "dark" } };
    let dirtyClears = 0;

    const queue = createUserPreferenceSaveQueue({
      signal: controller.signal,
      configClient: {
        saveConfig: async (input) => {
          saveCalls += 1;
          if (saveCalls === 1) {
            await new Promise<void>((resolve) => {
              firstSave.release = resolve;
            });
          }
          saves.push(input.userPreferences);
        },
      },
      getCurrentPreferences: () => currentPreferences,
      clearDirtyKeys: () => {
        dirtyClears += 1;
      },
      onError: (message, error) => {
        throw new Error(`${message} ${String(error)}`);
      },
    });

    queue.enqueue({ appearance: { theme: "dark" } });
    currentPreferences = { appearance: { theme: "light" } };
    queue.enqueue(currentPreferences);

    await waitUntil(() => expect(firstSave.release).toBeDefined());
    const releaseFirst = firstSave.release;
    if (!releaseFirst) {
      throw new Error("Expected first save release callback");
    }
    releaseFirst();

    await waitUntil(() => expect(saves).toHaveLength(2));
    expect(saves).toEqual([{ appearance: { theme: "dark" } }, { appearance: { theme: "light" } }]);
    expect(dirtyClears).toBe(1);
  });

  describe("save queue waitForPersisted", () => {
    const THRESHOLD_KEY = getAutoCompactionThresholdKey("anthropic:claude-sonnet-4-5");
    const preferences: UserPreferences = { appearance: { theme: "dark" } };

    function createQueue(params?: { onError?: (message: string, error: unknown) => void }) {
      const controller = new AbortController();
      const saveConfig = createControllableSaveConfig();
      const queue = createUserPreferenceSaveQueue({
        signal: controller.signal,
        configClient: {
          saveConfig: saveConfig.saveConfig,
        },
        getCurrentPreferences: () => preferences,
        clearDirtyKeys: () => undefined,
        onError:
          params?.onError ??
          ((message, error) => {
            throw new Error(`${message} ${String(error)}`);
          }),
      });
      return { controller, queue, attempts: saveConfig.attempts };
    }

    test("resolves immediately when nothing is pending for the key", async () => {
      const { queue, attempts } = createQueue();
      const signal = new AbortController().signal;

      await queue.waitForPersisted(THRESHOLD_KEY, signal);
      expect(attempts).toHaveLength(0);

      queue.enqueue(preferences, [THRESHOLD_KEY]);
      await waitUntil(() => expect(attempts).toHaveLength(1));
      attempts[0].resolve();
      await queue.waitForPersisted(THRESHOLD_KEY, signal);

      // Acknowledged versions are sticky: a later wait for the same key is free.
      await queue.waitForPersisted(THRESHOLD_KEY, signal);
      expect(attempts).toHaveLength(1);
    });

    test("resolves after the matching version is acknowledged", async () => {
      const { queue, attempts } = createQueue();
      const signal = new AbortController().signal;

      queue.enqueue(preferences, [THRESHOLD_KEY]);
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));

      await waitUntil(() => expect(attempts).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(wait.state.settled).toBe(false);

      attempts[0].resolve();
      await wait.tracked;
      expect(wait.state.error).toBeUndefined();
    });

    test("a reserved (pre-hydration) write keeps waiters pending until a save carries it", async () => {
      const { queue, attempts } = createQueue();
      const signal = new AbortController().signal;

      queue.reserve([THRESHOLD_KEY]);
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Nothing was enqueued, yet the write is not acknowledged either.
      expect(attempts).toHaveLength(0);
      expect(wait.state.settled).toBe(false);

      // The hydration save carries the dirty key; its acknowledgement releases the waiter.
      queue.enqueue(preferences, [THRESHOLD_KEY]);
      await waitUntil(() => expect(attempts).toHaveLength(1));
      attempts[0].resolve();
      await wait.tracked;
      expect(wait.state.error).toBeUndefined();
    });

    test("settle releases reserved writes the backend already holds", async () => {
      const { queue, attempts } = createQueue();
      const signal = new AbortController().signal;

      queue.reserve([THRESHOLD_KEY]);
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));
      queue.settle([THRESHOLD_KEY]);
      await wait.tracked;
      expect(wait.state.error).toBeUndefined();
      expect(attempts).toHaveLength(0);
      // Settling a key with nothing reserved is a no-op.
      queue.settle([THRESHOLD_KEY]);
      await queue.waitForPersisted(THRESHOLD_KEY, signal);
    });

    test("is not blocked by a pending save for another key", async () => {
      const { queue, attempts } = createQueue();
      const signal = new AbortController().signal;

      queue.enqueue(preferences, [THRESHOLD_KEY]);
      await waitUntil(() => expect(attempts).toHaveLength(1));
      // The threshold write is in flight; a theme write queues behind it.
      queue.enqueue(preferences, [UI_THEME_KEY]);

      const thresholdWait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));
      const themeWait = observe(queue.waitForPersisted(UI_THEME_KEY, signal));

      attempts[0].resolve();
      await thresholdWait.tracked;
      expect(thresholdWait.state.error).toBeUndefined();

      // The theme save is still pending; only the theme waiter stays blocked.
      await waitUntil(() => expect(attempts).toHaveLength(2));
      expect(themeWait.state.settled).toBe(false);

      attempts[1].resolve();
      await themeWait.tracked;
      expect(themeWait.state.error).toBeUndefined();
    });

    test("a superseded version resolves once the newer write is acknowledged", async () => {
      const { queue, attempts } = createQueue();
      const signal = new AbortController().signal;

      // Hold an unrelated save in flight so the two threshold writes coalesce.
      queue.enqueue(preferences, [UI_THEME_KEY]);
      await waitUntil(() => expect(attempts).toHaveLength(1));

      queue.enqueue(preferences, [THRESHOLD_KEY]);
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));
      queue.enqueue(preferences, [THRESHOLD_KEY]);

      attempts[0].resolve();
      await waitUntil(() => expect(attempts).toHaveLength(2));
      expect(wait.state.settled).toBe(false);

      attempts[1].resolve();
      await wait.tracked;
      expect(wait.state.error).toBeUndefined();
      // Both threshold writes rode a single save.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attempts).toHaveLength(2);
    });

    test("rejects when the save carrying the version fails while the queue keeps retrying", async () => {
      const errors: string[] = [];
      const { queue, attempts } = createQueue({
        onError: (message) => {
          errors.push(message);
        },
      });
      const signal = new AbortController().signal;

      queue.enqueue(preferences, [THRESHOLD_KEY]);
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));

      await waitUntil(() => expect(attempts).toHaveLength(1));
      attempts[0].reject(new Error("disk full"));

      await wait.tracked;
      expect(wait.state.error).toBeInstanceOf(Error);
      expect((wait.state.error as Error).message).toContain("Settings could not be saved");
      expect(signal.aborted).toBe(false);
      expect(errors[0]).toContain("retrying");

      // The queue retries in the background and a later attempt succeeds.
      await waitUntil(() => expect(attempts).toHaveLength(2));
      attempts[1].resolve();
      await queue.waitForPersisted(THRESHOLD_KEY, signal);
    });

    test("a version enqueued after a failing attempt is not rejected by that failure", async () => {
      const errors: string[] = [];
      const { queue, attempts } = createQueue({
        onError: (message) => {
          errors.push(message);
        },
      });
      const signal = new AbortController().signal;

      queue.enqueue(preferences, [THRESHOLD_KEY]);
      await waitUntil(() => expect(attempts).toHaveLength(1));
      // Newer write while the first attempt is in flight; the waiter observes the newer version.
      queue.enqueue(preferences, [THRESHOLD_KEY]);
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));

      attempts[0].reject(new Error("disk full"));
      await waitUntil(() => expect(errors).toHaveLength(1));
      await waitUntil(() => expect(attempts).toHaveLength(2));
      expect(wait.state.settled).toBe(false);

      attempts[1].resolve();
      await wait.tracked;
      expect(wait.state.error).toBeUndefined();
    });

    test("rejects when the caller's signal aborts", async () => {
      const { queue, attempts } = createQueue();
      const controller = new AbortController();

      queue.enqueue(preferences, [THRESHOLD_KEY]);
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, controller.signal));
      await waitUntil(() => expect(attempts).toHaveLength(1));

      controller.abort();
      await wait.tracked;
      expect(controller.signal.aborted).toBe(true);
      expect(wait.state.error).toBe(controller.signal.reason);

      // The save itself is unaffected by the caller giving up.
      attempts[0].resolve();
      await queue.waitForPersisted(THRESHOLD_KEY, new AbortController().signal);
    });

    test("a multi-key enqueue (hydration save) bumps every given key", async () => {
      const { queue, attempts } = createQueue();
      const signal = new AbortController().signal;

      queue.enqueue(preferences, new Set([THRESHOLD_KEY, UI_THEME_KEY]));
      const wait = observe(queue.waitForPersisted(THRESHOLD_KEY, signal));
      await waitUntil(() => expect(attempts).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(wait.state.settled).toBe(false);

      attempts[0].resolve();
      await wait.tracked;
      expect(wait.state.error).toBeUndefined();
    });
  });
});
