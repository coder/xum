import { ContextManagementService } from "./contextManagement/contextManagementService";
import { eventSpine } from "./events/eventSpine";
import { runMessageSendHooks, runTurnStopHooks } from "./agentPlugins/promptHooks";
import { mock } from "bun:test";
import { EventEmitter } from "events";

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { Err, Ok } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import type { TurnStreamHandle } from "@/node/services/streamManager";
import {
  AgentSession,
  type AgentSessionAIService,
  type AgentSessionStreamManager,
} from "@/node/services/agentSession";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { CompactionHandler } from "@/node/services/compactionHandler";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { HistoryService } from "@/node/services/historyService";
import { InitStateManager } from "@/node/services/initStateManager";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { StreamErrorType } from "@/common/types/errors";
import { nodeRuntimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";
import { defaultEffectRunner, type EffectRunner } from "@/node/services/di/effectRunner";
import { hostClockFor } from "@/node/services/di/hostClockLive";
import type { HostClock } from "@/node/utils/hostClock";

export function createStartedTurnHandle(
  signal: AbortSignal,
  messageId = "test-assistant"
): TurnStreamHandle {
  // Policy-only fixtures have no engine. Their own session shutdown retires this handle;
  // lifecycle tests supply independent completion gates instead of this convenience helper.
  const completion = Promise.withResolvers<Awaited<TurnStreamHandle["completion"]>>();
  const stop = () => completion.resolve({ status: "aborted", abortReason: "user" });
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return { messageId, completion: completion.promise };
}

export function createFailedTurnHandle(
  messageId: string,
  failure: { error: string; errorType: StreamErrorType; model?: string }
): TurnStreamHandle {
  return {
    messageId,
    completion: Promise.resolve({
      status: "failed" as const,
      streamError: { messageId, ...failure },
    }),
  };
}

/**
 * Isolated terminal-policy tests with no engine. Lifecycle tests must instead
 * return controllable handles through streamMessage (see turnCompletion.test.ts).
 */
export function runSessionTerminalPolicy(
  session: AgentSession,
  emitter: EventEmitter,
  payload: StreamEndEvent | StreamAbortEvent
): Promise<void> {
  const policy = session as unknown as {
    handleTurnSuccess(payload: StreamEndEvent): Promise<void>;
    handleTurnAbort(payload: StreamAbortEvent, systemMessageTokens?: number): Promise<void>;
    streamManager: {
      getStreamInfo(
        workspaceId: string
      ): { initialMetadata?: { systemMessageTokens?: number } } | undefined;
    };
  };
  const systemMessageTokens = policy.streamManager.getStreamInfo(payload.workspaceId)
    ?.initialMetadata?.systemMessageTokens;
  emitter.emit(payload.type, payload);
  return payload.type === "stream-end"
    ? policy.handleTurnSuccess(payload)
    : policy.handleTurnAbort(payload, systemMessageTokens);
}

function createMockBackgroundProcessManager(
  overrides?: Partial<BackgroundProcessManager>
): BackgroundProcessManager {
  return {
    cleanup: mock((_workspaceId: string) => Promise.resolve()),
    getForegroundToolCallIds: mock(() => []),
    ...overrides,
  } as unknown as BackgroundProcessManager;
}

/** Real manager (no init runs recorded) with per-test method overrides applied on top. */
function createTestInitStateManager(
  config: Config,
  overrides?: Partial<InitStateManager>
): InitStateManager {
  return Object.assign(new InitStateManager(config), overrides);
}

/** Stream-lifecycle surface AgentSession's constructor requires from its engine seam. */
export function createStreamLifecycleMocks() {
  return {
    isStreaming: mock((_workspaceId: string) => false),
    stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    getStreamInfo: mock((_workspaceId: string) => undefined),
    replayStream: mock((_workspaceId: string, _options?: { afterTimestamp?: number }) =>
      Promise.resolve()
    ),
  };
}

/** The stream lifecycle a test drives; the AI fakes implement it (createStreamLifecycleMocks). */
export type StreamLifecycle = Pick<
  AgentSessionStreamManager,
  "stopStream" | "isStreaming" | "getStreamInfo" | "replayStream"
>;

/**
 * Stream-manager double. It answers from `lifecycle` at call time, so a spy installed on the
 * lifecycle object later still applies, and it hands out one runner and its clock, as
 * StreamManager does.
 */
export function createTestStreamManager(
  lifecycle: StreamLifecycle = createStreamLifecycleMocks(),
  effectRunner: EffectRunner = defaultEffectRunner,
  hostClock: HostClock = hostClockFor(effectRunner)
): AgentSessionStreamManager {
  return {
    stopStream: (workspaceId, options) => lifecycle.stopStream(workspaceId, options),
    isStreaming: (workspaceId) => lifecycle.isStreaming(workspaceId),
    getStreamInfo: (workspaceId, includeFinalizing) =>
      lifecycle.getStreamInfo(workspaceId, includeFinalizing),
    replayStream: (workspaceId, options) => lifecycle.replayStream(workspaceId, options),
    effectRunner,
    hostClock,
  };
}

export type AgentSessionAIServiceFake = AgentSessionAIService & StreamLifecycle;

/** A caller-supplied AI double stands in for the stream manager only if it has the lifecycle. */
function streamLifecycleOf(aiService: AgentSessionAIService): StreamLifecycle {
  const candidate = aiService as Partial<StreamLifecycle>;
  assert(
    typeof candidate.stopStream === "function" &&
      typeof candidate.isStreaming === "function" &&
      typeof candidate.getStreamInfo === "function" &&
      typeof candidate.replayStream === "function",
    "createAgentSessionHarness: pass streamManager, or an aiService with the stream lifecycle"
  );
  return candidate as StreamLifecycle;
}

export interface AgentSessionAIServiceFakeOptions {
  /** Event source the session subscribes to; tests emit stream events on it. */
  emitter?: EventEmitter;
  overrides?: Partial<AgentSessionAIServiceFake>;
  /**
   * Signal that ends the default stream's started-turn handle (usually the session's
   * closingSignal). Without it the default stream reports a startup failure instead.
   */
  getClosingSignal?: () => AbortSignal;
}

/**
 * Typed AgentSession AI fake with every required member implemented, so tests never need a
 * cast (and production never needs a typeof guard for a member a partial fake left out).
 * The returned object is the emitter itself.
 */
export function createAgentSessionAIServiceFake(
  options: AgentSessionAIServiceFakeOptions = {}
): AgentSessionAIServiceFake & EventEmitter {
  const aiEmitter = options.emitter ?? new EventEmitter();
  const getClosingSignal = options.getClosingSignal;
  const aiService: AgentSessionAIServiceFake & EventEmitter = Object.assign(aiEmitter, {
    runtimeFactory: nodeRuntimeFactory,
    // Real implementations report failures as Err results, never rejections.
    createModelWithPinnedOptions: mock(() =>
      Promise.resolve(
        Err({ type: "unknown" as const, raw: "Test AI service cannot create models" })
      )
    ),
    getWorkspaceMetadata: mock((workspaceId: string) =>
      Promise.resolve(
        Ok({
          id: workspaceId,
          name: workspaceId,
          projectName: "project",
          projectPath: "/tmp/project",
          runtimeConfig: { type: "local" as const },
        })
      )
    ),
    getProvidersConfig: mock(() => null),
    isExperimentEnabled: mock((_experimentId) => false),
    prepareStreamMessage: mock(() =>
      Promise.resolve(
        Ok({
          start: (streamOptions: Parameters<AgentSessionAIService["streamMessage"]>[0]) =>
            aiService.streamMessage(streamOptions),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        })
      )
    ),
    captureRequestAssemblySnapshot: mock((workspaceId: string) =>
      Promise.resolve(Ok(eventSpine.captureRequestAssembly(workspaceId)))
    ),
    // The real chain on the real spine: tests register fake prompt-hook consumers on it.
    prepareMessageSendHooks: mock((workspaceId: string) =>
      Promise.resolve(eventSpine.hasMiddlewareFor("message.send", workspaceId))
    ),
    runMessageSendHooks: mock(
      (workspaceId: string, input: Parameters<typeof runMessageSendHooks>[2]) =>
        runMessageSendHooks(eventSpine, workspaceId, input)
    ),
    runTurnStopHooks: mock((workspaceId: string, input: Parameters<typeof runTurnStopHooks>[2]) =>
      runTurnStopHooks(eventSpine, workspaceId, input)
    ),
    ...createStreamLifecycleMocks(),
    streamMessage: mock<AgentSessionAIService["streamMessage"]>(() =>
      Promise.resolve(
        getClosingSignal
          ? Ok(createStartedTurnHandle(getClosingSignal(), "test-assistant-message"))
          : Err({ type: "unknown" as const, raw: "Test AI service has no stream" })
      )
    ),
    ...options.overrides,
  });
  return aiService;
}

export interface AgentSessionHarnessOptions extends Pick<
  ConstructorParameters<typeof AgentSession>[0],
  | "effectRunner"
  | "appFiberScope"
  | "isStopInProgress"
  | "getStopEpoch"
  | "onTurnSettled"
  | "onTurnSuperseded"
  | "onBeforeTurnCompletion"
  | "planSnapshotCaptureTimeoutMs"
  | "onPostCompactionStateChange"
  | "sessionUsageService"
  | "autoModelRouter"
  | "hasExternalSendPreflight"
  | "hasExternalManualSendPreflight"
  | "callerOwnsTurnEnd"
> {
  workspaceId: string;
  contextManagement?: ContextManagementService;
  config?: Config;
  historyService?: HistoryService;
  /** Without `streamManager`, it must also implement the stream lifecycle (StreamLifecycle). */
  aiService?: AgentSessionAIService;
  /** Default: createTestStreamManager over the AI fake, on the session's runner. */
  streamManager?: AgentSessionStreamManager;
  aiEmitter?: EventEmitter;
  aiServiceOverrides?: Partial<AgentSessionAIServiceFake>;
  initStateManager?: InitStateManager;
  initStateManagerOverrides?: Partial<InitStateManager>;
  backgroundProcessManager?: BackgroundProcessManager;
  backgroundProcessManagerOverrides?: Partial<BackgroundProcessManager>;
  workspaceGoalService?: WorkspaceGoalService;
  mcpServerManager?: MCPServerManager;
  onCompactionComplete?: (metadata: CompactionCompletionMetadata) => void;
  onIdleCompactionOutcome?: (success: boolean) => void;
  captureEvents?: boolean;
}

export interface AgentSessionHarness {
  session: AgentSession;
  contextManagement: ContextManagementService;
  config: Config;
  historyService: HistoryService;
  cleanup: () => Promise<void>;
  aiEmitter: EventEmitter;
  /** The fake, or the caller's double (which then answers the lifecycle calls tests spy on). */
  aiService: AgentSessionAIServiceFake;
  initStateManager: InitStateManager;
  backgroundProcessManager: BackgroundProcessManager;
  events: WorkspaceChatMessage[];
}

/**
 * Persists a per-model auto-compaction slider value the way the UI does (user preferences in
 * config.json). The session resolves the threshold from config on every decision, so this is
 * the only way a test changes it; the save also fires `onConfigChanged`.
 */
export async function seedAutoCompactionThreshold(
  config: Config,
  model: string,
  percent: number
): Promise<void> {
  await config.updateUserPreferences([
    { ai: { autoCompactionThresholdByModel: { [model]: percent } } },
  ]);
}

export async function createAgentSessionHarness(
  options: AgentSessionHarnessOptions
): Promise<AgentSessionHarness> {
  // A caller-owned HistoryService must come with the Config that owns its sessions dir (and
  // vice versa); pairing either with a temp stand-in would split session state across roots.
  assert(
    (options.historyService == null) === (options.config == null),
    "createAgentSessionHarness: pass config and historyService together"
  );
  const testHistory = options.historyService ? undefined : await createTestHistoryService();
  const historyService = options.historyService ?? testHistory!.historyService;
  const config = options.config ?? testHistory!.config;
  const removeTempDir = testHistory?.cleanup ?? (() => Promise.resolve());
  // Dispose before removing the folder: a session left alive keeps its RetryManager retrying
  // (up to every 60 s) after its file ends, and each retry takes workspace use leases while
  // later files in the same bun process run (#7526, #7518). dispose() is idempotent, so tests
  // that already dispose their session can keep doing so.
  const cleanup = async () => {
    try {
      await session.dispose();
    } finally {
      await removeTempDir();
    }
  };
  const fake = options.aiService
    ? undefined
    : createAgentSessionAIServiceFake({
        getClosingSignal: () => session.closingSignal,
        emitter: options.aiEmitter,
        overrides: options.aiServiceOverrides,
      });
  const aiService = options.aiService ?? fake!;
  const aiEmitter = fake ?? options.aiEmitter ?? new EventEmitter();
  const initStateManager =
    options.initStateManager ??
    createTestInitStateManager(config, options.initStateManagerOverrides);
  const backgroundProcessManager =
    options.backgroundProcessManager ??
    createMockBackgroundProcessManager(options.backgroundProcessManagerOverrides);

  const contextManagement =
    options.contextManagement ??
    new ContextManagementService({
      config,
      historyService,
      aiService,
      sessionUsageService: options.sessionUsageService,
    });
  const session: AgentSession = new AgentSession({
    contextManagement,
    effectRunner: options.effectRunner,
    appFiberScope: options.appFiberScope,
    workspaceId: options.workspaceId,
    config,
    historyService,
    aiService,
    streamManager:
      options.streamManager ??
      createTestStreamManager(
        fake ?? streamLifecycleOf(aiService),
        options.effectRunner ?? defaultEffectRunner
      ),
    mcpServerManager: options.mcpServerManager,
    initStateManager,
    workspaceGoalService: options.workspaceGoalService,
    backgroundProcessManager,
    onCompactionComplete: options.onCompactionComplete,
    onIdleCompactionOutcome: options.onIdleCompactionOutcome,
    isStopInProgress: options.isStopInProgress,
    getStopEpoch: options.getStopEpoch,
    onTurnSettled: options.onTurnSettled,
    onTurnSuperseded: options.onTurnSuperseded,
    onBeforeTurnCompletion: options.onBeforeTurnCompletion,
    planSnapshotCaptureTimeoutMs: options.planSnapshotCaptureTimeoutMs,
    onPostCompactionStateChange: options.onPostCompactionStateChange,
    sessionUsageService: options.sessionUsageService,
    autoModelRouter: options.autoModelRouter,
    hasExternalSendPreflight: options.hasExternalSendPreflight,
    hasExternalManualSendPreflight: options.hasExternalManualSendPreflight,
    callerOwnsTurnEnd: options.callerOwnsTurnEnd,
  });

  const events: WorkspaceChatMessage[] = [];
  if (options.captureEvents) {
    session.onChatEvent(({ message }) => {
      events.push(message);
    });
  }

  return {
    session,
    contextManagement,
    config,
    historyService,
    cleanup,
    aiEmitter,
    // A caller double is returned as given; see AgentSessionHarness.aiService.
    aiService: aiService as AgentSessionAIServiceFake,
    initStateManager,
    backgroundProcessManager,
    events,
  };
}

/** The session's compaction handler, for tests that drive compaction directly. */
export function sessionCompactionHandler(session: AgentSession): CompactionHandler {
  return (session as unknown as { contextController: { compaction: CompactionHandler } })
    .contextController.compaction;
}

/** Publish a real compaction boundary "boundary" with no tail; it builds its header as usual. */
export async function compactSessionForTest(
  session: AgentSession,
  historyService: HistoryService,
  workspaceId: string
): Promise<void> {
  const handler = sessionCompactionHandler(session);
  const persisted = await handler.persistContinuousCompaction({
    preparation: handler.beginPreparation(() => true),
    publication: {
      generation: await historyService
        .getContinuousCompactionJournal(workspaceId)
        .captureGeneration(),
    },
    attachmentMessages: [],
    messages: [],
    boundaryMessageId: "boundary",
    text: "summary",
    model: "anthropic:claude-sonnet-4-5",
    tail: [],
    systemMessageTokens: 0,
    shouldPersist: () => true,
  });
  assert(persisted, "Expected the compaction to persist");
}
