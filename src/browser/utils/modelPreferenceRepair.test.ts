import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";

import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  DEFAULT_MODEL_KEY,
  HIDDEN_MODELS_KEY,
  LAST_CUSTOM_MODEL_PROVIDER_KEY,
  getModelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { repairLocalModelPreferencesForRemovedProvider } from "./modelPreferenceRepair";

const REMOVED_PROVIDER = "removed-provider";
const OTHER_PROVIDER = "other-provider";

let cleanupDom: (() => void) | null = null;
let workspaceCounter = 0;
const touchedKeys = new Set<string>();

function nextWorkspaceId(): string {
  workspaceCounter += 1;
  return `model-preference-repair-test-${workspaceCounter}`;
}

function touchKey(key: string): string {
  touchedKeys.add(key);
  return key;
}

function writeState<T>(key: string, value: T): void {
  touchedKeys.add(key);
  updatePersistedState(key, value);
}

function readString(key: string): string | undefined {
  touchedKeys.add(key);
  return readPersistedString(key);
}

function readState<T>(key: string, defaultValue: T): T {
  touchedKeys.add(key);
  return readPersistedState(key, defaultValue);
}

describe("repairLocalModelPreferencesForRemovedProvider", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    touchedKeys.clear();
  });

  afterEach(() => {
    for (const key of touchedKeys) {
      updatePersistedState<undefined>(key, undefined);
    }
    touchedKeys.clear();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("resets default model only when it belongs to the removed provider", () => {
    writeState(DEFAULT_MODEL_KEY, `${REMOVED_PROVIDER}:legacy-model`);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, []);

    expect(readString(DEFAULT_MODEL_KEY)).toBe(WORKSPACE_DEFAULTS.model);

    const unrelatedModel = `${OTHER_PROVIDER}:kept-model`;
    writeState(DEFAULT_MODEL_KEY, unrelatedModel);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, []);

    expect(readString(DEFAULT_MODEL_KEY)).toBe(unrelatedModel);
  });

  test("resets per-workspace model only when it belongs to the removed provider", () => {
    const affectedWorkspaceId = nextWorkspaceId();
    const unaffectedWorkspaceId = nextWorkspaceId();
    const affectedKey = getModelKey(affectedWorkspaceId);
    const unaffectedKey = getModelKey(unaffectedWorkspaceId);
    const unaffectedModel = `${OTHER_PROVIDER}:workspace-model`;

    writeState(affectedKey, `${REMOVED_PROVIDER}:workspace-model`);
    writeState(unaffectedKey, unaffectedModel);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, [
      affectedWorkspaceId,
      unaffectedWorkspaceId,
      affectedWorkspaceId,
    ]);

    expect(readString(affectedKey)).toBe(WORKSPACE_DEFAULTS.model);
    expect(readString(unaffectedKey)).toBe(unaffectedModel);
  });

  test("filters hidden models for the removed provider and preserves other entries", () => {
    const keptModels = [`${OTHER_PROVIDER}:kept-model`, `${REMOVED_PROVIDER}-fork:similar-name`];
    writeState(HIDDEN_MODELS_KEY, [
      `${REMOVED_PROVIDER}:hidden-a`,
      keptModels[0],
      `${REMOVED_PROVIDER}:hidden-b`,
      keptModels[1],
    ]);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, []);

    expect(readState<string[]>(HIDDEN_MODELS_KEY, [])).toEqual(keptModels);
  });

  test("clears last custom model provider only when it matches the removed provider", () => {
    writeState(LAST_CUSTOM_MODEL_PROVIDER_KEY, REMOVED_PROVIDER);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, []);

    expect(readString(LAST_CUSTOM_MODEL_PROVIDER_KEY)).toBe("");

    writeState(LAST_CUSTOM_MODEL_PROVIDER_KEY, OTHER_PROVIDER);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, []);

    expect(readString(LAST_CUSTOM_MODEL_PROVIDER_KEY)).toBe(OTHER_PROVIDER);
  });

  test("resets affected per-agent workspace models while preserving entries and fields", () => {
    const workspaceId = nextWorkspaceId();
    const key = getWorkspaceAISettingsByAgentKey(workspaceId);
    const originalSettings = {
      exec: {
        model: `${REMOVED_PROVIDER}:agent-model`,
        thinkingLevel: "high",
        extraField: "preserve-me",
      },
      plan: {
        model: `${OTHER_PROVIDER}:agent-model`,
        thinkingLevel: "medium",
        extraField: 42,
      },
      custom: {
        thinkingLevel: "off",
        extraField: true,
      },
    };

    writeState(key, originalSettings);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, [workspaceId]);

    expect(readState(key, {})).toEqual({
      exec: {
        model: WORKSPACE_DEFAULTS.model,
        thinkingLevel: "high",
        extraField: "preserve-me",
      },
      plan: originalSettings.plan,
      custom: originalSettings.custom,
    });
  });

  test("does not change persisted state when no values match", () => {
    const workspaceId = nextWorkspaceId();
    const missingWorkspaceId = nextWorkspaceId();
    const workspaceModelKey = getModelKey(workspaceId);
    const missingWorkspaceModelKey = touchKey(getModelKey(missingWorkspaceId));
    const workspaceSettingsKey = getWorkspaceAISettingsByAgentKey(workspaceId);
    const missingWorkspaceSettingsKey = touchKey(
      getWorkspaceAISettingsByAgentKey(missingWorkspaceId)
    );
    const unchangedSettings = {
      exec: {
        model: `${OTHER_PROVIDER}:agent-model`,
        thinkingLevel: "off",
        extraField: { nested: true },
      },
    };

    writeState(DEFAULT_MODEL_KEY, `${OTHER_PROVIDER}:default-model`);
    writeState(HIDDEN_MODELS_KEY, [`${OTHER_PROVIDER}:hidden-model`]);
    writeState(LAST_CUSTOM_MODEL_PROVIDER_KEY, OTHER_PROVIDER);
    writeState(workspaceModelKey, `${OTHER_PROVIDER}:workspace-model`);
    writeState(workspaceSettingsKey, unchangedSettings);

    const before = {
      defaultModel: readString(DEFAULT_MODEL_KEY),
      hiddenModels: readState<string[]>(HIDDEN_MODELS_KEY, []),
      lastProvider: readString(LAST_CUSTOM_MODEL_PROVIDER_KEY),
      workspaceModel: readString(workspaceModelKey),
      workspaceSettings: readState(workspaceSettingsKey, {}),
    };

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER, [
      workspaceId,
      missingWorkspaceId,
    ]);

    expect({
      defaultModel: readString(DEFAULT_MODEL_KEY),
      hiddenModels: readState<string[]>(HIDDEN_MODELS_KEY, []),
      lastProvider: readString(LAST_CUSTOM_MODEL_PROVIDER_KEY),
      workspaceModel: readString(workspaceModelKey),
      workspaceSettings: readState(workspaceSettingsKey, {}),
    }).toEqual(before);
    expect(readString(missingWorkspaceModelKey)).toBeUndefined();
    expect(readState<unknown>(missingWorkspaceSettingsKey, undefined)).toBeUndefined();
  });
});
