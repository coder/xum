import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  consumeAiSelectionIntent,
  getAiSelectionIntentForSend,
  getAiSelectionIntentForSendOptions,
  hasPendingAiSelectionIntent,
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
} from "@/browser/utils/aiSelectionIntent";
import { getAgentIdKey } from "@/common/constants/storage";

const WS = "intent-ws";
const MODEL_A = "openai:gpt-5.2";
const MODEL_B = "anthropic:claude-sonnet-4-5";

describe("aiSelectionIntent", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
    resetAiSelectionIntentForTests();
    updatePersistedState(getAgentIdKey(WS), "exec");
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
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
    consumeAiSelectionIntent(WS, "exec", latest.attachedTokens);
    expect(getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).intent).toBeUndefined();
  });

  test("a pick scoped to Plan does not apply to Exec", () => {
    updatePersistedState(getAgentIdKey(WS), "plan");
    markAiSelectionIntent(WS, "model", MODEL_A);
    expect(getAiSelectionIntentForSend(WS, "exec", { model: MODEL_A }).intent).toBeUndefined();
    expect(hasPendingAiSelectionIntent(WS, "exec", "model", MODEL_A)).toBe(false);
    expect(hasPendingAiSelectionIntent(WS, "plan", "model", MODEL_A)).toBe(true);
    expect(hasPendingAiSelectionIntent(WS, "plan", "model", MODEL_B)).toBe(false);
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
    consumeAiSelectionIntent(WS, "exec", autoModel.attachedTokens);
    expect(getAiSelectionIntentForSend(WS, "exec", sent).intent).toEqual({ model: true });

    markAiSelectionIntent(WS, "thinkingLevel", "high");
    expect(
      getAiSelectionIntentForSendOptions(WS, "exec", { ...sent, autoThinkingLevel: true }).intent
    ).toEqual({ model: true });
  });
});
