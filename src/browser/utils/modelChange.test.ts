import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  consumeWorkspaceModelChange,
  recordAutoRoutingChoiceForAgent,
  setAutoRoutingChoice,
  setWorkspaceModelWithOrigin,
} from "@/browser/utils/modelChange";
import {
  AUTO_ROUTING_CHOICE_BY_AGENT_MAX_CHARS,
  getAgentIdKey,
  getAutoModelRoutingKey,
  getAutoRoutingChoiceByAgentKey,
} from "@/common/constants/storage";

let workspaceCounter = 0;

function nextWorkspaceId(): string {
  workspaceCounter += 1;
  return `model-change-test-${workspaceCounter}`;
}

describe("modelChange", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    restoreDomGlobals();
  });

  test("explicit user and agent picks turn Auto off; sync keeps it", () => {
    const workspaceId = nextWorkspaceId();
    const autoKey = getAutoModelRoutingKey(workspaceId);

    updatePersistedState(autoKey, true);
    setWorkspaceModelWithOrigin(workspaceId, "openai:gpt-5.2-codex", "sync");
    expect(readPersistedState(autoKey, false)).toBe(true);

    setWorkspaceModelWithOrigin(workspaceId, "anthropic:claude-sonnet-4-5", "agent");
    expect(readPersistedState(autoKey, false)).toBe(false);

    updatePersistedState(autoKey, true);
    setWorkspaceModelWithOrigin(workspaceId, "openai:gpt-5.2-codex", "user");
    expect(readPersistedState(autoKey, false)).toBe(false);
  });

  test("records workspace routing picks per agent without a local experiment override", () => {
    const workspaceId = nextWorkspaceId();
    updatePersistedState(getAgentIdKey(workspaceId), "plan");

    setAutoRoutingChoice(workspaceId, "thinkingLevel", true);
    setWorkspaceModelWithOrigin(workspaceId, "openai:gpt-5.2-codex", "user");

    expect(readPersistedState(getAutoRoutingChoiceByAgentKey(workspaceId), {})).toEqual({
      plan: { thinkingLevel: true, model: false },
    });
  });

  test("does not record explicit entries for no-op model changes", () => {
    const workspaceId = nextWorkspaceId();
    const model = "openai:gpt-5.2-codex";
    const otherModel = "anthropic:claude-sonnet-4-5";

    setWorkspaceModelWithOrigin(workspaceId, model, "sync");

    // Simulate user selecting the already-active model.
    setWorkspaceModelWithOrigin(workspaceId, model, "user");

    expect(consumeWorkspaceModelChange(workspaceId, model)).toBeNull();

    // A later sync-driven away→back transition should not misclassify as explicit.
    expect(consumeWorkspaceModelChange(workspaceId, otherModel)).toBeNull();
    expect(consumeWorkspaceModelChange(workspaceId, model)).toBeNull();
  });

  test("clears stale explicit entries once the model diverges", () => {
    const workspaceId = nextWorkspaceId();

    const previousModel = "anthropic:claude-sonnet-4-5";
    const targetModel = "openai:gpt-5.2-codex";
    const divergedModel = "openai:gpt-4o-mini";

    setWorkspaceModelWithOrigin(workspaceId, previousModel, "sync");

    // Record an explicit change to targetModel.
    setWorkspaceModelWithOrigin(workspaceId, targetModel, "user");

    // If the store reports a totally different model first, the pending entry is stale.
    expect(consumeWorkspaceModelChange(workspaceId, divergedModel)).toBeNull();

    // Returning to targetModel later should not consume the stale entry.
    expect(consumeWorkspaceModelChange(workspaceId, targetModel)).toBeNull();
  });

  test("keeps pending entries when the model briefly reports the previous value", () => {
    const workspaceId = nextWorkspaceId();

    const initialModel = "anthropic:claude-sonnet-4-5";
    const firstModel = "openai:gpt-5.2-codex";
    const secondModel = "openai:gpt-4o-mini";

    setWorkspaceModelWithOrigin(workspaceId, initialModel, "sync");

    setWorkspaceModelWithOrigin(workspaceId, firstModel, "user");
    setWorkspaceModelWithOrigin(workspaceId, secondModel, "user");

    // Rapid A→B: if we observe A while tracking B, keep the pending B entry.
    expect(consumeWorkspaceModelChange(workspaceId, firstModel)).toBeNull();
    expect(consumeWorkspaceModelChange(workspaceId, secondModel)).toBe("user");
  });

  test("tracks switches between a Coder gateway entry and the direct model as explicit", () => {
    const workspaceId = nextWorkspaceId();
    const directModel = "openai:claude-opus-4-1";
    const coderModel = "coder:openai/claude-opus-4-1";

    setWorkspaceModelWithOrigin(workspaceId, directModel, "sync");

    // Name-only canonicalization collapsed these into the same identity, so
    // the explicit entry was dropped and the warning path saw a background sync.
    setWorkspaceModelWithOrigin(workspaceId, coderModel, "user");

    expect(consumeWorkspaceModelChange(workspaceId, coderModel)).toBe("user");
  });

  test("still collapses passthrough gateway aliases when tracking explicit changes", () => {
    const workspaceId = nextWorkspaceId();
    const canonicalModel = "openai:gpt-5.2-codex";
    const gatewayAlias = "mux-gateway:openai/gpt-5.2-codex";

    setWorkspaceModelWithOrigin(workspaceId, "anthropic:claude-sonnet-4-5", "sync");
    setWorkspaceModelWithOrigin(workspaceId, canonicalModel, "user");

    // A persisted rewrite to the passthrough alias must still consume the entry.
    expect(consumeWorkspaceModelChange(workspaceId, gatewayAlias)).toBe("user");
  });

  // Choices accumulate one entry per agent. Past the key budget the value would only live in
  // memory, so after a reload the newest explicit choices would be lost.
  test("keeps the newest per-agent routing choices on disk as agents accumulate", () => {
    const workspaceId = nextWorkspaceId();
    const agentIds = Array.from({ length: 12 }, (_, index) =>
      `custom-agent-${index}`.padEnd(64, "x")
    );
    for (const agentId of agentIds) {
      recordAutoRoutingChoiceForAgent(workspaceId, agentId, { model: true, thinkingLevel: false });
    }

    const stored = localStorage.getItem(getAutoRoutingChoiceByAgentKey(workspaceId))!;
    expect(stored.length).toBeLessThanOrEqual(AUTO_ROUTING_CHOICE_BY_AGENT_MAX_CHARS);
    expect(JSON.parse(stored)).toMatchObject({
      [agentIds[agentIds.length - 1]]: { model: true, thinkingLevel: false },
    });
  });
});
