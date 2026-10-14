import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { resetTestExperiments, setTestExperiment } from "@/browser/testUtils";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import {
  resetAiSelectionIntentForTests,
  setAutoRoutingPick,
  setWorkspaceAiMetadata,
} from "@/browser/utils/aiSelectionIntent";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getProjectScopeId } from "@/common/constants/storage";
import { installDom } from "../../../../tests/ui/dom";
import { getSendOptionsFromStorage } from "./sendOptions";
import { SendMessageOptionsSchema } from "@/common/orpc/schemas/stream";
import { normalizeModelPreference } from "./buildSendMessageOptions";

let cleanupDom: (() => void) | null = null;

describe("getSendOptionsFromStorage", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    getAppConfigStore().updateOptimistically({ defaultModel: "openai:default" });
  });

  afterEach(() => {
    resetTestExperiments();
    resetAiSelectionIntentForTests();
    getAppConfigStore().updateOptimistically({
      userPreferences: undefined,
      defaultModel: undefined,
    });
    window.localStorage.clear();
    cleanupDom?.();
    cleanupDom = null;
  });

  test.each([
    { experiment: true, selected: true, expected: true },
    { experiment: false, selected: true, expected: undefined },
    { experiment: true, selected: false, expected: undefined },
  ])(
    "carries the Auto flag only while the experiment is on and Auto is selected (%j)",
    ({ experiment, selected, expected }) => {
      setTestExperiment(EXPERIMENT_IDS.AUTO_MODEL_ROUTING, experiment);
      setAutoRoutingPick("ws-auto", "exec", "model", selected);
      const options = getSendOptionsFromStorage("ws-auto");
      expect(options.autoModelRouting).toBe(expected);
      expect(SendMessageOptionsSchema.parse(JSON.parse(JSON.stringify(options))).model).toBe(
        options.model
      );
    }
  );

  test.each([
    { experiment: true, model: true, thinking: false },
    { experiment: true, model: false, thinking: true },
    { experiment: false, model: true, thinking: true },
  ])("routes the model and thinking dimensions independently (%j)", (input) => {
    setTestExperiment(EXPERIMENT_IDS.AUTO_MODEL_ROUTING, input.experiment);
    setAutoRoutingPick("ws-dims", "exec", "model", input.model);
    setAutoRoutingPick("ws-dims", "exec", "thinkingLevel", input.thinking);
    const options = getSendOptionsFromStorage("ws-dims");
    expect(options.autoModelRouting).toBe(input.experiment && input.model ? true : undefined);
    expect(options.autoThinkingLevel).toBe(input.experiment && input.thinking ? true : undefined);
    expect(SendMessageOptionsSchema.parse(JSON.parse(JSON.stringify(options))).thinkingLevel).toBe(
      options.thinkingLevel
    );
  });

  test("a project without its own agent sends the inherited global agent's Auto choice", () => {
    setTestExperiment(EXPERIMENT_IDS.AUTO_MODEL_ROUTING, true);
    getAppConfigStore().updateOptimistically({
      userPreferences: { ai: { globalDefaults: { agentId: "plan" } } },
    });
    const scopeId = getProjectScopeId("/send-options-project");
    setAutoRoutingPick(scopeId, "plan", "model", true);
    const options = getSendOptionsFromStorage(scopeId);
    expect(options.agentId).toBe("plan");
    expect(options.autoModelRouting).toBe(true);
  });

  test("preserves explicit gateway-scoped saved workspace models", () => {
    const workspaceId = "ws-1";
    const rawModel = "mux-gateway:anthropic/claude-haiku-4-5";

    setWorkspaceAiMetadata(workspaceId, {
      aiSettingsByAgent: { exec: { model: rawModel, thinkingLevel: "off" } },
    });

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.model).toBe(rawModel);
    expect(options.thinkingLevel).toBe(WORKSPACE_DEFAULTS.thinkingLevel);
  });

  test("keeps direct-provider model preferences normalized via the shared helper", () => {
    expect(normalizeModelPreference(" openai:gpt-5.2 ", "anthropic:default")).toBe(
      "openai:gpt-5.2"
    );
  });

  test("includes Anthropic prompt cache TTL from persisted provider options", () => {
    const workspaceId = "ws-3";

    getAppConfigStore().updateOptimistically({
      userPreferences: { ai: { providerOptions: { anthropic: { cacheTtl: "1h" } } } },
    });

    const options = getSendOptionsFromStorage(workspaceId);
    expect(options.providerOptions?.anthropic?.cacheTtl).toBe("1h");
  });
});
