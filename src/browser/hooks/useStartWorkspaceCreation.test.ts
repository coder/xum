import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  persistWorkspaceCreationPrefill,
  type StartWorkspaceCreationDetail,
} from "./useStartWorkspaceCreation";
import { getProjectScopeId } from "@/common/constants/storage";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import { defaultCreationDraftScope, getDraftStore } from "@/browser/stores/DraftStore";
import { resetAiSelectionIntentForTests } from "@/browser/utils/aiSelectionIntent";
import { setAutoRoutingChoice } from "@/browser/utils/modelChange";
import { getAutoRouting } from "@/browser/utils/workspaceAiSettingsSync";

describe("persistWorkspaceCreationPrefill", () => {
  const projectPath = "/tmp/project";

  beforeEach(() => {
    const store = getAppConfigStore();
    store.setClient(createTestApiClient({ config: createTestPreferencesConfig() }));
    store.updateOptimistically({ userPreferences: {} });
  });

  afterEach(() => {
    resetAiSelectionIntentForTests();
    getAppConfigStore().setClient(null);
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
  });

  function projectModel() {
    return getUserPreferences().ai?.projectDefaults?.[projectPath]?.model;
  }

  function projectTrunk() {
    return getUserPreferences().workspaceCreation?.byProject?.[projectPath]?.trunkBranch;
  }

  test("writes provided values and normalizes whitespace", () => {
    const detail: StartWorkspaceCreationDetail = {
      projectPath,
      startMessage: "Ship it",
      model: "provider:model",
      trunkBranch: " main ",
      runtime: " ssh dev ", // runtime is NOT persisted - it's a one-time override
    };
    persistWorkspaceCreationPrefill(projectPath, detail);

    expect(getDraftStore().getText(defaultCreationDraftScope(projectPath))).toBe("Ship it");
    expect(projectModel()).toBe("provider:model");
    expect(projectTrunk()).toBe("main");
  });

  test("a prefilled model is an explicit pick and leaves the project's Auto routing", () => {
    const scopeId = getProjectScopeId(projectPath);
    setAutoRoutingChoice(scopeId, "model", true);

    persistWorkspaceCreationPrefill(projectPath, { projectPath, model: "provider:model" });

    expect(projectModel()).toBe("provider:model");
    expect(getAutoRouting(scopeId, "model")).toBe(false);
  });

  test("clears persisted values when empty strings are provided", () => {
    getAppConfigStore().updateOptimistically({
      userPreferences: {
        workspaceCreation: { byProject: { [projectPath]: { trunkBranch: "dev" } } },
      },
    });
    persistWorkspaceCreationPrefill(projectPath, { projectPath, trunkBranch: "   " });

    expect(projectTrunk()).toBeUndefined();
  });
});
