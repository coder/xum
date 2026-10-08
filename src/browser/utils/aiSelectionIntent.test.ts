import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";

import {
  consumeAiSelectionIntent,
  getAiSelectionIntentForSend,
  getAiSelectionIntentForSendOptions,
  getPendingAiSelection,
  getWorkspaceAgentId,
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
  setWorkspaceAgentPick,
  setWorkspaceAiMetadata,
} from "@/browser/utils/aiSelectionIntent";

const WS = "intent-ws";
const MODEL_A = "openai:gpt-5.2";
const MODEL_B = "anthropic:claude-sonnet-4-5";

function saveExecModel(model: string): void {
  setWorkspaceAiMetadata(WS, { aiSettingsByAgent: { exec: { model, thinkingLevel: "off" } } });
}

describe("aiSelectionIntent", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
    resetAiSelectionIntentForTests();
  });

  afterEach(() => {
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
    restoreDomGlobals();
  });

  test("the workspace agent falls back to the project, then the global default agent", () => {
    getAppConfigStore().updateOptimistically({
      userPreferences: {
        ai: {
          globalDefaults: { agentId: "ask" },
          projectDefaults: { "/repo": { agentId: "plan" } },
        },
      },
    });
    setWorkspaceAiMetadata(WS, { projectPath: "/repo" });
    expect(getWorkspaceAgentId(WS)).toBe("plan");
    setWorkspaceAiMetadata(WS, { projectPath: "/other" });
    expect(getWorkspaceAgentId(WS)).toBe("ask");
    setWorkspaceAiMetadata(WS, { projectPath: "/repo", agentId: "exec" });
    expect(getWorkspaceAgentId(WS)).toBe("exec");
  });

  test("a sent agent pick lasts until the saved agent matches it; an unsent one outlasts it", () => {
    setWorkspaceAiMetadata(WS, { agentId: "plan" });
    setWorkspaceAgentPick(WS, "exec");
    setWorkspaceAiMetadata(WS, { agentId: "exec" });
    setWorkspaceAiMetadata(WS, { agentId: "plan" });
    expect(getWorkspaceAgentId(WS)).toBe("exec");

    consumeAiSelectionIntent(
      WS,
      "exec",
      getAiSelectionIntentForSend(WS, "exec", {}).attachedTokens
    );
    expect(getWorkspaceAgentId(WS)).toBe("exec");
    setWorkspaceAiMetadata(WS, { agentId: "exec" });
    setWorkspaceAiMetadata(WS, { agentId: "plan" });
    expect(getWorkspaceAgentId(WS)).toBe("plan");
  });

  test("re-picking the saved agent while a send is outstanding survives that send", () => {
    setWorkspaceAiMetadata(WS, { agentId: "plan" });
    setWorkspaceAgentPick(WS, "exec");
    const first = getAiSelectionIntentForSend(WS, "exec", {});
    setWorkspaceAgentPick(WS, "plan");
    consumeAiSelectionIntent(WS, "exec", first.attachedTokens);
    setWorkspaceAiMetadata(WS, { agentId: "exec" });
    expect(getWorkspaceAgentId(WS)).toBe("plan");
  });

  test("a sent agent pick the saved agent already holds ends at once", () => {
    setWorkspaceAiMetadata(WS, { agentId: "plan" });
    setWorkspaceAgentPick(WS, "plan");
    consumeAiSelectionIntent(
      WS,
      "plan",
      getAiSelectionIntentForSend(WS, "plan", {}).attachedTokens
    );
    // A no-op save emits no metadata; another window's later change still applies.
    setWorkspaceAiMetadata(WS, { agentId: "exec" });
    expect(getWorkspaceAgentId(WS)).toBe("exec");
  });

  test("attaches only fields whose sent value still equals the pick", () => {
    markAiSelectionIntent(WS, "model", MODEL_A);
    markAiSelectionIntent(WS, "thinkingLevel", "high");
    const { intent } = getAiSelectionIntentForSend(WS, "exec", {
      model: MODEL_A,
      thinkingLevel: "low", // moved away from the pick: stale
    });
    expect(intent).toEqual({ model: true });
  });

  test("a same-value pick still attaches, and nothing attaches without a pick", () => {
    expect(getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).intent).toBeUndefined();
    markAiSelectionIntent(WS, "reasoningMode", "standard");
    // An omitted reasoning mode is standard.
    expect(getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).intent).toEqual({
      reasoningMode: true,
    });
  });

  test("a re-pick made while a send is outstanding survives that send's consume", () => {
    markAiSelectionIntent(WS, "model", MODEL_A);
    const first = getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A });
    markAiSelectionIntent(WS, "model", MODEL_A); // same value, new token
    consumeAiSelectionIntent(WS, "exec", first.attachedTokens);
    expect(getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).intent).toEqual({
      model: true,
    });
  });

  test("A to B to A attaches the latest token, and consuming it clears the pick", () => {
    markAiSelectionIntent(WS, "model", MODEL_A);
    const staleTokens = getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).attachedTokens;
    markAiSelectionIntent(WS, "model", MODEL_B);
    markAiSelectionIntent(WS, "model", MODEL_A);
    const latest = getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A });
    expect(latest.attachedTokens.model).not.toBe(staleTokens.model);
    saveExecModel(MODEL_A);
    consumeAiSelectionIntent(WS, "exec", latest.attachedTokens);
    expect(getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).intent).toBeUndefined();
  });

  test("a sent pick lasts until the saved bucket holds it; an unsent pick outlasts it", () => {
    saveExecModel(MODEL_A);
    markAiSelectionIntent(WS, "model", MODEL_B);
    consumeAiSelectionIntent(
      WS,
      "exec",
      getAiSelectionIntentForSend(WS, "exec", { model: MODEL_B }).attachedTokens
    );
    // The save is in flight or failed: the composer keeps the sent pick.
    expect(getPendingAiSelection(WS, "exec", "model")).toBe(MODEL_B);
    saveExecModel(MODEL_B);
    expect(getPendingAiSelection(WS, "exec", "model")).toBeUndefined();

    markAiSelectionIntent(WS, "model", MODEL_A);
    saveExecModel(MODEL_A);
    expect(getPendingAiSelection(WS, "exec", "model")).toBe(MODEL_A);
  });

  test("a pick scoped to Plan does not apply to Exec", () => {
    setWorkspaceAgentPick(WS, "plan");
    markAiSelectionIntent(WS, "model", MODEL_A);
    expect(getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).intent).toBeUndefined();
    expect(getPendingAiSelection(WS, "exec", "model")).toBeUndefined();
    expect(getPendingAiSelection(WS, "plan", "model")).toBe(MODEL_A);
  });

  test("send options: one-shot sends pin nothing and Auto drops the routed dimension", () => {
    markAiSelectionIntent(WS, "model", MODEL_A);
    markAiSelectionIntent(WS, "thinkingLevel", "high");
    const sent = { model: MODEL_A, thinkingLevel: "high" };

    expect(
      getAiSelectionIntentForSendOptions(WS, "exec", { ...sent, skipAiSettingsPersistence: true })
        .intent
    ).toBeUndefined();

    const autoModel = getAiSelectionIntentForSendOptions(WS, "exec", {
      ...sent,
      autoModelRouting: true,
    });
    expect(autoModel.intent).toEqual({ thinkingLevel: true });
    // Only attached fields are consumed; the model pick stays pending.
    setWorkspaceAiMetadata(WS, {
      aiSettingsByAgent: { exec: { model: MODEL_B, thinkingLevel: "high" } },
    });
    consumeAiSelectionIntent(WS, "exec", autoModel.attachedTokens);
    expect(getAiSelectionIntentForSend(WS, "exec", sent).intent).toEqual({ model: true });

    markAiSelectionIntent(WS, "thinkingLevel", "high");
    expect(
      getAiSelectionIntentForSendOptions(WS, "exec", { ...sent, autoThinkingLevel: true }).intent
    ).toEqual({ model: true });
  });
});
