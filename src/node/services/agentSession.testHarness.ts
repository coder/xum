import { mock } from "bun:test";
import { EventEmitter } from "events";

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { Ok } from "@/common/types/result";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { TurnStreamHandle } from "@/node/services/streamManager";
import { AgentSession } from "@/node/services/agentSession";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { StreamErrorType } from "@/common/types/errors";

export function createStartedTurnHandle(messageId = "test-assistant"): TurnStreamHandle {
  return { messageId, completion: new Promise(() => undefined) };
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

function createAgentSessionTestConfig(sessionDir = "/tmp"): Config {
  return {
    srcDir: sessionDir,
    getSessionDir: mock((_workspaceId: string) => sessionDir),
    loadConfigOrDefault: mock(() => ({})),
  } as unknown as Config;
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

function createMockAiService(args?: { emitter?: EventEmitter; overrides?: Partial<AIService> }): {
  aiEmitter: EventEmitter;
  aiService: AIService;
} {
  const aiEmitter = args?.emitter ?? new EventEmitter();
  return {
    aiEmitter,
    aiService: Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      getStreamInfo: mock((_workspaceId: string) => null),
      streamMessage: mock(() =>
        Promise.resolve(Ok(createStartedTurnHandle("test-assistant-message")))
      ) as unknown as AIService["streamMessage"],
      ...args?.overrides,
    }) as unknown as AIService,
  };
}

export interface AgentSessionHarnessOptions {
  workspaceId: string;
  config?: Config;
  historyService?: HistoryService;
  aiService?: AIService;
  aiEmitter?: EventEmitter;
  aiServiceOverrides?: Partial<AIService>;
  initStateManager?: InitStateManager;
  initStateManagerOverrides?: Partial<InitStateManager>;
  backgroundProcessManager?: BackgroundProcessManager;
  backgroundProcessManagerOverrides?: Partial<BackgroundProcessManager>;
  workspaceGoalService?: WorkspaceGoalService;
  mcpServerManager?: MCPServerManager;
  onCompactionComplete?: (metadata: CompactionCompletionMetadata) => void;
  captureEvents?: boolean;
}

export interface AgentSessionHarness {
  session: AgentSession;
  config: Config;
  historyService: HistoryService;
  cleanup: () => Promise<void>;
  aiEmitter: EventEmitter;
  aiService: AIService;
  initStateManager: InitStateManager;
  backgroundProcessManager: BackgroundProcessManager;
  events: WorkspaceChatMessage[];
}

export async function createAgentSessionHarness(
  options: AgentSessionHarnessOptions
): Promise<AgentSessionHarness> {
  const testHistory = options.historyService ? undefined : await createTestHistoryService();
  const historyService = options.historyService ?? testHistory!.historyService;
  const config = options.config ?? testHistory?.config ?? createAgentSessionTestConfig();
  const cleanup = testHistory?.cleanup ?? (() => Promise.resolve());
  const { aiEmitter, aiService } = options.aiService
    ? { aiEmitter: options.aiEmitter ?? new EventEmitter(), aiService: options.aiService }
    : createMockAiService({
        emitter: options.aiEmitter,
        overrides: options.aiServiceOverrides,
      });
  const initStateManager =
    options.initStateManager ?? createMockInitStateManager(options.initStateManagerOverrides);
  const backgroundProcessManager =
    options.backgroundProcessManager ??
    createMockBackgroundProcessManager(options.backgroundProcessManagerOverrides);

  const session = new AgentSession({
    workspaceId: options.workspaceId,
    config,
    historyService,
    aiService,
    mcpServerManager: options.mcpServerManager,
    initStateManager,
    workspaceGoalService: options.workspaceGoalService,
    backgroundProcessManager,
    onCompactionComplete: options.onCompactionComplete,
  });

  const events: WorkspaceChatMessage[] = [];
  if (options.captureEvents) {
    session.onChatEvent(({ message }) => {
      events.push(message);
    });
  }

  return {
    session,
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
