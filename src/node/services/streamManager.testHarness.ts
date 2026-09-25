import type { ModelMessage, streamText } from "ai";
import type { Scope } from "effect";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import type { CompletedMessagePart } from "@/common/types/stream";
import type { EffectRunner } from "./di/effectRunner";
import type { HistoryService } from "./historyService";
import type { SessionUsageService } from "./sessionUsageService";
import type {
  ActiveTurnThinkingOverride,
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "./thinkingOverride";
import {
  StreamManager,
  type StreamManagerOptions,
  type StreamManagerTokenTracker,
  type TurnEngineEvent,
  type TurnEngineEventSink,
} from "./streamManager";

type TurnEngineEventOfType<T extends TurnEngineEvent["type"]> = Extract<
  TurnEngineEvent,
  { type: T }
>;

// Chains a listener onto StreamManager's event sink so tests can observe
// engine events without wiring an AIService.
export function onTurnEngineEvent<T extends TurnEngineEvent["type"]>(
  streamManager: StreamManager,
  type: T,
  listener: (event: TurnEngineEventOfType<T>) => void
): void {
  const internals = engineInternals(streamManager);
  const previous = internals.eventSink;
  internals.eventSink = (event) => {
    const result = previous(event);
    if (event.type === type) {
      listener(event as TurnEngineEventOfType<T>);
    }
    return result;
  };
}

/** No-op token tracker: engine tests don't need live token stats or tokenizer workers. */
export const noopTokenTracker: StreamManagerTokenTracker = {
  setModel: () => Promise.resolve(),
  countTokens: () => Promise.resolve(0),
};

/**
 * Types a test double as the injected stream factory. Doubles return only the
 * StreamTextResult fields StreamManager reads (fullStream, usage, ...).
 */
export function fakeStreamText(
  impl: (options: Parameters<typeof streamText>[0]) => unknown
): typeof streamText {
  return impl as unknown as typeof streamText;
}

export interface StreamManagerTestDeps extends StreamManagerOptions {
  sessionUsageService?: SessionUsageService;
  getProvidersConfig?: () => ProvidersConfigMap | null;
  eventSink?: TurnEngineEventSink;
  runner?: EffectRunner;
  engineScope?: Scope.Closeable;
}

/** Builds a StreamManager with named test deps; the token tracker defaults to a no-op. */
export function createStreamManagerForTests(
  historyService: HistoryService,
  deps: StreamManagerTestDeps = {}
): StreamManager {
  return new StreamManager(
    historyService,
    deps.sessionUsageService,
    deps.getProvidersConfig,
    deps.eventSink,
    deps.runner,
    deps.engineScope,
    undefined,
    { streamText: deps.streamText, tokenTracker: deps.tokenTracker ?? noopTokenTracker }
  );
}

/** The StreamRequestConfig fields the engine-internals tests read or build. */
export interface StreamRequestConfigForTests {
  model: unknown;
  messages: ModelMessage[];
  system?: string;
  providerOptions?: Record<string, unknown>;
  thinkingOverrideState?: ActiveTurnThinkingOverride;
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
  rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
  onStepMessages?: (stepMessages: ModelMessage[]) => void;
}

type StopWhenConditionForTests = (options: { steps: unknown[] }) => boolean | Promise<boolean>;

/**
 * Whitebox access to StreamManager's private engine for tests that seed a
 * hand-built stream state or drive one engine step directly (usage/sidecar
 * accounting, refusal fallback, reasoning-replay and previousResponseId retry,
 * abort persistence, prepareStep internals). Every member here is private in
 * StreamManager; the types mirror what these tests pass, not the real
 * signatures, so a rename surfaces as a runtime failure in the using test.
 *
 * FOLLOW-UP (test-audit WS5): migrate these tests to startStream with an
 * injected streamText (createStreamManagerForTests) and assert on events,
 * partial/history, and the sidecar instead. Do not add members for new tests.
 */
export interface StreamManagerEngineInternals {
  eventSink: TurnEngineEventSink;
  readonly workspaceStreams: Map<string, unknown>;
  readonly PARTIAL_WRITE_THROTTLE_MS: number;
  processStreamWithCleanup: (
    workspaceId: string,
    streamInfo: unknown,
    historySequence: number
  ) => Promise<void>;
  appendPartAndEmit: (
    workspaceId: string,
    streamInfo: unknown,
    part: CompletedMessagePart,
    schedulePartialWrite?: boolean
  ) => Promise<void>;
  handleToolExecutionStart: (workspaceId: string, messageId: string, toolCallId: string) => void;
  schedulePartialWrite: (workspaceId: string, streamInfo: unknown) => Promise<void>;
  flushPartialWrite: (workspaceId: string, streamInfo: unknown) => Promise<void>;
  recordSessionUsage: (
    workspaceId: string,
    model: string,
    usage: Record<string, number>,
    providerMetadata: Record<string, unknown> | undefined,
    logMessage: string,
    logLevel: "warn" | "error",
    streamInfo?: unknown
  ) => Promise<void>;
  recordDroppedPartialUsageInSidecar: (
    workspaceId: string,
    streamInfo: unknown,
    usage: Record<string, number> | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    analyticsSource: string,
    streamUsageSource?: string
  ) => Promise<void>;
  recordToolModelUsage: (workspaceId: string, messageId: string, event: unknown) => void;
  createStopWhenCondition: (request: object) => StopWhenConditionForTests[];
  tryModelFallbackAfterRefusal: (
    workspaceId: string,
    streamInfo: unknown,
    refusalFinishReason: string,
    options?: unknown
  ) => Promise<{ kind: string }>;
  buildPartialAssistantMessage: (
    streamInfo: unknown,
    options?: Record<string, unknown>
  ) => MuxMessage;
  buildStreamRequestConfig: (input: object) => StreamRequestConfigForTests;
  createStreamResult: (
    request: unknown,
    abortController: AbortController,
    stepTracker?: unknown
  ) => unknown;
  resetStreamStateForRetry: (
    workspaceId: string,
    streamInfo: unknown,
    options: { preserveParts: boolean }
  ) => Promise<void>;
  emitStreamStart: (workspaceId: string, streamInfo: unknown, historySequence: number) => void;
  completeToolCall: (
    workspaceId: string,
    streamInfo: unknown,
    toolCalls: Map<string, unknown>,
    toolCallId: string,
    toolName: string,
    output: unknown
  ) => Promise<void>;
  extractPreviousResponseIdFromError: (error: unknown) => string | undefined;
  recordLostResponseIdIfApplicable: (
    workspaceId: string,
    error: unknown,
    streamInfo: unknown
  ) => void;
  retryStreamWithoutPreviousResponseId: (
    workspaceId: string,
    streamInfo: unknown,
    error: unknown,
    hasRetried: boolean
  ) => Promise<boolean>;
  retryStreamWithoutOpenAIReasoningReplay: (
    workspaceId: string,
    streamInfo: unknown,
    error: unknown,
    hasRetried: boolean
  ) => Promise<boolean>;
  resolveTotalUsageForStreamEnd: (streamInfo: unknown, totalUsage: unknown) => unknown;
  categorizeError: (error: unknown) => unknown;
  cleanupAbortedStream: (
    workspaceId: string,
    streamInfo: unknown,
    abortReason: string,
    abandonPartial?: boolean
  ) => Promise<void>;
  persistStreamError: (
    workspaceId: string,
    streamInfo: unknown,
    payload: { messageId: string; error: string; errorType: string }
  ) => Promise<void>;
  ensureStreamSafety: (workspaceId: string) => Promise<string>;
  createStreamAtomically: (...args: never[]) => unknown;
  cleanupStreamTempDir: (runtime: unknown, runtimeTempDir: string) => void;
}

/** The single cast into StreamManager's private engine; see StreamManagerEngineInternals. */
export function engineInternals(streamManager: StreamManager): StreamManagerEngineInternals {
  return streamManager as unknown as StreamManagerEngineInternals;
}
