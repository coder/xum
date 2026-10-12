import { describe, expect, test } from "bun:test";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import {
  auditCacheBusts,
  auditStepPrefixes,
  collapseEnvelopesToFinalPerSequence,
} from "./cacheAudit";
import type { RecordedStepRequest, TurnEnvelopeEvent } from "./replayVerify";

function makeEnvelope(
  seq: number,
  data: Partial<TurnEnvelopeEvent["data"]> = {}
): TurnEnvelopeEvent {
  return {
    v: 1,
    seq,
    id: `envelope-${seq}`,
    ts: 1_000 + seq,
    workspaceId: "test-ws",
    kind: "turn-envelope",
    data: {
      systemPromptHash: `sha256:${"a".repeat(64)}`,
      toolsetManifest: [{ name: "bash", schemaHash: "hash-1" }],
      modelString: "anthropic:claude-sonnet-4-5",
      providerOptionsHash: "options-1",
      thinkingLevel: "off",
      ...data,
    },
  };
}

function usage(input: number, cacheCreate: number): ChatUsageDisplay {
  return {
    input: { tokens: input },
    cached: { tokens: 0 },
    cacheCreate: { tokens: cacheCreate },
    output: { tokens: 10 },
    reasoning: { tokens: 0 },
  };
}

describe("auditCacheBusts", () => {
  test("first turn is baseline and identical follow-ups report no causes", () => {
    const audit = auditCacheBusts([makeEnvelope(1), makeEnvelope(2)]);
    expect(audit[0].causes).toEqual([]);
    expect(audit[1].causes).toEqual([]);
  });

  test("attributes each changed prefix component", () => {
    const audit = auditCacheBusts([
      makeEnvelope(1),
      makeEnvelope(2, { systemPromptHash: `sha256:${"b".repeat(64)}` }),
      makeEnvelope(3, {
        systemPromptHash: `sha256:${"b".repeat(64)}`,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "high",
        providerOptionsHash: "options-2",
      }),
      makeEnvelope(4, {
        systemPromptHash: `sha256:${"b".repeat(64)}`,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "high",
        providerOptionsHash: "options-2",
        toolsetManifest: [{ name: "bash", schemaHash: "hash-2" }],
      }),
    ]);

    expect(audit[1].causes.map((cause) => cause.kind)).toEqual(["system-prompt"]);
    expect(audit[2].causes.map((cause) => cause.kind).sort()).toEqual([
      "model",
      "provider-options",
      "thinking-level",
    ]);
    expect(audit[3].causes).toEqual([{ kind: "toolset", detail: "schema-changed:bash" }]);
  });

  test("reports tool additions and removals by name", () => {
    const audit = auditCacheBusts([
      makeEnvelope(1, {
        toolsetManifest: [
          { name: "bash", schemaHash: "hash-1" },
          { name: "file_read", schemaHash: "hash-2" },
        ],
      }),
      makeEnvelope(2, {
        toolsetManifest: [
          { name: "bash", schemaHash: "hash-1" },
          { name: "web_search", schemaHash: "hash-3" },
        ],
      }),
    ]);
    expect(audit[1].causes).toEqual([
      { kind: "toolset", detail: "removed:file_read, added:web_search" },
    ]);
  });

  test("attributes busted tokens only when a cause exists and usage is available", () => {
    const audit = auditCacheBusts(
      [
        makeEnvelope(1),
        makeEnvelope(2),
        makeEnvelope(3, { systemPromptHash: `sha256:${"c".repeat(64)}` }),
        makeEnvelope(4, { systemPromptHash: `sha256:${"d".repeat(64)}` }),
      ],
      [usage(1000, 900), usage(50, 0), usage(80, 1200), undefined]
    );

    // Baseline and prefix-stable turns never attribute busted tokens.
    expect(audit[0].approxBustedTokens).toBeUndefined();
    expect(audit[1].approxBustedTokens).toBeUndefined();
    // Busted turn: fresh input + cache-write tokens.
    expect(audit[2].approxBustedTokens).toBe(1280);
    // Busted turn without recorded usage: cause reported, tokens unknown.
    expect(audit[3].causes.map((cause) => cause.kind)).toEqual(["system-prompt"]);
    expect(audit[3].approxBustedTokens).toBeUndefined();
  });
});

describe("collapseEnvelopesToFinalPerSequence", () => {
  test("fallback turns audit once with the identity that actually streamed", () => {
    const primary = makeEnvelope(0, {
      requestHistorySequence: 5,
      modelString: "anthropic:claude-primary",
    });
    const fallback = makeEnvelope(1, {
      requestHistorySequence: 5,
      modelString: "openai:gpt-fallback",
    });
    const nextTurn = makeEnvelope(2, {
      requestHistorySequence: 7,
      modelString: "openai:gpt-fallback",
    });

    const collapsed = collapseEnvelopesToFinalPerSequence([primary, fallback, nextTurn]);
    expect(collapsed).toEqual([fallback, nextTurn]);

    // The superseded primary is invisible to the audit: no artificial model
    // bust between the failed primary and the fallback request.
    const audit = auditCacheBusts(collapsed);
    expect(audit).toHaveLength(2);
    expect(audit[1].causes).toEqual([]);
  });

  test("legacy rows without a sequence are kept in order", () => {
    const legacyA = makeEnvelope(0);
    const keyed = makeEnvelope(1, { requestHistorySequence: 3 });
    const legacyB = makeEnvelope(2);
    expect(collapseEnvelopesToFinalPerSequence([legacyA, keyed, legacyB])).toEqual([
      legacyA,
      keyed,
      legacyB,
    ]);
  });
});

describe("auditStepPrefixes", () => {
  const step = (
    runId: string,
    stepNumber: number,
    texts: string[],
    modelId = "anthropic:claude-sonnet-4-5",
    provider: string | null = "anthropic.messages",
    extra: Partial<RecordedStepRequest> = {}
  ): RecordedStepRequest => ({
    ...extra,
    runId,
    stepId: `${runId}-${stepNumber}`,
    stepNumber,
    modelId,
    provider,
    tools: [],
    prompt: [
      { role: "system", content: "You are Xum." },
      ...texts.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
    ],
  });

  test("a mid-turn step that rewrites history breaks at the step boundary", () => {
    const audit = auditStepPrefixes([
      step("run-1", 0, ["a"]),
      step("run-1", 1, ["a", "b"]),
      step("run-1", 2, ["a", "c"]),
    ]);
    expect(audit.comparedPairs).toBe(2);
    expect(audit.breaks).toMatchObject([
      // System sentinel, system block, messages sentinel, "a", then "c".
      { stepId: "run-1-2", boundary: "step", comparison: { blockIndex: 4 } },
    ]);
  });

  test("a model change is not compared and a side run resets the baseline", () => {
    const audit = auditStepPrefixes(
      [
        step("run-1", 0, ["a"]),
        step("run-2", 0, ["x"], "anthropic:claude-opus-4-5"),
        step("compact", 0, ["summarize"], "anthropic:claude-opus-4-5"),
        step("run-3", 0, ["summary"], "anthropic:claude-opus-4-5"),
      ],
      (recorded) => recorded.runId === "compact"
    );
    expect(audit).toMatchObject({ comparedPairs: 0, breaks: [] });
  });

  test("only Anthropic steps on one route are compared", () => {
    const model = "anthropic:claude-sonnet-4-5";
    const audit = auditStepPrefixes([
      step("run-1", 0, ["a"], model),
      // Another route for the same model id: not compared, but it becomes the baseline.
      step("run-2", 0, ["x"], model, "anthropic.gateway"),
      // Non-Anthropic steps are never compared, even when they would "break" by Anthropic rules.
      step("run-3", 0, ["y"], "openai:gpt-6", "openai.responses"),
      step("run-3", 1, ["y2"], "openai:gpt-6", "openai.responses"),
      step("run-4", 0, ["z"], model),
      step("run-4", 1, ["z", "w"], model),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [] });
  });

  test("a non-Anthropic step keeps the last Anthropic step as the baseline", () => {
    const audit = auditStepPrefixes([
      step("run-1", 0, ["a"]),
      step("run-2", 0, ["x"], "openai:gpt-6", "openai.responses"),
      step("run-3", 0, ["b"]),
    ]);
    expect(audit).toMatchObject({
      comparedPairs: 1,
      breaks: [{ runId: "run-3", boundary: "turn" }],
    });
  });

  test("a context epoch change starts a new baseline; runs without an epoch still compare", () => {
    expect(
      auditStepPrefixes([
        step("run-1", 0, ["a"], undefined, undefined, { contextEpoch: "row-1" }),
        step("run-2", 0, ["cleared"], undefined, undefined, { contextEpoch: "row-9" }),
      ])
    ).toMatchObject({ comparedPairs: 0, breaks: [] });
    expect(
      auditStepPrefixes([step("run-1", 0, ["a"]), step("run-2", 0, ["cleared"])])
    ).toMatchObject({ comparedPairs: 1, breaks: [{ runId: "run-2" }] });
  });

  test.each([
    ["thinking", { providerOptions: { anthropic: { thinking: { type: "adaptive" } } } }],
    ["effort", { providerOptions: { anthropic: { effort: "high" } } }],
    ["tool choice", { toolChoice: { type: "required" } }],
    ["parallel tool use", { providerOptions: { anthropic: { disableParallelToolUse: true } } }],
  ])("a recorded %s change breaks the messages section", (_name, extra) => {
    const audit = auditStepPrefixes([
      step("run-1", 0, ["a"]),
      step("run-2", 0, ["a", "b"], undefined, undefined, extra),
    ]);
    expect(audit.breaks).toMatchObject([
      { comparison: { section: "messages", previous: { type: "message_options" } } },
    ]);
  });

  test("a context-editing step is not compared and becomes the baseline", () => {
    const editing = { providerOptions: { anthropic: { contextManagement: { edits: [] } } } };
    const audit = auditStepPrefixes([
      step("run-1", 0, ["a"]),
      step("run-2", 0, ["edited"], undefined, undefined, editing),
      step("run-3", 0, ["after"]),
      step("run-4", 0, ["changed"]),
    ]);
    // Only run-3 -> run-4 is compared; the pairs with the editing step are unsupported.
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [{ runId: "run-4" }] });
  });
});
