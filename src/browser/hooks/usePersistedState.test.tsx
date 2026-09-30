import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import {
  installQuotaLimitedStorage,
  type QuotaLimitedStorage,
} from "../../../tests/ui/quotaLimitedStorage";

import {
  LAST_CUSTOM_MODEL_PROVIDER_KEY,
  LAST_VISITED_ROUTE_KEY,
  MAX_PERSISTED_KEY_CHARS,
  UI_THEME_KEY,
  getLastRuntimeConfigKey,
  getPersistedKeyRegistration,
  getTimelineFilterKey,
} from "@/common/constants/storage";
import {
  removePersistedStateKeys,
  readPersistedRawString,
  readPersistedState,
  readPersistedString,
  subscribePersistedStateWrites,
  syncPersistedStateFromBackend,
  updatePersistedState,
  usePersistedState,
  writePersistedRawString,
  type PersistedStateWriteEvent,
} from "./usePersistedState";

const QUOTA_FULL_KEY = getLastRuntimeConfigKey("/repo/quota-full");

describe("raw persisted strings when storage access is denied", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  // Some browsers throw from the window.localStorage getter itself when storage is blocked; the
  // auth token is read during render, so this must not throw.
  test("reads return null and writes return false instead of throwing", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });

    expect(readPersistedRawString("mux:auth-token")).toBeNull();
    expect(writePersistedRawString("mux:auth-token", "token")).toBe(false);
    // JSON reads (e.g. palette recents, experiment flags in state initializers) use defaults.
    expect(readPersistedState("commandPalette:recent", ["none"])).toEqual(["none"]);
    expect(readPersistedString("uiTheme")).toBeUndefined();
  });
});

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
    const { result } = renderHook(() => usePersistedState(UI_THEME_KEY, "initial"));

    expect(result.current[0]).toBe("initial");

    act(() => {
      syncPersistedStateFromBackend(UI_THEME_KEY, "from-backend");
    });

    expect(result.current[0]).toBe("from-backend");
  });

  test("write observers receive local and backend source labels", () => {
    const events: PersistedStateWriteEvent[] = [];
    const unsubscribe = subscribePersistedStateWrites((event) => {
      events.push(event);
    });

    updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "local-value");
    syncPersistedStateFromBackend(LAST_CUSTOM_MODEL_PROVIDER_KEY, "backend-value");
    unsubscribe();

    expect(events).toEqual([
      { key: LAST_CUSTOM_MODEL_PROVIDER_KEY, newValue: "local-value", source: "local" },
      { key: LAST_CUSTOM_MODEL_PROVIDER_KEY, newValue: "backend-value", source: "backend" },
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
        "branch:aaaaaaaaaa",
      ];
      for (const key of cacheKeys) storage.seed(key, "x".repeat(300));
      const keptKeys = ["review-state:aaaaaaaaaa", "inputAttachments:aaaaaaaaaa", "uiTheme"];
      for (const key of keptKeys) storage.seed(key, "y".repeat(150));

      write(LAST_VISITED_ROUTE_KEY, "z".repeat(600));

      expect(storage.getItem(LAST_VISITED_ROUTE_KEY)).toBe(JSON.stringify("z".repeat(600)));
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

    const results = [1, 2, 3].map(() => updatePersistedState(QUOTA_FULL_KEY, "z".repeat(400)));
    unsubscribe();

    expect(results).toEqual([false, false, false]);
    expect(storage.getItem(QUOTA_FULL_KEY)).toBeNull();
    expect(storage.getItem("session-cost:bbbbbbbbbb")).toBeNull();
    expect(storage.getItem("review-state:bbbbbbbbbb")).not.toBeNull();
    // First write: original attempt plus one retry after eviction. Later writes find nothing
    // left to evict and do not retry.
    expect(storage.setItemCalls).toEqual([
      QUOTA_FULL_KEY,
      QUOTA_FULL_KEY,
      QUOTA_FULL_KEY,
      QUOTA_FULL_KEY,
    ]);
    // Nothing changed on disk, so no write observer hears about it.
    expect(events).toEqual([]);
    // One warning per key per session instead of one per keystroke.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("persisted state key budgets", () => {
  let cleanupDom: (() => void) | null = null;
  let error: ReturnType<typeof spyOn<Console, "error">>;
  let warn: ReturnType<typeof spyOn<Console, "warn">>;

  // Every test uses its own workspace id because refusals are logged once per key per session.
  const TIMELINE_FILTER_BUDGET = getPersistedKeyRegistration(
    getTimelineFilterKey("budget")
  )!.maxValueChars;
  const valueOfLength = (serializedLength: number) => "x".repeat(serializedLength - 2);
  // Refusal logs shorten long keys, so match on the key's start.
  const logsFor = (spy: typeof error | typeof warn, key: string) =>
    spy.mock.calls.filter((call) => String(call[0]).includes(`"${key.slice(0, 100)}`));
  const refusalLogsFor = (key: string) => logsFor(error, key);
  // Over-budget values still work for the session, so they only warn.
  const overBudgetLogsFor = (key: string) => logsFor(warn, key);

  beforeEach(() => {
    cleanupDom = installDom();
    error = spyOn(console, "error").mockImplementation(() => undefined);
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    error.mockRestore();
    warn.mockRestore();
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("stores a value at its budget; one char more stays in memory only, logged once", () => {
    const key = getTimelineFilterKey("budget0001");
    const atBudget = valueOfLength(TIMELINE_FILTER_BUDGET);

    expect(updatePersistedState(key, atBudget)).toBe(true);
    const overBudget = valueOfLength(TIMELINE_FILTER_BUDGET + 1);
    expect(updatePersistedState(key, overBudget)).toBe(true);
    expect(updatePersistedState(key, overBudget)).toBe(true);

    // Readers see the new value for this session; localStorage keeps the last value that fit.
    expect(readPersistedState(key, "")).toBe(overBudget);
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(atBudget));
    expect(overBudgetLogsFor(key)).toHaveLength(1);
    expect(refusalLogsFor(key)).toHaveLength(0);

    // A value that fits again is stored and replaces the in-memory one; removal clears both.
    expect(updatePersistedState(key, "tools")).toBe(true);
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify("tools"));
    expect(updatePersistedState(key, overBudget)).toBe(true);
    expect(updatePersistedState(key, null)).toBe(true);
    expect(readPersistedState(key, "all")).toBe("all");
  });

  test("an over-budget hook update changes the UI state but not the stored value", () => {
    const key = getTimelineFilterKey("budget0002");
    const { result } = renderHook(() => usePersistedState(key, "all"));
    const overBudget = valueOfLength(TIMELINE_FILTER_BUDGET + 1);

    // A refused write used to leave the UI unchanged, which froze whatever wrote it.
    act(() => result.current[1](overBudget));

    expect(result.current[0]).toBe(overBudget);
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(overBudgetLogsFor(key)).toHaveLength(1);
  });

  test("refuses unregistered keys and keys over the length cap, but always allows removal", () => {
    const unregistered = "unregistered-feature:state";
    const overlongKey = getTimelineFilterKey("w".repeat(MAX_PERSISTED_KEY_CHARS));

    expect(updatePersistedState(unregistered, true)).toBe(false);
    syncPersistedStateFromBackend(overlongKey, "all");
    // Unlike over-budget values, these are not kept in memory either.
    expect(readPersistedState(unregistered, null)).toBeNull();
    expect(readPersistedState(overlongKey, null)).toBeNull();
    expect(window.localStorage.getItem(unregistered)).toBeNull();
    expect(window.localStorage.getItem(overlongKey)).toBeNull();
    expect(refusalLogsFor(unregistered)).toHaveLength(1);
    expect(refusalLogsFor(overlongKey)).toHaveLength(1);
    // The log line stays bounded instead of echoing the whole oversized key.
    expect(String(refusalLogsFor(overlongKey)[0][0]).length).toBeLessThan(overlongKey.length);

    // Legacy keys are no longer registered; startup cleanups must still remove them.
    window.localStorage.setItem("input:legacy-draft", JSON.stringify("old text"));
    expect(updatePersistedState("input:legacy-draft", null)).toBe(true);
    expect(window.localStorage.getItem("input:legacy-draft")).toBeNull();
  });

  test("batch removal clears every key and mounted hooks fall back to their defaults", () => {
    const keys = [getTimelineFilterKey("budget0003"), getTimelineFilterKey("budget0004")];
    for (const key of keys) window.localStorage.setItem(key, JSON.stringify("tools"));
    const { result } = renderHook(() => usePersistedState(keys[0], "all", { listener: true }));
    expect(result.current[0]).toBe("tools");

    act(() => removePersistedStateKeys(keys));

    expect(result.current[0]).toBe("all");
    for (const key of keys) expect(window.localStorage.getItem(key)).toBeNull();
  });
});
