import { describe, expect, test } from "bun:test";
import { APICallError, type ModelMessage } from "ai";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import type { ContinuousCompactionJournal } from "@/common/orpc/schemas/continuousCompaction";
import { createMuxMessage } from "@/common/types/message";
import type { ContinuousPrefixSwap } from "@/node/services/continuousCompactionJournal";
import { log, type Logger } from "@/node/services/log";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";

import {
  ProviderRequest,
  type PrefixSwapStream,
  type StreamRequestConfig,
  type StreamRequestOptions,
} from "./ProviderRequest";

const WORKSPACE_ID = "provider-request-ws";
const MODEL = "anthropic:claude-sonnet-4-5";

function createProviderRequest(): { request: ProviderRequest; lostLogs: unknown[] } {
  const lostLogs: unknown[] = [];
  const logger: Logger = {
    ...log,
    info: (...args: unknown[]) => {
      lostLogs.push(args);
    },
  };
  return {
    request: new ProviderRequest({ getProvidersConfig: () => null, workspaceLogger: () => logger }),
    lostLogs,
  };
}

function apiError(statusCode: number, responseBody: string, data?: unknown): APICallError {
  return new APICallError({
    message: "request failed",
    url: "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseBody,
    data,
  });
}

const turn = { messageId: "msg-1", model: "openai:gpt-5" };
const notFoundBody = "Previous response with id 'resp_abc123' not found.";

describe("ProviderRequest lost previousResponseIds", () => {
  test.each([400, 404, 500])("records the ID named by a %i error", (statusCode) => {
    const { request } = createProviderRequest();
    request.recordLostResponseIdIfApplicable(
      WORKSPACE_ID,
      apiError(statusCode, notFoundBody),
      turn
    );
    expect(request.isResponseIdLost("resp_abc123")).toBe(true);
    expect(request.isResponseIdLost("resp_other")).toBe(false);
  });

  test("records a previous_response_not_found code on any status", () => {
    const { request } = createProviderRequest();
    const error = apiError(409, notFoundBody, {
      error: { code: "previous_response_not_found" },
    });
    request.recordLostResponseIdIfApplicable(WORKSPACE_ID, error, turn);
    expect(request.isResponseIdLost("resp_abc123")).toBe(true);
  });

  test("ignores other statuses and errors without a response ID", () => {
    const { request } = createProviderRequest();
    request.recordLostResponseIdIfApplicable(WORKSPACE_ID, apiError(401, notFoundBody), turn);
    request.recordLostResponseIdIfApplicable(WORKSPACE_ID, apiError(404, "not found"), turn);
    expect(request.isResponseIdLost("resp_abc123")).toBe(false);
  });

  test("reads the ID from the error message and logs each ID once", () => {
    const { request, lostLogs } = createProviderRequest();
    const error = Object.assign(new Error(notFoundBody), { statusCode: 404 });
    request.recordLostResponseIdIfApplicable(WORKSPACE_ID, error, turn);
    request.recordLostResponseIdIfApplicable(WORKSPACE_ID, error, turn);
    expect(request.isResponseIdLost("resp_abc123")).toBe(true);
    expect(lostLogs).toHaveLength(1);
  });
});

// Staging reads only streamMessageId, parentModel and preparation.effectiveThinkingLevel.
const boundary = createMuxMessage("summary", "assistant", "summary", { compactionBoundary: true });
const journal: ContinuousCompactionJournal = {
  version: 1,
  boundary,
  staticCopies: [],
  liveTailCopySpec: {
    sourceMessageId: "live",
    sourceHistorySequence: 1,
    copyId: "copy",
    partIndex: 1,
    metadataTemplate: {},
  },
  postCompactionAttachments: [],
  prefixSourceRows: [boundary],
  systemPrefix: [],
  cacheEnabled: true,
  preparation: {
    modelString: MODEL,
    providerForMessages: "anthropic",
    effectiveThinkingLevel: "off",
    effectiveAgentId: "exec",
    toolNamesForSentinel: [],
  },
  providerFamily: "anthropic",
  parentModel: MODEL,
  summaryModel: MODEL,
  headFingerprint: "head",
  sourceFingerprint: "source",
  headEnd: { id: "head", sequence: 0 },
  epoch: 0,
  streamMessageId: "live",
  streamHistorySequence: 1,
  stepNumber: 0,
  firstTailToolCallId: "keep",
};
const prefix: ModelMessage[] = [{ role: "user", content: "compacted prefix" }];

function swapFixture(): ContinuousPrefixSwap {
  return { journal, prefix, firstTailToolCallId: "keep" };
}

function streamFixture(overrides: Partial<PrefixSwapStream> = {}): PrefixSwapStream {
  return { messageId: "live", model: MODEL, stepTracker: {}, ...overrides };
}

describe("ProviderRequest prefix swap staging", () => {
  test("stages one swap on the matching stream and reports its state", () => {
    const { request } = createProviderRequest();
    const stream = streamFixture();
    const swap = swapFixture();
    expect(request.getPrefixSwapState(stream.stepTracker)).toBe("none");
    expect(request.setPrefixSwap(stream, swap)).toBe(true);
    expect(stream.stepTracker.pendingPrefixSwap).toBe(swap);
    expect(request.getPrefixSwapState(stream.stepTracker)).toBe("pending");
    // A second swap for the same turn is refused while the first is staged or consumed.
    expect(request.setPrefixSwap(stream, swapFixture())).toBe(false);
    stream.stepTracker.consumedPrefixSwap = swap;
    stream.stepTracker.pendingPrefixSwap = undefined;
    expect(request.getPrefixSwapState(stream.stepTracker)).toBe("consumed");
    expect(request.setPrefixSwap(stream, swapFixture())).toBe(false);
    stream.stepTracker.prefixSwapInvalidated = true;
    expect(request.getPrefixSwapState(stream.stepTracker)).toBe("invalidated");
  });

  test.each<[string, PrefixSwapStream | undefined]>([
    ["no stream", undefined],
    ["another message", streamFixture({ messageId: "other" })],
    ["another model", streamFixture({ model: "openai:gpt-5" })],
    ["another thinking level", streamFixture({ thinkingLevel: "high" })],
  ])("refuses a swap for %s", (_label, stream) => {
    const { request } = createProviderRequest();
    expect(request.setPrefixSwap(stream, swapFixture())).toBe(false);
    expect(stream?.stepTracker.pendingPrefixSwap).toBeUndefined();
  });

  test("clearing drops the staged and consumed swaps", () => {
    const { request } = createProviderRequest();
    const stream = streamFixture({ thinkingLevel: "off" });
    expect(request.setPrefixSwap(stream, swapFixture())).toBe(true);
    stream.stepTracker.consumedPrefixSwap = swapFixture();
    request.clearPrefixSwap(stream.stepTracker);
    expect(request.getPrefixSwapState(stream.stepTracker)).toBe("none");
    expect(request.setPrefixSwap(stream, swapFixture())).toBe(true);
  });
});

function toolCall(toolCallId: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName: "bash", input: {} }],
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
}

describe("ProviderRequest swapPrefix", () => {
  const head: ModelMessage = { role: "user", content: "old context" };

  test("replaces everything before the locator and strips the tail's cache marks", () => {
    const { request } = createProviderRequest();
    const tail = [toolCall("keep"), { role: "user", content: "next" } satisfies ModelMessage];
    const swapped = request.swapPrefix([head, toolCall("drop"), ...tail], swapFixture());
    expect(swapped).toEqual([
      ...prefix,
      { ...toolCall("keep"), providerOptions: { anthropic: {} } },
      { role: "user", content: "next", providerOptions: undefined },
    ]);
  });

  test.each([
    ["missing", [head, toolCall("drop")]],
    ["repeated", [head, toolCall("keep"), toolCall("keep")]],
  ])("keeps the full context when the locator is %s", (_label, messages) => {
    const { request } = createProviderRequest();
    expect(request.swapPrefix(messages, swapFixture())).toBeNull();
  });
});

/** A provider config that maps the alias ollama:custom to `mappedToModel`. */
function aliasConfig(mappedToModel: string): ProvidersConfigMap {
  return {
    ollama: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      models: [{ id: "custom", mappedToModel }],
    },
  };
}

function requestOptions(overrides: Partial<StreamRequestOptions> = {}): StreamRequestOptions {
  return {
    model: KNOWN_MODELS.SONNET.id,
    modelString: KNOWN_MODELS.SONNET.id,
    messages: [{ role: "user", content: "hi" }],
    system: undefined,
    ...overrides,
  };
}

describe("ProviderRequest buildStreamRequestConfig", () => {
  const sonnetMaxOutput = getModelStats(KNOWN_MODELS.SONNET.id)?.max_output_tokens;

  test("takes the output cap from the caller, then call settings, then model stats", () => {
    const { request } = createProviderRequest();
    expect(sonnetMaxOutput).toBeGreaterThan(0);
    expect(request.buildStreamRequestConfig(requestOptions()).maxOutputTokens).toBe(
      sonnetMaxOutput
    );
    const fromSettings = request.buildStreamRequestConfig(
      requestOptions({ callSettingsOverrides: { maxOutputTokens: 200, temperature: 0.5 } })
    );
    expect(fromSettings.maxOutputTokens).toBe(200);
    // The cap is its own request field, so the call settings drop it.
    expect(fromSettings.streamCallSettings).toEqual({ temperature: 0.5 });
    const fromCaller = request.buildStreamRequestConfig(
      requestOptions({ maxOutputTokens: 100, callSettingsOverrides: { maxOutputTokens: 200 } })
    );
    expect(fromCaller.maxOutputTokens).toBe(100);
    expect(fromCaller.streamCallSettings).toBeUndefined();
  });

  test("a pinned providers-config snapshot wins over the live config", () => {
    const request = new ProviderRequest({
      getProvidersConfig: () => aliasConfig(KNOWN_MODELS.SONNET.id),
      workspaceLogger: () => log,
    });
    const alias = { model: "ollama:custom", modelString: "ollama:custom" };
    const live = request.buildStreamRequestConfig(requestOptions(alias));
    expect(live.budgetMetadataModel).toBe(KNOWN_MODELS.SONNET.id);
    // An unknown alias takes its output cap from the model it maps to.
    expect(live.maxOutputTokens).toBe(sonnetMaxOutput);
    const pinned = request.buildStreamRequestConfig(
      requestOptions({ ...alias, providersConfigSnapshot: aliasConfig("anthropic:pinned") })
    );
    expect(pinned.budgetMetadataModel).toBe("anthropic:pinned");
  });

  test("gives a rebuildable request a mutable providerOptions object", () => {
    const { request } = createProviderRequest();
    expect(request.buildStreamRequestConfig(requestOptions()).providerOptions).toBeUndefined();
    const rebuildable = request.buildStreamRequestConfig(
      requestOptions({ rebuildProviderOptionsForThinkingLevel: () => null })
    );
    expect(rebuildable.providerOptions).toEqual({});
  });
});

describe("ProviderRequest applyPendingThinkingOverride", () => {
  function overrideRequest(
    state: ActiveTurnThinkingOverride,
    rebuild?: StreamRequestConfig["rebuildProviderOptionsForThinkingLevel"]
  ): StreamRequestConfig {
    return {
      model: MODEL,
      modelString: MODEL,
      messages: [],
      providerOptions: { anthropic: { thinking: { type: "enabled" } }, stale: true },
      thinkingOverrideState: state,
      rebuildProviderOptionsForThinkingLevel: rebuild,
    };
  }

  test("replaces the provider options in place and records the applied level", () => {
    const { request } = createProviderRequest();
    const appliedLevels: string[] = [];
    const state: ActiveTurnThinkingOverride = {
      pending: "high",
      onApplied: (level) => appliedLevels.push(level),
    };
    const rebuilt = { anthropic: { thinking: { type: "adaptive" } } };
    const config = overrideRequest(state, () => ({
      effectiveLevel: "medium",
      providerOptions: rebuilt,
    }));
    const target = config.providerOptions;
    expect(request.applyPendingThinkingOverride(config, false)).toBe(rebuilt);
    // Same object: the SDK reads the reference it got at streamText() time.
    expect(config.providerOptions).toBe(target);
    expect(config.providerOptions).toEqual(rebuilt);
    expect(state).toMatchObject({ pending: undefined, applied: "medium" });
    expect(appliedLevels).toEqual(["medium"]);
  });

  test("holds the change until after a stage turn's first request", () => {
    const { request } = createProviderRequest();
    const state: ActiveTurnThinkingOverride = { pending: "high", holdBeforeFirstRequest: true };
    const config = overrideRequest(state, () => ({ effectiveLevel: "high", providerOptions: {} }));
    expect(request.applyPendingThinkingOverride(config, true)).toBeUndefined();
    expect(state.pending).toBe("high");
    expect(request.applyPendingThinkingOverride(config, false)).toEqual({});
    expect(state.pending).toBeUndefined();
  });

  test.each([
    ["no rebuild closure", undefined],
    ["a no-op rebuild", () => null],
  ])("drops the pending level once for %s", (_label, rebuild) => {
    const { request } = createProviderRequest();
    const state: ActiveTurnThinkingOverride = { pending: "high" };
    const config = overrideRequest(state, rebuild);
    const before = structuredClone(config.providerOptions);
    expect(request.applyPendingThinkingOverride(config, false)).toBeUndefined();
    expect(state.pending).toBeUndefined();
    expect(state.applied).toBeUndefined();
    expect(config.providerOptions).toEqual(before);
  });
});
