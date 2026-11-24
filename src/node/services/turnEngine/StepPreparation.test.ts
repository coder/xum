import { describe, expect, spyOn, test } from "bun:test";
import type { LanguageModel, ModelMessage, Tool } from "ai";

import type { AutoModelRoutingEscalation } from "@/common/types/autoModelRouting";
import type { ToolSearchStreamState } from "@/common/utils/tools/toolCatalog";
import { log } from "@/node/services/log";

import { createAutoThinkingEscalationState } from "@/node/services/autoThinkingEscalation";
import type { ContinuousPrefixSwap } from "@/node/services/continuousCompactionJournal";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";
import {
  advanceReasoningReplayBoundary,
  buildContextBudgetRequest,
  buildPrepareStepResult,
  dropVoidedPrefixSwap,
  isFirstTurnRequest,
  prefixSwapInvalidationReason,
  recordStepMessages,
  selectStepActiveTools,
  settleAutoThinkingEscalation,
  stageAutoThinkingEscalation,
  startFirstStepRebuild,
  stripReasoningBeforeReplayBoundary,
  thinkingChangeVoidsPrefixSwap,
} from "./StepPreparation";

/** A staged swap whose prefix was prepared at this thinking level. */
function swapPreparedAt(level: string): ContinuousPrefixSwap {
  const swap = { journal: { preparation: { effectiveThinkingLevel: level } } };
  return swap as unknown as ContinuousPrefixSwap;
}

/** Three failing bash steps: detectStuckReason's simplest stuck window. */
function stuckTranscript(): ModelMessage[] {
  const failingBash = (id: string): ModelMessage[] => [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: { command: id } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "bash",
          output: { type: "json", value: { success: false, error: "boom" } },
        },
      ],
    },
  ];
  return [
    { role: "user", content: "go" },
    ...failingBash("a"),
    ...failingBash("b"),
    ...failingBash("c"),
  ];
}

describe("stageAutoThinkingEscalation", () => {
  test("stages a stuck turn's raise as the pending override", () => {
    const escalationState = createAutoThinkingEscalationState("low", [], () => undefined);
    const overrideState: ActiveTurnThinkingOverride = { applied: "low" };
    const escalation = stageAutoThinkingEscalation(
      escalationState,
      overrideState,
      stuckTranscript()
    );
    expect(escalation).toMatchObject({ from: "low", to: "medium" });
    expect(overrideState.pending).toBe("medium");
  });

  test("defers to the user's slider and to a pending change, and needs Auto's state", () => {
    const manual: ActiveTurnThinkingOverride = { applied: "low", manual: true };
    const pending: ActiveTurnThinkingOverride = { applied: "low", pending: "high" };
    for (const overrideState of [manual, pending]) {
      const escalationState = createAutoThinkingEscalationState("low", [], () => undefined);
      expect(
        stageAutoThinkingEscalation(escalationState, overrideState, stuckTranscript())
      ).toBeUndefined();
    }
    expect(pending.pending).toBe("high");
    expect(stageAutoThinkingEscalation(undefined, { applied: "low" }, stuckTranscript())).toBe(
      undefined
    );
  });
});

describe("thinkingChangeVoidsPrefixSwap", () => {
  test("a pending thinking change voids any swap", () => {
    expect(thinkingChangeVoidsPrefixSwap({ pending: "high" }, undefined)).toBe(true);
  });

  test("an applied level voids only a swap prepared at another level", () => {
    expect(thinkingChangeVoidsPrefixSwap({ applied: "high" }, swapPreparedAt("low"))).toBe(true);
    expect(thinkingChangeVoidsPrefixSwap({ applied: "low" }, swapPreparedAt("low"))).toBe(false);
    expect(thinkingChangeVoidsPrefixSwap({}, swapPreparedAt("low"))).toBe(false);
    expect(thinkingChangeVoidsPrefixSwap({ applied: "high" }, undefined)).toBe(false);
    expect(thinkingChangeVoidsPrefixSwap(undefined, swapPreparedAt("low"))).toBe(false);
  });
});

describe("selectStepActiveTools", () => {
  const toolSearchState: ToolSearchStreamState = {
    catalog: [],
    deferredToolNames: new Set(["deferred"]),
    allToolNames: ["core", "deferred"],
    activatedToolNames: new Set(),
    native: false,
  };

  test("forced first-step tools apply on step zero only", () => {
    const request = { toolSearchState, forcedFirstStepToolNames: ["forced"] };
    expect(selectStepActiveTools(request, 0, false)).toEqual({
      forceFirstStepTools: ["forced"],
      activeTools: ["forced"],
    });
    expect(selectStepActiveTools(request, 1, false)).toEqual({
      forceFirstStepTools: undefined,
      activeTools: ["core"],
    });
  });

  test("an empty forced list falls back to the tool-search scope", () => {
    const request = { toolSearchState, forcedFirstStepToolNames: [] };
    expect(selectStepActiveTools(request, 0, false).forceFirstStepTools).toBeUndefined();
    expect(selectStepActiveTools(request, 0, false).activeTools).toEqual(["core"]);
  });

  test("disabled agent tools and native tool search scope nothing", () => {
    const forced = { toolSearchState, forcedFirstStepToolNames: ["forced"] };
    expect(selectStepActiveTools(forced, 0, true)).toEqual({
      forceFirstStepTools: undefined,
      activeTools: undefined,
    });
    const native = { toolSearchState: { ...toolSearchState, native: true } };
    expect(selectStepActiveTools(native, 1, false).activeTools).toBeUndefined();
  });
});

describe("settleAutoThinkingEscalation", () => {
  const escalation = { from: "low" as const, to: "medium" as const, step: 4, reason: "stuck" };

  function settle(overrideState: ActiveTurnThinkingOverride, thinkingOverride?: object) {
    const recorded: AutoModelRoutingEscalation[][] = [];
    const state = createAutoThinkingEscalationState("low", [], (escalations) =>
      recorded.push(escalations)
    );
    settleAutoThinkingEscalation(
      escalation,
      state,
      overrideState,
      thinkingOverride as Record<string, unknown> | undefined
    );
    return { state, recorded };
  }

  test("records the raise at the level the rebuild applied", () => {
    const info = spyOn(log, "info").mockImplementation(() => undefined);
    try {
      const { state, recorded } = settle({ applied: "high" }, {});
      expect(state.level).toBe("high");
      expect(recorded.at(-1)?.map((raise) => raise.to)).toEqual(["high"]);
      expect(state.exhausted).toBe(false);
      expect(settle({ applied: "medium" }, {}).recorded.at(-1)).toEqual([escalation]);
    } finally {
      info.mockRestore();
    }
  });

  test("a no-op rebuild, a skipped rebuild or the user's slider exhausts Auto", () => {
    for (const [overrideState, thinkingOverride] of [
      [{ applied: "low" }, {}],
      [{}, {}],
      [{ applied: "medium" }, undefined],
      [{ applied: "medium", manual: true }, {}],
    ] as const) {
      const { state, recorded } = settle(overrideState, thinkingOverride);
      expect(state.exhausted).toBe(true);
      expect(recorded).toEqual([]);
    }
  });

  test("does nothing without a staged raise", () => {
    const state = createAutoThinkingEscalationState("low", [], () => undefined);
    settleAutoThinkingEscalation(undefined, state, { applied: "high" }, {});
    expect(state.exhausted).toBe(false);
  });
});

describe("advanceReasoningReplayBoundary", () => {
  type Boundary = Parameters<typeof advanceReasoningReplayBoundary>[0];
  test("moves only when the tool set or the consumed swap changes", () => {
    const boundary: Boundary = { index: 0, step: 0 };
    advanceReasoningReplayBoundary(boundary, ["b", "a"], undefined, 3, 0);
    expect(boundary).toMatchObject({ index: 0, step: 0 });
    // Same set in another order: not a change.
    advanceReasoningReplayBoundary(boundary, ["a", "b"], undefined, 5, 1);
    expect(boundary).toMatchObject({ index: 0, step: 0 });
    advanceReasoningReplayBoundary(boundary, ["a"], undefined, 7, 2);
    expect(boundary).toMatchObject({ index: 7, step: 2 });

    const swap = swapPreparedAt("low");
    advanceReasoningReplayBoundary(boundary, ["a"], swap, 9, 3);
    expect(boundary).toMatchObject({ index: 9, step: 3 });
    advanceReasoningReplayBoundary(boundary, ["a"], swap, 11, 4);
    expect(boundary).toMatchObject({ index: 9, step: 3 });
  });

  test("a first step with a consumed swap moves it; an unscoped tool list is a set too", () => {
    const boundary: Boundary = { index: 0, step: 0 };
    advanceReasoningReplayBoundary(boundary, undefined, swapPreparedAt("low"), 4, 0);
    expect(boundary).toMatchObject({ index: 4, step: 0 });
    advanceReasoningReplayBoundary(boundary, ["a"], boundary.seenPrefixSwap, 6, 1);
    expect(boundary).toMatchObject({ index: 6, step: 1 });
  });
});

describe("stripReasoningBeforeReplayBoundary", () => {
  function modelOf(provider: string, modelId: string): LanguageModel {
    const model = { provider, modelId };
    return model as unknown as LanguageModel;
  }
  const anthropic = modelOf("anthropic.messages", "claude-sonnet-4-5");
  const thinkingRow = (text: string): ModelMessage => ({
    role: "assistant",
    content: [
      { type: "reasoning", text: `thinking ${text}` },
      { type: "text", text },
    ],
  });
  const outgoing: ModelMessage[] = [
    { role: "user", content: "go" },
    thinkingRow("before"),
    thinkingRow("after"),
  ];
  /** The tracker fields the strip reads and writes. */
  interface StripTracker {
    anthropicThinkingStripStep?: number;
    recordSystemSections: () => undefined;
  }
  function tracker(): StripTracker {
    return { recordSystemSections: () => undefined };
  }

  test("strips thinking before the boundary and records the step that first sent it", () => {
    const stepTracker = tracker();
    const stripped = stripReasoningBeforeReplayBoundary(
      { model: anthropic },
      stepTracker,
      { index: 2, step: 1 },
      outgoing
    );
    expect(stripped).toEqual([
      outgoing[0],
      { role: "assistant", content: [{ type: "text", text: "before" }] },
      outgoing[2],
    ]);
    expect(stepTracker.anthropicThinkingStripStep).toBe(1);
  });

  test("returns undefined when no thinking precedes the boundary", () => {
    const stepTracker = tracker();
    expect(
      stripReasoningBeforeReplayBoundary(
        { model: anthropic },
        stepTracker,
        { index: 1, step: 1 },
        outgoing
      )
    ).toBeUndefined();
    expect(stepTracker.anthropicThinkingStripStep).toBeUndefined();
  });

  test("Bedrock Claude and between_tools strip without a receipt; other routes keep thinking", () => {
    const boundary = { index: 2, step: 1 };
    const bedrock = { model: modelOf("amazon-bedrock", "us.anthropic.claude-sonnet-4-5") };
    const betweenTools = {
      model: modelOf("openai.responses", "gpt-5"),
      providerOptions: { anthropic: { thinking: { type: "between_tools" } } },
    };
    for (const request of [bedrock, betweenTools]) {
      const stepTracker = tracker();
      expect(
        stripReasoningBeforeReplayBoundary(request, stepTracker, boundary, outgoing)
      ).toHaveLength(3);
      expect(stepTracker.anthropicThinkingStripStep).toBeUndefined();
    }
    const opaqueBedrock = {
      model: modelOf("amazon-bedrock", "arn:aws:bedrock:profile/abc"),
      budgetMetadataModel: "bedrock:claude-sonnet-4-5",
    };
    expect(
      stripReasoningBeforeReplayBoundary(opaqueBedrock, tracker(), boundary, outgoing)
    ).toBeDefined();
    const openai = { model: modelOf("openai.responses", "gpt-5") };
    expect(
      stripReasoningBeforeReplayBoundary(openai, tracker(), boundary, outgoing)
    ).toBeUndefined();
    const bedrockOther = { model: modelOf("amazon-bedrock", "amazon.nova-pro") };
    expect(
      stripReasoningBeforeReplayBoundary(bedrockOther, tracker(), boundary, outgoing)
    ).toBeUndefined();
  });
});

describe("buildContextBudgetRequest", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "go" }];
  // The budget request carries the tools as-is; their shape does not matter here.
  const bashTool = {};
  const tools = { bash: bashTool as Tool };
  const request = {
    modelString: "anthropic:claude-sonnet-4-5",
    budgetMetadataModel: "anthropic:claude-sonnet-4-5",
    system: "sys",
    tools,
  };

  test("carries the step's request, with forced tools as its active tools", () => {
    expect(buildContextBudgetRequest(request, false, ["bash"], messages)).toEqual({
      model: "anthropic:claude-sonnet-4-5",
      metadataModel: "anthropic:claude-sonnet-4-5",
      system: "sys",
      tools,
      activeTools: ["bash"],
      messages,
    });
  });

  test("drops the tools when agent tools are disabled", () => {
    const budget = buildContextBudgetRequest(request, true, undefined, messages);
    expect(budget.tools).toBeUndefined();
    expect(budget.activeTools).toBeUndefined();
  });
});

describe("buildPrepareStepResult", () => {
  const stepMessages: ModelMessage[] = [{ role: "user", content: "go" }];
  const unchanged = {
    stepMessages,
    effectiveMessages: stepMessages,
    rebuiltFirstStepMessages: undefined,
    forceFirstStepTools: undefined,
    activeTools: undefined,
    thinkingOverride: undefined,
  };

  test("returns undefined when the step sends what the SDK assembled", () => {
    expect(buildPrepareStepResult(unchanged)).toBeUndefined();
  });

  test("sends rewritten messages, preferring a step-0 rebuild", () => {
    const rewritten: ModelMessage[] = [{ role: "user", content: "rewritten" }];
    const rebuilt: ModelMessage[] = [{ role: "user", content: "rebuilt" }];
    expect(buildPrepareStepResult({ ...unchanged, effectiveMessages: rewritten })).toEqual({
      messages: rewritten,
    });
    expect(
      buildPrepareStepResult({
        ...unchanged,
        rebuiltFirstStepMessages: rebuilt,
        thinkingOverride: { anthropic: {} },
      })
    ).toEqual({ messages: rebuilt, providerOptions: { anthropic: {} } });
  });

  test("forced tools require a tool call; scoped tools and options ride along", () => {
    expect(
      buildPrepareStepResult({ ...unchanged, forceFirstStepTools: ["bash"], activeTools: ["bash"] })
    ).toEqual({ toolChoice: "required", activeTools: ["bash"] });
    expect(buildPrepareStepResult({ ...unchanged, activeTools: [] })).toEqual({ activeTools: [] });
  });
});

describe("startFirstStepRebuild", () => {
  const rebuilt: ModelMessage[] = [{ role: "user", content: "rebuilt" }];

  function rebuildRequest(rebuild: () => Promise<{ messages: ModelMessage[] }>) {
    const notified: ModelMessage[][] = [];
    const levels: unknown[] = [];
    const request = {
      thinkingOverrideState: { applied: "high" as const },
      rebuildFirstStepForThinkingLevel: (level: unknown) => {
        levels.push(level);
        return rebuild();
      },
      onStepMessages: (messages: ModelMessage[]) => notified.push(messages),
    };
    return { request, notified, levels };
  }

  test("rebuilds step zero at the applied level and re-notifies the step's messages", async () => {
    const { request, notified, levels } = rebuildRequest(() =>
      Promise.resolve({ messages: rebuilt, systemMessageTokens: 7 })
    );
    const sections: unknown[] = [];
    const stepTracker: {
      latestMessages?: ModelMessage[];
      recordSystemSections: (rebuiltSystem: unknown) => void;
    } = {
      recordSystemSections: (rebuiltSystem) => sections.push(rebuiltSystem),
    };
    const result = await startFirstStepRebuild(request, stepTracker, 0, { anthropic: {} });
    expect(result).toEqual(rebuilt);
    expect(levels).toEqual(["high"]);
    expect(notified).toEqual([rebuilt]);
    expect(sections).toEqual([{ systemMessageTokens: 7 }]);
    expect(stepTracker.latestMessages).toEqual(rebuilt);
  });

  test("a held thinking-repair receipt strips the rebuilt thinking and moves its point here", async () => {
    const signed: ModelMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: { anthropic: { signature: "sig" } },
          },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const { request, notified } = rebuildRequest(() => Promise.resolve({ messages: signed }));
    const stepTracker: {
      anthropicThinkingStripStep?: number;
      hasAnthropicReplayReceipt: () => boolean;
      recordSystemSections: () => undefined;
    } = {
      hasAnthropicReplayReceipt: () => true,
      recordSystemSections: () => undefined,
    };
    const expected: ModelMessage[] = [
      signed[0],
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    expect(await startFirstStepRebuild(request, stepTracker, 0, {})).toEqual(expected);
    expect(notified).toEqual([expected]);
    expect(stepTracker.anthropicThinkingStripStep).toBe(0);

    // Without the receipt the rebuilt thinking stays and the point does not move.
    const plain: { anthropicThinkingStripStep?: number; recordSystemSections: () => undefined } = {
      recordSystemSections: () => undefined,
    };
    expect(await startFirstStepRebuild(request, plain, 0, {})).toEqual(signed);
    expect(plain.anthropicThinkingStripStep).toBeUndefined();
  });

  test("does not start without an applied override on step zero before a consumed swap", () => {
    const { request, levels } = rebuildRequest(() => Promise.resolve({ messages: rebuilt }));
    const tracker = { recordSystemSections: () => undefined };
    expect(startFirstStepRebuild(request, tracker, 0, undefined)).toBeUndefined();
    expect(startFirstStepRebuild(request, tracker, 1, {})).toBeUndefined();
    const swapped = { ...tracker, consumedPrefixSwap: swapPreparedAt("low") };
    expect(startFirstStepRebuild(request, swapped, 0, {})).toBeUndefined();
    const unapplied = { ...request, thinkingOverrideState: {} };
    expect(startFirstStepRebuild(unapplied, tracker, 0, {})).toBeUndefined();
    const noRebuild = { ...request, rebuildFirstStepForThinkingLevel: undefined };
    expect(startFirstStepRebuild(noRebuild, tracker, 0, {})).toBeUndefined();
    expect(levels).toEqual([]);
  });

  test("fails open to the options-only rebuild when the rebuild throws", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const { request, notified } = rebuildRequest(() => Promise.reject(new Error("boom")));
      expect(await startFirstStepRebuild(request, undefined, 0, {})).toBeUndefined();
      expect(notified).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("dropVoidedPrefixSwap", () => {
  test("clears only a swap that a thinking change voids", () => {
    const voided = {
      recordSystemSections: () => undefined,
      pendingPrefixSwap: swapPreparedAt("low"),
    };
    dropVoidedPrefixSwap({ thinkingOverrideState: { applied: "high" } }, voided);
    expect(voided.pendingPrefixSwap).toBeUndefined();

    const swap = swapPreparedAt("low");
    const kept = { recordSystemSections: () => undefined, pendingPrefixSwap: swap };
    dropVoidedPrefixSwap({ thinkingOverrideState: { applied: "low" } }, kept);
    expect(kept.pendingPrefixSwap).toBe(swap);
    // No tracker: nothing to clear, and no throw.
    dropVoidedPrefixSwap({ thinkingOverrideState: { pending: "high" } }, undefined);
  });
});

describe("recordStepMessages", () => {
  test("records the step's messages on the tracker and notifies the listener", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const notified: ModelMessage[][] = [];
    const stepTracker: { latestMessages?: ModelMessage[]; recordSystemSections: () => undefined } =
      {
        recordSystemSections: () => undefined,
      };
    recordStepMessages({ onStepMessages: (sent) => notified.push(sent) }, stepTracker, messages);
    expect(stepTracker.latestMessages).toBe(messages);
    expect(notified).toEqual([messages]);
    // Neither a tracker nor a listener is required.
    recordStepMessages({}, undefined, messages);
  });
});

describe("isFirstTurnRequest", () => {
  test("only step zero of a tracked turn that has not prepared a request yet", () => {
    const fresh = { recordSystemSections: () => undefined };
    expect(isFirstTurnRequest(fresh, 0)).toBe(true);
    expect(isFirstTurnRequest(fresh, 1)).toBe(false);
    expect(isFirstTurnRequest({ ...fresh, providerRequestPrepared: true }, 0)).toBe(false);
    // Without a tracker, assume a step ran.
    expect(isFirstTurnRequest(undefined, 0)).toBe(false);
  });
});

describe("prefixSwapInvalidationReason", () => {
  test("is the stop's own reason, else a prefix-swap error", () => {
    const stopped = new AbortController();
    const reason = new Error("stopped by the session");
    stopped.abort(reason);
    expect(prefixSwapInvalidationReason(stopped.signal)).toBe(reason);
    const running = new AbortController();
    expect(prefixSwapInvalidationReason(running.signal)).toEqual(
      new Error("Prefix swap invalidated")
    );
  });
});
