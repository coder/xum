import { describe, expect, test } from "bun:test";
import { AppConfigStore } from "./AppConfigStore";
import { createTestApiClient, createTestConfig } from "@/browser/testUtils";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";

function createClient(getUserPreferences: () => UserPreferences) {
  return createTestApiClient({
    config: {
      // Every fetch deserializes fresh objects, as the oRPC transport does.
      getConfig: () =>
        Promise.resolve(
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
});
