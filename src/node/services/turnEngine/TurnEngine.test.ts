import { describe, expect, test } from "bun:test";
import { Scope } from "effect";

import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { recordAutoThinkingEscalation } from "@/node/services/autoThinkingEscalation";
import type { ActiveTurnThinkingOverride, LiveTurnRouting } from "@/node/services/thinkingOverride";
import {
  StreamState,
  type StepMessageTracker,
  type StreamRequestConfig,
  type StreamToken,
} from "@/node/services/turnEngine/types";
import { StepApply } from "@/node/services/turnEngine/StepApply";
import type { WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";

import {
  createStreamInfo,
  createTurnCompletionController,
  resolveExecutionScope,
  wireStepTrackerHooks,
  wireThinkingOverride,
  type TurnExecutionOptions,
} from "./TurnEngine";

const TOKEN = "tok12345" as StreamToken;

function routing(overrides: Partial<AutoModelRoutingRecord> = {}): AutoModelRoutingRecord {
  return {
    requestedFallbackModel: "anthropic:claude-sonnet-5-5",
    model: "anthropic:claude-sonnet-5-5",
    status: "routed",
    thinkingLevel: "low",
    ...overrides,
  };
}

function startOptions(overrides: Partial<TurnExecutionOptions> = {}): TurnExecutionOptions {
  const options: Partial<TurnExecutionOptions> = {
    workspaceId: "ws-1",
    messageId: "msg-1",
    modelString: "anthropic:claude-sonnet-5-5",
    historySequence: 4,
    maxOutputTokens: 1000,
    ...overrides,
  };
  return options as TurnExecutionOptions;
}

/** A STARTING stream record for options, with a request carrying the given override holder. */
function streamFor(
  options: TurnExecutionOptions,
  thinkingOverrideState?: ActiveTurnThinkingOverride
): WorkspaceStreamInfo {
  const stepTracker: StepMessageTracker = { recordSystemSections: () => undefined };
  const request: Partial<StreamRequestConfig> = { maxOutputTokens: 4000, thinkingOverrideState };
  return createStreamInfo(options, {
    streamToken: TOKEN,
    runtimeTempDir: "/tmp/turn",
    resourceScope: Scope.makeUnsafe(),
    abortController: new AbortController(),
    completionController: createTurnCompletionController(),
    executionScope: { workspaceId: "ws-1", messageId: "msg-1", token: TOKEN },
    streamResult: undefined as unknown as WorkspaceStreamInfo["streamResult"],
    request: request as StreamRequestConfig,
    stepTracker,
    metadataModel: "anthropic:claude-sonnet-5-5",
    durationStartMs: 0,
  });
}

describe("resolveExecutionScope", () => {
  test("a stream without a caller scope gets its own", () => {
    expect(resolveExecutionScope(startOptions(), TOKEN)).toEqual({
      workspaceId: "ws-1",
      messageId: "msg-1",
      token: TOKEN,
    });
  });

  test("a caller scope is kept only when it belongs to this stream", () => {
    const own = { workspaceId: "ws-1", messageId: "msg-1", token: TOKEN };
    const foreign = { workspaceId: "ws-1", messageId: "msg-1", token: "other" };

    expect(resolveExecutionScope(startOptions({ executionScope: own }), TOKEN)).toBe(own);
    expect(() => resolveExecutionScope(startOptions({ executionScope: foreign }), TOKEN)).toThrow(
      "MCP execution scope must belong to the stream being registered"
    );
  });
});

describe("createStreamInfo", () => {
  test("a new stream starts with its turn identity and empty parts", () => {
    const info = streamFor(startOptions());

    expect(info.state).toBe(StreamState.STARTING);
    expect(info).toMatchObject({ messageId: "msg-1", token: TOKEN, historySequence: 4 });
    expect(info.parts).toEqual([]);
    expect(info.lastPartTimestamp).toBe(info.startTime);
    expect(info.modelFallback).toBeUndefined();
  });

  test("a refusal fallback is armed only with a non-empty chain, from the caller's limits", () => {
    const prepare = () => Promise.reject(new Error("not called"));
    const empty = streamFor(startOptions({ modelFallback: { chain: [], prepare } }));
    const armed = streamFor(startOptions({ modelFallback: { chain: ["openai:gpt-6"], prepare } }));

    expect(empty.modelFallback).toBeUndefined();
    expect(armed.modelFallback).toMatchObject({
      requestedModel: normalizeToCanonical("anthropic:claude-sonnet-5-5"),
      refusedModels: [],
      // The caller's limit, not the request's (which may carry call-settings overrides).
      original: { maxOutputTokens: 1000 },
    });
  });
});

describe("wireStepTrackerHooks", () => {
  test("same-turn rebuilds read and update the stream's current row metadata", () => {
    const info = streamFor(startOptions({ initialMetadata: { systemMessageTokens: 10 } }));
    wireStepTrackerHooks(info);

    expect(info.stepTracker.hasAnthropicReplayReceipt?.()).toBe(false);
    StepApply.setInitialMetadata(info, { ...info.initialMetadata, anthropicThinkingReplay: "off" });
    expect(info.stepTracker.hasAnthropicReplayReceipt?.()).toBe(true);

    info.stepTracker.recordSystemSections({ systemMessageTokens: 25 });
    expect(info.initialMetadata?.systemMessageTokens).toBe(25);
    expect(info.initialMetadata?.anthropicThinkingReplay).toBe("off");
  });
});

describe("wireThinkingOverride", () => {
  test("without an override holder the stream is left alone", () => {
    const info = streamFor(startOptions({ thinkingLevel: "medium" }));

    wireThinkingOverride(info, info.initialMetadata);

    expect(info.thinkingLevel).toBe("medium");
    expect(info.stepTracker.autoThinkingEscalation).toBeUndefined();
  });

  test("an applied level reaches the stream, and a level applied earlier catches up", () => {
    const holder: ActiveTurnThinkingOverride = { applied: "high" };
    const info = streamFor(startOptions({ thinkingLevel: "low" }), holder);

    wireThinkingOverride(info, info.initialMetadata);
    expect(info.thinkingLevel).toBe("high");

    holder.onApplied?.("xhigh");
    expect(info.thinkingLevel).toBe("xhigh");
  });

  test("a manual level withdraws Auto's thinking claim and reports the live routing", () => {
    const live: LiveTurnRouting[] = [];
    const holder: ActiveTurnThinkingOverride = {
      onLiveRoutingChanged: (next) => void live.push(next),
    };
    const initialMetadata = { autoModelRouting: routing() };
    const info = streamFor(startOptions({ initialMetadata }), holder);
    wireThinkingOverride(info, initialMetadata);

    holder.onApplied?.("medium");
    expect(info.initialMetadata?.autoModelRouting?.thinkingLevel).toBe("low");

    holder.manual = true;
    holder.onApplied?.("high");
    expect(info.initialMetadata?.autoModelRouting?.thinkingLevel).toBeUndefined();
    expect(live.map((entry) => entry.thinkingLevel)).toEqual(["medium", "high"]);
  });

  test("a level Auto chose may raise itself, and each raise lands on the routing record", () => {
    const holder: ActiveTurnThinkingOverride = {};
    const initialMetadata = { autoModelRouting: routing({ thinkingLevel: "low" }) };
    const info = streamFor(startOptions({ initialMetadata }), holder);
    wireThinkingOverride(info, initialMetadata);

    const escalation = info.stepTracker.autoThinkingEscalation;
    expect(escalation?.level).toBe("low");
    const raise = { step: 3, from: "low" as const, to: "medium" as const, reason: "stuck" };
    if (escalation) recordAutoThinkingEscalation(escalation, raise);

    expect(info.initialMetadata?.autoModelRouting?.escalations).toEqual([raise]);
  });

  test("raises from an earlier stream of the turn carry into the new stream", () => {
    const earlier = { step: 2, from: "low" as const, to: "medium" as const, reason: "stuck" };
    const initialMetadata = {
      autoModelRouting: routing({ thinkingLevel: "low", escalations: [earlier] }),
    };
    const info = streamFor(startOptions({ initialMetadata }), {});

    wireThinkingOverride(info, initialMetadata);

    expect(info.stepTracker.autoThinkingEscalation?.escalations).toEqual([earlier]);
  });
});
