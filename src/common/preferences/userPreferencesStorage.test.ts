import { describe, expect, test } from "bun:test";

import {
  applyStoredUserPreference,
  entriesFromUserPreferences,
  getStoredUserPreferenceEntries,
  isUserPreferenceStorageKey,
  removeStoredUserPreference,
} from "./userPreferencesStorage";
import {
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
} from "@/common/constants/storage";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";

class MemoryStorage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setJSON(key: string, value: unknown) {
    this.values.set(key, JSON.stringify(value));
  }
}

function collectForTest(storage: MemoryStorage) {
  return getStoredUserPreferenceEntries(storage).reduce(
    (preferences, entry) => applyStoredUserPreference(preferences, entry.key, entry.value),
    undefined as Parameters<typeof applyStoredUserPreference>[0]
  );
}

function entryKeys(preferences: UserPreferences | undefined): string[] {
  return entriesFromUserPreferences(preferences).map((entry) => entry.key);
}

describe("user preference localStorage registry", () => {
  test("collects semantic preferences from legacy localStorage keys", () => {
    const storage = new MemoryStorage();
    storage.setJSON(getNotifyOnResponseAutoEnableKey("/repo"), true);
    storage.setJSON(getNotifyOnResponseKey("ws-1"), true);

    expect(collectForTest(storage)).toEqual({
      workspaceCreation: { byProject: { "/repo": { notifyOnResponseAutoEnable: true } } },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
    });
  });

  test("all flattened preference entries are recognized, applied, and removable", () => {
    const preferences: UserPreferences = {
      workspaceCreation: { byProject: { "/repo": { notifyOnResponseAutoEnable: true } } },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": false } },
    };

    const entries = entriesFromUserPreferences(preferences);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);

    for (const entry of entries) {
      expect(isUserPreferenceStorageKey(entry.key)).toBe(true);
      const applied = applyStoredUserPreference(undefined, entry.key, entry.value);
      expect(entryKeys(applied)).toContain(entry.key);
      expect(entryKeys(removeStoredUserPreference(applied, entry.key))).not.toContain(entry.key);
    }
  });

  test("removes a single localStorage preference without dropping siblings", () => {
    let preferences = applyStoredUserPreference(undefined, getNotifyOnResponseKey("ws-1"), true);
    preferences = applyStoredUserPreference(preferences, getNotifyOnResponseKey("ws-2"), false);
    preferences = removeStoredUserPreference(preferences, getNotifyOnResponseKey("ws-1"));

    expect(preferences).toEqual({
      notifications: { notifyOnResponseByWorkspace: { "ws-2": false } },
    });
  });

  test("returns only valid entries for backfill", () => {
    const storage = new MemoryStorage();
    storage.setJSON(getNotifyOnResponseKey("ws-1"), true);
    storage.setJSON(getNotifyOnResponseAutoEnableKey("/repo"), "  ");

    expect(getStoredUserPreferenceEntries(storage)).toEqual([
      { key: getNotifyOnResponseKey("ws-1"), value: true },
    ]);
  });
});
