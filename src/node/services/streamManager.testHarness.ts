import type { streamText } from "ai";
import type { Scope } from "effect";
import type { ProvidersConfigMap } from "@/common/orpc/types";
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

// Chains a listener onto StreamManager's private event sink so tests can
// observe engine events without wiring an AIService.
export function onTurnEngineEvent<T extends TurnEngineEvent["type"]>(
  streamManager: StreamManager,
  type: T,
  listener: (event: TurnEngineEventOfType<T>) => void
): void {
  const internals = streamManager as unknown as { eventSink: TurnEngineEventSink };
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
