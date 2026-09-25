import type { streamText } from "ai";
import type { Scope } from "effect";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import type { EffectRunner } from "./di/effectRunner";
import type { HistoryService } from "./historyService";
import type { SessionUsageService } from "./sessionUsageService";
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

// Sinks installed through the public setEventSink: the construction-time sink each
// harness-built manager received, then any listeners chained onto it.
const constructionSinks = new WeakMap<StreamManager, TurnEngineEventSink>();
const chainedSinks = new WeakMap<StreamManager, TurnEngineEventSink>();

// Chains a listener onto StreamManager's event sink so tests can observe
// engine events without wiring an AIService.
export function onTurnEngineEvent<T extends TurnEngineEvent["type"]>(
  streamManager: StreamManager,
  type: T,
  listener: (event: TurnEngineEventOfType<T>) => void
): void {
  const previous: TurnEngineEventSink =
    chainedSinks.get(streamManager) ?? constructionSinks.get(streamManager) ?? (() => undefined);
  const sink: TurnEngineEventSink = (event) => {
    const result = previous(event);
    if (event.type === type) {
      listener(event as TurnEngineEventOfType<T>);
    }
    return result;
  };
  chainedSinks.set(streamManager, sink);
  streamManager.setEventSink(sink);
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
  const streamManager = new StreamManager(
    historyService,
    deps.sessionUsageService,
    deps.getProvidersConfig,
    deps.eventSink,
    deps.runner,
    deps.engineScope,
    undefined,
    { streamText: deps.streamText, tokenTracker: deps.tokenTracker ?? noopTokenTracker }
  );
  if (deps.eventSink) constructionSinks.set(streamManager, deps.eventSink);
  return streamManager;
}

/**
 * Whitebox access to StreamManager's private engine, kept only where no public
 * observable can produce or reveal the state under test (#4523 residual list):
 * - workspaceStreams: seeding a replacement registration while the start lock is
 *   held during onStreamConstructed, and replacing processingPromise with a
 *   rejecting one (startStream always attaches a catch).
 * - flushPartialWrite: forcing the pre-cancel flush to reject (it swallows its
 *   own writePartial errors).
 * - resetStreamStateForRetry / buildPartialAssistantMessage: the parts-preserving
 *   reset, reachable publicly only through the previousResponseId retry.
 * - processStreamWithCleanup: asserting the refusal-fallback swap clears the
 *   private stepTracker.latestMessages.
 * Types mirror what these tests pass, not the real signatures. Do not add members
 * for new tests: drive startStream with an injected streamText instead.
 */
export interface StreamManagerEngineInternals {
  readonly workspaceStreams: Map<string, unknown>;
  flushPartialWrite: (workspaceId: string, streamInfo: unknown) => Promise<void>;
  resetStreamStateForRetry: (
    workspaceId: string,
    streamInfo: unknown,
    options: { preserveParts: boolean }
  ) => Promise<void>;
  buildPartialAssistantMessage: (
    streamInfo: unknown,
    options?: Record<string, unknown>
  ) => MuxMessage;
  processStreamWithCleanup: (
    workspaceId: string,
    streamInfo: unknown,
    historySequence: number
  ) => Promise<void>;
}

/** The single cast into StreamManager's private engine; see StreamManagerEngineInternals. */
export function engineInternals(streamManager: StreamManager): StreamManagerEngineInternals {
  return streamManager as unknown as StreamManagerEngineInternals;
}
