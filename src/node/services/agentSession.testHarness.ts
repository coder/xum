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
import type { InitStateManager } from "@/node/services/initStateManager";
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

function createMockInitStateManager(overrides?: Partial<InitStateManager>): InitStateManager {
  return Object.assign(new EventEmitter(), overrides) as unknown as InitStateManager;
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

function createMockAiService(args: {
  getClosingSignal: () => AbortSignal;
  emitter?: EventEmitter;
  overrides?: Partial<AgentSessionAIService>;
}): {
  aiEmitter: EventEmitter;
  aiService: AgentSessionAIService;
} {
  const aiEmitter = args?.emitter ?? new EventEmitter();
  const aiService: AgentSessionAIService = Object.assign(aiEmitter, {
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
          start: (options: Parameters<AgentSessionAIService["streamMessage"]>[0]) =>
            aiService.streamMessage(options),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        })
      )
    ),
    captureRequestAssemblySnapshot: mock((workspaceId: string) =>
      Promise.resolve(Ok(eventSpine.captureRequestAssembly(workspaceId)))
    ),
    ...createStreamLifecycleMocks(),
    streamMessage: mock(() =>
      Promise.resolve(
        Ok(createStartedTurnHandle(args.getClosingSignal(), "test-assistant-message"))
      )
    ),
    ...args?.overrides,
  });
  return { aiEmitter, aiService };
}

/** Direct session fixtures bypass the app graph, but still use the real context controller. */
export function createTestAgentSession(
  options: Omit<ConstructorParameters<typeof AgentSession>[0], "contextManagement"> & {
    contextManagement?: ContextManagementService;
  }
): AgentSession {
  return new AgentSession({
    ...options,
    contextManagement:
      options.contextManagement ??
      new ContextManagementService({
        config: options.config,
        historyService: options.historyService,
        aiService: options.aiService,
        sessionUsageService: options.sessionUsageService,
        telemetryService: options.telemetryService,
      }),
  });
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
  // A caller-owned HistoryService must come with the Config that owns its sessions dir;
  // pairing it with a stand-in config would split session state across two roots.
  assert(
    options.historyService == null || options.config != null,
    "createAgentSessionHarness: pass config together with historyService"
  );
  const testHistory = options.historyService ? undefined : await createTestHistoryService();
  const historyService = options.historyService ?? testHistory!.historyService;
  const config = options.config ?? testHistory!.config;
  const cleanup = testHistory?.cleanup ?? (() => Promise.resolve());
  const { aiEmitter, aiService } = options.aiService
    ? { aiEmitter: options.aiEmitter ?? new EventEmitter(), aiService: options.aiService }
    : createMockAiService({
        getClosingSignal: () => session.closingSignal,
        emitter: options.aiEmitter,
        overrides: options.aiServiceOverrides,
      });
  const initStateManager =
    options.initStateManager ?? createMockInitStateManager(options.initStateManagerOverrides);
  const backgroundProcessManager =
    options.backgroundProcessManager ??
    createMockBackgroundProcessManager(options.backgroundProcessManagerOverrides);

  const contextManagement =
    options.contextManagement ??
    new ContextManagementService({
      config,
      historyService,
      aiService,
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
