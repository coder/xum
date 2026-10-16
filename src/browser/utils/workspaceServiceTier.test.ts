import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { createTestApiClient } from "@/browser/testUtils";
import { getDraftScopeId, getProjectScopeId, GLOBAL_SCOPE_ID } from "@/common/constants/storage";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import { applyMergePatch } from "@/common/utils/applyMergePatch";
import { SendMessageOptionsSchema } from "@/common/orpc/schemas/stream";
import { WorkspaceAISettingsSchema } from "@/common/orpc/schemas/workspaceAiSettings";
import { pickPreservedSendOptions, pickStartupRetrySendOptions } from "@/common/types/message";
import {
  applyAiSelectionIntentToPins,
  taskAiPinsToLayer,
  targetWorkspaceBucketToLayer,
} from "@/common/types/agentAiSettings";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import { getSendOptionsFromStorage } from "./messages/sendOptions";
import { getWorkspaceAiSelection } from "./workspaceAiSettingsSync";
import { setWorkspaceServiceTier, toggleServiceTier } from "./fastModeServiceTier";
import {
  consumeAiSelectionIntent,
  getAiSelectionIntentForSendOptions,
  getPendingAiSelection,
  handOffCreationAiSelection,
  resetAiSelectionIntentForTests,
  setWorkspaceAiMetadata,
} from "./aiSelectionIntent";

const saved = { model: "openai:gpt-6-astra", thinkingLevel: "high" as const };
let cleanupDom: () => void;

beforeEach(() => {
  cleanupDom = installDom();
  resetAiSelectionIntentForTests();
  const store = getAppConfigStore();
  store.updateOptimistically({ defaultModel: saved.model });
  // Apply preference writes locally, as a connected store would once they save.
  spyOn(store, "updateUserPreferences").mockImplementation((patch) => {
    store.updateOptimistically({
      userPreferences: normalizeUserPreferences(applyMergePatch(getUserPreferences(), patch)),
    });
  });
});
afterEach(() => {
  resetAiSelectionIntentForTests();
  mock.restore();
  getAppConfigStore().updateOptimistically({ defaultModel: undefined, userPreferences: undefined });
  cleanupDom();
});

describe("per-chat OpenAI speed", () => {
  test("isolates pending and saved selections and restores the saved tier after reload", () => {
    setWorkspaceAiMetadata("a", { aiSettingsByAgent: { exec: saved } });
    setWorkspaceAiMetadata("b", {
      aiSettingsByAgent: { exec: { ...saved, serviceTier: "ultrafast" } },
    });
    setWorkspaceServiceTier(null, "a", "priority");
    expect(getWorkspaceAiSelection("a").serviceTier).toBe("priority");
    expect(getWorkspaceAiSelection("b").serviceTier).toBe("ultrafast");
    expect(getWorkspaceAiSelection("a", "plan").serviceTier).toBeUndefined();

    const options = getSendOptionsFromStorage("a");
    const prepared = getAiSelectionIntentForSendOptions("a", "exec", options);
    expect(prepared.intent).toEqual({ serviceTier: true });
    consumeAiSelectionIntent("a", "exec", prepared);
    expect(getPendingAiSelection("a", "exec", "serviceTier")).toBe("priority");
    const persisted = WorkspaceAISettingsSchema.parse(options);
    setWorkspaceAiMetadata("a", { aiSettingsByAgent: { exec: persisted } });
    expect(getPendingAiSelection("a", "exec", "serviceTier")).toBeUndefined();
    setWorkspaceServiceTier(null, "a", "default");
    resetAiSelectionIntentForTests(); // A renderer reload drops only the unsent pick.
    setWorkspaceAiMetadata("a", { aiSettingsByAgent: { exec: persisted } });
    expect(getWorkspaceAiSelection("a").serviceTier).toBe("priority");
  });

  test("a rapid re-pick survives completion of an older send", () => {
    setWorkspaceServiceTier(null, "a", "priority");
    const prepared = getAiSelectionIntentForSendOptions(
      "a",
      "exec",
      getSendOptionsFromStorage("a")
    );
    setWorkspaceServiceTier(null, "a", "default");
    setWorkspaceAiMetadata("a", {
      aiSettingsByAgent: { exec: { ...saved, serviceTier: "priority" } },
    });
    consumeAiSelectionIntent("a", "exec", prepared);
    expect(getWorkspaceAiSelection("a").serviceTier).toBe("default");
    expect(
      getAiSelectionIntentForSendOptions("a", "exec", { ...saved, serviceTier: "priority" }).intent
    ).toBeUndefined();
    expect(
      getAiSelectionIntentForSendOptions("a", "exec", {
        ...saved,
        serviceTier: "default",
        skipAiSettingsPersistence: true,
      }).intent
    ).toBeUndefined();
  });

  test.each(["priority", "ultrafast", "default"] as const)(
    "serializes %s at the send root through compaction and restart",
    (serviceTier) => {
      setWorkspaceServiceTier(null, "a", serviceTier);
      const options = getSendOptionsFromStorage("a");
      const parsed = SendMessageOptionsSchema.parse(
        JSON.parse(
          JSON.stringify({
            ...options,
            aiSelectionIntent: getAiSelectionIntentForSendOptions("a", "exec", options).intent,
          })
        )
      );
      expect(parsed.serviceTier).toBe(serviceTier);
      expect(parsed.aiSelectionIntent).toEqual({ serviceTier: true });
      expect(parsed.providerOptions?.openai?.serviceTier).toBeUndefined();
      expect(pickPreservedSendOptions(parsed).serviceTier).toBe(serviceTier);
      expect(pickStartupRetrySendOptions(parsed).serviceTier).toBe(serviceTier);
      handOffCreationAiSelection("created", "exec", { reasoningMode: "standard", serviceTier });
      expect(getWorkspaceAiSelection("created").serviceTier).toBe(serviceTier);
    }
  );

  // Like the thinking level, the new-workspace page's speed is the project (or global) default.
  test("a new-workspace speed pick is a saved default that later chats inherit", () => {
    const project = "/speed-project";
    const scope = getProjectScopeId(project);
    setWorkspaceServiceTier(null, scope, "priority");
    resetAiSelectionIntentForTests(); // A renderer reload keeps saved defaults.
    expect(getWorkspaceAiSelection(scope).serviceTier).toBe("priority");
    expect(getSendOptionsFromStorage(scope).serviceTier).toBe("priority");
    expect(getUserPreferences().ai?.projectDefaults?.[project]?.serviceTier).toBe("priority");

    // Existing chats in the project inherit it until they save their own choice.
    setWorkspaceAiMetadata("inherits", {
      projectPath: project,
      aiSettingsByAgent: { exec: saved },
    });
    setWorkspaceAiMetadata("own", {
      projectPath: project,
      aiSettingsByAgent: { exec: { ...saved, serviceTier: "default" } },
    });
    setWorkspaceAiMetadata("elsewhere", {
      projectPath: "/other",
      aiSettingsByAgent: { exec: saved },
    });
    expect(getWorkspaceAiSelection("inherits").serviceTier).toBe("priority");
    expect(getWorkspaceAiSelection("own").serviceTier).toBe("default");
    expect(getWorkspaceAiSelection("elsewhere").serviceTier).toBeUndefined();

    // The global new-workspace page sets the fallback for every project.
    setWorkspaceServiceTier(null, GLOBAL_SCOPE_ID, "ultrafast");
    expect(getWorkspaceAiSelection("elsewhere").serviceTier).toBe("ultrafast");
    expect(getWorkspaceAiSelection("inherits").serviceTier).toBe("priority");

    // Draft scopes have no saved defaults; they keep an unsent pick.
    const draft = getDraftScopeId(project, "draft-1");
    setWorkspaceServiceTier(null, draft, "default");
    expect(getWorkspaceAiSelection(draft).serviceTier).toBe("default");
    expect(getUserPreferences().ai?.projectDefaults?.[project]?.serviceTier).toBe("priority");
  });

  test("legacy absence remains inheritable while turning Fast off is an explicit default", () => {
    setWorkspaceAiMetadata("a", { aiSettings: saved });
    expect(getSendOptionsFromStorage("a").serviceTier).toBeUndefined();
    expect(pickPreservedSendOptions(getSendOptionsFromStorage("a"))).not.toHaveProperty(
      "serviceTier"
    );
    for (const premium of ["priority", "ultrafast"] as const) {
      setWorkspaceServiceTier(null, "a", toggleServiceTier(premium, premium));
      expect(getSendOptionsFromStorage("a").serviceTier).toBe("default");
    }
    expect(toggleServiceTier("ultrafast", "priority")).toBe("priority");
  });

  test("only a workspace pick nudges the live turn and neither scope writes provider defaults", async () => {
    const nudge = mock(() => Promise.resolve({ success: true as const, data: { accepted: true } }));
    const providerWrite = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const api = createTestApiClient({
      workspace: { setActiveTurnServiceTier: nudge },
      providers: { setProviderConfig: providerWrite },
    });
    setWorkspaceServiceTier(api, "a", "priority");
    setWorkspaceServiceTier(api, getProjectScopeId("/creation"), "ultrafast");
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledWith({ workspaceId: "a", serviceTier: "priority" });
    expect(providerWrite).not.toHaveBeenCalled();
    nudge.mockRejectedValueOnce(new Error("disconnected"));
    setWorkspaceServiceTier(api, "a", "default");
    await Promise.resolve();
    expect(getWorkspaceAiSelection("a").serviceTier).toBe("default");
  });

  test("the shared resolver preserves explicit speed, workspace fallback and task pins", () => {
    const base = {
      targetAgentId: "exec",
      profile: "interactive" as const,
      targetWorkspaceSettings: targetWorkspaceBucketToLayer({ ...saved, serviceTier: "priority" }),
      parentRuntime: { serviceTier: "ultrafast" as const },
    };
    expect(resolveAgentAiSettings(base).selected.serviceTier).toBe("priority");
    const explicit = resolveAgentAiSettings({ ...base, explicit: { serviceTier: "default" } });
    expect(explicit.selected.serviceTier).toBe("default");
    expect(explicit.effective.serviceTier).toBe("default");
    expect(
      resolveAgentAiSettings({ ...base, targetWorkspaceSettings: saved }).selected.serviceTier
    ).toBe("ultrafast");
    expect(taskAiPinsToLayer({ serviceTier: "invalid" })).not.toHaveProperty("serviceTier");
    const pins = applyAiSelectionIntentToPins(
      {},
      { serviceTier: true },
      { ...saved, serviceTier: "default" }
    );
    expect(taskAiPinsToLayer(pins).serviceTier).toBe("default");
    expect(applyAiSelectionIntentToPins(pins, {}, { ...saved, serviceTier: "priority" })).toBe(
      pins
    );
  });
});
