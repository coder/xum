import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";

import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import {
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
  setAgentBases,
  setAutoRoutingPick,
  setWorkspaceAiMetadata,
} from "@/browser/utils/aiSelectionIntent";
import {
  getAutoRouting,
  getWorkspaceAiSelection,
  useAutoRouting,
  useWorkspaceAiSelection,
  type WorkspaceAiSelection,
} from "@/browser/utils/workspaceAiSettingsSync";
import { getProjectScopeId } from "@/common/constants/storage";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";

const WS = "resolver-ws";
const PROJECT = "/repo";

type Tier = "pick" | "saved" | "legacy" | "configured" | "project";

function seed(tiers: readonly Tier[]): void {
  const has = (tier: Tier) => tiers.includes(tier);
  getAppConfigStore().updateOptimistically({
    defaultModel: "openai:global",
    agentAiDefaults: has("configured")
      ? { exec: { modelString: "openai:configured", thinkingLevel: "high", reasoningMode: "pro" } }
      : {},
    userPreferences: {
      ai: {
        globalDefaults: { thinkingLevel: "low" },
        projectDefaults: has("project")
          ? { [PROJECT]: { model: "openai:project", thinkingLevel: "medium" } }
          : undefined,
      },
    },
  });
  setWorkspaceAiMetadata(WS, {
    projectPath: PROJECT,
    aiSettings: has("legacy") ? { model: "openai:legacy", thinkingLevel: "xhigh" } : undefined,
    aiSettingsByAgent: has("saved")
      ? { exec: { model: "openai:saved", thinkingLevel: "xhigh" } }
      : undefined,
  });
  if (has("pick")) {
    markAiSelectionIntent(WS, "model", "openai:picked");
    markAiSelectionIntent(WS, "thinkingLevel", "max");
    markAiSelectionIntent(WS, "reasoningMode", "pro");
  }
}

describe("getWorkspaceAiSelection", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    resetAiSelectionIntentForTests();
  });

  afterEach(() => {
    cleanup();
    resetAiSelectionIntentForTests();
    getAppConfigStore().updateOptimistically({
      defaultModel: undefined,
      agentAiDefaults: undefined,
      userPreferences: undefined,
    });
    restoreDomGlobals();
  });

  test("each field falls through the unsent pick, saved settings, agent and project defaults", () => {
    const cases: Array<{
      tiers: Tier[];
      model: string;
      thinkingLevel: ThinkingLevel;
      reasoning: OpenAIReasoningMode;
    }> = [
      {
        tiers: ["pick", "saved", "legacy", "configured", "project"],
        model: "openai:picked",
        thinkingLevel: "max",
        reasoning: "pro",
      },
      {
        tiers: ["saved", "legacy", "configured", "project"],
        model: "openai:saved",
        thinkingLevel: "xhigh",
        // A saved bucket owns reasoning: its absent mode means standard.
        reasoning: "standard",
      },
      {
        tiers: ["legacy", "configured", "project"],
        model: "openai:legacy",
        thinkingLevel: "xhigh",
        reasoning: "standard",
      },
      {
        tiers: ["configured", "project"],
        model: "openai:configured",
        thinkingLevel: "high",
        reasoning: "pro",
      },
      {
        tiers: ["project"],
        model: "openai:project",
        thinkingLevel: "medium",
        reasoning: "standard",
      },
      { tiers: [], model: "openai:global", thinkingLevel: "low", reasoning: "standard" },
    ];

    for (const testCase of cases) {
      resetAiSelectionIntentForTests();
      seed(testCase.tiers);
      expect({ tiers: testCase.tiers, ...getWorkspaceAiSelection(WS, "exec") }).toEqual({
        tiers: testCase.tiers,
        model: testCase.model,
        thinkingLevel: testCase.thinkingLevel,
        reasoningMode: testCase.reasoning,
      });
    }
  });

  test("a custom agent resolves its base agent's defaults from the loaded agent list", () => {
    getAppConfigStore().updateOptimistically({
      defaultModel: "openai:global",
      agentAiDefaults: { exec: { modelString: "openai:configured", thinkingLevel: "high" } },
    });
    setWorkspaceAiMetadata(WS, {
      projectPath: PROJECT,
      aiSettings: undefined,
      aiSettingsByAgent: undefined,
    });
    setAgentBases(WS, [{ id: "exec" }, { id: "reviewer", base: "exec" }]);

    expect(getWorkspaceAiSelection(WS, "reviewer")).toMatchObject({
      model: "openai:configured",
      thinkingLevel: "high",
    });
  });

  test("the hook follows a default model that loads after it rendered", () => {
    setWorkspaceAiMetadata(WS, {
      projectPath: PROJECT,
      aiSettings: undefined,
      aiSettingsByAgent: undefined,
    });
    const { result } = renderHook(() => useWorkspaceAiSelection(WS, "exec"));

    act(() => getAppConfigStore().updateOptimistically({ defaultModel: "openai:loaded-later" }));

    expect(result.current.model).toBe("openai:loaded-later");
  });

  test("a legacy workspace id that starts with __ resolves its saved settings", () => {
    const legacyId = "__proj-main";
    setWorkspaceAiMetadata(legacyId, {
      projectPath: PROJECT,
      aiSettings: undefined,
      aiSettingsByAgent: { exec: { model: "openai:saved", thinkingLevel: "high" } },
    });

    const { result } = renderHook(() => useWorkspaceAiSelection(legacyId, "exec"));
    expect(result.current.model).toBe("openai:saved");
    expect(getWorkspaceAiSelection(legacyId, "exec").model).toBe("openai:saved");
  });

  test("a creation scope resolves its own defaults in the hook and the plain reader", () => {
    const scopeId = getProjectScopeId(PROJECT);
    // Workspace resolution would apply the configured Exec model here instead.
    getAppConfigStore().updateOptimistically({
      defaultModel: "openai:global",
      agentAiDefaults: { exec: { modelString: "openai:configured" } },
      userPreferences: {
        ai: {
          projectDefaults: { [PROJECT]: { model: "openai:project", thinkingLevel: "medium" } },
        },
      },
    });
    markAiSelectionIntent(scopeId, "reasoningMode", "pro");

    const expected: WorkspaceAiSelection = {
      model: "openai:project",
      thinkingLevel: "medium",
      reasoningMode: "pro",
    };
    const { result } = renderHook(() => useWorkspaceAiSelection(scopeId));
    expect(result.current).toEqual(expected);
    expect(getWorkspaceAiSelection(scopeId)).toEqual(expected);
  });

  test("Auto routing falls through the unsent pick, the saved flag and configured Auto", () => {
    getAppConfigStore().updateOptimistically({
      agentAiDefaults: { exec: { autoModelRouting: true, autoThinkingLevel: true } },
    });
    const save = (flags: { autoModelRouting?: boolean }) =>
      setWorkspaceAiMetadata(WS, {
        aiSettingsByAgent: { exec: { model: "openai:saved", thinkingLevel: "low", ...flags } },
      });
    expect(getAutoRouting(WS, "model", "exec")).toBe(true);
    expect(getAutoRouting(WS, "model", "plan")).toBe(false);
    setAgentBases(WS, [{ id: "reviewer", base: "exec" }]);
    expect(getAutoRouting(WS, "model", "reviewer")).toBe(true);
    setAutoRoutingPick(WS, "exec", "model", false);
    expect(getAutoRouting(WS, "model", "exec")).toBe(false);

    // A saved bucket owns the flag: its absent flag means off.
    save({});
    expect(getAutoRouting(WS, "thinkingLevel", "exec")).toBe(false);

    setAutoRoutingPick(WS, "exec", "model", true);
    expect(getAutoRouting(WS, "model", "exec")).toBe(true);

    // A legacy workspace's single bucket owns the flag too.
    const legacy = "resolver-legacy";
    setWorkspaceAiMetadata(legacy, { aiSettings: { model: "openai:saved", thinkingLevel: "low" } });
    expect(getAutoRouting(legacy, "model", "exec")).toBe(false);
  });

  test("a project without its own agent routes Auto for the inherited global agent", () => {
    getAppConfigStore().updateOptimistically({
      agentAiDefaults: { plan: { autoModelRouting: true } },
      userPreferences: { ai: { globalDefaults: { agentId: "plan" } } },
    });
    const scopeId = getProjectScopeId(PROJECT);
    expect(getAutoRouting(scopeId, "model")).toBe(true);
    const { result } = renderHook(() => useAutoRouting(scopeId, "model"));
    expect(result.current).toBe(true);
  });
});
