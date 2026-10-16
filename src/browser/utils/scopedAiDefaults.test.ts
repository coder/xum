import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import { getCreationDraftScopeId } from "@/common/constants/storage";
import { readScopedAiDefault } from "./scopedAiDefaults";

const PROJECT = "/projects/with-defaults";

describe("readScopedAiDefault for a creation draft", () => {
  beforeEach(() => {
    const store = getAppConfigStore();
    store.setClient(createTestApiClient({ config: createTestPreferencesConfig() }));
    store.updateOptimistically({
      userPreferences: {
        ai: { projectDefaults: { [PROJECT]: { model: "openai:gpt-5", thinkingLevel: "high" } } },
      },
    });
  });

  afterEach(() => {
    getCreationDraftStore().forgetProject(PROJECT);
    getAppConfigStore().setClient(null);
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
  });

  test("a field the draft never set shows its project's default; a set field wins", () => {
    const store = getCreationDraftStore();
    const draftId = store.create(PROJECT, null);
    // An imported old draft carries no AI choices.
    store.update(draftId, { ai: {} });
    const scopeId = getCreationDraftScopeId(draftId);
    expect(readScopedAiDefault(scopeId, "model")).toBe("openai:gpt-5");
    expect(readScopedAiDefault(scopeId, "thinkingLevel")).toBe("high");

    store.update(draftId, { ai: { model: "anthropic:claude-sonnet-4-5" } });
    expect(readScopedAiDefault(scopeId, "model")).toBe("anthropic:claude-sonnet-4-5");
  });
});
