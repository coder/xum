import { describe, expect, test } from "bun:test";
import { AppConfigStore } from "./AppConfigStore";
import { createTestApiClient, createTestConfig } from "@/browser/testUtils";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";

function createClient(
  getUserPreferences: () => UserPreferences,
  updateUserPreferences: (
    input: { patches: unknown[] },
    options?: { signal?: AbortSignal }
  ) => Promise<void> = () => Promise.resolve(),
  shouldFail: () => boolean = () => false
) {
  return createTestApiClient({
    config: {
      updateUserPreferences,
      // Every fetch deserializes fresh objects, as the oRPC transport does.
      getConfig: () =>
        shouldFail()
          ? Promise.reject(new Error("backend unavailable"))
          : Promise.resolve(
              createTestConfig({ userPreferences: structuredClone(getUserPreferences()) })
            ),
      onConfigChanged: () =>
        Promise.resolve(
          (async function* () {
            yield* [];
            await new Promise<void>(() => undefined);
          })()
        ),
    },
  });
}

describe("AppConfigStore", () => {
  test("a refetch keeps the previous object for unchanged values", async () => {
    let preferences: UserPreferences = {
      appearance: {
        theme: "dark",
        terminalFontConfig: { fontFamily: "Menlo", fontSize: 13 },
      },
      navigation: { projectOrder: ["/repo/a", "/repo/b"] },
    };
    const store = new AppConfigStore();
    store.setClient(createClient(() => preferences));
    await store.refresh();
    const first = store.getSnapshot();

    // An unrelated config write (workspace metadata) changes nothing the snapshot holds.
    await store.refresh();
    expect(store.getSnapshot()).toBe(first);

    preferences = {
      ...preferences,
      appearance: { ...preferences.appearance, theme: "light" },
    };
    await store.refresh();
    const second = store.getSnapshot();

    expect(second?.userPreferences?.appearance?.theme).toBe("light");
    expect(second?.userPreferences?.appearance).not.toBe(first?.userPreferences?.appearance);
    expect(second?.userPreferences?.appearance?.terminalFontConfig).toBe(
      first?.userPreferences?.appearance?.terminalFontConfig
    );
    expect(second?.userPreferences?.navigation).toBe(first?.userPreferences?.navigation);
    expect(second?.experiments).toBe(first?.experiments);
  });

  test("retries a failed initial read with capped backoff until one succeeds", async () => {
    const delays: number[] = [];
    let reads = 0;
    const store = new AppConfigStore((ms) => {
      delays.push(ms);
      return Promise.resolve();
    });
    store.setClient(
      createClient(
        () => ({ appearance: { theme: "light" } }),
        undefined,
        () => ++reads <= 6
      )
    );
    await flushMicrotasks();

    expect(store.getSnapshot()?.userPreferences?.appearance?.theme).toBe("light");
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000]);
  });

  test("a replaced client's initial read stops retrying", async () => {
    let reads = 0;
    let resumeRetry: () => void = () => undefined;
    const store = new AppConfigStore(() => new Promise<void>((resolve) => (resumeRetry = resolve)));
    const failRead = () => {
      reads++;
      return true;
    };
    store.setClient(createClient(() => ({}), undefined, failRead));
    await flushMicrotasks();
    const resumeFirstClientRetry = resumeRetry;
    store.setClient(createClient(() => ({}), undefined, failRead));
    await flushMicrotasks();
    expect(reads).toBe(2);

    resumeFirstClientRetry();
    await flushMicrotasks();
    expect(reads).toBe(2);
  });

  test("a pending patch shows at once and survives a refetch that lands before the write", async () => {
    let server: UserPreferences = { appearance: { theme: "dark" } };
    const write = Promise.withResolvers<void>();
    const store = new AppConfigStore();
    store.setClient(
      createClient(
        () => server,
        () => write.promise
      )
    );
    await store.refresh();

    store.updateUserPreferences({ appearance: { vimEnabled: true } });
    expect(store.getSnapshot()?.userPreferences?.appearance).toEqual({
      theme: "dark",
      vimEnabled: true,
    });

    server = { appearance: { theme: "light" } };
    await store.refresh();
    expect(store.getSnapshot()?.userPreferences?.appearance).toEqual({
      theme: "light",
      vimEnabled: true,
    });

    server = { appearance: { theme: "light", vimEnabled: true } };
    write.resolve();
    await store.flushUserPreferences();
    expect(store.getSnapshot()?.userPreferences?.appearance).toEqual(server.appearance);
  });

  // Each scenario saves theme "light" over a loaded "dark" while it controls when fetches answer.
  const savedWriteScenarios: Record<string, (fetches: ControlledFetches) => Promise<void>> = {
    "the refetch after the write fails": async (fetches) => {
      await fetches.writeLight();
      fetches.fail(1);
    },
    "an optimistic update supersedes the refetch after the write": async (fetches) => {
      await fetches.writeLight();
      fetches.store.updateOptimistically({ keepScreenAwake: true });
      fetches.answer(1);
    },
    "a fetch started before the write answers after the refetch failed": async (fetches) => {
      void fetches.store.refresh();
      await fetches.writeLight();
      fetches.fail(2);
      await flushMicrotasks();
      fetches.answer(1);
    },
    "a newer fetch answers before the refetch after the write": async (fetches) => {
      await fetches.writeLight();
      fetches.state.server = { appearance: { theme: "auto" } };
      void fetches.store.refresh();
      fetches.answer(2);
      await flushMicrotasks();
      fetches.answer(1);
    },
  };
  test.each(Object.entries(savedWriteScenarios))(
    "a saved write shows the server's latest value when %s",
    async (_name, run) => {
      const fetches = createControlledFetches();
      await run(fetches);
      await flushMicrotasks();
      expect(fetches.store.getSnapshot()?.userPreferences).toEqual(fetches.state.server);
    }
  );

  test("a failed write returns to the server value and fails the flush", async () => {
    const store = new AppConfigStore();
    store.setClient(
      createClient(
        () => ({ appearance: { theme: "dark" } }),
        () => Promise.reject(new Error("disk full"))
      )
    );
    await store.refresh();

    store.updateUserPreferences({ appearance: { theme: "light" } });
    const flushed = await store.flushUserPreferences().then(
      () => "resolved",
      (error: Error) => error.message
    );

    expect(flushed).toBe("Settings could not be saved");
    expect(store.getSnapshot()?.userPreferences).toEqual({ appearance: { theme: "dark" } });
  });

  test("a failed or disconnected write tells the user settings could not be saved", async () => {
    const alerts: unknown[] = [];
    const originalWindow = globalThis.window;
    // Without a mounted composer the toast falls back to window.alert.
    globalThis.window = { alert: (message: unknown) => alerts.push(message) } as unknown as Window &
      typeof globalThis;
    try {
      const failing = new AppConfigStore();
      failing.setClient(
        createClient(
          () => ({}),
          () => Promise.reject(new Error("disk full"))
        )
      );
      await failing.refresh();
      failing.updateUserPreferences({ appearance: { theme: "light" } });
      await failing.flushUserPreferences().catch(() => undefined);
      expect(alerts).toEqual(["Settings could not be saved"]);

      const disconnected = new AppConfigStore();
      disconnected.updateUserPreferences({ appearance: { theme: "light" } });
      expect(alerts).toEqual(["Settings could not be saved", "Settings could not be saved"]);
      expect(disconnected.getSnapshot()).toBeNull();

      const unloaded = createControlledFetches({ loaded: false });
      unloaded.store.updateUserPreferences({ appearance: { theme: "light" } });
      expect(alerts).toHaveLength(3);
      expect(unloaded.state.writes).toBe(0);
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("flushUserPreferences waits for the in-flight write and the patches made meanwhile", async () => {
    const writes: Array<{ patches: unknown[]; done: { resolve: () => void } }> = [];
    const store = new AppConfigStore();
    store.setClient(
      createClient(
        () => ({}),
        (input: { patches: unknown[] }) => {
          const done = Promise.withResolvers<void>();
          writes.push({ patches: input.patches, done });
          return done.promise;
        }
      )
    );
    await store.refresh();

    store.updateUserPreferences({ appearance: { vimEnabled: true } });
    store.updateUserPreferences({ appearance: { theme: "light" } });
    store.updateUserPreferences({ navigation: { launchBehavior: "new-chat" } });
    let flushed = false;
    void store.flushUserPreferences().then(() => {
      flushed = true;
    });

    writes[0].done.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes.map((write) => write.patches.length)).toEqual([1, 2]);
    expect(flushed).toBe(false);

    writes[1].done.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushed).toBe(true);
  });

  test("a write cut off by a client change settles as unconfirmed and drops the edits queued behind it", async () => {
    // A dead connection never answers; oRPC then settles a request only through its abort signal.
    const dead = createClient(
      () => ({ appearance: { theme: "dark" } }),
      (_input, options) =>
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const sent: unknown[][] = [];
    const live = createClient(
      () => ({ appearance: { theme: "dark" } }),
      (input) => {
        sent.push(input.patches);
        return Promise.resolve();
      }
    );
    const store = new AppConfigStore();
    store.setClient(dead);
    await store.refresh();

    store.updateUserPreferences({ appearance: { transcriptDensity: "hyper" } });
    store.updateUserPreferences({ appearance: { theme: "light" } });
    store.setClient(live);
    const flushed = await store.flushUserPreferences().then(
      () => "resolved",
      (error: Error) => error.message
    );

    expect(flushed).toBe("Connection lost: settings may not have been saved");
    expect(sent).toEqual([]);
    await store.refresh();
    expect(store.getSnapshot()?.userPreferences).toEqual({ appearance: { theme: "dark" } });

    store.updateUserPreferences({ appearance: { theme: "light" } });
    await store.flushUserPreferences();
    expect(sent).toEqual([[{ appearance: { theme: "light" } }]]);
  });

  test("an edit on the next connection is sent when the replaced connection's write settles late", async () => {
    // This request ignores its abort signal and settles only after the next connection's edit.
    let settleDead!: (error: Error) => void;
    const dead = createClient(
      () => ({ appearance: { theme: "dark" } }),
      () =>
        new Promise<void>((_resolve, reject) => {
          settleDead = reject;
        })
    );
    const sent: unknown[][] = [];
    const live = createClient(
      () => ({ appearance: { theme: "dark" } }),
      (input) => {
        sent.push(input.patches);
        return Promise.resolve();
      }
    );
    const store = new AppConfigStore();
    store.setClient(dead);
    await store.refresh();

    store.updateUserPreferences({ appearance: { transcriptDensity: "hyper" } });
    store.setClient(live);
    await store.refresh();
    store.updateUserPreferences({ appearance: { theme: "light" } });
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    settleDead(aborted);
    await store.flushUserPreferences().catch(() => undefined);

    expect(sent).toEqual([[{ appearance: { theme: "light" } }]]);
  });

  test("a write cut off by a closed socket settles as unconfirmed", async () => {
    const closed = new Error("WebSocket closed (code 1006)");
    closed.name = "AbortError";
    const store = new AppConfigStore();
    store.setClient(
      createClient(
        () => ({}),
        () => Promise.reject(closed)
      )
    );
    await store.refresh();

    store.updateUserPreferences({ appearance: { theme: "light" } });
    const flushed = await store.flushUserPreferences().then(
      () => "resolved",
      (error: Error) => error.message
    );

    expect(flushed).toBe("Connection lost: settings may not have been saved");
    expect(store.getSnapshot()?.userPreferences).toEqual({});
  });
});

// Every retry wait above resolves in a microtask, so one macrotask turn drains the whole loop.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type ControlledFetches = ReturnType<typeof createControlledFetches>;

const DARK: UserPreferences = { appearance: { theme: "dark" } };

// Each getConfig answers only when the test says so; fetch 0 is the store's initial read.
function createControlledFetches(options: { loaded?: boolean } = {}) {
  const state = { server: DARK, writes: 0 };
  const replies: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const store = new AppConfigStore();
  store.setClient(
    createTestApiClient({
      config: {
        updateUserPreferences: () => {
          state.writes++;
          state.server = { appearance: { theme: "light" } };
          return Promise.resolve();
        },
        getConfig: async () => {
          const userPreferences = structuredClone(state.server);
          await new Promise<void>((resolve, reject) => replies.push({ resolve, reject }));
          return createTestConfig({ userPreferences });
        },
      },
    })
  );
  if (options.loaded !== false) replies[0].resolve();
  return {
    store,
    state,
    answer: (index: number) => replies[index].resolve(),
    fail: (index: number) => replies[index].reject(new Error("backend unavailable")),
    writeLight: async () => {
      await flushMicrotasks();
      store.updateUserPreferences({ appearance: { theme: "light" } });
      await flushMicrotasks();
    },
  };
}
