import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import { getCreationDraftScopeId } from "@/common/constants/storage";
import { getUserPreferences } from "@/browser/stores/AppConfigStore";
import { markAiSelectionIntent } from "./aiSelectionIntent";
import { setWorkspaceServiceTier } from "./fastModeServiceTier";
import { readScopeAgentId, readScopedAiDefault, writeScopedAiDefault } from "./scopedAiDefaults";
import { getWorkspaceAiSelection } from "./workspaceAiSettingsSync";

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

  test("a draft without an agent pick shows the global agent, not a stale project agent", () => {
    getAppConfigStore().updateOptimistically({
      userPreferences: {
        ai: {
          globalDefaults: { agentId: "plan" },
          projectDefaults: { [PROJECT]: { agentId: "ask" } },
        },
      },
    });
    const store = getCreationDraftStore();
    const scopeId = getCreationDraftScopeId(store.create(PROJECT, null));
    expect(readScopedAiDefault(scopeId, "agentId")).toBeUndefined();
    expect(readScopeAgentId(scopeId)).toBe("plan");

    writeScopedAiDefault(scopeId, "agentId", "ask");
    expect(readScopeAgentId(scopeId)).toBe("ask");
  });

  // Speed and Pro/Cyber follow the same draft ownership as the thinking level (#6620).
  test("speed and Pro picks belong to the draft, like the thinking level", () => {
    const store = getCreationDraftStore();
    const draftId = store.create(PROJECT, null);
    const scopeId = getCreationDraftScopeId(draftId);
    writeScopedAiDefault(scopeId, "thinkingLevel", "low");
    setWorkspaceServiceTier(null, scopeId, "priority");
    markAiSelectionIntent(scopeId, "reasoningMode", "pro"); // The selector's Pro toggle.

    expect(store.getView(draftId).draft?.ai).toMatchObject({
      thinkingLevel: "low",
      serviceTier: "priority",
      reasoningMode: "pro",
    });
    expect(getWorkspaceAiSelection(scopeId)).toMatchObject({
      thinkingLevel: "low",
      serviceTier: "priority",
      reasoningMode: "pro",
    });
    // None of them writes the project's defaults, so the next draft starts from those.
    expect(getUserPreferences().ai?.projectDefaults?.[PROJECT]).toEqual({
      model: "openai:gpt-5",
      thinkingLevel: "high",
    });
    const next = getCreationDraftScopeId(store.create(PROJECT, null));
    expect(getWorkspaceAiSelection(next)).toMatchObject({
      thinkingLevel: "high",
      serviceTier: undefined,
      reasoningMode: "standard",
    });
  });
});
