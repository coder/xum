import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { DEFAULT_MODEL_KEY, HIDDEN_MODELS_KEY } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { migrateLocalModelPrefsToBackend } from "./WorkspaceContext";
import { createTestApiClient } from "@/browser/testUtils";

function createApiMock() {
  const updateModelPreferences = mock(() => Promise.resolve(undefined));

  return {
    api: createTestApiClient({
      config: {
        updateModelPreferences,
      },
    }),
    updateModelPreferences,
  };
}

function setLocalDefaultModel(model: string): void {
  globalThis.window.localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(model));
}

function getNonDefaultModel(): string {
  const alternativeModel = Object.values(KNOWN_MODELS).find(
    (model) => model.id !== WORKSPACE_DEFAULTS.model
  );
  if (!alternativeModel) {
    throw new Error("Expected at least one non-default known model");
  }

  return alternativeModel.id;
}

describe("migrateLocalModelPrefsToBackend", () => {
  beforeEach(() => {
    saveDomGlobals();
    const happyWindow = new GlobalWindow();
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    globalThis.localStorage = happyWindow.localStorage;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    globalThis.window.localStorage.clear();
    restoreDomGlobals();
  });

  test("migrates an explicit local default when it matches the built-in default", () => {
    setLocalDefaultModel(WORKSPACE_DEFAULTS.model);
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).toHaveBeenCalledTimes(1);
    expect(updateModelPreferences).toHaveBeenCalledWith({
      defaultModel: WORKSPACE_DEFAULTS.model,
    });
  });

  test("migrates an explicit local default when it differs from the built-in default", () => {
    const nonDefaultModel = getNonDefaultModel();
    setLocalDefaultModel(nonDefaultModel);
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).toHaveBeenCalledTimes(1);
    expect(updateModelPreferences).toHaveBeenCalledWith({ defaultModel: nonDefaultModel });
  });

  test("does not overwrite a backend default model", () => {
    setLocalDefaultModel(getNonDefaultModel());
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, { defaultModel: WORKSPACE_DEFAULTS.model });

    expect(updateModelPreferences).not.toHaveBeenCalled();
  });

  test("does not migrate when no local default model is stored", () => {
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).not.toHaveBeenCalled();
  });

  test("does not migrate when the local default model is empty after trimming", () => {
    setLocalDefaultModel("   ");
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).not.toHaveBeenCalled();
  });

  test("preserves explicit gateway-scoped local default during migration", () => {
    setLocalDefaultModel("openrouter:openai/gpt-5");
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).toHaveBeenCalledTimes(1);
    expect(updateModelPreferences).toHaveBeenCalledWith({
      defaultModel: "openrouter:openai/gpt-5",
    });
  });

  test("merges legacy hides with uninitialized backend hides before hydration", () => {
    const legacyHidden = "openrouter:openai/gpt-5";
    const backendHidden = ["openai:gpt-6-luna", "openai:custom-model"];
    updatePersistedState(HIDDEN_MODELS_KEY, [legacyHidden]);
    const { api, updateModelPreferences } = createApiMock();

    const prefs = migrateLocalModelPrefsToBackend(api, {
      hiddenModels: backendHidden,
      hiddenModelsInitialized: false,
    });
    expect(prefs.hiddenModels).toEqual([...backendHidden, legacyHidden]);
    expect(updateModelPreferences).toHaveBeenCalledWith({ hiddenModels: prefs.hiddenModels });
  });

  test.each([{ hiddenModels: [] }, { hiddenModels: ["openai:gpt-5"] }])(
    "restores local hides when migrated backend data is lost: %j",
    ({ hiddenModels }) => {
      updatePersistedState(HIDDEN_MODELS_KEY, hiddenModels);
      const { api, updateModelPreferences } = createApiMock();
      const prefs = migrateLocalModelPrefsToBackend(api, { hiddenModelsInitialized: false });
      expect(prefs.hiddenModels).toEqual([...hiddenModels]);
      expect(updateModelPreferences).toHaveBeenCalledWith({ hiddenModels });
    }
  );

  test.each([{ hiddenModels: [] }, { hiddenModels: ["openai:gpt-6-astra"] }])(
    "keeps initialized backend choices authoritative over stale local hides: %j",
    ({ hiddenModels }) => {
      updatePersistedState(HIDDEN_MODELS_KEY, ["openai:gpt-6-luna"]);
      const { api, updateModelPreferences } = createApiMock();
      const prefs = migrateLocalModelPrefsToBackend(api, {
        hiddenModels: [...hiddenModels],
        hiddenModelsInitialized: true,
      });
      expect(prefs.hiddenModels).toEqual([...hiddenModels]);
      expect(updateModelPreferences).not.toHaveBeenCalled();
    }
  );
});
