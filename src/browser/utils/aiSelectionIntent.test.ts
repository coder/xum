import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  consumeAiSelectionIntent,
  getAiSelectionIntentForSend,
  getAiSelectionIntentForSendOptions,
  getPendingAiSelection,
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
  setWorkspaceAiMetadata,
} from "@/browser/utils/aiSelectionIntent";
import { getAgentIdKey } from "@/common/constants/storage";

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
    updatePersistedState(getAgentIdKey(WS), "exec");
  });

  afterEach(() => {
    restoreDomGlobals();
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
    updatePersistedState(getAgentIdKey(WS), "plan");
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
