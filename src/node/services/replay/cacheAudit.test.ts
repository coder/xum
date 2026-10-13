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
    startedAt: "2026-10-12T10:00:00.000Z",
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
      // Another route for the same model id: not compared, and it keeps its own baseline.
      step("run-2", 0, ["x"], model, "anthropic.gateway"),
      // Non-Anthropic steps are never compared, even when they would "break" by Anthropic rules.
      step("run-3", 0, ["y"], "openai:gpt-6", "openai.responses"),
      step("run-3", 1, ["y2"], "openai:gpt-6", "openai.responses"),
      step("run-4", 0, ["a", "z"], model),
      step("run-4", 1, ["a", "z", "w"], model),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 2, breaks: [] });
  });

  test("a model switch keeps each model's baseline", () => {
    const opus = "anthropic:claude-opus-4-5";
    const audit = auditStepPrefixes([
      step("run-1", 0, ["a"]),
      step("run-2", 0, ["x"], opus),
      step("run-3", 0, ["x", "y"], opus),
      // Back on Sonnet within the TTL: compared with run-1, not lost to the Opus baseline.
      step("run-4", 0, ["b"]),
    ]);
    expect(audit).toMatchObject({
      comparedPairs: 2,
      breaks: [{ runId: "run-4", boundary: "turn" }],
    });
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

  test("a gap longer than the previous step's cache TTL starts a new baseline", () => {
    const at = (minutes: number, extra: Partial<RecordedStepRequest> = {}) => ({
      startedAt: new Date(Date.UTC(2026, 9, 12, 10, minutes)).toISOString(),
      ...extra,
    });
    // 5-minute default: 6 minutes later the entry has expired, so no break.
    expect(
      auditStepPrefixes([
        step("run-1", 0, ["a"], undefined, undefined, at(0)),
        step("run-2", 0, ["changed"], undefined, undefined, at(6)),
      ])
    ).toMatchObject({ comparedPairs: 0, breaks: [] });
    // A 1h marker on the previous step keeps the entry, so the same gap still compares.
    const hourMarked = {
      ...step("run-1", 0, ["a"], undefined, undefined, at(0)),
      tools: [
        {
          type: "function",
          name: "bash",
          inputSchema: { type: "object" },
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
        },
      ],
    };
    expect(
      auditStepPrefixes([hourMarked, step("run-2", 0, ["changed"], undefined, undefined, at(6))])
    ).toMatchObject({ comparedPairs: 1, breaks: [{ runId: "run-2" }] });
  });

  test("an omitted and a false disableParallelToolUse are the same request", () => {
    const parallel = (value: boolean) => ({
      providerOptions: { anthropic: { disableParallelToolUse: value } },
    });
    expect(
      auditStepPrefixes([
        step("run-1", 0, ["a"]),
        step("run-2", 0, ["a", "b"], undefined, undefined, parallel(false)),
      ])
    ).toMatchObject({ comparedPairs: 1, breaks: [] });
    // An explicit "auto" choice is sent on the wire, so it differs from no choice.
    expect(
      auditStepPrefixes([
        step("run-1", 0, ["a"]),
        step("run-2", 0, ["a", "b"], undefined, undefined, { toolChoice: { type: "auto" } }),
      ]).breaks
    ).toHaveLength(1);
  });
});

describe("auditStepPrefixes with recorded wire facts", () => {
  const MODEL = "anthropic:claude-sonnet-4-5";
  const iso = (minutes: number, seconds = 0) =>
    new Date(Date.UTC(2026, 9, 12, 10, minutes, seconds)).toISOString();
  /** A step the cache wrapper saw on `route`; `wire` overrides the dispatch facts. */
  const wired = (
    runId: string,
    texts: string[],
    wire: Partial<NonNullable<RecordedStepRequest["promptCacheWire"]>> = {},
    startedAt = iso(0)
  ): RecordedStepRequest => ({
    runId,
    stepId: `${runId}-0`,
    stepNumber: 0,
    startedAt,
    modelId: "claude-sonnet-4-5",
    provider: "anthropic.messages",
    tools: [],
    prompt: [
      { role: "system", content: "You are Xum." },
      ...texts.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
    ],
    promptCacheWire: {
      route: "anthropic",
      modelString: MODEL,
      cacheMarkersInjected: true,
      dispatched: true,
      observedAt: startedAt,
      ...wire,
    },
  });

  test("mux-gateway steps are audited from their wire record", () => {
    // The Gateway SDK reports provider "gateway", not "anthropic.*": the wire record the
    // Anthropic cache wrapper wrote is what proves an Anthropic wire.
    const gateway = (runId: string, texts: string[]): RecordedStepRequest => ({
      ...wired(runId, texts, { route: "mux-gateway" }),
      provider: "gateway",
    });
    const audit = auditStepPrefixes([gateway("run-1", ["a"]), gateway("run-2", ["b"])]);
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [{ runId: "run-2" }] });
    // Without a wire record (older logs), a non-Anthropic provider id is still skipped.
    const { promptCacheWire: _wire, ...legacy } = gateway("run-3", ["c"]);
    expect(auditStepPrefixes([legacy, { ...legacy, runId: "run-4" }])).toMatchObject({
      comparedPairs: 0,
    });
  });

  test("steps on two routes of one model keep separate baselines", () => {
    // Direct Anthropic and a Coder gateway are separate caches, though both use the
    // AI SDK provider id "anthropic.messages" and the same model id.
    const audit = auditStepPrefixes([
      wired("run-1", ["a"]),
      wired("run-2", ["x"], { route: "coder:dogfood" }),
      wired("run-3", ["a", "b"]),
      wired("run-4", ["x", "y"], { route: "coder:dogfood" }),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 2, breaks: [] });
  });

  test("steps on two endpoints of one route keep separate baselines", () => {
    // Another base URL reaches another cache, as in the monitor's key.
    const audit = auditStepPrefixes([
      wired("run-1", ["a"], { endpoint: "https://proxy-a.example/v1/messages" }),
      wired("run-2", ["x"], { endpoint: "https://proxy-b.example/v1/messages" }),
      wired("run-3", ["a", "b"], { endpoint: "https://proxy-a.example/v1/messages" }),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [] });
  });

  test.each([
    ["was not dispatched", { dispatched: false, observedAt: undefined }],
    ["got no OK response", { observedAt: undefined }],
    ["ran without cache markers", { cacheMarkersInjected: false }],
  ])("a request that %s neither breaks nor replaces the baseline", (_name, wire) => {
    const audit = auditStepPrefixes([
      wired("run-1", ["a"]),
      wired("run-2", ["other"], wire),
      wired("run-3", ["a", "b"]),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [] });
  });

  test("overlapping runs compare in the order their OK responses arrived", () => {
    // run-long starts first, but run-short's response arrives first, so the monitor
    // takes run-short as the baseline and run-long extends it.
    const audit = auditStepPrefixes([
      wired("run-long", ["a", "b"], { observedAt: iso(0, 30) }, iso(0, 0)),
      wired("run-short", ["a"], { observedAt: iso(0, 10) }, iso(0, 5)),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [] });
  });

  test("OK responses in the same millisecond compare in observation-counter order", () => {
    // Both observed at 10:00:10.000; run-short was observed first (counter 1), though
    // run-long comes first in the log, so run-long extends run-short's baseline.
    const audit = auditStepPrefixes([
      wired("run-long", ["a", "b"], { observedAt: iso(0, 10), observedSeq: 2 }),
      wired("run-short", ["a"], { observedAt: iso(0, 10), observedSeq: 1 }),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [] });
    // Older logs without the counter keep the log order for a tie (and report the break).
    const legacy = auditStepPrefixes([
      wired("run-long", ["a", "b"], { observedAt: iso(0, 10) }),
      wired("run-short", ["a"], { observedAt: iso(0, 10) }),
    ]);
    expect(legacy).toMatchObject({ comparedPairs: 1, breaks: [{ runId: "run-short" }] });
  });

  test("the cache TTL runs from the observation time, not the start", () => {
    // Started 10:00 but answered OK at 10:04; the next request at 10:06 is two minutes
    // after the monitor's observation, inside the 5-minute default TTL: compared.
    const audit = auditStepPrefixes([
      wired("run-1", ["a"], { observedAt: iso(4) }, iso(0)),
      wired("run-2", ["changed"], {}, iso(6)),
    ]);
    expect(audit).toMatchObject({ comparedPairs: 1, breaks: [{ runId: "run-2" }] });
  });
});
