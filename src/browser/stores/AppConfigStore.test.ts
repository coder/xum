import { describe, expect, test } from "bun:test";
import { AppConfigStore } from "./AppConfigStore";
import { createTestApiClient, createTestConfig } from "@/browser/testUtils";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";

function createClient(
  getUserPreferences: () => UserPreferences,
  shouldFail: () => boolean = () => false
) {
  return createTestApiClient({
    config: {
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
    store.setClient(createClient(() => ({}), failRead));
    await flushMicrotasks();
    const resumeFirstClientRetry = resumeRetry;
    store.setClient(createClient(() => ({}), failRead));
    await flushMicrotasks();
    expect(reads).toBe(2);

    resumeFirstClientRetry();
    await flushMicrotasks();
    expect(reads).toBe(2);
  });
});

// Every retry wait above resolves in a microtask, so one macrotask turn drains the whole loop.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
