import { ContextManagementService } from "./contextManagement/contextManagementService";
import { eventSpine } from "./events/eventSpine";
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
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { HistoryService } from "@/node/services/historyService";
import { InitStateManager } from "@/node/services/initStateManager";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { StreamErrorType } from "@/common/types/errors";

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
  failure: { error: string; errorType: StreamErrorType }
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
    setMessageQueued: mock((_workspaceId: string, _queued: boolean) => void _queued),
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

export interface AgentSessionAIServiceFakeOptions {
  /** Event source the session subscribes to; tests emit stream events on it. */
  emitter?: EventEmitter;
  overrides?: Partial<AgentSessionAIService>;
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
): AgentSessionAIService & EventEmitter {
  const aiEmitter = options.emitter ?? new EventEmitter();
  const getClosingSignal = options.getClosingSignal;
  const aiService: AgentSessionAIService & EventEmitter = Object.assign(aiEmitter, {
    // Real implementations report failures as Err results, never rejections.
    createModelWithPinnedMetadata: mock(() =>
      Promise.resolve(
        Err({ type: "unknown" as const, raw: "Test AI service cannot create models" })
      )
    ),
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
> {
  workspaceId: string;
  contextManagement?: ContextManagementService;
  config?: Config;
  historyService?: HistoryService;
  aiService?: AgentSessionAIService;
  streamManager?: AgentSessionStreamManager;
  aiEmitter?: EventEmitter;
  aiServiceOverrides?: Partial<AgentSessionAIService>;
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
  aiService: AgentSessionAIService;
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
  const current = config.loadConfigOrDefault().userPreferences;
  await config.saveUserConfig({
    userPreferences: {
      ...current,
      ai: {
        ...current?.ai,
        autoCompactionThresholdByModel: {
          ...current?.ai?.autoCompactionThresholdByModel,
          [model]: percent,
        },
      },
    },
  });
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
  const cleanup = testHistory?.cleanup ?? (() => Promise.resolve());
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
    streamManager: options.streamManager,
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
    aiService,
    initStateManager,
    backgroundProcessManager,
    events,
  };
}
