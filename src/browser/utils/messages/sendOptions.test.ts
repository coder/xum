import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { resetTestExperiments, setTestExperiment } from "@/browser/testUtils";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
  getModelKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { installDom } from "../../../../tests/ui/dom";
import { getSendOptionsFromStorage } from "./sendOptions";
import { SendMessageOptionsSchema } from "@/common/orpc/schemas/stream";
import { normalizeModelPreference } from "./buildSendMessageOptions";

let cleanupDom: (() => void) | null = null;

describe("getSendOptionsFromStorage", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    resetTestExperiments();
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
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
      updatePersistedState(getAutoModelRoutingKey("ws-auto"), selected);
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
    updatePersistedState(getAutoModelRoutingKey("ws-dims"), input.model);
    updatePersistedState(getAutoThinkingLevelKey("ws-dims"), input.thinking);
    const options = getSendOptionsFromStorage("ws-dims");
    expect(options.autoModelRouting).toBe(input.experiment && input.model ? true : undefined);
    expect(options.autoThinkingLevel).toBe(input.experiment && input.thinking ? true : undefined);
    expect(SendMessageOptionsSchema.parse(JSON.parse(JSON.stringify(options))).thinkingLevel).toBe(
      options.thinkingLevel
    );
  });

  test("preserves explicit gateway-scoped stored model preferences", () => {
    const workspaceId = "ws-1";
    const rawModel = "mux-gateway:anthropic/claude-haiku-4-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(rawModel));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.model).toBe(rawModel);
    expect(options.thinkingLevel).toBe(WORKSPACE_DEFAULTS.thinkingLevel);
  });

  test("a project scope ignores the legacy per-model thinking level and writes nothing", () => {
    const projectScopeId = getProjectScopeId("/repo");
    window.localStorage.setItem(getThinkingLevelByModelKey("openai:default"), '"high"');

    expect(getSendOptionsFromStorage(projectScopeId).thinkingLevel).toBe("off");
    expect(window.localStorage.getItem(getThinkingLevelKey(projectScopeId))).toBeNull();
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
