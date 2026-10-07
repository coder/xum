import { describe, expect, test } from "bun:test";

import {
  applyStoredUserPreference,
  entriesFromUserPreferences,
  getStoredUserPreferenceEntries,
  isUserPreferenceStorageKey,
  removeStoredUserPreference,
} from "./userPreferencesStorage";
import {
  REVIEW_INCLUDE_UNCOMMITTED_KEY,
  getLastRuntimeConfigKey,
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
  getReviewDefaultBaseKey,
  getTrunkBranchKey,
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
    storage.setJSON(getTrunkBranchKey("/repo"), "origin/main");
    storage.setJSON(getLastRuntimeConfigKey("/repo"), { ssh: { host: "devbox" } });
    storage.setJSON(getNotifyOnResponseAutoEnableKey("/repo"), true);
    storage.setJSON(getNotifyOnResponseKey("ws-1"), true);
    storage.setJSON(REVIEW_INCLUDE_UNCOMMITTED_KEY, true);
    storage.setJSON(getReviewDefaultBaseKey("/repo"), "origin/main");

    expect(collectForTest(storage)).toEqual({
      workspaceCreation: {
        byProject: {
          "/repo": {
            trunkBranch: "origin/main",
            lastRuntimeConfig: { ssh: { host: "devbox" } },
            notifyOnResponseAutoEnable: true,
          },
        },
      },
      notifications: {
        notifyOnResponseByWorkspace: { "ws-1": true },
      },
      review: {
        includeUncommitted: true,
        defaultBaseByProject: { "/repo": "origin/main" },
      },
    });
  });

  test("all flattened preference entries are recognized, applied, and removable", () => {
    const preferences: UserPreferences = {
      workspaceCreation: {
        byProject: {
          "/repo": {
            trunkBranch: "origin/main",
            lastRuntimeConfig: { ssh: { host: "devbox" } },
            notifyOnResponseAutoEnable: true,
          },
        },
      },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": false } },
      review: { includeUncommitted: true, defaultBaseByProject: { "/repo": "origin/main" } },
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

  test("round trips backend preferences to localStorage entries", () => {
    const preferences = {
      review: { includeUncommitted: true },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": false } },
    };

    expect(entriesFromUserPreferences(preferences)).toEqual([
      { key: getNotifyOnResponseKey("ws-1"), value: false },
      { key: REVIEW_INCLUDE_UNCOMMITTED_KEY, value: true },
    ]);
  });

  test("removes a single localStorage preference without dropping siblings", () => {
    let preferences = applyStoredUserPreference(undefined, REVIEW_INCLUDE_UNCOMMITTED_KEY, true);
    preferences = applyStoredUserPreference(preferences, getReviewDefaultBaseKey("/repo"), "main");
    preferences = removeStoredUserPreference(preferences, REVIEW_INCLUDE_UNCOMMITTED_KEY);

    expect(preferences).toEqual({ review: { defaultBaseByProject: { "/repo": "main" } } });
    expect(entryKeys(preferences)).not.toContain(REVIEW_INCLUDE_UNCOMMITTED_KEY);
  });

  test("returns only valid entries for backfill", () => {
    const storage = new MemoryStorage();
    storage.setJSON(REVIEW_INCLUDE_UNCOMMITTED_KEY, true);
    storage.setJSON(getTrunkBranchKey("/repo"), "  ");

    expect(getStoredUserPreferenceEntries(storage)).toEqual([
      { key: REVIEW_INCLUDE_UNCOMMITTED_KEY, value: true },
    ]);
  });
});
