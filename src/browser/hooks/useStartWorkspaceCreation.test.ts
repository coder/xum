import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  persistWorkspaceCreationPrefill,
  type StartWorkspaceCreationDetail,
} from "./useStartWorkspaceCreation";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import { resetAiSelectionIntentForTests } from "@/browser/utils/aiSelectionIntent";

describe("persistWorkspaceCreationPrefill", () => {
  const projectPath = "/tmp/project";

  beforeEach(() => {
    const store = getAppConfigStore();
    store.setClient(createTestApiClient({ config: createTestPreferencesConfig() }));
    store.updateOptimistically({ userPreferences: {} });
  });

  afterEach(() => {
    getCreationDraftStore().forgetProject(projectPath);
    resetAiSelectionIntentForTests();
    getAppConfigStore().setClient(null);
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
  });

  function prefilledDraft(detail: StartWorkspaceCreationDetail) {
    const draftId = persistWorkspaceCreationPrefill(projectPath, null, detail);
    expect(draftId).toBeDefined();
    return getCreationDraftStore().getView(draftId!).draft;
  }

  test("writes provided values and normalizes whitespace", () => {
    const draft = prefilledDraft({
      projectPath,
      startMessage: "Ship it",
      model: "provider:model",
      trunkBranch: " main ",
      runtime: " ssh dev ", // runtime is NOT persisted - it's a one-time override
    });

    expect(draft?.text).toBe("Ship it");
    expect(draft?.ai.model).toBe("provider:model");
    expect(draft?.execution).toEqual({
      agent: null,
      runtime: null,
      trunkBranch: "main",
    });
  });

  test("a prefilled model is an explicit pick and leaves Auto routing", () => {
    const draft = prefilledDraft({ projectPath, model: "provider:model" });

    expect(draft?.ai.model).toBe("provider:model");
    expect(draft?.auto.model).toBe(false);
    expect(draft?.intent.model).toBe(true);
  });
});
