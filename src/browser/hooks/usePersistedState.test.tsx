import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import {
  installQuotaLimitedStorage,
  type QuotaLimitedStorage,
} from "../../../tests/ui/quotaLimitedStorage";

import {
  subscribePersistedStateWrites,
  syncPersistedStateFromBackend,
  updatePersistedState,
  usePersistedState,
  type PersistedStateWriteEvent,
} from "./usePersistedState";

describe("usePersistedState backend sync", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("backend cache hydration updates subscribers that did not opt into storage listening", () => {
    const { result } = renderHook(() => usePersistedState("backend-synced-key", "initial"));

    expect(result.current[0]).toBe("initial");

    act(() => {
      syncPersistedStateFromBackend("backend-synced-key", "from-backend");
    });

    expect(result.current[0]).toBe("from-backend");
  });

  test("write observers receive local and backend source labels", () => {
    const events: PersistedStateWriteEvent[] = [];
    const unsubscribe = subscribePersistedStateWrites((event) => {
      events.push(event);
    });

    updatePersistedState("observed-key", "local-value");
    syncPersistedStateFromBackend("observed-key", "backend-value");
    unsubscribe();

    expect(events).toEqual([
      { key: "observed-key", newValue: "local-value", source: "local" },
      { key: "observed-key", newValue: "backend-value", source: "backend" },
    ]);
  });
});

describe("persisted state writes under storage quota pressure", () => {
  let cleanupDom: (() => void) | null = null;
  let storage: QuotaLimitedStorage;
  let warn: ReturnType<typeof spyOn<Console, "warn">>;

  const installStorage = (capacityChars: number) => {
    storage = installQuotaLimitedStorage(capacityChars);
  };

  beforeEach(() => {
    cleanupDom = installDom();
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // Every public write path shares the quota handling: draft text goes through the hook setter,
  // attachments/LRU caches through updatePersistedState, and backend preferences through sync.
  const writePaths: Array<[string, (key: string, value: string) => void]> = [
    [
      "updatePersistedState",
      (key, value) => {
        expect(updatePersistedState(key, value)).toBe(true);
      },
    ],
    [
      "usePersistedState setter",
      (key, value) => {
        const { result } = renderHook(() => usePersistedState(key, ""));
        act(() => result.current[1](value));
      },
    ],
    ["syncPersistedStateFromBackend", (key, value) => syncPersistedStateFromBackend(key, value)],
  ];

  test.each(writePaths)(
    "%s evicts only cache keys and retries, so the write succeeds",
    (_, write) => {
      installStorage(2_000);
      const cacheKeys = [
        "session-cost:aaaaaaaaaa",
        "session-cost-index",
        "prStatus:aaaaaaaaaa",
        "planContent:aaaaaaaaaa",
      ];
      for (const key of cacheKeys) storage.seed(key, "x".repeat(300));
      const keptKeys = ["review-state:aaaaaaaaaa", "inputAttachments:aaaaaaaaaa", "uiTheme"];
      for (const key of keptKeys) storage.seed(key, "y".repeat(150));

      write("input:quota-draft", "z".repeat(600));

      expect(storage.getItem("input:quota-draft")).toBe(JSON.stringify("z".repeat(600)));
      for (const key of cacheKeys) expect(storage.getItem(key)).toBeNull();
      for (const key of keptKeys) expect(storage.getItem(key)).not.toBeNull();
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test("reports failure without throwing when eviction cannot free enough space", () => {
    installStorage(1_000);
    storage.seed("session-cost:bbbbbbbbbb", "x".repeat(100));
    storage.seed("review-state:bbbbbbbbbb", "y".repeat(800));
    const events: PersistedStateWriteEvent[] = [];
    const unsubscribe = subscribePersistedStateWrites((event) => events.push(event));

    const results = [1, 2, 3].map(() => updatePersistedState("input:quota-full", "z".repeat(400)));
    unsubscribe();

    expect(results).toEqual([false, false, false]);
    expect(storage.getItem("input:quota-full")).toBeNull();
    expect(storage.getItem("session-cost:bbbbbbbbbb")).toBeNull();
    expect(storage.getItem("review-state:bbbbbbbbbb")).not.toBeNull();
    // First write: original attempt plus one retry after eviction. Later writes find nothing
    // left to evict and do not retry.
    expect(storage.setItemCalls).toEqual([
      "input:quota-full",
      "input:quota-full",
      "input:quota-full",
      "input:quota-full",
    ]);
    // Nothing changed on disk, so no write observer hears about it.
    expect(events).toEqual([]);
    // One warning per key per session instead of one per keystroke.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
