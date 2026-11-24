// Bun test file - doesn't support Jest mocking, so we skip this test for now
// These tests would need to be rewritten to work with Bun's test runner
// For now, the commandProcessor tests demonstrate our testing approach

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

import {
  AIService,
  prepareProviderRequestMessages,
  resolveMuxProjectRootForHostFs,
} from "./aiService";
import { discoverAvailableSubagentsForToolContext } from "./streamContextBuilder";
import {
  normalizeAnthropicBaseURL,
  buildAppAttributionHeaders,
  type ProviderModelFactory,
} from "./providerModelFactory";
import { HistoryService } from "./historyService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import { createTaskTool } from "./tools/task";
import { createTestToolConfig } from "./tools/testHelpers";
import { MUX_APP_ATTRIBUTION_TITLE, MUX_APP_ATTRIBUTION_URL } from "@/constants/appAttribution";
import type { ProviderName } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { CODEX_ENDPOINT } from "@/common/constants/codexOAuth";

import { addInterruptedSentinel } from "@/browser/utils/messages/modelMessageTransform";
import { buildWorkflowRunCardMessage } from "@/common/utils/workflowRunMessages";
import type { LanguageModel, Tool } from "ai";
import { createMuxMessage } from "@/common/types/message";
import type { ModelMessage, MuxMessage } from "@/common/types/message";
import type { MuxToolScope } from "@/common/types/toolScope";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { uniqueSuffix } from "@/common/utils/hasher";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type {
  ErrorEvent,
  RuntimeStatusEvent,
  StreamAbortEvent,
  StreamEndEvent,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";
import { log } from "./log";
import type { SessionUsageService } from "./sessionUsageService";
import type { ModelFallbackOptions, StreamManager } from "./streamManager";
import type {
  ActiveTurnThinkingOverride,
  RebuildProviderOptionsForThinkingLevel,
} from "./thinkingOverride";
import { ExperimentsService } from "./experimentsService";
import type { DevToolsService } from "./devToolsService";
import { TelemetryService } from "@/node/services/telemetryService";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import * as agentResolution from "./agentResolution";
import * as streamContextBuilder from "./streamContextBuilder";
import * as messagePipeline from "./messagePipeline";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService, projectMemoryDirName } from "@/node/services/memoryService";
import * as toolAssembly from "./toolAssembly";
import type { ToolModelUsageEvent } from "@/common/utils/tools/tools";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import * as toolsModule from "@/common/utils/tools/tools";
import * as providerOptionsModule from "@/common/utils/ai/providerOptions";
import * as systemMessageModule from "./systemMessage";

interface BasicAIServiceParts {
  config: Config;
  historyService: HistoryService;
  initStateManager: InitStateManager;
  providerService: ProviderService;
  service: AIService;
}

type GeneratePrompt = Array<{
  role: "system" | "user";
  content: string | Array<{ type: "text"; text: string }>;
}>;

type RecordingFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Promise<Response>;

interface RecordedFetchRequest {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
}

const TEST_CODEX_OAUTH = {
  type: "oauth" as const,
  access: "test-access-token",
  refresh: "test-refresh-token",
  expires: Date.now() + 60_000,
  accountId: "test-account-id",
};

function createBasicAIService(
  root?: string,
  options?: {
    sessionUsageService?: SessionUsageService;
    devToolsService?: DevToolsService;
    experimentsService?: ExperimentsService;
  }
): BasicAIServiceParts {
  const config = new Config(root);
  const historyService = new HistoryService(config);
  const initStateManager = new InitStateManager(config);
  const providerService = new ProviderService(config);
  const service = new AIService(
    config,
    historyService,
    initStateManager,
    providerService,
    undefined,
    options?.sessionUsageService,
    undefined,
    undefined,
    undefined,
    options?.devToolsService,
    undefined,
    options?.experimentsService
  );
  return { config, historyService, initStateManager, providerService, service };
}

async function writeMainConfig(root: string, config: object): Promise<void> {
  await fs.writeFile(
    path.join(root, "config.json"),
    JSON.stringify({ projects: [], ...config }, null, 2),
    "utf-8"
  );
}

async function writeProvidersConfig(root: string, config: object): Promise<void> {
  await fs.writeFile(path.join(root, "providers.jsonc"), JSON.stringify(config, null, 2), "utf-8");
}

function toGatewayModelString(modelString: string): string {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex === -1 ? modelString : modelString.slice(0, colonIndex);
  const modelId = colonIndex === -1 ? "" : modelString.slice(colonIndex + 1);
  return `mux-gateway:${provider}/${modelId}`;
}

function createRecordingOpenAIFetch(
  requests: RecordedFetchRequest[],
  model = "gpt-5.2"
): RecordingFetch {
  return (input, init) => {
    requests.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "resp_test",
          created_at: 0,
          model,
          output: [
            {
              type: "message",
              role: "assistant",
              id: "msg_test",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  };
}

function configureOpenAICodexOAuth(
  service: AIService,
  config: Config,
  requests: RecordedFetchRequest[],
  options?: { defaultAuth?: "apiKey"; responseModel?: string; setOauthService?: boolean }
): void {
  config.loadProvidersConfig = () => ({
    openai: {
      apiKey: "test-openai-api-key",
      codexOauth: TEST_CODEX_OAUTH,
      ...(options?.defaultAuth ? { codexOauthDefaultAuth: options.defaultAuth } : {}),
      fetch: createRecordingOpenAIFetch(requests, options?.responseModel),
    },
  });

  if (options?.setOauthService !== false) {
    service.setCodexOauthService({
      getValidAuth: () => Promise.resolve({ success: true, data: TEST_CODEX_OAUTH }),
    } as CodexOauthService);
  }
}

async function createGeneratedModel(
  service: AIService,
  modelString: string,
  prompt: GeneratePrompt
): Promise<void> {
  const modelResult = await service.createModel(modelString);
  expect(modelResult.success).toBe(true);
  if (!modelResult.success) return;

  const model = modelResult.data;
  if (typeof model === "string") {
    throw new Error("Expected a LanguageModelV2 instance, got a model id string");
  }

  const generateModel = model as unknown as {
    doGenerate: (args: { prompt: GeneratePrompt }) => Promise<unknown>;
  };
  await generateModel.doGenerate({ prompt });
}

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    const possibleUrl = (input as { url?: unknown }).url;
    if (typeof possibleUrl === "string") return possibleUrl;
  }
  return "";
}

function createLocalWorkspaceMetadata(
  workspaceId: string,
  projectPath: string,
  overrides?: Partial<WorkspaceMetadata>
): WorkspaceMetadata {
  return {
    id: workspaceId,
    name: "workspace-under-test",
    projectName: "project-under-test",
    projectPath,
    runtimeConfig: { type: "local" },
    ...overrides,
  };
}

function resolvedAgentResultFor(
  metadata: WorkspaceMetadata
): Awaited<ReturnType<typeof agentResolution.resolveAgentForStream>> {
  return {
    success: true,
    data: {
      effectiveAgentId: "exec",
      agentDefinition: {
        id: "exec",
        scope: "built-in",
        frontmatter: { name: "Exec" },
        body: "Exec agent body",
      },
      agentDiscoveryRuntime: new LocalRuntime(metadata.projectPath),
      agentDiscoveryPath: metadata.projectPath,
      isSubagentWorkspace: false,
      agentInheritanceChain: [{ id: "exec", tools: { add: [".*"] } }],
      agentIsPlanLike: false,
      effectiveMode: "exec",
      taskSettings: DEFAULT_TASK_SETTINGS,
      taskDepth: 0,
      shouldDisableTaskToolsForDepth: false,
      effectiveToolPolicy: undefined,
    },
  };
}

function providerNameFromModelString(modelString: string): ProviderName {
  return modelString.startsWith("anthropic:") ? "anthropic" : "openai";
}

function modelIdFromModelString(modelString: string): string {
  return modelString.includes(":") ? (modelString.split(":").at(1) ?? modelString) : modelString;
}

function stubCommonStreamMessageDependencies(args: {
  service: AIService;
  config: Config;
  historyService: HistoryService;
  initStateManager: InitStateManager;
  metadata: WorkspaceMetadata;
  startStreamCalls?: unknown[][];
  routeProvider?: ProviderName;
  allTools?: Record<string, Tool>;
  workspacePathOverride?: string;
  historySequence?: number;
  effectiveModelString?: string;
  canonicalProviderName?: ProviderName;
  canonicalModelId?: string;
  useRequestedModelString?: boolean;
  onPlanPayloadMessageIds?: (messageIds: string[]) => void;
  onBuildStreamSystemContext?: (
    args: Parameters<typeof streamContextBuilder.buildStreamSystemContext>[0]
  ) => void;
  onPrepareMessagesForProvider?: (
    args: Parameters<typeof messagePipeline.prepareMessagesForProvider>[0]
  ) => void;
}): ReturnType<typeof spyOn<typeof toolsModule, "getToolsForModel">> {
  spyOn(agentResolution, "resolveAgentForStream").mockResolvedValue(
    resolvedAgentResultFor(args.metadata)
  );
  spyOn(streamContextBuilder, "buildPlanInstructions").mockImplementation((planArgs) => {
    args.onPlanPayloadMessageIds?.(planArgs.requestPayloadMessages.map((message) => message.id));
    return Promise.resolve({
      effectiveAdditionalInstructions: undefined,
      planFilePath: path.join(args.metadata.projectPath, "plan.md"),
      planContentForTransition: undefined,
    });
  });
  spyOn(streamContextBuilder, "buildStreamSystemContext").mockImplementation((contextArgs) => {
    args.onBuildStreamSystemContext?.(contextArgs);
    return Promise.resolve({
      agentSystemPromptSections: ["test-agent-prompt"],
      systemMessage: "test-system-message",
      systemMessageTokens: 1,
      agentDefinitions: undefined,
      availableSkills: undefined,
      ancestorPlanFilePaths: [],
    });
  });
  spyOn(messagePipeline, "prepareMessagesForProvider").mockImplementation((pipelineArgs) => {
    args.onPrepareMessagesForProvider?.(pipelineArgs);
    return Promise.resolve(
      pipelineArgs.messagesWithSentinel as unknown as Awaited<
        ReturnType<typeof messagePipeline.prepareMessagesForProvider>
      >
    );
  });
  const getToolsForModelSpy = spyOn(toolsModule, "getToolsForModel").mockResolvedValue(
    args.allTools ?? {}
  );
  spyOn(systemMessageModule, "readToolInstructions").mockResolvedValue({});

  const providerModelFactory = Reflect.get(args.service, "providerModelFactory") as
    | ProviderModelFactory
    | undefined;
  if (!providerModelFactory) {
    throw new Error("Expected AIService.providerModelFactory in streamMessage test harness");
  }
  spyOn(providerModelFactory, "resolveAndCreateModel").mockImplementation(
    (requestedModelString) => {
      const canonicalModelString = args.useRequestedModelString
        ? requestedModelString
        : (args.effectiveModelString ?? "openai:gpt-5.2");
      return Promise.resolve({
        success: true,
        data: {
          model: Object.create(null) as LanguageModel,
          effectiveModelString: canonicalModelString,
          canonicalModelString,
          canonicalProviderName:
            args.canonicalProviderName ?? providerNameFromModelString(canonicalModelString),
          canonicalModelId: args.canonicalModelId ?? modelIdFromModelString(canonicalModelString),
          routedThroughGateway: false,
          ...(args.routeProvider != null ? { routeProvider: args.routeProvider } : {}),
        },
      });
    }
  );
  spyOn(args.service, "getWorkspaceMetadata").mockResolvedValue({
    success: true,
    data: args.metadata,
  });
  spyOn(args.initStateManager, "waitForInit").mockResolvedValue(undefined);
  spyOn(args.config, "findWorkspace").mockReturnValue({
    workspacePath: args.workspacePathOverride ?? args.metadata.projectPath,
    projectPath: args.metadata.projectPath,
  });
  spyOn(args.historyService, "commitPartial").mockResolvedValue({ success: true, data: undefined });
  spyOn(args.historyService, "appendToHistory").mockImplementation((_workspaceId, message) => {
    message.metadata = { ...(message.metadata ?? {}), historySequence: args.historySequence ?? 7 };
    return Promise.resolve({ success: true, data: undefined });
  });

  const streamManager = (args.service as unknown as { streamManager: StreamManager }).streamManager;
  const streamToken = "stream-token" as ReturnType<StreamManager["generateStreamToken"]>;
  spyOn(streamManager, "generateStreamToken").mockReturnValue(streamToken);
  spyOn(streamManager, "createTempDirForStream").mockResolvedValue(
    path.join(args.metadata.projectPath, ".tmp-stream")
  );
  spyOn(streamManager, "isResponseIdLost").mockReturnValue(false);
  if (args.startStreamCalls) {
    spyOn(streamManager, "startStream").mockImplementation((...startArgs: unknown[]) => {
      args.startStreamCalls?.push(startArgs);
      return Promise.resolve({ success: true, data: streamToken });
    });
  } else {
    spyOn(streamManager, "startStream").mockResolvedValue({ success: true, data: streamToken });
  }

  return getToolsForModelSpy;
}

describe("prepareProviderRequestMessages", () => {
  it("slices at reset boundaries before filtering empty assistant messages", () => {
    const oldMessage = createMuxMessage("old-user", "user", "old context", {
      historySequence: 1,
    });
    const resetBoundary = createMuxMessage("reset-boundary", "assistant", "", {
      historySequence: 2,
      contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
    });
    const newMessage = createMuxMessage("new-user", "user", "new context", {
      historySequence: 3,
    });

    const result = prepareProviderRequestMessages(
      [oldMessage, resetBoundary, newMessage],
      "openai",
      "off"
    );

    expect(result.activeContextMessages.map((message) => message.id)).toEqual(["new-user"]);
    expect(result.providerRequestMessages.map((message) => message.id)).toEqual(["new-user"]);
  });

  it("filters /btw side-question rows out of provider-bound context", () => {
    const mainUser = createMuxMessage("main-user", "user", "normal follow-up", {
      historySequence: 1,
    });
    const sideQuestion = createMuxMessage("btw-user", "user", "what is 1+1?", {
      historySequence: 2,
      muxMetadata: {
        type: "side-question",
        rawCommand: "/btw what is 1+1?",
        commandPrefix: "/btw",
      },
    });
    const sideAnswer = createMuxMessage("btw-answer", "assistant", "2", {
      historySequence: 3,
      muxMetadata: { type: "side-question-answer" },
    });
    const nextUser = createMuxMessage("next-user", "user", "continue normal work", {
      historySequence: 4,
    });

    const result = prepareProviderRequestMessages(
      [mainUser, sideQuestion, sideAnswer, nextUser],
      "openai",
      "off"
    );

    expect(result.activeContextMessages.map((message) => message.id)).toEqual([
      "main-user",
      "next-user",
    ]);
    expect(result.providerRequestMessages.map((message) => message.id)).toEqual([
      "main-user",
      "next-user",
    ]);
  });

  it("filters workflow display rows while keeping provider-visible workflow results", () => {
    const trigger = createMuxMessage("workflow-command", "user", "/shallow-review mux", {
      historySequence: 1,
      muxMetadata: {
        type: "workflow-trigger-display",
        rawCommand: "/shallow-review mux",
        commandPrefix: "/shallow-review",
        runId: "wfr_1",
      },
    });
    const card = buildWorkflowRunCardMessage(
      { name: "shallow-review", args: { input: "mux" } },
      { runId: "wfr_1", status: "running", result: null },
      2
    );
    card.metadata = {
      historySequence: 2,
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "workflow-run-card-display", runId: "wfr_1" },
    };
    const result = createMuxMessage(
      "workflow-result",
      "user",
      "/shallow-review mux\n\n<mux_workflow_result>{}</mux_workflow_result>",
      {
        historySequence: 3,
        muxMetadata: {
          type: "workflow-result",
          rawCommand: "/shallow-review mux",
          commandPrefix: "/shallow-review",
          runId: "wfr_1",
        },
      }
    );
    const nextUser = createMuxMessage("next-user", "user", "continue normal work", {
      historySequence: 4,
    });

    const prepared = prepareProviderRequestMessages(
      [trigger, card, result, nextUser],
      "openai",
      "off"
    );

    expect(prepared.activeContextMessages.map((message) => message.id)).toEqual([
      "workflow-result",
      "next-user",
    ]);
    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "workflow-result",
      "next-user",
    ]);
  });
});

describe("AIService", () => {
  let service: AIService;

  beforeEach(() => {
    service = createBasicAIService().service;
  });

  // Note: These tests are placeholders as Bun doesn't support Jest mocking
  // In a production environment, we'd use dependency injection or other patterns
  // to make the code more testable without mocking

  it("should create an AIService instance", () => {
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(AIService);
  });
});

describe("resolveMuxProjectRootForHostFs", () => {
  const projectPath = "/home/user/projects/my-app";
  const workspacePath = "/home/user/.mux/src/my-app/feature-branch";

  function createMetadata(runtimeConfig: WorkspaceMetadata["runtimeConfig"]): WorkspaceMetadata {
    return {
      id: "workspace-id",
      name: "feature-branch",
      projectName: "my-app",
      projectPath,
      runtimeConfig,
    };
  }

  it("returns workspacePath for local runtime", () => {
    expect(resolveMuxProjectRootForHostFs(createMetadata({ type: "local" }), workspacePath)).toBe(
      workspacePath
    );
  });

  it("returns workspacePath for worktree runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({ type: "worktree", srcBaseDir: "/home/user/.mux/src" }),
        workspacePath
      )
    ).toBe(workspacePath);
  });

  it("returns workspacePath for devcontainer runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({ type: "devcontainer", configPath: ".devcontainer/devcontainer.json" }),
        workspacePath
      )
    ).toBe(workspacePath);
  });

  it("returns projectPath for ssh runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({
          type: "ssh",
          host: "remote",
          srcBaseDir: "/home/remote/.mux/src",
        }),
        "/remote/workspace/path"
      )
    ).toBe(projectPath);
  });

  it("returns projectPath for docker runtime", () => {
    expect(
      resolveMuxProjectRootForHostFs(
        createMetadata({ type: "docker", image: "ubuntu:22.04" }),
        "/src"
      )
    ).toBe(projectPath);
  });
});

describe("AIService.setupStreamEventForwarding", () => {
  interface ForwardingInternals {
    streamManager: StreamManager;
    pendingDevToolsRunMetadataByMessageId: Map<string, { workspaceId: string; metadataId: string }>;
  }

  function createForwardingHarness(tempDirName: string): {
    historyService: HistoryService;
    service: AIService;
    internals: ForwardingInternals;
    clearPendingRunMetadataSpy: ReturnType<typeof mock>;
    [Symbol.dispose]: () => void;
  } {
    const muxHome = new DisposableTempDir(tempDirName);
    const clearPendingRunMetadataSpy = mock(
      (_workspaceId: string, _metadataId?: string) => undefined
    );
    const devToolsService = {
      enabled: true,
      clearPendingRunMetadata: clearPendingRunMetadataSpy,
    } as unknown as DevToolsService;
    const { historyService, service } = createBasicAIService(muxHome.path, { devToolsService });
    return {
      historyService,
      service,
      internals: service as unknown as ForwardingInternals,
      clearPendingRunMetadataSpy,
      [Symbol.dispose]: () => muxHome[Symbol.dispose](),
    };
  }

  afterEach(() => {
    mock.restore();
  });

  it("forwards stream-abort even when partial cleanup throws", async () => {
    using harness = createForwardingHarness("ai-service-stream-abort-forwarding");
    const { historyService, service, internals, clearPendingRunMetadataSpy } = harness;
    const cleanupError = new Error("disk full");
    const deletePartialSpy = spyOn(historyService, "deletePartial").mockImplementation(() =>
      Promise.reject(cleanupError)
    );
    const abortEvent: StreamAbortEvent = {
      type: "stream-abort",
      workspaceId: "workspace-1",
      messageId: "message-1",
      abandonPartial: true,
    };
    internals.pendingDevToolsRunMetadataByMessageId.set(abortEvent.messageId, {
      workspaceId: abortEvent.workspaceId,
      metadataId: "metadata-1",
    });

    const forwardedAbortPromise = new Promise<StreamAbortEvent>((resolve) => {
      service.once("stream-abort", (event) => resolve(event as StreamAbortEvent));
    });
    internals.streamManager.emit("stream-abort", abortEvent);

    expect(await forwardedAbortPromise).toEqual(abortEvent);
    expect(deletePartialSpy).toHaveBeenCalledWith(abortEvent.workspaceId);
    expect(clearPendingRunMetadataSpy).toHaveBeenCalledWith(abortEvent.workspaceId, "metadata-1");
    expect(internals.pendingDevToolsRunMetadataByMessageId.has(abortEvent.messageId)).toBe(false);
  });

  it("forwards stream-abort with empty messageId without throwing", async () => {
    using harness = createForwardingHarness("ai-service-stream-abort-empty-message-id");
    const { service, internals, clearPendingRunMetadataSpy } = harness;
    internals.pendingDevToolsRunMetadataByMessageId.set("message-1", {
      workspaceId: "workspace-1",
      metadataId: "metadata-1",
    });
    const abortEvent: StreamAbortEvent = {
      type: "stream-abort",
      workspaceId: "workspace-1",
      messageId: "",
      abandonPartial: true,
    };

    const forwardedAbortPromise = new Promise<StreamAbortEvent>((resolve) => {
      service.once("stream-abort", (event) => resolve(event as StreamAbortEvent));
    });
    internals.streamManager.emit("stream-abort", abortEvent);

    expect(await forwardedAbortPromise).toEqual(abortEvent);
    expect(clearPendingRunMetadataSpy).not.toHaveBeenCalled();
    expect(internals.pendingDevToolsRunMetadataByMessageId.has("message-1")).toBe(true);
  });

  it("forwards workflow-run-attached events", async () => {
    using harness = createForwardingHarness("ai-service-workflow-run-attached-forwarding");
    const { service, internals } = harness;
    const event: WorkflowRunAttachedEvent = {
      type: "workflow-run-attached",
      workspaceId: "workspace-1",
      messageId: "message-1",
      toolCallId: "workflow-call-1",
      runId: "wfr_forwarded",
      timestamp: Date.now(),
    };

    const forwardedPromise = new Promise<WorkflowRunAttachedEvent>((resolve) => {
      service.once("workflow-run-attached", (forwarded) =>
        resolve(forwarded as WorkflowRunAttachedEvent)
      );
    });
    internals.streamManager.emit("workflow-run-attached", event);

    expect(await forwardedPromise).toEqual(event);
  });

  it.each([
    {
      name: "stream error",
      eventName: "error" as const,
      event: {
        type: "error" as const,
        workspaceId: "workspace-1",
        messageId: "message-1",
        error: "request failed",
        errorType: "rate_limit" as const,
      } satisfies ErrorEvent,
    },
    {
      name: "stream-end",
      eventName: "stream-end" as const,
      event: {
        type: "stream-end" as const,
        workspaceId: "workspace-1",
        messageId: "message-1",
        metadata: { model: "anthropic:claude-opus-4-1" },
        parts: [],
      } satisfies StreamEndEvent,
    },
  ])("clears tracked devtools run metadata on $name", async ({ eventName, event }) => {
    using harness = createForwardingHarness(`ai-service-${eventName}-devtools-cleanup`);
    const { service, internals, clearPendingRunMetadataSpy } = harness;
    internals.pendingDevToolsRunMetadataByMessageId.set(event.messageId, {
      workspaceId: event.workspaceId,
      metadataId: "metadata-1",
    });

    const forwardedPromise = new Promise<typeof event>((resolve) => {
      service.once(eventName, (forwarded) => resolve(forwarded as typeof event));
    });
    internals.streamManager.emit(eventName, event);

    expect(await forwardedPromise).toEqual(event);
    expect(clearPendingRunMetadataSpy).toHaveBeenCalledWith(event.workspaceId, "metadata-1");
    expect(internals.pendingDevToolsRunMetadataByMessageId.has(event.messageId)).toBe(false);
  });
});

describe("AIService.resolveGatewayModelString", () => {
  it("routes allowlisted models when gateway is enabled + configured", async () => {
    using muxHome = new DisposableTempDir("gateway-routing");

    await writeMainConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.SONNET.id],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(muxHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(toGatewayModelString(KNOWN_MODELS.SONNET.id));
  });

  it("does not route when the mux-gateway provider is disabled", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-provider-disabled");

    await writeMainConfig(muxHome.path, {
      routePriority: ["mux-gateway", "direct"],
    });
    await writeProvidersConfig(muxHome.path, {
      anthropic: { apiKey: "sk-ant-test" },
      "mux-gateway": {
        couponCode: "test-coupon",
        enabled: false,
      },
    });

    const service = createBasicAIService(muxHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(KNOWN_MODELS.SONNET.id);
  });

  it("does not route when gateway is not configured", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-unconfigured");

    await writeMainConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.SONNET.id],
    });

    const service = createBasicAIService(muxHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(KNOWN_MODELS.SONNET.id);

    expect(resolved).toBe(KNOWN_MODELS.SONNET.id);
  });

  it("does not route unsupported providers even when allowlisted", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-unsupported-provider");

    const modelString = "openrouter:some-model";
    await writeMainConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [modelString],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(muxHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(modelString);

    expect(resolved).toBe(modelString);
  });

  it("routes model variants when the base model is allowlisted via modelKey", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-model-key");

    const variant = "xai:grok-4-1-fast-reasoning";
    await writeMainConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [KNOWN_MODELS.GROK_4_1.id],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(muxHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(
      variant,
      KNOWN_MODELS.GROK_4_1.id
    );

    expect(resolved).toBe(toGatewayModelString(variant));
  });

  it("honors explicit mux-gateway prefixes from legacy clients", async () => {
    using muxHome = new DisposableTempDir("gateway-routing-explicit");

    await writeMainConfig(muxHome.path, {
      muxGatewayEnabled: true,
      muxGatewayModels: [],
    });
    await writeProvidersConfig(muxHome.path, {
      "mux-gateway": { couponCode: "test-coupon" },
    });

    const service = createBasicAIService(muxHome.path).service;

    // @ts-expect-error - accessing private field for testing
    const resolved = service.providerModelFactory.resolveGatewayModelString(
      KNOWN_MODELS.GPT.id,
      undefined,
      true
    );

    expect(resolved).toBe(toGatewayModelString(KNOWN_MODELS.GPT.id));
  });
});

describe("AIService.createModel (Codex OAuth routing)", () => {
  it("returns oauth_not_connected for required Codex models when both OAuth and API key are missing", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-missing");

    await writeProvidersConfig(muxHome.path, {
      openai: {},
    });

    // Temporarily clear OPENAI_API_KEY so resolveProviderCredentials doesn't find it
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = createBasicAIService(muxHome.path).service;
      const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX_SPARK.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({ type: "oauth_not_connected", provider: "openai" });
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("returns api_key_not_found for released gpt-5.3-codex when OAuth and API key are missing", async () => {
    using muxHome = new DisposableTempDir("codex-api-model-missing-auth");

    await writeProvidersConfig(muxHome.path, {
      openai: {},
    });

    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = createBasicAIService(muxHome.path).service;
      const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({ type: "api_key_not_found", provider: "openai" });
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("returns api_key_not_found for gpt-5.5 when OAuth and API key are missing", async () => {
    using muxHome = new DisposableTempDir("codex-gpt-5-5-missing-auth");

    await writeProvidersConfig(muxHome.path, {
      openai: {},
    });

    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = createBasicAIService(muxHome.path).service;
      const result = await service.createModel(KNOWN_MODELS.GPT.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({ type: "api_key_not_found", provider: "openai" });
      }
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("falls back to API key for required Codex models when OAuth is missing but API key is present", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-missing-apikey-present");

    await writeProvidersConfig(muxHome.path, {
      openai: { apiKey: "sk-test-key" },
    });

    const service = createBasicAIService(muxHome.path).service;
    const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX_SPARK.id);

    // Should succeed — falls back to API key instead of erroring with oauth_not_connected
    expect(result.success).toBe(true);
  });

  it("does not require an OpenAI API key when Codex OAuth is configured", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-present");

    await writeProvidersConfig(muxHome.path, {
      openai: {
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "test-account-id",
        },
      },
    });

    const service = createBasicAIService(muxHome.path).service;
    const result = await service.createModel(KNOWN_MODELS.GPT_53_CODEX_SPARK.id);

    expect(result.success).toBe(true);
  });

  it.each([
    {
      name: "defaults OAuth-allowed models to ChatGPT OAuth when both auth methods are configured",
      tempDirName: "codex-oauth-default-auth-oauth",
      defaultAuth: undefined,
      endpointMatcher: (url: string) => expect(url).toBe(CODEX_ENDPOINT),
    },
    {
      name: "does not rewrite OAuth-allowed models when default auth is set to apiKey",
      tempDirName: "codex-oauth-default-auth-api-key",
      defaultAuth: "apiKey" as const,
      endpointMatcher: (url: string) => expect(url).not.toBe(CODEX_ENDPOINT),
    },
  ])("$name", async ({ tempDirName, defaultAuth, endpointMatcher }) => {
    using muxHome = new DisposableTempDir(tempDirName);
    const { config, service } = createBasicAIService(muxHome.path);
    const requests: RecordedFetchRequest[] = [];
    configureOpenAICodexOAuth(service, config, requests, { defaultAuth });

    await createGeneratedModel(service, KNOWN_MODELS.GPT.id, [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(requests.length).toBeGreaterThan(0);
    const lastRequest = requests[requests.length - 1];
    endpointMatcher(getFetchUrl(lastRequest.input));
  });

  it("ensures Codex OAuth routed Responses requests include non-empty instructions", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-instructions");
    const { config, service } = createBasicAIService(muxHome.path);
    const requests: RecordedFetchRequest[] = [];
    configureOpenAICodexOAuth(service, config, requests, { responseModel: "gpt-5.3-codex" });
    const systemPrompt = "Test system prompt";

    await createGeneratedModel(service, KNOWN_MODELS.GPT_53_CODEX.id, [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(requests.length).toBeGreaterThan(0);

    const lastRequest = requests[requests.length - 1];

    // URL rewrite to chatgpt.com
    expect(lastRequest.input).toBe(CODEX_ENDPOINT);

    // Auth header injection
    const headers = new Headers(lastRequest.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-access-token");
    expect(headers.get("chatgpt-account-id")).toBe("test-account-id");

    // Body mutation: non-empty instructions
    const bodyString = lastRequest.init?.body;
    expect(typeof bodyString).toBe("string");
    if (typeof bodyString !== "string") {
      throw new Error("Expected request body to be a string");
    }

    const parsedBody = JSON.parse(bodyString) as unknown;
    if (!parsedBody || typeof parsedBody !== "object") {
      throw new Error("Expected request body to parse as an object");
    }

    const instructions = (parsedBody as { instructions?: unknown }).instructions;
    expect(typeof instructions).toBe("string");
    if (typeof instructions !== "string") {
      throw new Error("Expected instructions to be a string");
    }

    expect(instructions.trim().length).toBeGreaterThan(0);
    expect(instructions).toBe(systemPrompt);

    // Codex endpoint requires store=false
    const store = (parsedBody as { store?: unknown }).store;
    expect(store).toBe(false);

    // System message should be removed from input to avoid double-system
    const input = (parsedBody as { input?: unknown[] }).input;
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === "object" && "role" in item) {
          expect((item as { role: string }).role).not.toBe("system");
          expect((item as { role: string }).role).not.toBe("developer");
        }
      }
    }
  });

  it("filters out item_reference entries and preserves inline items when routing through Codex OAuth", async () => {
    using muxHome = new DisposableTempDir("codex-oauth-filter-refs");
    const { config, service } = createBasicAIService(muxHome.path);
    const requests: RecordedFetchRequest[] = [];
    configureOpenAICodexOAuth(service, config, requests, { responseModel: "gpt-5.3-codex" });

    await createGeneratedModel(service, KNOWN_MODELS.GPT_53_CODEX.id, [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(requests.length).toBeGreaterThan(0);

    const lastRequest = requests[requests.length - 1];
    const bodyString = lastRequest.init?.body;
    expect(typeof bodyString).toBe("string");
    if (typeof bodyString !== "string") {
      throw new Error("Expected request body to be a string");
    }

    const parsedBody = JSON.parse(bodyString) as { store?: boolean; input?: unknown[] };

    // Verify Codex transform ran (store=false is set)
    expect(parsedBody.store).toBe(false);

    // Verify no item_reference entries exist in output
    const input = parsedBody.input;
    expect(Array.isArray(input)).toBe(true);
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === "object" && item !== null) {
          expect((item as Record<string, unknown>).type).not.toBe("item_reference");
        }
      }
    }
  });

  it("item_reference filter removes references and preserves inline items", () => {
    // Direct unit test of the item_reference filtering logic used in the
    // Codex body transformation, independent of the full AIService pipeline.
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "item_reference", id: "rs_abc123" },
      {
        type: "message",
        role: "assistant",
        id: "msg_001",
        content: [{ type: "output_text", text: "hi" }],
      },
      {
        type: "function_call",
        id: "fc_xyz",
        call_id: "call_1",
        name: "test_fn",
        arguments: "{}",
      },
      { type: "item_reference", id: "rs_def456" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ];

    // Same filter logic as in aiService.ts Codex body transformation
    const filtered = input.filter(
      (item) => !(item && typeof item === "object" && item.type === "item_reference")
    );

    // Both item_reference entries removed
    expect(filtered).toHaveLength(4);
    expect(filtered.some((i) => i.type === "item_reference")).toBe(false);

    // Inline items preserved with their IDs intact
    expect(filtered.find((i) => i.role === "assistant")?.id).toBe("msg_001");
    expect(filtered.find((i) => i.type === "function_call")?.id).toBe("fc_xyz");
    expect(filtered.find((i) => i.type === "function_call_output")?.call_id).toBe("call_1");
    expect(filtered.find((i) => i.role === "user")).toBeDefined();
  });
});

describe("AIService.streamMessage compaction boundary slicing", () => {
  interface StreamMessageHarness {
    config: Config;
    service: AIService;
    planPayloadMessageIds: string[][];
    preparedPayloadMessageIds: string[][];
    preparedToolNamesForSentinel: string[][];
    streamSystemContextMuxScopes: MuxToolScope[];
    streamSystemContextAdvisorFlags: Array<boolean | undefined>;
    streamSystemContextMemoryToolFlags: Array<boolean | undefined>;
    streamSystemContextHotMemoriesBlocks: Array<string | undefined>;
    startStreamCalls: unknown[][];
    getToolsForModelSpy: ReturnType<typeof spyOn<typeof toolsModule, "getToolsForModel">>;
  }

  function messageIdsFromUnknownArray(messages: unknown): string[] {
    if (!Array.isArray(messages)) {
      throw new Error("Expected message array");
    }

    return messages.map((message) => {
      if (!message || typeof message !== "object") {
        throw new Error("Expected message object in array");
      }

      const id = (message as { id?: unknown }).id;
      if (typeof id !== "string") {
        throw new Error("Expected message.id to be a string");
      }

      return id;
    });
  }

  function openAIOptionsFromStartStreamCall(startStreamArgs: unknown[]): Record<string, unknown> {
    const providerOptions = startStreamArgs[11];
    if (!providerOptions || typeof providerOptions !== "object") {
      throw new Error("Expected provider options object at startStream arg index 11");
    }

    const openai = (providerOptions as { openai?: unknown }).openai;
    if (!openai || typeof openai !== "object") {
      throw new Error("Expected OpenAI provider options in startStream providerOptions");
    }

    return openai as Record<string, unknown>;
  }

  function initialMetadataFromStartStreamCall(startStreamArgs: unknown[]): Record<string, unknown> {
    const initialMetadata = startStreamArgs[10];
    if (!initialMetadata || typeof initialMetadata !== "object" || Array.isArray(initialMetadata)) {
      throw new Error("Expected initial metadata object at startStream arg index 10");
    }

    return initialMetadata as Record<string, unknown>;
  }

  function createHarness(
    muxHomePath: string,
    metadata: WorkspaceMetadata,
    options?: {
      routeProvider?: ProviderName;
      allTools?: Record<string, Tool>;
      postPolicyTools?: Record<string, Tool>;
      sessionUsageService?: SessionUsageService;
      effectiveModelString?: string;
      canonicalProviderName?: ProviderName;
      canonicalModelId?: string;
      useRequestedModelString?: boolean;
      experimentsService?: ExperimentsService;
    }
  ): StreamMessageHarness {
    const { config, historyService, initStateManager, service } = createBasicAIService(
      muxHomePath,
      {
        sessionUsageService: options?.sessionUsageService,
        experimentsService: options?.experimentsService,
      }
    );
    const planPayloadMessageIds: string[][] = [];
    const preparedPayloadMessageIds: string[][] = [];
    const preparedToolNamesForSentinel: string[][] = [];
    const streamSystemContextMuxScopes: MuxToolScope[] = [];
    const streamSystemContextAdvisorFlags: Array<boolean | undefined> = [];
    const streamSystemContextMemoryToolFlags: Array<boolean | undefined> = [];
    const streamSystemContextHotMemoriesBlocks: Array<string | undefined> = [];
    const startStreamCalls: unknown[][] = [];

    const getToolsForModelSpy = stubCommonStreamMessageDependencies({
      service,
      config,
      historyService,
      initStateManager,
      metadata,
      startStreamCalls,
      routeProvider: options?.routeProvider,
      allTools: options?.allTools,
      effectiveModelString: options?.effectiveModelString,
      canonicalProviderName: options?.canonicalProviderName,
      canonicalModelId: options?.canonicalModelId,
      useRequestedModelString: options?.useRequestedModelString,
      onPlanPayloadMessageIds: (messageIds) => planPayloadMessageIds.push(messageIds),
      onBuildStreamSystemContext: (contextArgs) => {
        if (!contextArgs.muxScope) {
          throw new Error("Expected muxScope in stream system context build args");
        }
        streamSystemContextMuxScopes.push(contextArgs.muxScope);
        streamSystemContextAdvisorFlags.push(contextArgs.advisorToolAvailable);
        streamSystemContextMemoryToolFlags.push(contextArgs.memoryToolAvailable);
        streamSystemContextHotMemoriesBlocks.push(contextArgs.hotMemoriesBlock);
      },
      onPrepareMessagesForProvider: (pipelineArgs) => {
        preparedPayloadMessageIds.push(
          pipelineArgs.messagesWithSentinel.map((message) => message.id)
        );
        preparedToolNamesForSentinel.push(pipelineArgs.toolNamesForSentinel);
      },
    });
    if (options?.postPolicyTools) {
      spyOn(toolAssembly, "applyToolPolicyAndExperiments").mockResolvedValue(
        options.postPolicyTools
      );
    }

    return {
      config,
      service,
      planPayloadMessageIds,
      preparedPayloadMessageIds,
      preparedToolNamesForSentinel,
      streamSystemContextMuxScopes,
      streamSystemContextAdvisorFlags,
      streamSystemContextMemoryToolFlags,
      streamSystemContextHotMemoriesBlocks,
      startStreamCalls,
      getToolsForModelSpy,
    };
  }

  const START_STREAM_ON_CHUNK_INDEX = 21;
  const START_STREAM_ON_STEP_MESSAGES_INDEX = 22;
  const START_STREAM_RUNTIME_TEMP_DIR_INDEX = 23;

  const START_STREAM_MODEL_FALLBACK_INDEX = 24;

  interface AdvisorRuntimeForTests {
    createModel: (modelString: string) => Promise<LanguageModel>;
    takeToolCallSnapshot: (toolCallId: string) =>
      | {
          toolCallId: string;
          toolName: "advisor";
          input: Record<string, unknown>;
          stepText: string;
          stepReasoning: string;
        }
      | undefined;
  }

  type AdvisorOnChunk = (event: {
    chunk: {
      type: string;
      delta?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    };
  }) => PromiseLike<void> | void;

  async function enableAdvisorForHarness(
    harness: StreamMessageHarness,
    advisorModelString = KNOWN_MODELS.SONNET.id
  ): Promise<void> {
    const baseConfig = harness.config.loadConfigOrDefault();
    await harness.config.editConfig(() => ({
      ...baseConfig,
      advisorModelString,
      agentAiDefaults: {
        ...baseConfig.agentAiDefaults,
        exec: {
          ...baseConfig.agentAiDefaults?.exec,
          advisorEnabled: true,
        },
      },
    }));
  }

  async function startAdvisorStream(
    harness: StreamMessageHarness,
    workspaceId: string
  ): Promise<Awaited<ReturnType<AIService["streamMessage"]>>> {
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { advisorTool: true },
    });
    expect(result.success).toBe(true);
    return result;
  }

  function getToolConfigFromHarness(harness: StreamMessageHarness): Record<string, unknown> {
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }
    return toolConfig as unknown as Record<string, unknown>;
  }

  function getAdvisorRuntimeFromHarness(harness: StreamMessageHarness): AdvisorRuntimeForTests {
    const toolConfig = getToolConfigFromHarness(harness);
    const advisorRuntime = (toolConfig as { advisorRuntime?: AdvisorRuntimeForTests })
      .advisorRuntime;
    expect(advisorRuntime).toBeDefined();
    if (!advisorRuntime) {
      throw new Error("Expected advisorRuntime in tool configuration");
    }
    return advisorRuntime;
  }

  function getAdvisorCallbacksFromHarness(harness: StreamMessageHarness): {
    onChunk: AdvisorOnChunk;
    onStepMessages: (messages: ModelMessage[]) => void;
  } {
    expect(harness.startStreamCalls).toHaveLength(1);
    const startStreamCall = harness.startStreamCalls[0];
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const onChunk = startStreamCall[START_STREAM_ON_CHUNK_INDEX];
    const onStepMessages = startStreamCall[START_STREAM_ON_STEP_MESSAGES_INDEX];
    expect(typeof onChunk).toBe("function");
    expect(typeof onStepMessages).toBe("function");
    if (typeof onChunk !== "function" || typeof onStepMessages !== "function") {
      throw new Error("Expected advisor startStream callbacks");
    }

    return {
      onChunk: onChunk as AdvisorOnChunk,
      onStepMessages: onStepMessages as (messages: ModelMessage[]) => void,
    };
  }

  afterEach(() => {
    mock.restore();
  });

  it("keeps set_goal disabled for one-shot streams that do not opt into agent-created goals", async () => {
    using muxHome = new DisposableTempDir("ai-service-set-goal-disabled");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-set-goal-disabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    const goalService = {
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      workspaceGoalService: goalService,
    });

    expect(result.success).toBe(true);
    expect(getToolConfigFromHarness(harness).enableGoalTools).toMatchObject({
      setGoal: false,
    });
  });

  it("enables set_goal for parent streams that opt into agent-created goals", async () => {
    using muxHome = new DisposableTempDir("ai-service-set-goal-enabled");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-set-goal-enabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    const goalService = {
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      workspaceGoalService: goalService,
      allowAgentSetGoal: true,
    });

    expect(result.success).toBe(true);
    expect(getToolConfigFromHarness(harness).enableGoalTools).toMatchObject({
      setGoal: true,
    });
  });

  it("keeps set_goal disabled for child workspaces even when the host opts in", async () => {
    using muxHome = new DisposableTempDir("ai-service-set-goal-child-disabled");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-set-goal-child-disabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath, {
      parentWorkspaceId: "parent-workspace",
    });
    const harness = createHarness(muxHome.path, metadata);
    const goalService = {
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService;

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      workspaceGoalService: goalService,
      allowAgentSetGoal: true,
    });

    expect(result.success).toBe(true);
    expect(getToolConfigFromHarness(harness).enableGoalTools).toMatchObject({
      setGoal: false,
    });
  });

  it("prepares fallback continuation from partial assistant output with one sentinel", async () => {
    using muxHome = new DisposableTempDir("ai-service-fallback-continuation");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-fallback-continuation";
    const fallbackModel = KNOWN_MODELS.GPT.id;
    await writeMainConfig(muxHome.path, {
      modelFallbacks: {
        [KNOWN_MODELS.SONNET.id]: { models: [fallbackModel] },
      },
    });

    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata, {
      effectiveModelString: KNOWN_MODELS.SONNET.id,
      canonicalProviderName: "anthropic",
      canonicalModelId: "claude-sonnet-4-5",
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "fix the issue")],
      workspaceId,
      modelString: KNOWN_MODELS.SONNET.id,
      thinkingLevel: "off",
    });
    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const modelFallback = harness.startStreamCalls[0]?.[START_STREAM_MODEL_FALLBACK_INDEX] as
      | ModelFallbackOptions
      | undefined;
    expect(modelFallback).toBeDefined();
    if (!modelFallback) {
      throw new Error("Expected modelFallback options on startStream");
    }

    const continuationAssistant: MuxMessage = {
      id: "assistant-partial",
      role: "assistant",
      metadata: { partial: true, historySequence: 2 },
      parts: [
        { type: "text", text: "I checked the report." },
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "bash",
          state: "output-available",
          input: { script: "printf ok" },
          output: { success: true, output: "ok" },
        },
      ],
    };

    const prepared = await modelFallback.prepare(fallbackModel, {
      continuation: { assistantMessage: continuationAssistant },
    });
    expect(prepared.success).toBe(true);

    expect(harness.preparedPayloadMessageIds).toHaveLength(2);
    expect(harness.preparedPayloadMessageIds[1]).toEqual([
      "latest-user",
      "assistant-partial",
      "interrupted-assistant-partial",
    ]);
    expect(
      harness.preparedPayloadMessageIds[1]?.filter((id) => id === "interrupted-assistant-partial")
    ).toHaveLength(1);
  });

  it("prepares fallback system context with the fallback model's hot memories", async () => {
    using muxHome = new DisposableTempDir("ai-service-fallback-hot-memories");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-fallback-hot-memories";
    const sourceModel = KNOWN_MODELS.SONNET.id;
    const fallbackModel = KNOWN_MODELS.GPT.id;
    await writeMainConfig(muxHome.path, {
      modelFallbacks: {
        [sourceModel]: { models: [fallbackModel] },
      },
    });

    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(muxHome.path),
      muxHome: muxHome.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) =>
        experimentId === EXPERIMENT_IDS.MEMORY || experimentId === EXPERIMENT_IDS.MEMORY_HOT_SET
    );
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for memory availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(muxHome.path, metadata, {
      allTools: { memory: stubTool },
      useRequestedModelString: true,
      experimentsService,
    });
    harness.service.setMemoryService(
      new MemoryService(harness.config, new MemoryMetaService(muxHome.path))
    );

    const memoryCalls: Array<{ modelString: string; includeHotMemories: boolean }> = [];
    const resolveMemoryContext = mock(
      (modelString: string, options?: { includeHotMemories?: boolean }) => {
        const includeHotMemories = options?.includeHotMemories !== false;
        memoryCalls.push({ modelString, includeHotMemories });
        return Promise.resolve({
          indexEntries: [],
          hotMemoriesBlock: includeHotMemories
            ? `<hot_memories>${modelString}</hot_memories>`
            : null,
        });
      }
    );

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "fix the issue")],
      workspaceId,
      modelString: sourceModel,
      thinkingLevel: "off",
      experiments: { memory: true },
      resolveMemoryContext,
    });
    expect(result.success).toBe(true);

    const modelFallback = harness.startStreamCalls[0]?.[START_STREAM_MODEL_FALLBACK_INDEX] as
      | ModelFallbackOptions
      | undefined;
    expect(modelFallback).toBeDefined();
    if (!modelFallback) {
      throw new Error("Expected modelFallback options on startStream");
    }

    const prepared = await modelFallback.prepare(fallbackModel);
    expect(prepared.success).toBe(true);
    expect(memoryCalls).toContainEqual({ modelString: sourceModel, includeHotMemories: false });
    expect(memoryCalls).toContainEqual({ modelString: sourceModel, includeHotMemories: true });
    expect(memoryCalls).toContainEqual({ modelString: fallbackModel, includeHotMemories: true });
    expect(harness.streamSystemContextHotMemoriesBlocks).toContain(
      `<hot_memories>${fallbackModel}</hot_memories>`
    );
  });

  // GPT-5.6 Chat Completions explicit-caching seam: fallback provider options
  // and route metadata must be rebuilt from the fallback model/route so cache
  // fields cannot leak across routes in either direction.
  function stubPerModelRouteResolution(service: AIService): void {
    const providerModelFactory = Reflect.get(service, "providerModelFactory") as
      | ProviderModelFactory
      | undefined;
    if (!providerModelFactory) {
      throw new Error("Expected AIService.providerModelFactory in fallback route test");
    }
    spyOn(providerModelFactory, "resolveAndCreateModel").mockImplementation(
      (requestedModelString) => {
        const isGateway = requestedModelString.startsWith("mux-gateway:");
        const canonicalModelString = isGateway
          ? requestedModelString.replace("mux-gateway:openai/", "openai:")
          : requestedModelString;
        return Promise.resolve({
          success: true,
          data: {
            model: Object.create(null) as LanguageModel,
            effectiveModelString: requestedModelString,
            canonicalModelString,
            canonicalProviderName: "openai" as ProviderName,
            canonicalModelId: canonicalModelString.split(":")[1] ?? canonicalModelString,
            routedThroughGateway: isGateway,
            routeProvider: (isGateway ? "mux-gateway" : "openai") as ProviderName,
          },
        });
      }
    );

    const providerService = Reflect.get(service, "providerService") as ProviderService | undefined;
    if (!providerService) {
      throw new Error("Expected AIService.providerService in fallback route test");
    }
    spyOn(providerService, "getConfig").mockReturnValue({
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    });
  }

  async function runChatCompletionsFallback(options: {
    tempDirName: string;
    workspaceId: string;
    sourceModel: string;
    fallbackModel: string;
  }): Promise<{
    primaryOpenAIOptions: Record<string, unknown>;
    primaryInitialMetadata: Record<string, unknown>;
    preparedOpenAIOptions: Record<string, unknown>;
    preparedMetadataPatch: Record<string, unknown>;
  }> {
    using muxHome = new DisposableTempDir(options.tempDirName);
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });
    await writeMainConfig(muxHome.path, {
      modelFallbacks: {
        [options.sourceModel]: { models: [options.fallbackModel] },
      },
    });

    const metadata = createLocalWorkspaceMetadata(options.workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata, { useRequestedModelString: true });
    stubPerModelRouteResolution(harness.service);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "fix the issue")],
      workspaceId: options.workspaceId,
      modelString: options.sourceModel,
      thinkingLevel: "off",
      muxProviderOptions: { openai: { wireFormat: "chatCompletions" } },
    });
    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamArgs = harness.startStreamCalls[0];
    const modelFallback = startStreamArgs[START_STREAM_MODEL_FALLBACK_INDEX] as
      | ModelFallbackOptions
      | undefined;
    if (!modelFallback) {
      throw new Error("Expected modelFallback options on startStream");
    }

    const prepared = await modelFallback.prepare(options.fallbackModel);
    expect(prepared.success).toBe(true);
    if (!prepared.success) {
      throw new Error(prepared.error);
    }

    const preparedOpenAIOptions = (prepared.data.providerOptions as { openai?: unknown })
      ?.openai as Record<string, unknown>;
    expect(preparedOpenAIOptions).toBeDefined();

    return {
      primaryOpenAIOptions: openAIOptionsFromStartStreamCall(startStreamArgs),
      primaryInitialMetadata: initialMetadataFromStartStreamCall(startStreamArgs),
      preparedOpenAIOptions,
      preparedMetadataPatch: (prepared.data.initialMetadataPatch ?? {}) as Record<string, unknown>,
    };
  }

  it("drops the Chat Completions cache key when an eligible source falls back to a gateway route", async () => {
    const {
      primaryOpenAIOptions,
      primaryInitialMetadata,
      preparedOpenAIOptions,
      preparedMetadataPatch,
    } = await runChatCompletionsFallback({
      tempDirName: "ai-service-fallback-cache-key-drop",
      workspaceId: "workspace-fallback-cache-key-drop",
      sourceModel: "openai:gpt-5.6-luna",
      fallbackModel: "mux-gateway:openai/gpt-5.6-sol",
    });

    // Source: direct official OpenAI GPT-5.6 Chat Completions gets the key.
    expect(primaryOpenAIOptions.promptCacheKey).toStartWith("mux-v1-");
    expect(primaryInitialMetadata.routeProvider).toBe("openai");
    // Fallback: gateway route — the rebuilt options must not carry the key.
    expect(preparedOpenAIOptions.promptCacheKey).toBeUndefined();
    expect(preparedMetadataPatch.routeProvider).toBe("mux-gateway");
    expect(preparedMetadataPatch.routedThroughGateway).toBe(true);
  });

  it("adds the Chat Completions cache key when a gateway source falls back to direct OpenAI", async () => {
    const {
      primaryOpenAIOptions,
      primaryInitialMetadata,
      preparedOpenAIOptions,
      preparedMetadataPatch,
    } = await runChatCompletionsFallback({
      tempDirName: "ai-service-fallback-cache-key-add",
      workspaceId: "workspace-fallback-cache-key-add",
      sourceModel: "mux-gateway:openai/gpt-5.6-luna",
      fallbackModel: "openai:gpt-5.6-sol",
    });

    // Source: gateway-routed GPT-5.6 Chat Completions gets no key.
    expect(primaryOpenAIOptions.promptCacheKey).toBeUndefined();
    expect(primaryInitialMetadata.routeProvider).toBe("mux-gateway");
    // Fallback: direct official OpenAI — the rebuilt options carry the key.
    expect(preparedOpenAIOptions.promptCacheKey).toStartWith("mux-v1-");
    expect(preparedMetadataPatch.routeProvider).toBe("openai");
    expect(preparedMetadataPatch.routedThroughGateway).toBe(false);
  });

  it("drops reasoning-only continuations before adding interrupted sentinels for non-Anthropic fallbacks", () => {
    const continuationAssistant: MuxMessage = {
      id: "assistant-reasoning-only",
      role: "assistant",
      metadata: { partial: true, historySequence: 2 },
      parts: [{ type: "reasoning", text: "internal scratchpad" }],
    };

    const { providerRequestMessages } = prepareProviderRequestMessages(
      [createMuxMessage("latest-user", "user", "fix the issue"), continuationAssistant],
      "openai",
      "off"
    );
    const messagesWithSentinel = addInterruptedSentinel(providerRequestMessages);

    expect(messagesWithSentinel.map((message) => message.id)).toEqual(["latest-user"]);
  });

  it("keeps reasoning-only continuations and sentinels for Anthropic thinking fallbacks", () => {
    const continuationAssistant: MuxMessage = {
      id: "assistant-reasoning-only",
      role: "assistant",
      metadata: { partial: true, historySequence: 2 },
      parts: [
        {
          type: "reasoning",
          text: "signed thinking",
        },
      ],
    };

    const { providerRequestMessages } = prepareProviderRequestMessages(
      [createMuxMessage("latest-user", "user", "fix the issue"), continuationAssistant],
      "anthropic",
      "medium"
    );
    const messagesWithSentinel = addInterruptedSentinel(providerRequestMessages);

    expect(messagesWithSentinel.map((message) => message.id)).toEqual([
      "latest-user",
      "assistant-reasoning-only",
      "interrupted-assistant-reasoning-only",
    ]);
  });

  it("emits startup breadcrumbs as runtime-status events before stream start", async () => {
    using muxHome = new DisposableTempDir("ai-service-startup-breadcrumbs");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-startup-breadcrumbs";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    const runtimeStatusEvents: RuntimeStatusEvent[] = [];

    harness.service.on("runtime-status", (event) => {
      runtimeStatusEvents.push(event as RuntimeStatusEvent);
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(
      runtimeStatusEvents.map((event) => ({
        phase: event.phase,
        detail: event.detail,
        runtimeType: event.runtimeType,
      }))
    ).toEqual([
      {
        phase: "waiting",
        detail: "Waiting for workspace initialization...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Checking workspace runtime...",
        runtimeType: "local",
      },
      {
        phase: "checking",
        detail: "Checking repository...",
        runtimeType: "local",
      },
      {
        phase: "ready",
        detail: undefined,
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Loading workspace context...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Loading tools...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Preparing model request...",
        runtimeType: "local",
      },
      {
        phase: "starting",
        detail: "Starting model stream...",
        runtimeType: "local",
      },
    ]);
  });

  it("reuses the pre-policy stream system context when advisor availability is unchanged", async () => {
    using muxHome = new DisposableTempDir("ai-service-reuse-system-context");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-reuse-system-context";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextAdvisorFlags).toEqual([false]);
    expect(harness.startStreamCalls[0]?.[START_STREAM_RUNTIME_TEMP_DIR_INDEX]).toBe(
      path.join(metadata.projectPath, ".tmp-stream")
    );
  });

  it("rebuilds the stream system context when policy removes advisor guidance", async () => {
    using muxHome = new DisposableTempDir("ai-service-rebuild-system-context-advisor");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-rebuild-system-context-advisor";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for advisor availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(muxHome.path, metadata, {
      allTools: { advisor: stubTool },
      postPolicyTools: {},
    });
    await harness.config.editConfig((cfg) => {
      cfg.advisorModelString = KNOWN_MODELS.SONNET.id;
      return cfg;
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { advisorTool: true },
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextAdvisorFlags).toEqual([true, false]);
  });

  it("rebuilds the stream system context without memory availability when policy strips the memory tool", async () => {
    using muxHome = new DisposableTempDir("ai-service-rebuild-system-context-memory");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-rebuild-system-context-memory";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for memory availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(muxHome.path, metadata, {
      allTools: { memory: stubTool },
      // Tool policy strips the memory tool: the final prompt must not claim
      // the memory tool is enabled (memoryToolAvailable gates the
      // hot-memories block; the index lives in the stripped tool's
      // description).
      postPolicyTools: {},
    });
    harness.service.setMemoryService(
      new MemoryService(harness.config, new MemoryMetaService(muxHome.path))
    );
    const memoryCalls: Array<{ includeHotMemories: boolean }> = [];

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { memory: true },
      resolveMemoryContext: (_modelString, options) => {
        memoryCalls.push({ includeHotMemories: options?.includeHotMemories !== false });
        return Promise.resolve({ indexEntries: [], hotMemoriesBlock: null });
      },
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextMemoryToolFlags).toEqual([true, false]);
    expect(memoryCalls).toEqual([{ includeHotMemories: false }]);
  });

  it("does not upgrade memory context when the hot-set sub-experiment is disabled", async () => {
    using muxHome = new DisposableTempDir("ai-service-memory-hot-set-disabled");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-memory-hot-set-disabled";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for memory availability gating
    const stubTool: Tool = {} as never;
    const harness = createHarness(muxHome.path, metadata, {
      allTools: { memory: stubTool },
    });
    harness.service.setMemoryService(
      new MemoryService(harness.config, new MemoryMetaService(muxHome.path))
    );
    const memoryCalls: Array<{ includeHotMemories: boolean }> = [];

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { memory: true },
      resolveMemoryContext: (_modelString, options) => {
        memoryCalls.push({ includeHotMemories: options?.includeHotMemories !== false });
        return Promise.resolve({ indexEntries: [], hotMemoriesBlock: null });
      },
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextMemoryToolFlags).toEqual([true]);
    expect(memoryCalls).toEqual([{ includeHotMemories: false }]);
  });

  it("anchors the memory index by project identity and gates hot preloading on the memory-hot-set experiment", async () => {
    using muxHome = new DisposableTempDir("ai-service-memory-session-context");
    const projectPath = path.join(muxHome.path, "project");
    const checkoutRoot = path.join(muxHome.path, "checkout");
    const subProjectCwd = path.join(checkoutRoot, "packages", "app");
    await fs.mkdir(subProjectCwd, { recursive: true });
    // Project memory lives in a host-local root keyed by the stable project
    // identity, so the advertised index must enumerate it even when the
    // workspace executes inside a sub-project checkout directory.
    const projectMemoryRoot = path.join(
      muxHome.path,
      "memory",
      "project",
      projectMemoryDirName(projectPath)
    );
    await fs.mkdir(projectMemoryRoot, { recursive: true });
    await fs.writeFile(path.join(projectMemoryRoot, "root-note.md"), "root fact\n");

    let hotSetEnabled = false;
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(muxHome.path),
      muxHome: muxHome.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) =>
        experimentId === EXPERIMENT_IDS.MEMORY ||
        (experimentId === EXPERIMENT_IDS.MEMORY_HOT_SET && hotSetEnabled)
    );
    const { config, service } = createBasicAIService(muxHome.path, { experimentsService });
    const memoryService = new MemoryService(config, new MemoryMetaService(muxHome.path));
    service.setMemoryService(memoryService);

    const workspaceId = "workspace-memory-session-context";
    // namedWorkspacePath is the persisted checkout root consumed by
    // resolveWorkspaceRootPath (WorkspaceMetadataForRuntime extension).
    const metadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createLocalWorkspaceMetadata(workspaceId, projectPath),
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      namedWorkspacePath: checkoutRoot,
      subProjectPath: "packages/app",
    };
    spyOn(service, "getWorkspaceMetadata").mockResolvedValue({ success: true, data: metadata });
    // Hot selection needs sidecar usage stats; stub the real instance so the
    // gating branch (not the ranking) is under test.
    const listHotSpy = spyOn(memoryService, "listHotMemories").mockResolvedValue([
      {
        path: "/memories/project/root-note.md",
        pinned: true,
        truncated: false,
        content: "root fact",
      },
    ]);

    const pullOnly = await service.buildMemorySessionContext(workspaceId, "openai:gpt-5.2");
    expect(pullOnly?.indexEntries.map((entry) => entry.path)).toEqual([
      "/memories/project/root-note.md",
    ]);
    // Sub-experiment off: no preloaded content, memories stay pull-based.
    expect(pullOnly?.hotMemoriesBlock).toBeNull();
    expect(listHotSpy).not.toHaveBeenCalled();

    hotSetEnabled = true;
    const withHotSet = await service.buildMemorySessionContext(workspaceId, "openai:gpt-5.2");
    expect(withHotSet?.hotMemoriesBlock).toContain("root fact");
  });

  it("preserves the memory index when hot-memory selection fails", async () => {
    using muxHome = new DisposableTempDir("ai-service-memory-hot-failure");
    const projectPath = path.join(muxHome.path, "project");
    const checkoutRoot = path.join(muxHome.path, "checkout");
    const projectMemoryRoot = path.join(
      muxHome.path,
      "memory",
      "project",
      projectMemoryDirName(projectPath)
    );
    await fs.mkdir(projectMemoryRoot, { recursive: true });
    await fs.writeFile(path.join(projectMemoryRoot, "root-note.md"), "root fact\n");

    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(muxHome.path),
      muxHome: muxHome.path,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) =>
        experimentId === EXPERIMENT_IDS.MEMORY || experimentId === EXPERIMENT_IDS.MEMORY_HOT_SET
    );
    const { config, service } = createBasicAIService(muxHome.path, { experimentsService });
    const memoryService = new MemoryService(config, new MemoryMetaService(muxHome.path));
    service.setMemoryService(memoryService);

    const workspaceId = "workspace-memory-hot-failure";
    const metadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createLocalWorkspaceMetadata(workspaceId, projectPath),
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      namedWorkspacePath: checkoutRoot,
    };
    spyOn(service, "getWorkspaceMetadata").mockResolvedValue({ success: true, data: metadata });
    spyOn(memoryService, "listHotMemories").mockImplementation(() => {
      throw new Error("tokenizer failed");
    });

    const context = await service.buildMemorySessionContext(workspaceId, "openai:gpt-5.2");

    expect(context?.indexEntries.map((entry) => entry.path)).toEqual([
      "/memories/project/root-note.md",
    ]);
    expect(context?.hotMemoriesBlock).toBeNull();
  });

  it("resolves the memory context only after the runtime is ready", async () => {
    using muxHome = new DisposableTempDir("ai-service-hot-memories-after-ready");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-hot-memories-after-ready";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    // Ordering is the contract under test: AgentSession caches the resolver
    // result per model/session segment, so resolving before ensureReady on a
    // stopped Docker/remote workspace would pin an empty/partial block.
    const order: string[] = [];
    const realCreateRuntime = runtimeFactory.createRuntime;
    spyOn(runtimeFactory, "createRuntime").mockImplementation((runtimeConfig, options) => {
      const runtime = realCreateRuntime(runtimeConfig, options);
      const realEnsureReady = runtime.ensureReady.bind(runtime);
      spyOn(runtime, "ensureReady").mockImplementation((...readyArgs) => {
        order.push("ensureReady");
        return realEnsureReady(...readyArgs);
      });
      return runtime;
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      resolveMemoryContext: () => {
        order.push("resolveMemoryContext");
        return Promise.resolve({
          indexEntries: [{ path: "/memories/global/lesson.md", description: "a lesson" }],
          hotMemoriesBlock: "<hot_memories>cached</hot_memories>",
        });
      },
    });

    expect(result.success).toBe(true);
    expect(order.indexOf("ensureReady")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("resolveMemoryContext")).toBeGreaterThan(order.indexOf("ensureReady"));
    expect(harness.streamSystemContextHotMemoriesBlocks).toContain(
      "<hot_memories>cached</hot_memories>"
    );
    // The index snapshot flows into the tool configuration so the memory tool
    // can advertise it in its description (same disclosure mechanic as skills).
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    expect(toolConfig).toMatchObject({
      memoryIndexEntries: [{ path: "/memories/global/lesson.md", description: "a lesson" }],
    });
  });

  it("keeps legacy system workspaces on the global mux tool scope", async () => {
    using muxHome = new DisposableTempDir("ai-service-system-tool-scope");
    const projectPath = path.join(muxHome.path, "legacy-system-project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-system-tool-scope";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [], projectKind: "system" });
      return cfg;
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextMuxScopes.at(-1)).toEqual({
      type: "global",
      muxHome: muxHome.path,
    });
  });

  it("keeps _multi workspaces on the project mux tool scope", async () => {
    using muxHome = new DisposableTempDir("ai-service-multi-project-tool-scope");
    const workspaceId = "workspace-multi-project-tool-scope";
    const metadata = createLocalWorkspaceMetadata(workspaceId, MULTI_PROJECT_CONFIG_KEY);
    const harness = createHarness(muxHome.path, metadata);
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, { workspaces: [], projectKind: "system" });
      return cfg;
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(harness.streamSystemContextMuxScopes.at(-1)).toEqual({
      type: "project",
      muxHome: muxHome.path,
      projectRoot: MULTI_PROJECT_CONFIG_KEY,
      projectStorageAuthority: "host-local",
    });
  });

  it("uses the latest durable boundary slice for provider payload and OpenAI derivations", async () => {
    using muxHome = new DisposableTempDir("ai-service-slice-latest-boundary");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-slice-latest";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    const messages: MuxMessage[] = [
      createMuxMessage("boundary-1", "assistant", "compaction epoch 1", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        model: "openai:gpt-5.2",
      }),
      createMuxMessage("assistant-old-response", "assistant", "older response", {
        model: "openai:gpt-5.2",
        providerMetadata: { openai: { responseId: "resp_epoch_1" } },
      }),
      createMuxMessage(
        "start-here-summary",
        "assistant",
        "# Start Here\n\n- Existing plan context\n\n*Plan file preserved at:* /tmp/plan.md",
        {
          compacted: "user",
          agentId: "plan",
        }
      ),
      createMuxMessage("mid-user", "user", "mid conversation"),
      createMuxMessage("boundary-2", "assistant", "compaction epoch 2", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
        model: "openai:gpt-5.2",
      }),
      createMuxMessage("latest-user", "user", "continue"),
    ];

    const result = await harness.service.streamMessage({
      messages,
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(true);
    expect(harness.planPayloadMessageIds).toEqual([["boundary-2", "latest-user"]]);
    expect(harness.preparedPayloadMessageIds).toEqual([["boundary-2", "latest-user"]]);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const startStreamMessageIds = messageIdsFromUnknownArray(startStreamCall[1]);
    expect(startStreamMessageIds).toEqual(["boundary-2", "latest-user"]);

    const openaiOptions = openAIOptionsFromStartStreamCall(startStreamCall);
    expect(openaiOptions.previousResponseId).toBeUndefined();
    expect(openaiOptions.promptCacheKey).toBe(
      `mux-v1-project-under-test-${uniqueSuffix([projectPath])}`
    );
  });

  it("passes the resolved routeProvider into initial stream metadata", async () => {
    using muxHome = new DisposableTempDir("ai-service-route-provider-present");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-route-provider-present";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata, { routeProvider: "openrouter" });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const initialMetadata = initialMetadataFromStartStreamCall(startStreamCall);
    expect(initialMetadata.routeProvider).toBe("openrouter");
  });

  it("passes muxMetadata into initial stream metadata", async () => {
    using muxHome = new DisposableTempDir("ai-service-mux-metadata");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-mux-metadata";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_handle",
        ownerWorkspaceId: "owner-workspace",
        turnId: "turn-id",
      },
    });

    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const initialMetadata = initialMetadataFromStartStreamCall(startStreamCall);
    expect(initialMetadata.muxMetadata).toEqual({
      type: "workspace-turn-task",
      taskHandleId: "wst_handle",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-id",
    });
  });

  it("omits routeProvider from initial stream metadata when unresolved", async () => {
    using muxHome = new DisposableTempDir("ai-service-route-provider-absent");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-route-provider-absent";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const initialMetadata = initialMetadataFromStartStreamCall(startStreamCall);
    expect(Object.prototype.hasOwnProperty.call(initialMetadata, "routeProvider")).toBe(false);
  });

  it("derives sentinel tool names from assembled post-policy tools", async () => {
    using muxHome = new DisposableTempDir("ai-service-sentinel-tool-names");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-sentinel-tools";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub for tool-name extraction test
    const stubTool: Tool = {} as never;
    const finalTools: Record<string, Tool> = {
      bash: stubTool,
      my_mcp_tool: stubTool,
    };
    const allTools: Record<string, Tool> = {
      web_search: stubTool,
      my_mcp_tool: stubTool,
      bash: stubTool,
    };
    const harness = createHarness(muxHome.path, metadata, {
      allTools,
      postPolicyTools: finalTools,
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      muxProviderOptions: {
        openai: { wireFormat: "chatCompletions" },
      },
    });

    expect(result.success).toBe(true);
    expect(harness.preparedToolNamesForSentinel).toEqual([["bash", "my_mcp_tool"]]);
    expect(harness.preparedToolNamesForSentinel[0]).not.toContain("web_search");
  });

  it("falls back safely when boundary metadata is malformed", async () => {
    using muxHome = new DisposableTempDir("ai-service-slice-malformed-boundary");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-slice-malformed";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    const messages: MuxMessage[] = [
      createMuxMessage("assistant-before-malformed", "assistant", "response before malformed", {
        model: "openai:gpt-5.2",
        providerMetadata: { openai: { responseId: "resp_before_malformed" } },
      }),
      createMuxMessage("malformed-boundary", "assistant", "not a durable boundary", {
        compacted: "user",
        compactionBoundary: true,
        // Invalid durable marker: must not truncate request payload.
        compactionEpoch: 0,
        model: "openai:gpt-5.2",
      }),
      createMuxMessage("latest-user", "user", "continue"),
    ];

    const result = await harness.service.streamMessage({
      messages,
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(true);
    expect(harness.planPayloadMessageIds).toEqual([
      ["assistant-before-malformed", "malformed-boundary", "latest-user"],
    ]);
    expect(harness.preparedPayloadMessageIds).toEqual([
      ["assistant-before-malformed", "malformed-boundary", "latest-user"],
    ]);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    expect(startStreamCall).toBeDefined();
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    const startStreamMessageIds = messageIdsFromUnknownArray(startStreamCall[1]);
    expect(startStreamMessageIds).toEqual([
      "assistant-before-malformed",
      "malformed-boundary",
      "latest-user",
    ]);

    const openaiOptions = openAIOptionsFromStartStreamCall(startStreamCall);
    expect(openaiOptions.previousResponseId).toBeUndefined();
    expect(openaiOptions.promptCacheKey).toBe(
      `mux-v1-project-under-test-${uniqueSuffix([projectPath])}`
    );
  });

  it("freezes advisor tool-call snapshots at the tool-call boundary", async () => {
    using muxHome = new DisposableTempDir("ai-service-advisor-step-snapshot-boundary");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-boundary";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "continue" }]);

    const input = { focus: "shared context" };
    await onChunk({ chunk: { type: "text-delta", delta: "draft answer" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "risk analysis" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input,
      },
    });
    input.focus = "mutated after freeze";

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toEqual({
      toolCallId: "advisor-call-1",
      toolName: "advisor",
      input: { focus: "shared context" },
      stepText: "draft answer",
      stepReasoning: "risk analysis",
    });
  });

  it("keeps multiple advisor tool-call snapshots isolated within the same step", async () => {
    using muxHome = new DisposableTempDir("ai-service-advisor-step-snapshot-isolated");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-isolated";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "continue" }]);

    await onChunk({ chunk: { type: "text-delta", delta: "alpha" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "first" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input: {},
      },
    });
    await onChunk({ chunk: { type: "text-delta", delta: " beta" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: " second" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-2",
        toolName: "advisor",
        input: {},
      },
    });

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toMatchObject({
      stepText: "alpha",
      stepReasoning: "first",
    });
    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-2")).toMatchObject({
      stepText: "alpha beta",
      stepReasoning: "first second",
    });
  });

  it("resets advisor step capture buffers and frozen snapshots between steps", async () => {
    using muxHome = new DisposableTempDir("ai-service-advisor-step-snapshot-reset");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-reset";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "step 1" }]);

    await onChunk({ chunk: { type: "text-delta", delta: "old text" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "old reasoning" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input: {},
      },
    });

    onStepMessages([{ role: "user", content: "step 2" }]);
    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toBeUndefined();

    await onChunk({ chunk: { type: "text-delta", delta: "new text" } });
    await onChunk({ chunk: { type: "reasoning-delta", delta: "new reasoning" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-2",
        toolName: "advisor",
        input: {},
      },
    });

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-2")).toEqual({
      toolCallId: "advisor-call-2",
      toolName: "advisor",
      input: {},
      stepText: "new text",
      stepReasoning: "new reasoning",
    });
  });

  it("consumes advisor tool-call snapshots on first read", async () => {
    using muxHome = new DisposableTempDir("ai-service-advisor-step-snapshot-consume");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-advisor-step-snapshot-consume";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);
    await enableAdvisorForHarness(harness);

    await startAdvisorStream(harness, workspaceId);

    const advisorRuntime = getAdvisorRuntimeFromHarness(harness);
    const { onChunk, onStepMessages } = getAdvisorCallbacksFromHarness(harness);
    onStepMessages([{ role: "user", content: "continue" }]);

    await onChunk({ chunk: { type: "text-delta", delta: "visible text" } });
    await onChunk({
      chunk: {
        type: "tool-call",
        toolCallId: "advisor-call-1",
        toolName: "advisor",
        input: {},
      },
    });

    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toMatchObject({
      toolCallId: "advisor-call-1",
      stepText: "visible text",
    });
    expect(advisorRuntime.takeToolCallSnapshot("advisor-call-1")).toBeUndefined();
  });

  it("resolves advisor tool metadata pricing without changing the stored model bucket", async () => {
    using muxHome = new DisposableTempDir("ai-service-tool-model-usage");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-tool-model-usage";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const recordUsage = mock(() => Promise.resolve(undefined));
    const getSessionUsage = mock(() => Promise.resolve(undefined));
    const sessionUsageService = {
      recordUsage,
      getSessionUsage,
    } as unknown as SessionUsageService;
    const harness = createHarness(muxHome.path, metadata, { sessionUsageService });
    const metadataModel = KNOWN_MODELS.SONNET.id;
    harness.config.saveProvidersConfig({
      anthropic: {
        models: [{ id: "custom-sonnet", mappedToModel: metadataModel }],
      },
    });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }

    const reportModelUsage = (
      toolConfig as {
        reportModelUsage?: (event: ToolModelUsageEvent) => void;
      }
    ).reportModelUsage;
    expect(typeof reportModelUsage).toBe("function");
    if (!reportModelUsage) {
      throw new Error("Expected reportModelUsage callback on tool configuration");
    }

    const event: ToolModelUsageEvent = {
      source: "tool",
      toolName: "advisor",
      model: "anthropic:custom-sonnet",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 10,
        outputTokens: 45,
        reasoningTokens: 5,
        totalTokens: 165,
      },
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 6 },
      },
      toolCallId: "call-1",
      timestamp: Date.now(),
    };
    const unresolvedDisplayUsage = createDisplayUsage(
      event.usage,
      event.model,
      event.providerMetadata
    );
    expect(unresolvedDisplayUsage).toBeDefined();
    if (!unresolvedDisplayUsage) {
      throw new Error("Expected unresolved tool usage event to produce display usage");
    }
    expect(unresolvedDisplayUsage.input.cost_usd).toBeUndefined();

    const expectedDisplayUsage = createDisplayUsage(
      event.usage,
      event.model,
      event.providerMetadata,
      metadataModel
    );
    expect(expectedDisplayUsage).toBeDefined();
    if (!expectedDisplayUsage) {
      throw new Error("Expected tool usage event to produce display usage");
    }
    expect(expectedDisplayUsage.model).toBe(event.model);
    expect(expectedDisplayUsage.input.cost_usd).toBeDefined();

    const canonicalModel = normalizeToCanonical(event.model);
    const callSequence: string[] = [];
    let sessionUsageDeltaEvent: unknown;
    harness.service.once("session-usage-delta", (payload) => {
      callSequence.push("emit");
      sessionUsageDeltaEvent = payload;
    });

    recordUsage.mockImplementationOnce(() => {
      callSequence.push("recordUsage");
      return Promise.resolve(undefined);
    });

    reportModelUsage(event);
    await Promise.resolve();
    await Promise.resolve();

    expect(recordUsage).toHaveBeenCalledWith(workspaceId, canonicalModel, expectedDisplayUsage);
    expect(callSequence).toEqual(["recordUsage", "emit"]);
    expect(sessionUsageDeltaEvent).toBeDefined();
    if (typeof sessionUsageDeltaEvent !== "object" || sessionUsageDeltaEvent === null) {
      throw new Error("Expected session-usage-delta event payload");
    }
    const sessionUsageDeltaRecord = sessionUsageDeltaEvent as Record<string, unknown>;
    expect(sessionUsageDeltaRecord.type).toBe("session-usage-delta");
    expect(sessionUsageDeltaRecord.workspaceId).toBe(workspaceId);
    expect(sessionUsageDeltaRecord.sourceWorkspaceId).toBe(workspaceId);
    expect(sessionUsageDeltaRecord.byModelDelta).toEqual({
      [canonicalModel]: expectedDisplayUsage,
    });
    expect(typeof sessionUsageDeltaRecord.timestamp).toBe("number");
  });

  it("zeros advisor tool usage costs for costs-included models before persisting", async () => {
    using muxHome = new DisposableTempDir("ai-service-tool-model-usage-costs-included");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-tool-model-usage-costs-included";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const recordUsage = mock(() => Promise.resolve(undefined));
    const getSessionUsage = mock(() => Promise.resolve(undefined));
    const sessionUsageService = {
      recordUsage,
      getSessionUsage,
    } as unknown as SessionUsageService;
    const harness = createHarness(muxHome.path, metadata, { sessionUsageService });

    harness.config.saveProvidersConfig({
      openai: {
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "test-account-id",
        },
      },
    });
    const baseConfig = harness.config.loadConfigOrDefault();
    await harness.config.editConfig(() => ({
      ...baseConfig,
      advisorModelString: KNOWN_MODELS.GPT_53_CODEX.id,
      agentAiDefaults: {
        ...baseConfig.agentAiDefaults,
        exec: {
          ...baseConfig.agentAiDefaults?.exec,
          advisorEnabled: true,
        },
      },
    }));

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
      experiments: { advisorTool: true },
    });

    expect(result.success).toBe(true);
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }

    const advisorRuntime = (
      toolConfig as {
        advisorRuntime?: {
          createModel: (modelString: string) => Promise<LanguageModel>;
        };
      }
    ).advisorRuntime;
    expect(advisorRuntime).toBeDefined();
    if (!advisorRuntime) {
      throw new Error("Expected advisorRuntime in tool configuration");
    }
    await advisorRuntime.createModel(KNOWN_MODELS.GPT_53_CODEX.id);

    const reportModelUsage = (
      toolConfig as {
        reportModelUsage?: (event: ToolModelUsageEvent) => void;
      }
    ).reportModelUsage;
    if (!reportModelUsage) {
      throw new Error("Expected reportModelUsage callback on tool configuration");
    }

    const event: ToolModelUsageEvent = {
      source: "tool",
      toolName: "advisor",
      model: KNOWN_MODELS.GPT_53_CODEX.id,
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
      },
      providerMetadata: {
        openai: { reasoningTokens: 5 },
      },
      timestamp: Date.now(),
    };
    const expectedDisplayUsage = createDisplayUsage(event.usage, event.model, {
      ...(event.providerMetadata ?? {}),
      mux: { costsIncluded: true },
    });
    expect(expectedDisplayUsage).toBeDefined();
    if (!expectedDisplayUsage) {
      throw new Error("Expected tool usage event to produce display usage");
    }
    expect(expectedDisplayUsage.costsIncluded).toBe(true);
    expect(expectedDisplayUsage.input.cost_usd).toBe(0);
    expect(expectedDisplayUsage.output.cost_usd).toBe(0);
    expect(expectedDisplayUsage.reasoning.cost_usd).toBe(0);

    reportModelUsage(event);
    await Promise.resolve();
    await Promise.resolve();

    expect(recordUsage).toHaveBeenCalledWith(
      workspaceId,
      normalizeToCanonical(event.model),
      expectedDisplayUsage
    );
  });

  it("logs and swallows tool model usage persistence failures", async () => {
    using muxHome = new DisposableTempDir("ai-service-tool-model-usage-failure");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-tool-model-usage-failure";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const recordUsageError = new Error("write failed");
    const recordUsage = mock(() => Promise.reject(recordUsageError));
    const getSessionUsage = mock(() => Promise.resolve(undefined));
    const sessionUsageService = {
      recordUsage,
      getSessionUsage,
    } as unknown as SessionUsageService;
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    const harness = createHarness(muxHome.path, metadata, { sessionUsageService });

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("latest-user", "user", "continue")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }

    const reportModelUsage = (
      toolConfig as {
        reportModelUsage?: (event: ToolModelUsageEvent) => void;
      }
    ).reportModelUsage;
    if (!reportModelUsage) {
      throw new Error("Expected reportModelUsage callback on tool configuration");
    }

    const event: ToolModelUsageEvent = {
      source: "tool",
      toolName: "advisor",
      model: "anthropic:claude-sonnet-4-20250514",
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      },
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 2 },
      },
      toolCallId: "call-2",
      timestamp: Date.now(),
    };

    reportModelUsage(event);
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to record tool model usage",
      expect.objectContaining({
        error: recordUsageError,
        workspaceId,
        toolName: "advisor",
        model: event.model,
      })
    );
  });

  describe("mid-turn thinking override rebuild closure", () => {
    const START_STREAM_THINKING_OVERRIDE_STATE_INDEX = 26;
    const START_STREAM_THINKING_REBUILD_INDEX = 27;

    function getThinkingOverrideStartStreamArgs(harness: StreamMessageHarness): {
      holder: unknown;
      rebuild: RebuildProviderOptionsForThinkingLevel;
    } {
      expect(harness.startStreamCalls).toHaveLength(1);
      const call = harness.startStreamCalls[0];
      if (!call) {
        throw new Error("Expected streamManager.startStream call arguments");
      }
      const holder = call[START_STREAM_THINKING_OVERRIDE_STATE_INDEX];
      const rebuild = call[START_STREAM_THINKING_REBUILD_INDEX];
      expect(typeof rebuild).toBe("function");
      return { holder, rebuild: rebuild as RebuildProviderOptionsForThinkingLevel };
    }

    it("threads the session holder by reference and rebuilds options through the same pipeline", async () => {
      using muxHome = new DisposableTempDir("ai-service-thinking-override");
      const projectPath = path.join(muxHome.path, "project");
      await fs.mkdir(projectPath, { recursive: true });

      const workspaceId = "workspace-thinking-override";
      const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
      const harness = createHarness(muxHome.path, metadata, {
        useRequestedModelString: true,
        canonicalProviderName: "anthropic",
      });

      const sessionHolder: ActiveTurnThinkingOverride = {};
      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("latest-user", "user", "hello")],
        workspaceId,
        // Budget-token Anthropic model (no adaptive effort): level changes show
        // up as thinking.budgetTokens differences.
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "low",
        minThinkingLevel: "off",
        activeTurnThinkingOverride: sessionHolder,
      });
      expect(result.success).toBe(true);

      const { holder, rebuild } = getThinkingOverrideStartStreamArgs(harness);
      // Same object: AgentSession's setter writes must be visible to prepareStep.
      expect(holder).toBe(sessionHolder);

      // No-op: requested level equals the current effective level.
      expect(rebuild("low")).toBeNull();

      // Real transition: rebuilt provider options reflect the new level.
      const rebuilt = rebuild("high");
      expect(rebuilt?.effectiveLevel).toBe("high");
      const anthropic = rebuilt?.providerOptions.anthropic as
        | { thinking?: { type: string; budgetTokens?: number } }
        | undefined;
      expect(anthropic?.thinking).toEqual({ type: "enabled", budgetTokens: 20000 });

      // The closure diffs against the LIVE level, not the send-time one:
      // repeating the applied level is now a no-op.
      expect(rebuild("high")).toBeNull();
    });

    it("clamps mid-turn requests against the session-provided floor", async () => {
      using muxHome = new DisposableTempDir("ai-service-thinking-floor");
      const projectPath = path.join(muxHome.path, "project");
      await fs.mkdir(projectPath, { recursive: true });

      const workspaceId = "workspace-thinking-floor";
      const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
      const harness = createHarness(muxHome.path, metadata, {
        useRequestedModelString: true,
        canonicalProviderName: "anthropic",
      });

      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("latest-user", "user", "hello")],
        workspaceId,
        modelString: KNOWN_MODELS.SONNET.id,
        thinkingLevel: "medium",
        minThinkingLevel: "medium",
        activeTurnThinkingOverride: {},
      });
      expect(result.success).toBe(true);

      const { rebuild } = getThinkingOverrideStartStreamArgs(harness);
      // Below-floor requests clamp up to the floor, which equals the current
      // level here — so they must be treated as no-ops, not as downgrades.
      expect(rebuild("off")).toBeNull();
      expect(rebuild("low")).toBeNull();
      // Above-floor requests still apply.
      expect(rebuild("high")?.effectiveLevel).toBe("high");
    });

    it("applies Anthropic native-xhigh transitions as plain provider-option rebuilds", async () => {
      using muxHome = new DisposableTempDir("ai-service-thinking-xhigh");
      const projectPath = path.join(muxHome.path, "project");
      await fs.mkdir(projectPath, { recursive: true });

      const workspaceId = "workspace-thinking-xhigh";
      const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
      const harness = createHarness(muxHome.path, metadata, {
        useRequestedModelString: true,
        canonicalProviderName: "anthropic",
      });

      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("latest-user", "user", "hello")],
        workspaceId,
        modelString: "anthropic:claude-opus-4-7",
        thinkingLevel: "high",
        activeTurnThinkingOverride: {},
      });
      expect(result.success).toBe(true);

      const { rebuild } = getThinkingOverrideStartStreamArgs(harness);
      const rebuilt = rebuild("xhigh");
      expect(rebuilt?.effectiveLevel).toBe("xhigh");
      const anthropic = rebuilt?.providerOptions.anthropic as
        | { effort?: string; thinking?: unknown }
        | undefined;
      // Post-wire-hack: the native effort flows directly via provider options.
      expect(anthropic?.effort).toBe("xhigh");
      expect(anthropic?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    });

    it("skips the grok-4-1-fast off<->on transition (model-instance swap)", async () => {
      using muxHome = new DisposableTempDir("ai-service-thinking-grok");
      const projectPath = path.join(muxHome.path, "project");
      await fs.mkdir(projectPath, { recursive: true });

      const workspaceId = "workspace-thinking-grok";
      const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
      const harness = createHarness(muxHome.path, metadata, {
        useRequestedModelString: true,
        canonicalProviderName: "xai" as ProviderName,
      });

      const result = await harness.service.streamMessage({
        messages: [createMuxMessage("latest-user", "user", "hello")],
        workspaceId,
        modelString: "xai:grok-4-1-fast",
        thinkingLevel: "off",
        activeTurnThinkingOverride: {},
      });
      expect(result.success).toBe(true);

      const { rebuild } = getThinkingOverrideStartStreamArgs(harness);
      // off -> high selects a different model instance at creation time; the
      // in-flight stream cannot express it via provider options.
      expect(rebuild("high")).toBeNull();
    });
  });
});

describe("AIService.streamMessage multi-project trust gating", () => {
  interface TrustGatingHarness {
    service: AIService;
    config: Config;
    getToolsForModelSpy: ReturnType<typeof spyOn<typeof toolsModule, "getToolsForModel">>;
  }

  function createTrustMetadata(
    workspaceId: string,
    projectPaths: string[],
    runtimeConfig: WorkspaceMetadata["runtimeConfig"] = { type: "local" }
  ): WorkspaceMetadata {
    const [primaryProjectPath, secondaryProjectPath] = projectPaths;
    if (!primaryProjectPath) {
      throw new Error("Expected at least one project path");
    }

    return {
      id: workspaceId,
      name: "workspace-trust-gating",
      projectName: "project-a",
      projectPath: primaryProjectPath,
      projects: secondaryProjectPath
        ? [
            { projectPath: primaryProjectPath, projectName: "project-a" },
            { projectPath: secondaryProjectPath, projectName: "project-b" },
          ]
        : undefined,
      runtimeConfig,
    };
  }

  function createHarness(
    muxHomePath: string,
    metadata: WorkspaceMetadata,
    multiProjectExperimentEnabled = true,
    workspacePathOverride?: string
  ): TrustGatingHarness {
    const experimentsService = new ExperimentsService({
      telemetryService: new TelemetryService(muxHomePath),
      muxHome: muxHomePath,
    });
    spyOn(experimentsService, "isExperimentEnabled").mockImplementation((experimentId) =>
      experimentId === EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
        ? multiProjectExperimentEnabled
        : false
    );
    const { config, historyService, initStateManager, service } = createBasicAIService(
      muxHomePath,
      {
        experimentsService,
      }
    );
    const getToolsForModelSpy = stubCommonStreamMessageDependencies({
      service,
      config,
      historyService,
      initStateManager,
      metadata,
      workspacePathOverride,
      historySequence: 11,
    });
    return { service, config, getToolsForModelSpy };
  }

  async function streamOnce(harness: TrustGatingHarness, workspaceId: string): Promise<void> {
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("user-message", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
  }

  function trustedFromFirstGetToolsCall(
    getToolsForModelSpy: TrustGatingHarness["getToolsForModelSpy"]
  ): boolean | undefined {
    const toolConfig = getToolsForModelSpy.mock.calls[0]?.[1];
    if (!toolConfig || typeof toolConfig !== "object") {
      throw new Error("Expected getToolsForModel to receive a tool configuration object");
    }

    return (toolConfig as { trusted?: boolean }).trusted;
  }

  afterEach(() => {
    mock.restore();
  });

  it("marks multi-project tool execution untrusted when any secondary project is untrusted", async () => {
    using muxHome = new DisposableTempDir("ai-service-multi-project-trust-gating");
    const projectAPath = path.join(muxHome.path, "project-a");
    const projectBPath = path.join(muxHome.path, "project-b");
    await fs.mkdir(projectAPath, { recursive: true });
    await fs.mkdir(projectBPath, { recursive: true });

    const workspaceId = "workspace-multi-project-trust";
    const metadata = createTrustMetadata(workspaceId, [projectAPath, projectBPath]);
    const harness = createHarness(muxHome.path, metadata);

    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectAPath, { workspaces: [], trusted: true });
      cfg.projects.set(projectBPath, { workspaces: [], trusted: false });
      return cfg;
    });

    await streamOnce(harness, workspaceId);

    expect(harness.getToolsForModelSpy).toHaveBeenCalledTimes(1);
    expect(trustedFromFirstGetToolsCall(harness.getToolsForModelSpy)).toBe(false);
  });

  it("uses the persisted workspace root as cwd for multi-project ssh startup", async () => {
    using muxHome = new DisposableTempDir("ai-service-multi-project-persisted-cwd");
    const projectAPath = path.join(muxHome.path, "project-a");
    const projectBPath = path.join(muxHome.path, "project-b");
    await fs.mkdir(projectAPath, { recursive: true });
    await fs.mkdir(projectBPath, { recursive: true });

    const workspaceId = "workspace-multi-project-persisted-cwd";
    const persistedWorkspacePath = path.join(muxHome.path, "persisted-legacy-workspace-root");
    const metadata = createTrustMetadata(workspaceId, [projectAPath, projectBPath], {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/remote/src",
    });
    const harness = createHarness(muxHome.path, metadata, true, persistedWorkspacePath);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => new LocalRuntime(options?.projectPath ?? projectAPath)
    );

    try {
      await harness.config.editConfig((cfg) => {
        cfg.projects.set(projectAPath, { workspaces: [], trusted: true });
        cfg.projects.set(projectBPath, { workspaces: [], trusted: true });
        return cfg;
      });

      await streamOnce(harness, workspaceId);

      const toolConfig = harness.getToolsForModelSpy.mock.calls[0]?.[1] as
        | { cwd?: unknown }
        | undefined;
      expect(toolConfig?.cwd).toBe(persistedWorkspacePath);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
  it("fails closed before tool setup when the multi-project experiment is disabled", async () => {
    using muxHome = new DisposableTempDir("ai-service-multi-project-experiment-disabled");
    const projectAPath = path.join(muxHome.path, "project-a");
    const projectBPath = path.join(muxHome.path, "project-b");
    await fs.mkdir(projectAPath, { recursive: true });
    await fs.mkdir(projectBPath, { recursive: true });

    const workspaceId = "workspace-multi-project-disabled";
    const metadata = createTrustMetadata(workspaceId, [projectAPath, projectBPath]);
    const harness = createHarness(muxHome.path, metadata, false);

    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("user-message", "user", "hello")],
      workspaceId,
      modelString: "openai:gpt-5.2",
      thinkingLevel: "off",
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: "unknown",
        raw: `Workspace ${workspaceId} reached multi-project AI runtime execution while ${EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES} is disabled`,
      },
    });
    expect(harness.getToolsForModelSpy).not.toHaveBeenCalled();
  });
});

describe("AIService.streamMessage model parameter overrides", () => {
  const ANTHROPIC_MODEL = "anthropic:claude-sonnet-4-5";

  interface ModelParameterOverridesHarness {
    service: AIService;
    config: Config;
    startStreamCalls: unknown[][];
  }

  function providerOptionsFromStartStreamCall(startStreamArgs: unknown[]): Record<string, unknown> {
    const providerOptions = startStreamArgs[11];
    if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
      throw new Error("Expected provider options object at startStream arg index 11");
    }

    return providerOptions as Record<string, unknown>;
  }

  function callSettingsOverridesFromStartStreamCall(
    startStreamArgs: unknown[]
  ): Record<string, unknown> {
    const callSettingsOverrides = startStreamArgs[20];
    if (
      !callSettingsOverrides ||
      typeof callSettingsOverrides !== "object" ||
      Array.isArray(callSettingsOverrides)
    ) {
      throw new Error("Expected call settings overrides object at startStream arg index 21");
    }

    return callSettingsOverrides as Record<string, unknown>;
  }

  function createHarness(
    muxHomePath: string,
    metadata: WorkspaceMetadata,
    options?: { routeProvider?: ProviderName }
  ): ModelParameterOverridesHarness {
    const { config, historyService, initStateManager, service } = createBasicAIService(muxHomePath);
    const startStreamCalls: unknown[][] = [];
    stubCommonStreamMessageDependencies({
      service,
      config,
      historyService,
      initStateManager,
      metadata,
      startStreamCalls,
      routeProvider: options?.routeProvider,
      historySequence: 9,
      effectiveModelString: ANTHROPIC_MODEL,
      canonicalProviderName: "anthropic",
      canonicalModelId: "claude-sonnet-4-5",
    });
    return { service, config, startStreamCalls };
  }

  async function streamAndGetStartStreamArgs(
    harness: ModelParameterOverridesHarness,
    workspaceId: string,
    modelString = ANTHROPIC_MODEL
  ): Promise<unknown[]> {
    const result = await harness.service.streamMessage({
      messages: [createMuxMessage("user-message", "user", "hello")],
      workspaceId,
      modelString,
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(harness.startStreamCalls).toHaveLength(1);

    const startStreamCall = harness.startStreamCalls[0];
    if (!startStreamCall) {
      throw new Error("Expected streamManager.startStream call arguments");
    }

    return startStreamCall;
  }

  afterEach(() => {
    mock.restore();
  });

  it("passes resolved call settings overrides as the final startStream argument", async () => {
    using muxHome = new DisposableTempDir("ai-service-model-overrides-standard");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-model-overrides-standard";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    spyOn(harness.config, "loadProvidersConfig").mockReturnValue({
      anthropic: {
        modelParameters: {
          "claude-sonnet-4-5": {
            max_output_tokens: 16384,
            temperature: 0.7,
          },
        },
      },
    });

    const startStreamArgs = await streamAndGetStartStreamArgs(harness, workspaceId);
    expect(callSettingsOverridesFromStartStreamCall(startStreamArgs)).toEqual({
      maxOutputTokens: 16384,
      temperature: 0.7,
    });
  });

  it("deep-merges provider extras under Mux-built provider options", async () => {
    using muxHome = new DisposableTempDir("ai-service-model-overrides-provider-extras");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-model-overrides-provider-extras";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    spyOn(harness.config, "loadProvidersConfig").mockReturnValue({
      anthropic: {
        modelParameters: {
          "*": {
            custom_knob: 40,
          },
        },
      },
    });

    spyOn(providerOptionsModule, "buildProviderOptions").mockReturnValue({
      anthropic: {
        thinking: { type: "enabled" },
      },
    });

    const startStreamArgs = await streamAndGetStartStreamArgs(harness, workspaceId);
    expect(providerOptionsFromStartStreamCall(startStreamArgs)).toEqual({
      anthropic: {
        custom_knob: 40,
        thinking: { type: "enabled" },
      },
    });
  });

  it("merges routed OpenAI provider extras under the active route namespace", async () => {
    using muxHome = new DisposableTempDir("ai-service-model-overrides-routed-openai");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-model-overrides-routed-openai";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata, { routeProvider: "openrouter" });

    const providerModelFactory = Reflect.get(
      harness.service,
      "providerModelFactory"
    ) as ProviderModelFactory;
    const fakeModel = Object.create(null) as LanguageModel;
    spyOn(providerModelFactory, "resolveAndCreateModel").mockResolvedValue({
      success: true,
      data: {
        model: fakeModel,
        effectiveModelString: "openrouter:openai/gpt-5.2",
        canonicalModelString: "openai:gpt-5.2",
        canonicalProviderName: "openai",
        canonicalModelId: "gpt-5.2",
        routedThroughGateway: false,
        routeProvider: "openrouter",
      },
    });

    spyOn(harness.config, "loadProvidersConfig").mockReturnValue({
      openai: {
        modelParameters: {
          "*": {
            reasoning: { max_tokens: 4096 },
          },
        },
      },
    });

    spyOn(providerOptionsModule, "buildProviderOptions").mockReturnValue({
      openrouter: {
        reasoning: {
          enabled: true,
          effort: "medium",
          exclude: false,
        },
      },
    });

    const startStreamArgs = await streamAndGetStartStreamArgs(
      harness,
      workspaceId,
      "openai:gpt-5.2"
    );
    expect(providerOptionsFromStartStreamCall(startStreamArgs)).toEqual({
      openrouter: {
        reasoning: {
          max_tokens: 4096,
          enabled: true,
          effort: "medium",
          exclude: false,
        },
      },
    });
  });

  it("passes empty call settings overrides when providers config is empty", async () => {
    using muxHome = new DisposableTempDir("ai-service-model-overrides-empty");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-model-overrides-empty";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    spyOn(harness.config, "loadProvidersConfig").mockReturnValue({});

    const startStreamArgs = await streamAndGetStartStreamArgs(harness, workspaceId);
    expect(startStreamArgs[20]).toEqual({});
  });

  it("preserves Mux-built provider options when provider extras conflict", async () => {
    using muxHome = new DisposableTempDir("ai-service-model-overrides-conflict");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-model-overrides-conflict";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    spyOn(harness.config, "loadProvidersConfig").mockReturnValue({
      anthropic: {
        modelParameters: {
          "*": {
            thinking: { type: "disabled" },
            custom_knob: 10,
          },
        },
      },
    });

    spyOn(providerOptionsModule, "buildProviderOptions").mockReturnValue({
      anthropic: {
        thinking: { type: "enabled" },
        sendReasoning: true,
      },
    });

    const startStreamArgs = await streamAndGetStartStreamArgs(harness, workspaceId);
    expect(providerOptionsFromStartStreamCall(startStreamArgs)).toEqual({
      anthropic: {
        custom_knob: 10,
        thinking: { type: "enabled" },
        sendReasoning: true,
      },
    });
  });

  it("deep-merges nested provider extras with Mux-built options", async () => {
    using muxHome = new DisposableTempDir("ai-service-model-overrides-nested");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-model-overrides-nested";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    // Override to OpenRouter provider
    const providerModelFactory = Reflect.get(
      harness.service,
      "providerModelFactory"
    ) as ProviderModelFactory;
    const fakeModel = Object.create(null) as LanguageModel;
    spyOn(providerModelFactory, "resolveAndCreateModel").mockResolvedValue({
      success: true,
      data: {
        model: fakeModel,
        effectiveModelString: "openrouter:deepseek/deepseek-r1",
        canonicalModelString: "openrouter:deepseek/deepseek-r1",
        canonicalProviderName: "openrouter",
        canonicalModelId: "deepseek/deepseek-r1",
        routedThroughGateway: false,
      },
    });

    spyOn(harness.config, "loadProvidersConfig").mockReturnValue({
      openrouter: {
        modelParameters: {
          "*": {
            reasoning: { max_tokens: 4096 },
          },
        },
      },
    });

    spyOn(providerOptionsModule, "buildProviderOptions").mockReturnValue({
      openrouter: {
        reasoning: {
          enabled: true,
          effort: "high",
          exclude: false,
        },
      },
    });

    const startStreamArgs = await streamAndGetStartStreamArgs(
      harness,
      workspaceId,
      "openrouter:deepseek/deepseek-r1"
    );
    expect(providerOptionsFromStartStreamCall(startStreamArgs)).toEqual({
      openrouter: {
        reasoning: {
          max_tokens: 4096,
          enabled: true,
          effort: "high",
          exclude: false,
        },
      },
    });
  });

  it("Mux values win on nested leaf conflicts during deep merge", async () => {
    using muxHome = new DisposableTempDir("ai-service-model-overrides-nested-conflict");
    const projectPath = path.join(muxHome.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const workspaceId = "workspace-model-overrides-nested-conflict";
    const metadata = createLocalWorkspaceMetadata(workspaceId, projectPath);
    const harness = createHarness(muxHome.path, metadata);

    // Override to OpenRouter provider
    const providerModelFactory = Reflect.get(
      harness.service,
      "providerModelFactory"
    ) as ProviderModelFactory;
    const fakeModel = Object.create(null) as LanguageModel;
    spyOn(providerModelFactory, "resolveAndCreateModel").mockResolvedValue({
      success: true,
      data: {
        model: fakeModel,
        effectiveModelString: "openrouter:deepseek/deepseek-r1",
        canonicalModelString: "openrouter:deepseek/deepseek-r1",
        canonicalProviderName: "openrouter",
        canonicalModelId: "deepseek/deepseek-r1",
        routedThroughGateway: false,
      },
    });

    spyOn(harness.config, "loadProvidersConfig").mockReturnValue({
      openrouter: {
        modelParameters: {
          "*": {
            reasoning: { enabled: false, max_tokens: 4096 },
          },
        },
      },
    });

    spyOn(providerOptionsModule, "buildProviderOptions").mockReturnValue({
      openrouter: {
        reasoning: {
          enabled: true,
          effort: "high",
          exclude: false,
        },
      },
    });

    const startStreamArgs = await streamAndGetStartStreamArgs(
      harness,
      workspaceId,
      "openrouter:deepseek/deepseek-r1"
    );
    expect(providerOptionsFromStartStreamCall(startStreamArgs)).toEqual({
      openrouter: {
        reasoning: {
          max_tokens: 4096,
          enabled: true,
          effort: "high",
          exclude: false,
        },
      },
    });
  });
});

describe("normalizeAnthropicBaseURL", () => {
  it("appends /v1 to URLs without it", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://custom-proxy.com")).toBe(
      "https://custom-proxy.com/v1"
    );
  });

  it("preserves URLs already ending with /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://custom-proxy.com/v1")).toBe(
      "https://custom-proxy.com/v1"
    );
  });

  it("removes trailing slashes before appending /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/")).toBe(
      "https://api.anthropic.com/v1"
    );
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com///")).toBe(
      "https://api.anthropic.com/v1"
    );
  });

  it("removes trailing slash after /v1", () => {
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1"
    );
  });

  it("handles URLs with ports", () => {
    expect(normalizeAnthropicBaseURL("http://localhost:8080")).toBe("http://localhost:8080/v1");
    expect(normalizeAnthropicBaseURL("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
  });

  it("handles URLs with paths that include v1 in the middle", () => {
    // This should still append /v1 because the path doesn't END with /v1
    expect(normalizeAnthropicBaseURL("https://proxy.com/api/v1-beta")).toBe(
      "https://proxy.com/api/v1-beta/v1"
    );
  });
});

describe("buildAppAttributionHeaders", () => {
  it("adds both headers when no headers exist", () => {
    expect(buildAppAttributionHeaders(undefined)).toEqual({
      "HTTP-Referer": MUX_APP_ATTRIBUTION_URL,
      "X-Title": MUX_APP_ATTRIBUTION_TITLE,
    });
  });

  it("adds only the missing header when one is present", () => {
    const existing = { "HTTP-Referer": "https://example.com" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual({
      "HTTP-Referer": "https://example.com",
      "X-Title": MUX_APP_ATTRIBUTION_TITLE,
    });
  });

  it("does not overwrite existing values (case-insensitive)", () => {
    const existing = { "http-referer": "https://example.com", "X-TITLE": "My App" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual(existing);
  });

  it("preserves unrelated headers", () => {
    const existing = { "x-custom": "value" };
    const result = buildAppAttributionHeaders(existing);
    expect(result).toEqual({
      "x-custom": "value",
      "HTTP-Referer": MUX_APP_ATTRIBUTION_URL,
      "X-Title": MUX_APP_ATTRIBUTION_TITLE,
    });
  });

  it("does not mutate the input object", () => {
    const existing = { "x-custom": "value" };
    const existingSnapshot = { ...existing };

    buildAppAttributionHeaders(existing);

    expect(existing).toEqual(existingSnapshot);
  });
});

describe("discoverAvailableSubagentsForToolContext", () => {
  it("includes derived agents that inherit subagent.runnable from base", async () => {
    using project = new DisposableTempDir("available-subagents");
    using muxHome = new DisposableTempDir("available-subagents-home");

    const agentsRoot = path.join(project.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    // Derived agent: base exec but no explicit subagent.runnable.
    await fs.writeFile(
      path.join(agentsRoot, "custom.md"),
      `---\nname: Custom Exec Derivative\nbase: exec\n---\nBody\n`,
      "utf-8"
    );

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(muxHome.path).loadConfigOrDefault();

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoot: agentsRoot,
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
    });

    const custom = availableSubagents.find((agent) => agent.id === "custom");
    expect(custom).toBeDefined();
    expect(custom?.subagentRunnable).toBe(true);

    // Ensure the task tool description includes the derived agent in the runnable sub-agent list.
    const taskTool = createTaskTool({
      ...createTestToolConfig(project.path, { workspaceId: "test-workspace" }),
      availableSubagents,
    });

    const description = (taskTool as unknown as { description?: unknown }).description;
    expect(typeof description).toBe("string");
    if (typeof description === "string") {
      expect(description).toContain("Available sub-agents");
      expect(description).toContain("- custom");
    }
  });

  it("filters the desktop agent when capability is unavailable", async () => {
    using project = new DisposableTempDir("available-subagents-desktop");
    using muxHome = new DisposableTempDir("available-subagents-desktop-home");

    const agentsRoot = path.join(project.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });
    await fs.writeFile(
      path.join(agentsRoot, "plain.md"),
      `---\nname: Plain Agent\nbase: exec\n---\nBody\n`,
      "utf-8"
    );

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(muxHome.path).loadConfigOrDefault();
    const loadDesktopCapability = mock(() =>
      Promise.resolve({
        available: false as const,
        reason: "unsupported_runtime" as const,
      })
    );

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoot: agentsRoot,
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
      loadDesktopCapability,
    });

    // The built-in `desktop` agent should be filtered out when capability is unavailable.
    expect(availableSubagents.find((agent) => agent.id === "desktop")).toBeUndefined();
    expect(availableSubagents.find((agent) => agent.id === "plain")?.subagentRunnable).toBe(true);
  });

  it("keeps the desktop agent when capability is available", async () => {
    using project = new DisposableTempDir("available-subagents-desktop-enabled");
    using muxHome = new DisposableTempDir("available-subagents-desktop-enabled-home");

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(muxHome.path).loadConfigOrDefault();
    const loadDesktopCapability = mock(() =>
      Promise.resolve({
        available: true as const,
        width: 1440,
        height: 900,
        sessionId: "desktop:test-workspace",
      })
    );

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoot: path.join(project.path, "empty-project-agents"),
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
      loadDesktopCapability,
    });

    expect(availableSubagents.find((agent) => agent.id === "desktop")?.subagentRunnable).toBe(true);
  });

  it("keeps a project-scope `desktop.md` override even when capability is unavailable", async () => {
    using project = new DisposableTempDir("available-subagents-desktop-override");
    using muxHome = new DisposableTempDir("available-subagents-desktop-override-home");

    const agentsRoot = path.join(project.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });
    // A user-defined `desktop` agent that does not need real desktop capability.
    // The built-in same-name agent should be shadowed by this project-scope override;
    // the runtime gate must not hide the override just because it shares the `desktop` id.
    await fs.writeFile(
      path.join(agentsRoot, "desktop.md"),
      `---\nname: Custom Desktop\nbase: exec\nsubagent:\n  runnable: true\n---\nBody\n`,
      "utf-8"
    );

    const runtime = new LocalRuntime(project.path);
    const cfg = new Config(muxHome.path).loadConfigOrDefault();
    const loadDesktopCapability = mock(() =>
      Promise.resolve({
        available: false as const,
        reason: "unsupported_runtime" as const,
      })
    );

    const availableSubagents = await discoverAvailableSubagentsForToolContext({
      runtime,
      workspacePath: project.path,
      cfg,
      roots: {
        projectRoot: agentsRoot,
        globalRoot: path.join(project.path, "empty-global-agents"),
      },
      loadDesktopCapability,
    });

    const desktop = availableSubagents.find((agent) => agent.id === "desktop");
    expect(desktop).toBeDefined();
    expect(desktop?.scope).toBe("project");
    expect(desktop?.subagentRunnable).toBe(true);
  });
});
