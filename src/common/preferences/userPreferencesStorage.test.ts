import { describe, expect, test } from "bun:test";

import {
  applyStoredUserPreference,
  entriesFromUserPreferences,
  getStoredUserPreferenceEntries,
  isUserPreferenceStorageKey,
  removeStoredUserPreference,
} from "./userPreferencesStorage";
import {
  PROJECT_ORDER_KEY,
  PROVIDER_OPTIONS_ANTHROPIC_KEY,
  REVIEW_INCLUDE_UNCOMMITTED_KEY,
  UI_THEME_KEY,
  getAgentIdKey,
  getAutoCompactionThresholdKey,
  getLastRuntimeConfigKey,
  getModelKey,
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
  getProjectScopeId,
  getReviewDefaultBaseKey,
  getThinkingLevelKey,
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
    const projectScope = getProjectScopeId("/repo");
    storage.setJSON(UI_THEME_KEY, "dark");
    storage.setJSON(PROJECT_ORDER_KEY, ["/repo"]);
    storage.setJSON(getAgentIdKey(projectScope), "plan");
    storage.setJSON(getModelKey(projectScope), "openai:gpt-4.1");
    storage.setJSON(getThinkingLevelKey(projectScope), "high");
    storage.setJSON(PROVIDER_OPTIONS_ANTHROPIC_KEY, { disableBetaFeatures: true });
    storage.setJSON(getAutoCompactionThresholdKey("openai:gpt-4.1"), 80);
    storage.setJSON(getTrunkBranchKey("/repo"), "origin/main");
    storage.setJSON(getLastRuntimeConfigKey("/repo"), { ssh: { host: "devbox" } });
    storage.setJSON(getNotifyOnResponseAutoEnableKey("/repo"), true);
    storage.setJSON(getNotifyOnResponseKey("ws-1"), true);
    storage.setJSON(REVIEW_INCLUDE_UNCOMMITTED_KEY, true);
    storage.setJSON(getReviewDefaultBaseKey("/repo"), "origin/main");

    expect(collectForTest(storage)).toEqual({
      appearance: { theme: "dark" },
      navigation: { projectOrder: ["/repo"] },
      ai: {
        projectDefaults: {
          "/repo": {
            agentId: "plan",
            model: "openai:gpt-4.1",
            thinkingLevel: "high",
          },
        },
        providerOptions: {
          anthropic: { disableBetaFeatures: true },
        },
        autoCompactionThresholdByModel: {
          "openai:gpt-4.1": 80,
        },
      },
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

  test("migrates legacy theme names during localStorage collection", () => {
    const storage = new MemoryStorage();
    storage.setJSON(UI_THEME_KEY, "solarized-dark");

    expect(collectForTest(storage)).toEqual({ appearance: { theme: "dark" } });
  });

  test("all flattened preference entries are recognized, applied, and removable", () => {
    const preferences: UserPreferences = {
      appearance: {
        theme: "flexoki-dark",
        transcriptDensity: "hyper",
        bashCollapsedSummaryMode: "intent",
        terminalFontConfig: { fontFamily: "Geist Mono", fontSize: 13 },
        editorConfig: { editor: "custom", customCommand: "code --goto" },
        vimEnabled: true,
      },
      navigation: { launchBehavior: "new-chat", projectOrder: ["/repo"] },
      ai: {
        globalDefaults: { agentId: "exec", thinkingLevel: "medium" },
        projectDefaults: {
          "/repo": {
            agentId: "plan",
            model: "openai:gpt-4.1",
            thinkingLevel: "high",
          },
        },
        providerOptions: {
          anthropic: { disableBetaFeatures: true },
          google: { safety: "off" },
        },
        autoCompactionThresholdByModel: { "openai:gpt-4.1": 100 },
      },
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
      appearance: { theme: "flexoki-light" as const },
      ai: {
        globalDefaults: { agentId: "exec" },
        projectDefaults: { "/repo": { model: "anthropic:claude-sonnet-4-20250514" } },
      },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": false } },
    };

    expect(entriesFromUserPreferences(preferences)).toEqual([
      { key: UI_THEME_KEY, value: "flexoki-light" },
      { key: getAgentIdKey("__global__"), value: "exec" },
      {
        key: getModelKey(getProjectScopeId("/repo")),
        value: "anthropic:claude-sonnet-4-20250514",
      },
      { key: getNotifyOnResponseKey("ws-1"), value: false },
    ]);
  });

  test("removes a single localStorage preference without dropping siblings", () => {
    let preferences = applyStoredUserPreference(undefined, UI_THEME_KEY, "dark");
    preferences = applyStoredUserPreference(preferences, "vimEnabled", true);
    preferences = removeStoredUserPreference(preferences, UI_THEME_KEY);

    expect(preferences).toEqual({ appearance: { vimEnabled: true } });
    expect(entryKeys(preferences)).not.toContain(UI_THEME_KEY);
  });

  test("returns only valid entries for backfill", () => {
    const storage = new MemoryStorage();
    storage.setJSON(UI_THEME_KEY, "dark");
    storage.setJSON(getAutoCompactionThresholdKey("bad"), 200);

    expect(getStoredUserPreferenceEntries(storage)).toEqual([{ key: UI_THEME_KEY, value: "dark" }]);
  });
});
