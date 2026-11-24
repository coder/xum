import * as fs from "fs/promises";
import { EventEmitter } from "events";

import assert from "@/common/utils/assert";
import { type LanguageModel, type Tool } from "ai";

import { linkAbortSignal } from "@/node/utils/abort";
import { ensurePrivateDir } from "@/node/utils/fs";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";

import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import {
  ADVISOR_DEFAULT_MAX_USES_PER_TURN,
  resolveAdvisorEnabledForAgent,
} from "@/common/constants/advisor";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";

import type { GoalRecordV1 } from "@/common/types/goal";
import type { ModelMessage, MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import { StreamManager, type ModelFallbackOptions, type StreamTextOnChunk } from "./streamManager";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import type { InitStateManager } from "./initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import {
  getToolsForModel,
  type AdvisorStepCaptureRef,
  type ToolConfiguration,
} from "@/common/utils/tools/tools";
import { getGoalToolAvailability } from "@/common/utils/tools/toolAvailability";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
} from "@/node/runtime/runtimeHelpers";
import { getWorkspacePathHintForProject } from "@/node/services/workspaceProjectRepos";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { getMuxEnv, getRuntimeType } from "@/node/runtime/initHook";
import { getSrcBaseDir, isSSHRuntime } from "@/common/types/runtime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { secretsToRecord, type ExternalSecretResolver } from "@/common/types/secrets";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { MuxToolScope } from "@/common/types/toolScope";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { FileState, EditedFileAttachment } from "@/node/services/agentSession";
import { log } from "./log";
import {
  addInterruptedSentinel,
  filterEmptyAssistantMessages,
} from "@/browser/utils/messages/modelMessageTransform";
import type { PostCompactionAttachment } from "@/common/types/attachment";

import type { HistoryService } from "./historyService";
import { delegatedToolCallManager } from "./delegatedToolCallManager";
import { createErrorEvent, formatSendMessageError } from "./utils/sendMessageError";
import { resolveWorkspaceModelFallbackChain } from "@/node/services/taskUtils";
import { createAssistantMessageId } from "./utils/messageIds";
import type { SessionUsageService } from "./sessionUsageService";
import { sumUsageHistory, getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { extractChunkDeltaText } from "@/common/utils/ai/streamChunks";
import { readToolInstructions } from "./systemMessage";
import {
  effectiveAdditionalSystemContext,
  mergeAdditionalSystemInstructions,
  readAdditionalSystemContext,
} from "./additionalSystemContext";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";

import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { MCPServerManager, MCPWorkspaceStats } from "@/node/services/mcpServerManager";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";
import type { TaskService } from "@/node/services/taskService";
import {
  resolveMemoryProjectIdentity,
  type MemoryService,
  type MemorySessionContext,
} from "@/node/services/memoryService";
import { formatHotMemoriesBlock } from "@/node/services/memoryHotSet";
import { resolveMemoryAccessPolicy } from "@/node/services/tools/memory";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import {
  buildProviderOptions,
  buildRequestHeaders,
  resolveProviderOptionsNamespaceKey,
} from "@/common/utils/ai/providerOptions";
import { resolveModelParameterOverrides } from "@/common/utils/ai/modelParameterOverrides";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import { uniqueSuffix } from "@/common/utils/hasher";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";

import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults } from "@/constants/goals";
import { mergeGoalDefaults } from "@/common/utils/goals/resolveGoalSetIntent";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import {
  THINKING_LEVEL_OFF,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import {
  enforceThinkingPolicy,
  isXaiGrokFastVariantSwap,
  resolveEffectiveThinkingLevel,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";
import type {
  ActiveTurnThinkingOverride,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";

import type {
  ErrorEvent,
  StreamAbortEvent,
  StreamAbortReason,
  StreamEndEvent,
} from "@/common/types/stream";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import {
  computeActiveToolNames,
  prepareToolSearch,
  rebuildToolSearchState,
  seedToolSearchActivationsFromMessages,
  TOOL_SEARCH_TOOL_NAME,
  type ToolSearchRuntime,
} from "@/common/utils/tools/toolCatalog";
import type { PTCEventWithParent } from "@/node/services/tools/code_execution";
import { MockAiStreamPlayer } from "./mock/mockAiStreamPlayer";
import { DEVTOOLS_RUN_METADATA_ID_HEADER } from "./devToolsHeaderCapture";
import { ProviderModelFactory, modelCostsIncluded } from "./providerModelFactory";
import { prepareMessagesForProvider } from "./messagePipeline";
import { getLegacyModeForAgentMetadata, resolveAgentForStream } from "./agentResolution";
import { buildPlanInstructions, buildStreamSystemContext } from "./streamContextBuilder";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import {
  simulateContextLimitError,
  simulateToolPolicyNoop,
  type SimulationContext,
} from "./streamSimulation";
import { applyToolPolicyAndExperiments, captureMcpToolTelemetry } from "./toolAssembly";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubsetSchema } from "@/common/utils/jsonSchemaSubset";
import { filterSideQuestionMessages } from "@/common/utils/messages/sideQuestion";
import { isTerminalWorkflowRunStatus } from "@/common/types/workflow";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  buildWorkflowResultContextMessage,
  filterWorkflowDisplayOnlyMessages,
} from "@/common/utils/workflowRunMessages";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import {
  WorkflowService,
  type WorkflowRunStatusChangedEvent,
} from "@/node/services/workflows/WorkflowService";
import {
  DEFAULT_WORKFLOW_AGENT_ID,
  WorkflowTaskServiceAdapter,
} from "@/node/services/workflows/WorkflowTaskServiceAdapter";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";

const STREAM_STARTUP_DIAGNOSTIC_THRESHOLD_MS = 1_000;

export function prepareProviderRequestMessages(
  messages: MuxMessage[],
  canonicalProviderName: string,
  effectiveThinkingLevel: ThinkingLevel
): {
  activeContextMessages: MuxMessage[];
  providerRequestMessages: MuxMessage[];
  sideQuestionFilteredCount: number;
  contextBoundarySlicedCount: number;
} {
  // /btw side questions and workflow display rows are durable UI history, not main-agent context.
  // Filter them before boundary slicing so future normal turns don't see UI-only artifacts.
  const messagesWithoutSideQuestions = filterSideQuestionMessages(messages);
  const messagesWithoutWorkflowDisplay = filterWorkflowDisplayOnlyMessages(
    messagesWithoutSideQuestions
  );
  const sideQuestionFilteredCount = messages.length - messagesWithoutSideQuestions.length;
  const activeContextMessages = sliceMessagesForProviderFromLatestContextBoundary(
    messagesWithoutWorkflowDisplay
  );
  const contextBoundarySlicedCount =
    messagesWithoutWorkflowDisplay.length - activeContextMessages.length;
  const preserveReasoningOnly =
    canonicalProviderName === "anthropic" && effectiveThinkingLevel !== "off";
  return {
    activeContextMessages,
    providerRequestMessages: filterEmptyAssistantMessages(
      activeContextMessages,
      preserveReasoningOnly
    ),
    sideQuestionFilteredCount,
    contextBoundarySlicedCount,
  };
}

function replaceOrAppendMessageById(messages: MuxMessage[], replacement: MuxMessage): MuxMessage[] {
  const index = messages.findIndex((message) => message.id === replacement.id);
  if (index === -1) {
    return [...messages, replacement];
  }

  const next = [...messages];
  next[index] = replacement;
  return next;
}

// ---------------------------------------------------------------------------
// streamMessage options
// ---------------------------------------------------------------------------

/** Options bag for {@link AIService.streamMessage}. */
export interface StreamMessageOptions {
  messages: MuxMessage[];
  workspaceId: string;
  modelString: string;
  thinkingLevel?: ThinkingLevel;
  /** OpenAI pro reasoning mode; delivered via provider options (inert for unsupported models). */
  reasoningMode?: OpenAIReasoningMode;
  toolPolicy?: ToolPolicy;
  abortSignal?: AbortSignal;
  /** Live workspace scratchpad snapshot from the renderer; when present it wins over disk. */
  additionalSystemContext?: string;
  additionalSystemInstructions?: string;
  maxOutputTokens?: number;
  muxProviderOptions?: MuxProviderOptions;
  /** Internal-only flag for Copilot billing attribution; never sourced from IPC schemas. */
  agentInitiated?: boolean;
  agentId?: string;
  /** ACP prompt correlation id used to match stream events to a specific request. */
  acpPromptId?: string;
  /** Tool names that should be delegated back to ACP clients for this request. */
  delegatedToolNames?: string[];
  recordFileState?: (filePath: string, state: FileState) => Promise<void>;
  changedFileAttachments?: EditedFileAttachment[];
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  /**
   * Resolver for the session-segment memory context (memory experiment):
   * index snapshot for the memory tool description + hot-memories block.
   * AgentSession caches the result per model/session segment because hot-memory
   * selection is token-budgeted with the active model tokenizer. A callback
   * (not a pre-resolved value) because it must be computed after
   * runtime.ensureReady(): project-scope listing on a
   * stopped Docker/remote workspace would otherwise cache an empty/partial
   * context for the whole segment.
   */
  resolveMemoryContext?: (
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ) => Promise<MemorySessionContext | undefined>;
  experiments?: SendMessageOptions["experiments"];
  allowAgentSetGoal?: boolean;
  workspaceGoalService?: WorkspaceGoalService;
  disableWorkspaceAgents?: boolean;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  muxMetadata?: MuxMessageMetadata;
  openaiTruncationModeOverride?: "auto" | "disabled";
  /**
   * Model floor already resolved by AgentSession (config.json
   * minThinkingLevelByModel → resolveMinimumThinkingLevel). Passed down so
   * mid-turn overrides clamp against the same floor as the send-time level;
   * internal callers may omit it (re-resolved from defaults).
   */
  minThinkingLevel?: ThinkingLevel;
  /**
   * Session-owned per-turn holder for mid-turn thinking-level overrides.
   * When absent (compaction, sub-agent paths), the feature is inert for the
   * stream. See src/node/services/thinkingOverride.ts.
   */
  activeTurnThinkingOverride?: ActiveTurnThinkingOverride;
}

/**
 * Recursively merge user-provided provider extras under Mux-built provider options.
 * Mux values win on leaf conflicts; both sides' non-conflicting nested fields are preserved.
 */
function mergeProviderExtrasUnderMux(
  providerExtras: Record<string, unknown>,
  muxProviderNamespace: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...providerExtras };

  for (const [key, muxValue] of Object.entries(muxProviderNamespace)) {
    const extraValue = merged[key];
    merged[key] =
      isPlainObject(extraValue) && isPlainObject(muxValue)
        ? mergeProviderExtrasUnderMux(extraValue, muxValue)
        : muxValue;
  }

  return merged;
}

function markProviderMetadataCostsIncluded(
  providerMetadata: Record<string, unknown> | undefined,
  costsIncluded: boolean | undefined
): Record<string, unknown> | undefined {
  if (!costsIncluded) {
    return providerMetadata;
  }

  const muxMetadata = providerMetadata?.mux;
  const existingMux =
    muxMetadata && typeof muxMetadata === "object"
      ? (muxMetadata as Record<string, unknown>)
      : undefined;

  return {
    ...(providerMetadata ?? {}),
    mux: {
      ...(existingMux ?? {}),
      costsIncluded: true,
    },
  };
}

const WORKFLOW_CONTINUATION_RETRY_DELAY_MS = 1_000;
const WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE = "Workspace is busy; idle-only send was skipped.";

function isWorkspaceBusyIdleOnlySend(error: SendMessageError): boolean {
  return error.type === "unknown" && error.raw.includes(WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE);
}

function waitForWorkflowContinuationRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WORKFLOW_CONTINUATION_RETRY_DELAY_MS));
}

interface ToolExecutionContext {
  toolCallId?: string;
  abortSignal?: AbortSignal;
}

function isToolExecutionContext(value: unknown): value is ToolExecutionContext {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const toolCallId = record.toolCallId;
  const abortSignal = record.abortSignal;

  const validToolCallId = toolCallId == null || typeof toolCallId === "string";
  const validAbortSignal = abortSignal == null || abortSignal instanceof AbortSignal;

  return validToolCallId && validAbortSignal;
}

/**
 * Derive the host-local project root for mux managed-file tools (fs/promises).
 * Remote runtimes (ssh, docker) have a workspacePath that is a remote/container
 * path — unusable by host fs. Fall back to metadata.projectPath which is always
 * host-local.
 */
export function resolveMuxProjectRootForHostFs(
  metadata: WorkspaceMetadata,
  workspacePath: string
): string {
  const runtimeType = metadata.runtimeConfig.type;
  return runtimeType === "ssh" || runtimeType === "docker" ? metadata.projectPath : workspacePath;
}

function resolveMuxToolScope(
  config: Config,
  metadata: WorkspaceMetadata,
  workspacePath: string
): MuxToolScope {
  const projectConfig = config.loadConfigOrDefault().projects.get(metadata.projectPath);
  if (
    projectConfig?.projectKind === "system" &&
    metadata.projectPath !== MULTI_PROJECT_CONFIG_KEY
  ) {
    // Preserve ~/.mux-backed tool behavior for legacy system workspaces after removing
    // Chat with Mux. Multi-project workspaces still point at a real checkout under _multi,
    // so they stay project-scoped.
    return {
      type: "global",
      muxHome: config.rootDir,
    };
  }

  const runtimeType = metadata.runtimeConfig.type;
  return {
    type: "project",
    muxHome: config.rootDir,
    projectRoot: resolveMuxProjectRootForHostFs(metadata, workspacePath),
    projectStorageAuthority:
      runtimeType === "ssh" || runtimeType === "docker" ? "runtime" : "host-local",
  };
}

function derivePromptCacheScope(metadata: WorkspaceMetadata): string {
  return `${metadata.projectName}-${uniqueSuffix([metadata.projectPath])}`;
}

interface WorkflowResultContinuationSender {
  isWorkflowInvocationCurrent(workspaceId: string, runId: string): Promise<boolean>;
  sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions,
    internal?: {
      skipAutoResumeReset?: boolean;
      synthetic?: boolean;
      agentInitiated?: boolean;
      /** When true, reject instead of queueing if the workspace is busy. */
      requireIdle?: boolean;
      startStreamInBackground?: boolean;
    }
  ): Promise<Result<void, SendMessageError>>;
}

export class AIService extends EventEmitter {
  private readonly streamManager: StreamManager;
  private readonly historyService: HistoryService;
  private readonly config: Config;
  private readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  private mcpServerManager?: MCPServerManager;
  private readonly policyService?: PolicyService;
  private readonly telemetryService?: TelemetryService;
  private readonly opResolver?: ExternalSecretResolver;
  private readonly initStateManager: InitStateManager;
  private mockModeEnabled: boolean;
  private mockAiStreamPlayer?: MockAiStreamPlayer;
  private readonly backgroundProcessManager?: BackgroundProcessManager;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly providerService: ProviderService;
  private readonly providerModelFactory: ProviderModelFactory;
  private readonly devToolsService?: DevToolsService;
  private readonly experimentsService?: ExperimentsService;

  // Tracks in-flight stream startup (before StreamManager emits stream-start).
  // This enables user interrupts (Esc/Ctrl+C) during the UI "starting..." phase.
  private readonly pendingStreamStarts = new Map<
    string,
    {
      abortController: AbortController;
      startTime: number;
      syntheticMessageId: string;
      acpPromptId?: string;
    }
  >();

  /**
   * Tracks queued DevTools run metadata by assistant message id so stream-end/abort
   * can clear orphaned entries when a stream starts but never reaches middleware run creation.
   */
  private readonly pendingDevToolsRunMetadataByMessageId = new Map<
    string,
    { workspaceId: string; metadataId: string }
  >();

  // Debug: captured LLM request payloads for last send per workspace
  private lastLlmRequestByWorkspace = new Map<string, DebugLlmRequestSnapshot>();
  private taskService?: TaskService;
  private memoryService?: MemoryService;
  private timelineService?: ToolConfiguration["timelineService"];
  private extraTools?: Record<string, Tool>;
  private onWorkflowRunStatusChanged?: (
    event: WorkflowRunStatusChangedEvent
  ) => Promise<void> | void;
  private workflowResultContinuationSender?: WorkflowResultContinuationSender;
  private workspaceHeartbeatService?: ToolConfiguration["workspaceHeartbeatService"];
  private analyticsService?: { executeRawQuery(sql: string): Promise<unknown> };
  private desktopSessionManager?: DesktopSessionManager;

  constructor(
    config: Config,
    historyService: HistoryService,
    initStateManager: InitStateManager,
    providerService: ProviderService,
    backgroundProcessManager?: BackgroundProcessManager,
    sessionUsageService?: SessionUsageService,
    workspaceMcpOverridesService?: WorkspaceMcpOverridesService,
    policyService?: PolicyService,
    telemetryService?: TelemetryService,
    devToolsService?: DevToolsService,
    opResolver?: ExternalSecretResolver,
    experimentsService?: ExperimentsService
  ) {
    super();
    // Increase max listeners to accommodate multiple concurrent workspace listeners
    // Each workspace subscribes to stream events, and we expect >10 concurrent workspaces
    this.setMaxListeners(50);
    this.workspaceMcpOverridesService =
      workspaceMcpOverridesService ?? new WorkspaceMcpOverridesService(config);
    this.config = config;
    this.historyService = historyService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.sessionUsageService = sessionUsageService;
    this.policyService = policyService;
    this.telemetryService = telemetryService;
    this.opResolver = opResolver;
    this.experimentsService = experimentsService;
    this.providerService = providerService;
    this.streamManager = new StreamManager(historyService, sessionUsageService, () =>
      this.providerService.getConfig()
    );
    this.devToolsService = devToolsService;
    this.providerModelFactory = new ProviderModelFactory(
      config,
      providerService,
      policyService,
      undefined,
      devToolsService,
      opResolver
    );
    void this.ensureSessionsDir();
    this.setupStreamEventForwarding();
    this.mockModeEnabled = false;

    if (process.env.MUX_MOCK_AI === "1") {
      log.info("AIService running in MUX_MOCK_AI mode");
      this.enableMockMode();
    }
  }

  setCodexOauthService(service: CodexOauthService): void {
    this.providerModelFactory.codexOauthService = service;
  }
  setMCPServerManager(manager: MCPServerManager): void {
    this.mcpServerManager = manager;
    this.streamManager.setMCPServerManager(manager);
  }

  setTaskService(taskService: TaskService): void {
    this.taskService = taskService;
  }

  setWorkspaceHeartbeatService(
    service: NonNullable<ToolConfiguration["workspaceHeartbeatService"]>
  ): void {
    this.workspaceHeartbeatService = service;
  }

  setMemoryService(memoryService: MemoryService): void {
    this.memoryService = memoryService;
  }

  setTimelineService(timelineService: NonNullable<ToolConfiguration["timelineService"]>): void {
    this.timelineService = timelineService;
  }

  /**
   * Whether a global experiment is enabled. False when no ExperimentsService was
   * provided (lightweight test setups). Exposed so collaborators constructed with
   * an AIService reference (e.g. AgentSession) can gate experiment-only behavior
   * without threading ExperimentsService through every constructor.
   */
  isExperimentEnabled(experimentId: ExperimentId): boolean {
    return this.experimentsService?.isExperimentEnabled(experimentId) === true;
  }

  /**
   * Whether the user explicitly enabled an experiment via local override.
   * Unlike isExperimentEnabled, remote assignment can never satisfy this gate —
   * required for security-sensitive experiments (see
   * ExperimentsService.isExperimentLocallyEnabled).
   */
  isExperimentLocallyEnabled(experimentId: ExperimentId): boolean {
    return this.experimentsService?.isExperimentLocallyEnabled(experimentId) === true;
  }

  /**
   * Build the session-segment memory context: the index snapshot advertised
   * in the memory tool description, plus the hot-memories block (pinned +
   * frequently used memory files; memory-hot-set sub-experiment). Returns
   * null when the memory experiment is off.
   *
   * Callers (AgentSession) cache the result per model and recompute it only
   * on the first use of a model in a session segment, or at compaction
   * boundaries, so repeated turns keep prompt-cache-stable bytes. Memories
   * written mid-segment surface in the next segment's index for cached models
   * (the writing agent already has its own tool calls in context, and `view`
   * lists live state).
   */
  async buildMemorySessionContext(
    workspaceId: string,
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ): Promise<MemorySessionContext | null> {
    if (!this.memoryService) return null;
    if (this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY) !== true) {
      return null;
    }
    try {
      const metadataResult = await this.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) return null;
      const metadata = metadataResult.data;
      const runtime = createRuntimeForWorkspace(metadata);
      const ctx = {
        runtime,
        checkoutCwd: "",
        workspaceId,
        // Stable per-project identity (handles multi-project workspaces); ""
        // disables project memory when no single project identity exists.
        projectPath: resolveMemoryProjectIdentity(metadata),
      };
      const indexEntries = await this.memoryService.listIndexEntries(ctx);
      // Hot preloading is a sub-experiment: without it, memories stay
      // pull-based like skills (index only, contents fetched on demand).
      let hotMemoriesBlock: string | null = null;
      if (
        options?.includeHotMemories !== false &&
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY_HOT_SET) === true
      ) {
        try {
          const metadataModel = resolveModelForMetadata(
            modelString,
            this.providerService.getConfig()
          );
          const tokenizer = await getTokenizerForModel(modelString, metadataModel);
          const items = await this.memoryService.listHotMemories(ctx, {
            countTokens: (text) => tokenizer.countTokens(text),
          });
          hotMemoriesBlock = items.length === 0 ? null : formatHotMemoriesBlock(items);
        } catch (error) {
          // Hot preloading is best-effort context. Preserve the pull-based
          // memory index when tokenizer setup or ranked selection fails.
          log.warn("Failed to build hot memories; continuing with memory index only", {
            workspaceId,
            error,
          });
        }
      }
      return { indexEntries, hotMemoriesBlock };
    } catch (error) {
      // Self-healing: memory context is best-effort, never a stream blocker.
      log.warn("Failed to build memory session context", { workspaceId, error });
      return null;
    }
  }

  setWorkflowRunStatusChangedHandler(
    handler: (event: WorkflowRunStatusChangedEvent) => Promise<void> | void
  ): void {
    this.onWorkflowRunStatusChanged = handler;
  }

  setWorkflowResultContinuationSender(sender: WorkflowResultContinuationSender): void {
    this.workflowResultContinuationSender = sender;
  }

  setAnalyticsService(service: { executeRawQuery(sql: string): Promise<unknown> }): void {
    this.analyticsService = service;
  }

  setDesktopSessionManager(desktopSessionManager: DesktopSessionManager): void {
    this.desktopSessionManager = desktopSessionManager;
  }

  getProvidersConfig(): ProvidersConfigMap | null {
    return this.providerService.getConfig();
  }

  /**
   * Set extra tools to include in every tool call.
   * Used by CLI to inject tools like set_exit_code without modifying core tool definitions.
   */
  setExtraTools(tools: Record<string, Tool>): void {
    this.extraTools = tools;
  }

  /**
   * Forward all stream events from StreamManager to AIService consumers
   */
  private setupStreamEventForwarding(): void {
    // Simple one-to-one event forwarding from StreamManager → AIService consumers
    for (const event of [
      "stream-start",
      "stream-delta",
      "tool-call-start",
      "tool-call-execution-start",
      "tool-call-delta",
      "tool-call-end",
      "reasoning-delta",
      "reasoning-end",
      "workflow-run-attached",
      "usage-delta",
    ] as const) {
      this.streamManager.on(event, (data) => this.emit(event, data));
    }

    // Stream errors can bypass stream-end/stream-abort. Clear any queued metadata
    // so failed requests don't leak pending-run tracking entries.
    this.streamManager.on("error", (data: ErrorEvent) => {
      this.clearTrackedPendingDevToolsRunMetadata(data.messageId);
      this.emit("error", data);
    });

    // stream-end needs extra logic: capture provider response for debug modal
    this.streamManager.on("stream-end", (data: StreamEndEvent) => {
      // Streams can end before DevTools middleware creates a run (for example when
      // interrupted early). Clear any still-queued run metadata for this message.
      this.clearTrackedPendingDevToolsRunMetadata(data.messageId);

      // Best-effort capture of the provider response for the "Last LLM request" debug modal.
      // Must never break live streaming.
      try {
        const snapshot = this.lastLlmRequestByWorkspace.get(data.workspaceId);
        if (snapshot) {
          // If messageId is missing (legacy fixtures), attach anyway.
          const shouldAttach = snapshot.messageId === data.messageId || snapshot.messageId == null;
          if (shouldAttach) {
            const updated: DebugLlmRequestSnapshot = {
              ...snapshot,
              response: {
                capturedAt: Date.now(),
                metadata: data.metadata,
                parts: data.parts,
              },
            };

            this.lastLlmRequestByWorkspace.set(data.workspaceId, structuredClone(updated));
          }
        }
      } catch (error) {
        const errMsg = getErrorMessage(error);
        log.warn("Failed to capture debug LLM response snapshot", { error: errMsg });
      }

      this.emit("stream-end", data);
    });

    // Handle stream-abort: dispose of partial based on abandonPartial flag
    this.streamManager.on("stream-abort", (data: StreamAbortEvent) => {
      // Aborts can happen before the first provider call reaches DevTools middleware.
      // Clear any queued run metadata for this message to avoid memory growth.
      this.clearTrackedPendingDevToolsRunMetadata(data.messageId);

      void (async () => {
        try {
          if (data.abandonPartial) {
            // Caller requested discarding partial - delete without committing
            await this.historyService.deletePartial(data.workspaceId);
          } else {
            // Commit interrupted message to history with partial:true metadata
            // This ensures /clear can clean up interrupted messages
            const partial = await this.historyService.readPartial(data.workspaceId);
            if (partial) {
              await this.historyService.commitPartial(data.workspaceId);
              await this.historyService.deletePartial(data.workspaceId);
            }
          }
        } catch (error) {
          log.error("Failed partial cleanup during stream-abort", {
            workspaceId: data.workspaceId,
            error: getErrorMessage(error),
          });
        } finally {
          // Always forward abort event to consumers (workspaceService, agentSession)
          // even if partial cleanup failed — stream lifecycle consistency is higher priority.
          this.emit("stream-abort", data);
        }
      })();
    });
  }

  private trackPendingDevToolsRunMetadata(
    messageId: string,
    workspaceId: string,
    metadataId: string
  ): void {
    assert(messageId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a messageId");
    assert(workspaceId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a workspaceId");
    assert(metadataId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a metadataId");

    this.pendingDevToolsRunMetadataByMessageId.set(messageId, {
      workspaceId,
      metadataId,
    });
  }

  private clearTrackedPendingDevToolsRunMetadata(messageId: string): void {
    // StreamManager can emit stream-abort with an empty messageId during startup races.
    // Treat that as "nothing to clear" instead of throwing so interruptStream remains reliable.
    if (messageId.trim().length === 0) {
      return;
    }

    const pending = this.pendingDevToolsRunMetadataByMessageId.get(messageId);
    if (!pending) {
      return;
    }

    this.pendingDevToolsRunMetadataByMessageId.delete(messageId);
    this.devToolsService?.clearPendingRunMetadata(pending.workspaceId, pending.metadataId);
  }

  private clearTrackedPendingDevToolsRunMetadataById(
    workspaceId: string,
    metadataId: string
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "clearTrackedPendingDevToolsRunMetadataById requires a workspaceId"
    );
    assert(
      metadataId.trim().length > 0,
      "clearTrackedPendingDevToolsRunMetadataById requires a metadataId"
    );

    for (const [messageId, pending] of this.pendingDevToolsRunMetadataByMessageId.entries()) {
      if (pending.workspaceId === workspaceId && pending.metadataId === metadataId) {
        this.pendingDevToolsRunMetadataByMessageId.delete(messageId);
        break;
      }
    }

    this.devToolsService?.clearPendingRunMetadata(workspaceId, metadataId);
  }

  private async shouldAllowLegacyInvalidWorkflowAgentOutputSchema(
    metadata: WorkspaceMetadata
  ): Promise<boolean> {
    const workflowTask = metadata.workflowTask;
    if (workflowTask?.outputSchema === undefined) {
      return false;
    }
    if (
      validateJsonSchemaSubsetSchema(workflowTask.outputSchema, { requireObjectSchema: true })
        .success
    ) {
      return false;
    }
    if (metadata.parentWorkspaceId == null) {
      return false;
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: this.config.getSessionDir(metadata.parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      return run.agentOutputSchemaRequired !== true;
    } catch (error) {
      log.debug("Could not determine legacy workflow agent_report schema policy", {
        workspaceId: metadata.id,
        workflowRunId: workflowTask.runId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await ensurePrivateDir(this.config.sessionsDir);
    } catch (error) {
      log.error("Failed to create sessions directory:", error);
    }
  }

  isMockModeEnabled(): boolean {
    return this.mockModeEnabled;
  }

  releaseMockStreamStartGate(workspaceId: string): void {
    this.mockAiStreamPlayer?.releaseStreamStartGate(workspaceId);
  }

  enableMockMode(): void {
    this.mockModeEnabled = true;

    this.mockAiStreamPlayer ??= new MockAiStreamPlayer({
      aiService: this,
      historyService: this.historyService,
    });
  }

  async getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>> {
    try {
      // Read from config.json (single source of truth)
      // getAllWorkspaceMetadata() handles migration from legacy metadata.json files
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const metadata = allMetadata.find((m) => m.id === workspaceId);

      if (!metadata) {
        return Err(
          `Workspace metadata not found for ${workspaceId}. Workspace may not be properly initialized.`
        );
      }

      return Ok(metadata);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to read workspace metadata: ${message}`);
    }
  }

  /**
   * Create an AI SDK model from a model string (e.g., "anthropic:claude-opus-4-1").
   * Delegates to ProviderModelFactory.
   */
  async createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<LanguageModel, SendMessageError>> {
    return this.providerModelFactory.createModel(modelString, muxProviderOptions, opts);
  }

  private wrapToolsForDelegation(
    workspaceId: string,
    tools: Record<string, Tool>,
    delegatedToolNames?: string[]
  ): Record<string, Tool> {
    const normalizedDelegatedTools =
      delegatedToolNames
        ?.map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0) ?? [];

    if (normalizedDelegatedTools.length === 0) {
      return tools;
    }

    const delegatedToolSet = new Set(normalizedDelegatedTools);
    const wrappedTools = { ...tools };

    for (const [toolName, tool] of Object.entries(tools)) {
      if (!delegatedToolSet.has(toolName)) {
        continue;
      }

      const toolRecord = tool as Record<string, unknown>;
      const execute = toolRecord.execute;
      if (typeof execute !== "function") {
        continue;
      }

      const wrappedTool = cloneToolPreservingDescriptors(tool);
      const wrappedToolRecord = wrappedTool as Record<string, unknown>;

      wrappedToolRecord.execute = async (_args: unknown, options: unknown) => {
        const executionContext = isToolExecutionContext(options) ? options : undefined;
        const toolCallId = executionContext?.toolCallId?.trim();

        if (executionContext == null || toolCallId == null || toolCallId.length === 0) {
          throw new Error(
            `Delegated tool '${toolName}' requires a non-empty toolCallId in execute context`
          );
        }

        const pendingResult = delegatedToolCallManager.registerPending(
          workspaceId,
          toolCallId,
          toolName
        );

        const abortSignal = executionContext.abortSignal;
        if (abortSignal == null) {
          return pendingResult;
        }

        if (abortSignal.aborted) {
          try {
            delegatedToolCallManager.cancel(workspaceId, toolCallId, "Interrupted");
          } catch {
            // no-op: pending may already have resolved
          }
          throw new Error("Interrupted");
        }

        let abortListener: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            try {
              delegatedToolCallManager.cancel(workspaceId, toolCallId, "Interrupted");
            } catch {
              // no-op: pending may already have resolved
            }
            reject(new Error("Interrupted"));
          };

          abortSignal.addEventListener("abort", abortListener, { once: true });
        });

        try {
          return await Promise.race([pendingResult, abortPromise]);
        } finally {
          if (abortListener != null) {
            abortSignal.removeEventListener("abort", abortListener);
          }
        }
      };

      wrappedTools[toolName] = wrappedTool;
    }

    return wrappedTools;
  }

  private getMultiProjectExecutionDisabledMessage(workspaceId: string): string {
    return `Workspace ${workspaceId} reached multi-project AI runtime execution while ${EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES} is disabled`;
  }

  private ensureMultiProjectRuntimeExecutionEnabled(
    workspaceId: string,
    metadata: WorkspaceMetadata
  ): Result<void, SendMessageError> {
    if (!isMultiProject(metadata)) {
      return Ok(undefined);
    }

    // Multi-project execution should already be gated before streamMessage reaches backend runtime
    // orchestration. If stale workspace ids or future callsites bypass those checks, fail closed
    // before constructing MultiProjectRuntime or loading shared-project secrets/tools.
    if (!this.experimentsService) {
      return Err({
        type: "unknown",
        raw: "AIService multi-project execution requires ExperimentsService to enforce the runtime gate",
      });
    }

    if (!this.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)) {
      return Err({
        type: "unknown",
        raw: this.getMultiProjectExecutionDisabledMessage(workspaceId),
      });
    }

    return Ok(undefined);
  }

  /**
   * Host-evaluated gate for the claude-skills-compat experiment: when enabled, skill
   * discovery/read paths also scan .claude/skills and ~/.claude/skills (read-only,
   * lowest precedence). Public so AgentSession's skill snapshot materialization can
   * resolve slash-invoked .claude skills with the same roots as discovery.
   */
  isClaudeSkillsCompatEnabled(): boolean {
    return (
      this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT) === true
    );
  }

  /** Stream a message conversation to the AI model. */
  async streamMessage(opts: StreamMessageOptions): Promise<Result<void, SendMessageError>> {
    const {
      messages,
      workspaceId,
      modelString,
      thinkingLevel,
      reasoningMode,
      toolPolicy,
      abortSignal,
      additionalSystemContext,
      additionalSystemInstructions,
      maxOutputTokens,
      muxProviderOptions,
      agentInitiated,
      agentId,
      acpPromptId,
      delegatedToolNames,
      recordFileState,
      changedFileAttachments,
      postCompactionAttachments,
      resolveMemoryContext,
      experiments,
      allowAgentSetGoal,
      workspaceGoalService,
      disableWorkspaceAgents,
      hasQueuedMessages,
      openaiTruncationModeOverride,
      muxMetadata,
      minThinkingLevel: providedMinThinkingLevel,
      activeTurnThinkingOverride,
    } = opts;
    // Support interrupts during startup (before StreamManager emits stream-start).
    // We register an AbortController up-front and let stopStream() abort it.
    const pendingAbortController = new AbortController();
    const startTime = Date.now();
    const syntheticMessageId = `starting-${startTime}-${Math.random().toString(36).substring(2, 11)}`;

    // Link external abort signal (if provided).
    const unlinkAbortSignal = linkAbortSignal(abortSignal, pendingAbortController);

    this.pendingStreamStarts.set(workspaceId, {
      abortController: pendingAbortController,
      startTime,
      syntheticMessageId,
      acpPromptId,
    });

    const combinedAbortSignal = pendingAbortController.signal;

    let pendingRunMetadataId: string | null = null;
    const startupPhaseTimingsMs: Record<string, number> = {};
    const recordStartupPhaseTiming = (phase: string, phaseStartedAt: number): void => {
      startupPhaseTimingsMs[phase] = Date.now() - phaseStartedAt;
    };
    let logSlowStreamStartup: ((details: Record<string, unknown>) => void) | undefined;

    try {
      if (this.mockModeEnabled && this.mockAiStreamPlayer) {
        await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
        if (combinedAbortSignal.aborted) {
          return Ok(undefined);
        }
        return await this.mockAiStreamPlayer.play(messages, workspaceId, {
          model: modelString,
          thinkingLevel,
          abortSignal: combinedAbortSignal,
        });
      }

      // DEBUG: Log streamMessage call
      const lastMessage = messages[messages.length - 1];
      log.debug(
        `[STREAM MESSAGE] workspaceId=${workspaceId} messageCount=${messages.length} lastRole=${lastMessage?.role}`
      );

      // Before starting a new stream, commit any existing partial to history
      // This is idempotent - won't double-commit if already in chat.jsonl
      const commitPartialStartedAt = Date.now();
      await this.historyService.commitPartial(workspaceId);
      recordStartupPhaseTiming("commitPartialMs", commitPartialStartedAt);

      // Helper: clean up an assistant placeholder that was appended to history but never
      // streamed (due to abort during setup). Used in two abort-check sites below.
      const deleteAbortedPlaceholder = async (messageId: string): Promise<void> => {
        const deleteResult = await this.historyService.deleteMessage(workspaceId, messageId);
        if (!deleteResult.success) {
          log.error(
            `Failed to delete aborted assistant placeholder (${messageId}): ${deleteResult.error}`
          );
        }
      };

      // Mode (plan|exec|compact) is derived from the selected agent definition.
      const effectiveMuxProviderOptions: MuxProviderOptions = muxProviderOptions ?? {};
      // Clamp away levels the provider rejects (Mythos-class Anthropic cannot
      // disable thinking) so provider options, replay transforms, and metadata
      // all agree with the provider's actual thinking behavior. Providers config
      // is passed so aliases mapped to Mythos models get the same treatment.
      const effectiveThinkingLevel: ThinkingLevel = resolveEffectiveThinkingLevel(
        modelString,
        thinkingLevel,
        this.providerService.getConfig()
      );

      // Resolve model string (xAI variant mapping + gateway routing) and create the model.
      const resolveAndCreateModelStartedAt = Date.now();
      const modelResult = await this.providerModelFactory.resolveAndCreateModel(
        modelString,
        effectiveThinkingLevel,
        effectiveMuxProviderOptions,
        { agentInitiated, workspaceId }
      );
      recordStartupPhaseTiming("resolveAndCreateModelMs", resolveAndCreateModelStartedAt);
      if (!modelResult.success) {
        return Err(modelResult.error);
      }
      const {
        effectiveModelString,
        canonicalModelString,
        canonicalProviderName,
        routedThroughGateway,
        routeProvider,
      } = modelResult.data;

      // Dump original messages for debugging
      log.debug_obj(`${workspaceId}/1_original_messages.json`, messages);

      // Context Boundary request slicing happens before empty-assistant filtering so
      // provider-invisible reset rows can still bound the active context window.
      const {
        activeContextMessages,
        providerRequestMessages,
        sideQuestionFilteredCount,
        contextBoundarySlicedCount,
      } = prepareProviderRequestMessages(messages, canonicalProviderName, effectiveThinkingLevel);
      if (sideQuestionFilteredCount > 0 || contextBoundarySlicedCount > 0) {
        log.debug("Prepared provider history window", {
          workspaceId,
          originalCount: messages.length,
          sideQuestionFilteredCount,
          contextBoundarySlicedCount,
          activeContextCount: activeContextMessages.length,
        });
      }
      log.debug_obj(`${workspaceId}/1a_active_context_messages.json`, activeContextMessages);
      log.debug(
        `Filtered ${activeContextMessages.length - providerRequestMessages.length} empty assistant messages`
      );
      log.debug_obj(`${workspaceId}/1b_provider_request_messages.json`, providerRequestMessages);

      // OpenAI-specific: Keep reasoning parts in history so each request can
      // carry forward reasoning context without relying on previous_response_id.
      if (canonicalProviderName === "openai") {
        log.debug("Keeping reasoning parts for OpenAI (managed via explicit history)");
      }
      // Add [CONTINUE] sentinel to partial messages (for model context)
      const messagesWithSentinel = addInterruptedSentinel(providerRequestMessages);

      // Get workspace metadata to retrieve workspace path
      const getWorkspaceMetadataStartedAt = Date.now();
      const metadataResult = await this.getWorkspaceMetadata(workspaceId);
      recordStartupPhaseTiming("getWorkspaceMetadataMs", getWorkspaceMetadataStartedAt);
      if (!metadataResult.success) {
        return Err({ type: "unknown", raw: metadataResult.error });
      }

      const metadata = metadataResult.data;

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isRuntimeAllowed(metadata.runtimeConfig)) {
          return Err({
            type: "policy_denied",
            message: "Workspace runtime is not allowed by policy",
          });
        }
      }
      const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });
      logSlowStreamStartup = (details: Record<string, unknown>) => {
        const totalMs = Date.now() - startTime;
        if (totalMs < STREAM_STARTUP_DIAGNOSTIC_THRESHOLD_MS) {
          return;
        }

        workspaceLog.info("[stream-startup] Slow pre-stream preparation", {
          workspaceId,
          modelString,
          totalMs,
          startupPhaseTimingsMs,
          ...details,
        });
      };

      const emitStartupBreadcrumb = (
        startupStage:
          | "waiting_for_init"
          | "checking_runtime"
          | "loading_workspace_context"
          | "loading_tools"
          | "preparing_request"
          | "starting_stream"
      ): void => {
        const breadcrumb =
          startupStage === "waiting_for_init"
            ? {
                phase: "waiting" as const,
                detail: "Waiting for workspace initialization...",
              }
            : startupStage === "checking_runtime"
              ? {
                  phase: "starting" as const,
                  detail: "Checking workspace runtime...",
                }
              : startupStage === "loading_workspace_context"
                ? {
                    phase: "starting" as const,
                    detail: "Loading workspace context...",
                  }
                : startupStage === "loading_tools"
                  ? {
                      phase: "starting" as const,
                      detail: "Loading tools...",
                    }
                  : startupStage === "preparing_request"
                    ? {
                        phase: "starting" as const,
                        detail: "Preparing model request...",
                      }
                    : {
                        phase: "starting" as const,
                        detail: "Starting model stream...",
                      };

        workspaceLog.info("[stream-startup] Breadcrumb", {
          startupStage,
          phase: breadcrumb.phase,
          detail: breadcrumb.detail,
          elapsedMs: Date.now() - startTime,
        });
        this.emit("runtime-status", {
          type: "runtime-status",
          workspaceId,
          phase: breadcrumb.phase,
          runtimeType: metadata.runtimeConfig.type,
          source: "startup",
          detail: breadcrumb.detail,
        });
      };

      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err({ type: "unknown", raw: `Workspace ${workspaceId} not found in config` });
      }

      const metadataWithPath = {
        ...metadata,
        // Existing SSH workspaces may still live at a persisted root that differs from the canonical
        // hashed project layout, so stream startup seeds the runtime from config for the current
        // workspace instead of always reconstructing the path from project metadata.
        namedWorkspacePath: workspace.workspacePath,
      };

      const multiProjectExecutionGate = this.ensureMultiProjectRuntimeExecutionEnabled(
        workspaceId,
        metadata
      );
      if (!multiProjectExecutionGate.success) {
        return multiProjectExecutionGate;
      }

      const singleProjectContext = isMultiProject(metadata)
        ? undefined
        : createRuntimeContextForWorkspace(metadataWithPath);
      const runtime = singleProjectContext
        ? singleProjectContext.runtime
        : new MultiProjectRuntime(
            new ContainerManager(getSrcBaseDir(metadata.runtimeConfig) ?? this.config.srcDir),
            getProjects(metadata).map((project) => ({
              projectPath: project.projectPath,
              projectName: project.projectName,
              runtime: createRuntime(metadata.runtimeConfig, {
                projectPath: project.projectPath,
                workspaceName: metadata.name,
                workspacePath: isSSHRuntime(metadata.runtimeConfig)
                  ? getWorkspacePathHintForProject(
                      {
                        workspaceId,
                        workspaceName: metadata.name,
                        workspacePath: workspace.workspacePath,
                        runtimeConfig: metadata.runtimeConfig,
                        projectPath: metadata.projectPath,
                        projectName: metadata.projectName,
                        projects: metadata.projects,
                      },
                      project.projectPath
                    )
                  : undefined,
              }),
            })),
            metadata.name
          );

      const workspacePath =
        singleProjectContext?.workspacePath ??
        (isSSHRuntime(metadata.runtimeConfig)
          ? resolveWorkspaceExecutionPath(metadataWithPath, runtime)
          : // Non-SSH multi-project runtimes intentionally start from their shared container root so
            // sibling repos stay addressable during agent/tool setup. SSH workspaces are the exception:
            // upgraded legacy layouts must reuse the persisted root from config until remote layout
            // detection seeds the new hashed paths.
            runtime.getWorkspacePath(metadata.projectPath, metadata.name));

      // Wait for init to complete before any runtime I/O operations
      // (SSH/devcontainer may not be ready until init finishes pulling the container)
      emitStartupBreadcrumb("waiting_for_init");
      const waitForInitStartedAt = Date.now();
      await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
      recordStartupPhaseTiming("waitForInitMs", waitForInitStartedAt);
      if (combinedAbortSignal.aborted) {
        return Ok(undefined);
      }

      // Verify runtime is actually reachable after init completes.
      // For Docker workspaces, this checks the container exists and starts it if stopped.
      // For Coder workspaces, this may start a stopped workspace and wait for it.
      // If init failed during container creation, ensureReady() will return an error.
      emitStartupBreadcrumb("checking_runtime");
      const ensureReadyStartedAt = Date.now();
      const readyResult = await runtime.ensureReady({
        signal: combinedAbortSignal,
        statusSink: (status) => {
          // Emit runtime-status events for frontend UX (StreamingBarrier)
          this.emit("runtime-status", {
            type: "runtime-status",
            workspaceId,
            phase: status.phase,
            runtimeType: status.runtimeType,
            source: "runtime",
            detail: status.detail,
          });
        },
      });
      recordStartupPhaseTiming("ensureReadyMs", ensureReadyStartedAt);
      if (!readyResult.ready) {
        // Generate message ID for the error event (frontend needs this for synthetic message)
        const errorMessageId = createAssistantMessageId();
        const runtimeType = metadata.runtimeConfig?.type ?? "local";
        const runtimeLabel = runtimeType === "docker" ? "Container" : "Runtime";
        const errorMessage = readyResult.error || `${runtimeLabel} unavailable.`;

        // Use the errorType from ensureReady result (runtime_not_ready vs runtime_start_failed)
        const errorType = readyResult.errorType;

        // Emit error event so frontend receives it via stream subscription.
        // This mirrors the context_exceeded pattern - the fire-and-forget sendMessage
        // call in useCreationWorkspace.ts won't see the returned Err, but will receive
        // this event through the workspace chat subscription.
        this.emit(
          "error",
          createErrorEvent(workspaceId, {
            messageId: errorMessageId,
            error: errorMessage,
            errorType,
            acpPromptId,
          })
        );

        logSlowStreamStartup?.({
          outcome: "runtime_not_ready",
          runtimeType,
          errorType,
          errorMessage,
        });

        return Err({
          type: errorType,
          message: errorMessage,
        });
      }

      // Memory context (memory experiment): resolved only after ensureReady so
      // project-scope listing sees a running runtime (a stopped Docker/remote
      // workspace would yield an empty/partial context, and AgentSession caches
      // the result per model/session segment).
      const memoryContext = resolveMemoryContext
        ? await resolveMemoryContext(modelString, { includeHotMemories: false })
        : undefined;

      // Resolve agent definition, compute effective mode & tool policy.
      const cfg = this.config.loadConfigOrDefault();
      const advisorExperimentEnabled =
        experiments?.advisorTool ??
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.ADVISOR_TOOL) === true;
      const dynamicWorkflowsExperimentEnabled =
        experiments?.dynamicWorkflows ??
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS) === true;
      const memoryExperimentEnabled =
        experiments?.memory ??
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY) === true;
      const timelineExperimentEnabled =
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.TIMELINE) === true;
      const workspaceHeartbeatsExperimentEnabled =
        experiments?.workspaceHeartbeats ??
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS) === true;
      const toolSearchExperimentEnabled =
        experiments?.toolSearch ??
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.TOOL_SEARCH) === true;
      const memoryHotSetExperimentEnabled =
        this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.MEMORY_HOT_SET) === true;
      // claude-skills-compat is host-evaluated (like memory-hot-set): sub-agents share the
      // host ExperimentsService, so it is not inherited through SendMessageOptions.experiments.
      const claudeSkillsCompatExperimentEnabled = this.isClaudeSkillsCompatEnabled();
      // Once final tool policy keeps the memory tool, upgrade the index-only
      // memory context (resolved pre-policy with includeHotMemories: false) to
      // the token-budgeted hot block for the model that will actually stream.
      // Returns the unchanged pre-policy `memoryContext` reference when hot
      // preloading is off or the memory tool was stripped, so callers can use
      // identity comparison to decide whether the system prompt must be rebuilt.
      const upgradeMemoryContextForModel = async (
        memoryToolAvailableForModel: boolean,
        modelStringForContext: string
      ): Promise<MemorySessionContext | undefined> =>
        memoryToolAvailableForModel &&
        memoryHotSetExperimentEnabled &&
        resolveMemoryContext !== undefined
          ? await resolveMemoryContext(modelStringForContext, { includeHotMemories: true })
          : memoryContext;
      emitStartupBreadcrumb("loading_workspace_context");
      const resolveAgentForStreamStartedAt = Date.now();
      const agentResult = await resolveAgentForStream({
        workspaceId,
        metadata,
        runtime,
        workspacePath,
        requestedAgentId: agentId,
        disableWorkspaceAgents: disableWorkspaceAgents ?? false,
        callerToolPolicy: toolPolicy,
        cfg,
        emitError: (event) => this.emit("error", event),
        isAdvisorExperimentEnabled: advisorExperimentEnabled,
      });
      recordStartupPhaseTiming("resolveAgentForStreamMs", resolveAgentForStreamStartedAt);
      if (!agentResult.success) {
        return agentResult;
      }
      const {
        effectiveAgentId,
        agentDefinition,
        agentDiscoveryRuntime,
        agentDiscoveryPath,
        isSubagentWorkspace,
        agentInheritanceChain,
        agentIsPlanLike,
        effectiveMode,
        taskSettings,
        taskDepth,
        shouldDisableTaskToolsForDepth,
        effectiveToolPolicy,
      } = agentResult.data;
      const legacyModeForMetadata = getLegacyModeForAgentMetadata(effectiveAgentId, effectiveMode);
      const projectTrusted = isWorkspaceProjectTrusted(this.config, metadata);
      const sharedExecutionTrusted = isWorkspaceTrustedForSharedExecution(metadata, cfg.projects);
      const agentAdvisorEnabled = resolveAdvisorEnabledForAgent(
        effectiveAgentId,
        cfg.agentAiDefaults?.[effectiveAgentId]?.advisorEnabled
      );
      const advisorModelString = cfg.advisorModelString?.trim() ?? "";
      const advisorToolEligible =
        advisorExperimentEnabled && agentAdvisorEnabled && advisorModelString.length > 0;

      // Goals graduated to GA: tools are gated solely on the workspace's
      // current goal status + agent capability, not on an experiment flag.
      let currentGoalForTools: GoalRecordV1 | null = null;
      if (workspaceGoalService) {
        currentGoalForTools = await workspaceGoalService.getGoal(workspaceId);
      }
      const effectiveGoalDefaults = mergeGoalDefaults(
        normalizeGoalDefaults(cfg.goalDefaults ?? DEFAULT_GOAL_DEFAULTS),
        metadata.goalDefaults ?? null
      );
      const goalToolAvailability = getGoalToolAvailability({
        goalStatus: currentGoalForTools?.status ?? null,
        parentWorkspaceId: metadata.parentWorkspaceId,
        allowAgentSetGoal,
        agentInheritanceChain,
      });

      // Fetch workspace MCP overrides (for filtering servers and tools)
      // NOTE: Stored in <workspace>/.mux/mcp.local.jsonc (not ~/.mux/config.json).
      let mcpOverrides: WorkspaceMCPOverrides | undefined;
      const loadWorkspaceMcpOverridesStartedAt = Date.now();
      try {
        mcpOverrides =
          await this.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId);
      } catch (error) {
        log.warn("[MCP] Failed to load workspace MCP overrides; continuing without overrides", {
          workspaceId,
          error,
        });
        mcpOverrides = undefined;
      }
      recordStartupPhaseTiming("loadWorkspaceMcpOverridesMs", loadWorkspaceMcpOverridesStartedAt);

      // Fetch MCP server config for system prompt (before building message).
      const listMcpServersStartedAt = Date.now();
      const mcpServers = this.mcpServerManager
        ? await this.mcpServerManager.listServers(
            metadata.projectPath,
            mcpOverrides,
            projectTrusted
          )
        : undefined;
      recordStartupPhaseTiming("listMcpServersMs", listMcpServersStartedAt);

      const loadAdditionalSystemContextStartedAt = Date.now();
      let workspaceAdditionalSystemContext = additionalSystemContext;
      if (workspaceAdditionalSystemContext == null) {
        try {
          // Fall back to disk only when the renderer did not send a live snapshot.
          // `effectiveAdditionalSystemContext` honors the `enabled` toggle: when
          // the user has disabled the scratchpad, the persisted content is
          // intentionally not injected.
          const record = await readAdditionalSystemContext(this.config, workspaceId);
          workspaceAdditionalSystemContext = effectiveAdditionalSystemContext(record);
        } catch (error) {
          // The scratchpad is user-editable state, so a transient read failure should not block a send.
          log.warn("Failed to load workspace additional system context; continuing without it", {
            workspaceId,
            error,
          });
          workspaceAdditionalSystemContext = "";
        }
      }
      const scratchpadAdditionalSystemInstructions = mergeAdditionalSystemInstructions(
        workspaceAdditionalSystemContext,
        additionalSystemInstructions
      );
      recordStartupPhaseTiming(
        "loadAdditionalSystemContextMs",
        loadAdditionalSystemContextStartedAt
      );

      // Build plan-aware instructions and determine plan→exec transition content.
      // IMPORTANT: Derive this from the same boundary-sliced message payload that is sent to
      // the model so plan hints/handoffs cannot be suppressed by pre-boundary history.
      const buildPlanInstructionsStartedAt = Date.now();
      const { effectiveAdditionalInstructions, planFilePath, planContentForTransition } =
        await buildPlanInstructions({
          runtime,
          metadata,
          workspaceId,
          workspacePath,
          effectiveMode,
          effectiveAgentId,
          agentIsPlanLike,
          agentDiscoveryRuntime,
          agentDiscoveryPath,
          additionalSystemInstructions: scratchpadAdditionalSystemInstructions,
          shouldDisableTaskToolsForDepth,
          taskDepth,
          taskSettings,
          requestPayloadMessages: providerRequestMessages,
        });
      recordStartupPhaseTiming("buildPlanInstructionsMs", buildPlanInstructionsStartedAt);

      const muxScope = resolveMuxToolScope(this.config, metadata, workspacePath);

      const desktopSessionManager = this.desktopSessionManager;
      let desktopCapabilityPromise: ReturnType<DesktopSessionManager["getCapability"]> | undefined;
      const loadDesktopCapability =
        desktopSessionManager == null
          ? undefined
          : () => {
              // Reuse the same capability probe for every desktop-gated agent discovered during
              // this request so discovery cannot trigger one desktop startup attempt per agent.
              desktopCapabilityPromise ??= desktopSessionManager.getCapability(workspaceId);
              return desktopCapabilityPromise;
            };

      // modelStringForSystem lets the refusal-fallback prepare() rebuild the
      // system prompt for the fallback model (model-keyed instruction sections).
      // Memory index eligibility mirrors memory tool registration (experiment +
      // service); tool policy may still strip the tool, which forces a rebuild
      // below so the prompt never advertises an absent tool.
      const memoryToolEligible = memoryExperimentEnabled && this.memoryService !== undefined;
      const buildStreamSystemContextForToolset = (
        toolset: { advisorToolAvailable: boolean; memoryToolAvailable: boolean },
        modelStringForSystem: string = modelString,
        contextForModel: MemorySessionContext | undefined = memoryContext
      ) =>
        buildStreamSystemContext({
          runtime,
          metadata,
          workspacePath,
          workspaceId,
          agentDefinition,
          effectiveMode,
          agentDiscoveryRuntime,
          agentDiscoveryPath,
          isSubagentWorkspace,
          effectiveAdditionalInstructions,
          planFilePath,
          modelString: modelStringForSystem,
          cfg,
          providersConfig: this.providerService.getConfig(),
          mcpServers,
          muxScope,
          loadDesktopCapability,
          advisorToolAvailable: toolset.advisorToolAvailable,
          memoryToolAvailable: toolset.memoryToolAvailable,
          hotMemoriesBlock: contextForModel?.hotMemoriesBlock ?? undefined,
          claudeSkillsCompatEnabled: claudeSkillsCompatExperimentEnabled,
        });

      // Build provisional agent context before tool policy finalizes the toolset.
      // The final system prompt is rebuilt after policy application so advisor guidance cannot
      // survive when the resolved toolset strips the advisor tool.
      const buildStreamSystemContextStartedAt = Date.now();
      const prePolicyStreamSystemContext = await buildStreamSystemContextForToolset({
        advisorToolAvailable: advisorToolEligible,
        memoryToolAvailable: memoryToolEligible,
      });
      recordStartupPhaseTiming("buildStreamSystemContextMs", buildStreamSystemContextStartedAt);
      const {
        agentSystemPromptSections,
        agentDefinitions,
        availableSkills,
        ancestorPlanFilePaths,
      } = prePolicyStreamSystemContext;
      let systemMessageTokens = prePolicyStreamSystemContext.systemMessageTokens;
      let systemMessage = prePolicyStreamSystemContext.systemMessage;

      // Load project secrets for local tool execution and MCP server startup.
      const projectSecrets = isMultiProject(metadata)
        ? mergeMultiProjectSecrets(metadata, this.config)
        : this.config.getEffectiveSecrets(metadata.projectPath);

      // Generate stream token and create temp directory for tools
      const streamToken = this.streamManager.generateStreamToken();

      let mcpTools: Record<string, Tool> | undefined;
      let mcpStats: MCPWorkspaceStats | undefined;
      let mcpSetupDurationMs = 0;

      if (this.mcpServerManager) {
        const mcpToolSetupStartedAt = Date.now();
        try {
          const result = await this.mcpServerManager.getToolsForWorkspace({
            workspaceId,
            projectPath: metadata.projectPath,
            runtime,
            workspacePath,
            trusted: projectTrusted,
            overrides: mcpOverrides,
            projectSecrets: await secretsToRecord(projectSecrets, this.opResolver),
          });

          mcpTools = result.tools;
          mcpStats = result.stats;
        } catch (error) {
          workspaceLog.error("Failed to start MCP servers", { error });
        } finally {
          mcpSetupDurationMs = Date.now() - mcpToolSetupStartedAt;
          startupPhaseTimingsMs.mcpToolSetupMs = mcpSetupDurationMs;
        }
      }

      // Tool search (tool-search experiment): assembly-time gate. The runtime
      // holder makes getToolsForModel create the tool_catalog_search tool; its `state`
      // is assigned only after policy filtering builds the deferred catalog
      // (see prepareToolSearch below). Without MCP tools there is nothing to
      // defer, so the feature stays fully inactive.
      const toolSearchRuntime: ToolSearchRuntime | undefined =
        toolSearchExperimentEnabled && Object.keys(mcpTools ?? {}).length > 0 ? {} : undefined;

      const createTempDirForStreamStartedAt = Date.now();
      const runtimeTempDir = await this.streamManager.createTempDirForStream(streamToken, runtime);
      recordStartupPhaseTiming("createTempDirForStreamMs", createTempDirForStreamStartedAt);

      // Extract tool-specific instructions from AGENTS.md files and agent definition
      const readToolInstructionsStartedAt = Date.now();
      const toolInstructions = await readToolInstructions(
        metadata,
        runtime,
        workspacePath,
        modelString,
        agentSystemPromptSections
      );
      recordStartupPhaseTiming("readToolInstructionsMs", readToolInstructionsStartedAt);

      // Calculate cumulative session costs for MUX_COSTS_USD env var
      let sessionCostsUsd: number | undefined;
      const loadSessionUsageStartedAt = Date.now();
      if (this.sessionUsageService) {
        const sessionUsage = await this.sessionUsageService.getSessionUsage(workspaceId);
        if (sessionUsage) {
          const allUsage = sumUsageHistory(Object.values(sessionUsage.byModel));
          sessionCostsUsd = getTotalCost(allUsage);
        }
      }
      recordStartupPhaseTiming("loadSessionUsageMs", loadSessionUsageStartedAt);

      // Get model-specific tools with workspace path (correct for local or remote)
      emitStartupBreadcrumb("loading_tools");
      const getToolsForModelStartedAt = Date.now();
      assert(
        workspaceId.trim().length > 0,
        "AIService.streamMessage requires a non-empty workspaceId"
      );
      if (advisorExperimentEnabled && agentAdvisorEnabled && advisorModelString.length === 0) {
        workspaceLog.warn(
          "Advisor tool enabled for agent without advisorModelString; suppressing",
          {
            effectiveAgentId,
          }
        );
      }
      if (advisorToolEligible) {
        assert(
          advisorModelString.length > 0,
          "AIService advisorModelString must be non-empty when advisor is eligible"
        );
      }
      // Mutable ref updated by StreamManager.prepareStep so the advisor tool reads the live
      // transcript lazily at execute time instead of capturing a stale snapshot here.
      const advisorTranscriptRef: { messages?: ModelMessage[] } = {};
      const advisorStepCaptureRef: AdvisorStepCaptureRef = {
        currentStepText: "",
        currentStepReasoning: "",
        frozenSnapshotsByToolCallId: new Map(),
      };
      const onAdvisorChunk: StreamTextOnChunk = ({ chunk }) => {
        switch (chunk.type) {
          case "text-delta": {
            // Providers/SDKs can stream advisor text deltas under different field names.
            const chunkText = extractChunkDeltaText(chunk as Record<string, unknown>, [
              "textDelta",
              "delta",
              "text",
            ]);
            if (chunkText.length > 0) {
              advisorStepCaptureRef.currentStepText += chunkText;
            }
            return;
          }
          case "reasoning-delta": {
            // Anthropic signature updates can arrive as reasoning deltas without text.
            const chunkText = extractChunkDeltaText(chunk as Record<string, unknown>, [
              "text",
              "textDelta",
              "delta",
            ]);
            if (chunkText.length > 0) {
              advisorStepCaptureRef.currentStepReasoning += chunkText;
            }
            return;
          }
          case "tool-call": {
            if (chunk.toolName !== "advisor") {
              return;
            }
            const toolCallId = chunk.toolCallId?.trim?.() ?? "";
            // Skip malformed tool calls defensively — the normal tool-error
            // path will handle bad input; crashing the stream callback would
            // be worse than missing the snapshot.
            if (
              toolCallId.length === 0 ||
              !isPlainObject(chunk.input) ||
              advisorStepCaptureRef.frozenSnapshotsByToolCallId.has(toolCallId)
            ) {
              return;
            }
            advisorStepCaptureRef.frozenSnapshotsByToolCallId.set(toolCallId, {
              toolCallId,
              toolName: "advisor",
              input: { ...chunk.input },
              stepText: advisorStepCaptureRef.currentStepText,
              stepReasoning: advisorStepCaptureRef.currentStepReasoning,
            });
            return;
          }
          default:
            return;
        }
      };
      // Tool-side generateText() results do not consistently echo mux.costsIncluded in
      // providerMetadata, so remember the resolved billing mode from model creation and
      // re-stamp it before converting usage into display/session costs.
      const toolModelCostsIncludedByModelString = new Map<string, boolean>();
      // Normalize: undefined -> default, null -> unlimited, positive int -> exact cap.
      const advisorMaxUses =
        cfg.advisorMaxUsesPerTurn === null
          ? null
          : (cfg.advisorMaxUsesPerTurn ?? ADVISOR_DEFAULT_MAX_USES_PER_TURN);
      assert(
        cfg.advisorMaxOutputTokens == null ||
          (Number.isInteger(cfg.advisorMaxOutputTokens) && cfg.advisorMaxOutputTokens > 0),
        "AIService advisorMaxOutputTokens must be null, undefined, or a positive integer"
      );
      const advisorMaxOutputTokens =
        cfg.advisorMaxOutputTokens != null && cfg.advisorMaxOutputTokens > 0
          ? cfg.advisorMaxOutputTokens
          : undefined;
      // Clamp the persisted advisor thinking level so the tool metadata matches the
      // providerOptions actually sent to generateText().
      const advisorReasoningLevel = enforceThinkingPolicy(
        advisorModelString,
        cfg.advisorThinkingLevel ?? THINKING_LEVEL_OFF,
        undefined,
        this.providerService.getConfig()
      );
      const runtimeType = getRuntimeType(metadata.runtimeConfig);
      const muxEnv = getMuxEnv(metadata.projectPath, runtimeType, metadata.name, {
        workspaceId,
        modelString,
        thinkingLevel: thinkingLevel ?? "off",
        costsUsd: sessionCostsUsd,
      });
      const getWorkflowProjectTrusted = () => isWorkspaceProjectTrusted(this.config, metadata);

      const workflowService =
        dynamicWorkflowsExperimentEnabled && this.taskService != null
          ? new WorkflowService({
              runStore: new WorkflowRunStore({
                sessionDir: this.config.getSessionDir(workspaceId),
              }),
              onRunStatusChanged: async (event) => {
                if (!isTerminalWorkflowRunStatus(event.status)) {
                  await this.taskService?.resetWorkflowRunTerminalAttention({
                    ownerWorkspaceId: event.workspaceId,
                    runId: event.runId,
                  });
                }
                await this.onWorkflowRunStatusChanged?.(event);
              },
              runtimeFactory: new QuickJSRuntimeFactory(),
              taskAdapterFactory: (runId, workflowName) =>
                new WorkflowTaskServiceAdapter({
                  taskService: this.taskService!,
                  parentWorkspaceId: workspaceId,
                  workflowRunId: runId,
                  workflowName,
                  defaultAgentId: DEFAULT_WORKFLOW_AGENT_ID,
                  patchToolConfig: {
                    workspaceId,
                    cwd: workspacePath,
                    runtime,
                    runtimeTempDir,
                    workspaceSessionDir: this.config.getSessionDir(workspaceId),
                    trusted: getWorkflowProjectTrusted(),
                  },
                  getProjectTrusted: getWorkflowProjectTrusted,
                  experiments: {
                    ...experiments,
                    dynamicWorkflows: dynamicWorkflowsExperimentEnabled,
                    workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
                  },
                }),
              resolveWorkflowScript: (scriptPath) =>
                resolveWorkflowScript({
                  scriptPath,
                  runtime,
                  workspacePath,
                  projectTrusted: getWorkflowProjectTrusted(),
                }),
              // Background workflow tools outlive the model turn that started them. Feed the
              // terminal result back as a hidden user turn so the parent agent continues
              // instead of leaving the user staring at the workflow report payload.
              onBackgroundRunTerminal: async ({ runId, status, result, run }) => {
                if (run.parentWorkflow != null) {
                  return;
                }
                if (this.taskService != null) {
                  await this.taskService.enqueueWorkflowRunTerminalAttention({
                    ownerWorkspaceId: workspaceId,
                    runId,
                    status,
                  });
                  return;
                }

                const continuationSender = this.workflowResultContinuationSender;
                if (continuationSender == null) {
                  log.warn("Workflow completed but no continuation sender is configured", {
                    workspaceId,
                    runId,
                  });
                  return;
                }

                const scriptPath = run.workflow.sourcePath ?? run.workflow.name;
                const rawCommand = `workflow_run ${scriptPath}`;
                const workflowResultMessage = buildWorkflowResultContextMessage({
                  rawCommand,
                  name: scriptPath,
                  runId,
                  status,
                  result,
                  run,
                });
                for (;;) {
                  const invocationCurrent = await continuationSender.isWorkflowInvocationCurrent(
                    workspaceId,
                    runId
                  );
                  if (!invocationCurrent) {
                    if (this.isStreaming(workspaceId)) {
                      await waitForWorkflowContinuationRetry();
                      continue;
                    }
                    log.debug("Skipping superseded workflow continuation", { workspaceId, runId });
                    return;
                  }

                  const sendResult = await continuationSender.sendMessage(
                    workspaceId,
                    workflowResultMessage,
                    {
                      model: modelString,
                      thinkingLevel: effectiveThinkingLevel,
                      // Carry the turn's pro mode so the workflow-result
                      // continuation does not silently drop back to standard.
                      reasoningMode,
                      agentId: effectiveAgentId,
                      toolPolicy: effectiveToolPolicy,
                      additionalSystemInstructions: scratchpadAdditionalSystemInstructions,
                      maxOutputTokens,
                      providerOptions: effectiveMuxProviderOptions,
                      experiments: {
                        ...experiments,
                        dynamicWorkflows: dynamicWorkflowsExperimentEnabled,
                        workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
                      },
                      skipAiSettingsPersistence: true,
                      muxMetadata: {
                        type: WORKFLOW_RESULT_METADATA_TYPE,
                        rawCommand,
                        commandPrefix: "workflow_run",
                        runId,
                        requestedModel: modelString,
                      },
                    },
                    {
                      skipAutoResumeReset: true,
                      synthetic: true,
                      agentInitiated: true,
                      requireIdle: true,
                      startStreamInBackground: true,
                    }
                  );
                  if (sendResult.success) {
                    return;
                  }
                  if (!isWorkspaceBusyIdleOnlySend(sendResult.error)) {
                    log.warn("Failed to continue agent after workflow completion", {
                      workspaceId,
                      runId,
                      error: sendResult.error,
                    });
                    return;
                  }
                  await waitForWorkflowContinuationRetry();
                }
              },
              getCurrentProjectTrusted: () => isWorkspaceProjectTrusted(this.config, metadata),
              runnerId: `workflow-runner:${workspaceId}`,
            })
          : undefined;

      // Create assistant message ID early so tool-side usage reporting and nested tool events
      // stay scoped to this specific assistant turn. The placeholder is appended to history below
      // (after the abort check).
      const assistantMessageId = createAssistantMessageId();
      const allowLegacyInvalidWorkflowAgentOutputSchema =
        await this.shouldAllowLegacyInvalidWorkflowAgentOutputSchema(metadata);
      // Hoisted so the refusal-fallback prepare() can rebuild the toolset for a
      // different model with identical context (only the model string varies).
      const toolsForModelConfig: ToolConfiguration = {
        cwd: workspacePath,
        runtime,
        projects: getProjects(metadata),
        secrets: await secretsToRecord(projectSecrets, this.opResolver),
        muxEnv,
        runtimeTempDir,
        ...(advisorToolEligible
          ? {
              advisorRuntime: {
                advisorModelString,
                reasoningLevel: advisorReasoningLevel,
                maxUsesPerTurn: advisorMaxUses,
                maxOutputTokens: advisorMaxOutputTokens,
                getTranscriptSnapshot: () => {
                  const messages = advisorTranscriptRef.messages;
                  assert(
                    messages != null,
                    "AIService advisor transcript ref must be populated before advisor execution"
                  );
                  return messages;
                },
                takeToolCallSnapshot: (toolCallId) => {
                  const normalizedToolCallId = toolCallId.trim();
                  assert(normalizedToolCallId.length > 0, "advisor toolCallId must be non-empty");
                  const snapshot =
                    advisorStepCaptureRef.frozenSnapshotsByToolCallId.get(normalizedToolCallId);
                  if (snapshot == null) {
                    return undefined;
                  }
                  const didDelete =
                    advisorStepCaptureRef.frozenSnapshotsByToolCallId.delete(normalizedToolCallId);
                  assert(didDelete, "advisor tool-call snapshot must be deleted when consumed");
                  assert(
                    snapshot.toolName === "advisor",
                    "advisor snapshot must belong to advisor"
                  );
                  return snapshot;
                },
                createModel: async (ms: string) => {
                  const advisorModelString = ms.trim();
                  assert(
                    advisorModelString.length > 0,
                    "advisor model string must be non-empty when creating an advisor model"
                  );
                  const advisorModel = await this.createModel(advisorModelString, undefined, {
                    workspaceId,
                  });
                  if (!advisorModel.success) {
                    throw new Error(
                      `Failed to create advisor model: ${getErrorMessage(advisorModel.error)}`
                    );
                  }
                  toolModelCostsIncludedByModelString.set(
                    advisorModelString,
                    modelCostsIncluded(advisorModel.data)
                  );
                  return advisorModel.data;
                },
                abortSignal: combinedAbortSignal,
              },
            }
          : {}),
        ...(toolSearchRuntime ? { toolSearchRuntime } : {}),
        openaiWireFormat: effectiveMuxProviderOptions?.openai?.wireFormat,
        backgroundProcessManager: this.backgroundProcessManager,
        // Plan agent configuration for plan file access.
        // - read: plan file is readable in all agents (useful context)
        // - write: allowed in all agents; plan agents still lock other edits to the exact plan path
        planFileOnly: agentIsPlanLike,
        emitChatEvent: (event) => {
          // Defensive: tools should only emit events for the workspace they belong to.
          if ("workspaceId" in event && event.workspaceId !== workspaceId) {
            return;
          }
          if (event.type === "workflow-run-attached") {
            return this.streamManager.attachWorkflowRunToToolCall(event).then(() => {
              this.emit(event.type, event as never);
            });
          }
          this.emit(event.type, event as never);
        },
        workspaceProjectPath: metadata.projectPath,
        workspaceExecutionRootPath: metadata.subProjectPath ?? metadata.projectPath,
        workspaceSessionDir: this.config.getSessionDir(workspaceId),
        planFilePath,
        ancestorPlanFilePaths,
        workspaceId,
        muxScope,
        timelineService: timelineExperimentEnabled ? this.timelineService : undefined,
        workspaceHeartbeatService: this.workspaceHeartbeatService,
        workflowService,
        goalService: workspaceGoalService,
        goalDefaults: effectiveGoalDefaults,
        enableGoalTools: goalToolAvailability,
        // Only child workspaces (tasks) can report to a parent.
        enableAgentReport: Boolean(metadata.parentWorkspaceId),
        workflowAgentOutputSchema: metadata.workflowTask?.outputSchema,
        allowLegacyInvalidWorkflowAgentOutputSchema,
        // External edit detection callback
        recordFileState,
        reportModelUsage: (event) => {
          try {
            const eventModel = event.model.trim();
            assert(eventModel.length > 0, "tool model usage event model must be non-empty");
            // Persist tool-side model usage under its own model bucket so session costs keep
            // advisor/system-side pricing separate from the parent chat model.
            const providerMetadata = markProviderMetadataCostsIncluded(
              event.providerMetadata,
              toolModelCostsIncludedByModelString.get(eventModel)
            );
            const metadataModel = resolveModelForMetadata(
              eventModel,
              this.providerService.getConfig()
            );
            this.streamManager.recordToolModelUsage(workspaceId, assistantMessageId, {
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              timestamp: event.timestamp,
              model: eventModel,
              metadataModel,
              usage: event.usage,
              ...(providerMetadata != null ? { providerMetadata } : {}),
            });
            void (async () => {
              try {
                if (!this.sessionUsageService) {
                  return;
                }
                const displayUsage = createDisplayUsage(
                  event.usage,
                  eventModel,
                  providerMetadata,
                  metadataModel
                );
                if (!displayUsage) {
                  return;
                }
                const canonicalModel = normalizeToCanonical(eventModel);
                await this.sessionUsageService.recordUsage(
                  workspaceId,
                  canonicalModel,
                  displayUsage
                );
                this.emit("session-usage-delta", {
                  type: "session-usage-delta" as const,
                  workspaceId,
                  sourceWorkspaceId: workspaceId,
                  byModelDelta: { [canonicalModel]: displayUsage },
                  timestamp: Date.now(),
                });
              } catch (error) {
                log.warn("Failed to record tool model usage", {
                  error,
                  workspaceId,
                  toolName: event.toolName,
                  model: event.model,
                });
              }
            })();
          } catch (error) {
            log.warn("Failed to record tool model usage", {
              error,
              workspaceId,
              toolName: event.toolName,
              model: event.model,
            });
          }
        },
        onConfigChanged: () => this.providerService.notifyConfigChanged(),
        taskService: this.taskService,
        analyticsService: this.analyticsService,
        desktopSessionManager: this.desktopSessionManager,
        // Agent memory (memory experiment): per-scope write policy derived from
        // the agent class (exec-like / plan-like / read-only). Project memory is
        // host-local under muxHome, keyed by the stable project identity.
        memoryService: this.memoryService,
        memoryAccess: resolveMemoryAccessPolicy({
          planLike: agentIsPlanLike,
          editingCapable: isExecLikeEditingCapableInResolvedChain(agentInheritanceChain),
        }),
        // Experiments for inheritance to subagents and workflow tool gating.
        experiments: {
          ...experiments,
          dynamicWorkflows: dynamicWorkflowsExperimentEnabled,
          memory: memoryExperimentEnabled,
          timeline: timelineExperimentEnabled,
          workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
          toolSearch: toolSearchExperimentEnabled,
          claudeSkillsCompat: claudeSkillsCompatExperimentEnabled,
        },
        // Dynamic context for tool descriptions (moved from system prompt for better model attention)
        availableSubagents: agentDefinitions,
        availableSkills,
        // Session-segment memory index advertised in the memory tool
        // description (same disclosure mechanic as skills).
        memoryIndexEntries: memoryContext?.indexEntries,
        // Trust gating: only run hooks/scripts when the full shared workspace runtime is trusted.
        trusted: sharedExecutionTrusted,
      };
      const allTools = await getToolsForModel(
        modelString,
        toolsForModelConfig,
        workspaceId,
        this.initStateManager,
        toolInstructions,
        mcpTools
      );
      recordStartupPhaseTiming("getToolsForModelMs", getToolsForModelStartedAt);
      const toolsWithDelegation = this.wrapToolsForDelegation(
        workspaceId,
        allTools,
        delegatedToolNames
      );

      // Forward nested PTC tool events to the stream (tool-call-start/end only,
      // not console events which appear in final result only). Shared with the
      // refusal-fallback prepare() tool rebuild.
      const emitNestedPtcToolEvent = (event: PTCEventWithParent) => {
        if (event.type === "tool-call-start" || event.type === "tool-call-end") {
          this.streamManager.emitNestedToolEvent(workspaceId, assistantMessageId, event);
        }
      };

      // Apply tool policy and PTC experiments (lazy-loads PTC dependencies only when needed).
      const applyToolPolicyAndExperimentsStartedAt = Date.now();
      let tools = await applyToolPolicyAndExperiments({
        allTools: toolsWithDelegation,
        extraTools: this.extraTools,
        effectiveToolPolicy,
        experiments,
        emitNestedToolEvent: emitNestedPtcToolEvent,
      });
      recordStartupPhaseTiming(
        "applyToolPolicyAndExperimentsMs",
        applyToolPolicyAndExperimentsStartedAt
      );

      // Tool search (tool-search experiment): post-policy gate. Classification
      // must consume the policy-filtered record so policy-disabled tools never
      // enter the deferred catalog. This runs before every downstream consumer
      // of `tools` (system-prompt rebuild, sentinel tool names, telemetry,
      // streaming) so a dropped tool_catalog_search cannot leak anywhere.
      // PTC gate uses the same condition toolAssembly uses to add code_execution:
      // presence-sniffing the record would misfire on an MCP tool named
      // code_execution (see prepareToolSearch).
      const ptcEnabled =
        experiments?.programmaticToolCalling === true ||
        experiments?.programmaticToolCallingExclusive === true;
      if (toolSearchRuntime) {
        const toolSearchPrep = prepareToolSearch({
          tools,
          mcpToolNames: Object.keys(mcpTools ?? {}),
          toolPolicy: effectiveToolPolicy,
          ptcEnabled,
        });
        tools = toolSearchPrep.tools;
        if (toolSearchPrep.state) {
          toolSearchRuntime.state = toolSearchPrep.state;
        }
      }

      const advisorToolAvailable = tools.advisor !== undefined;
      const memoryToolAvailable = tools.memory !== undefined;
      const finalMemoryContext = await upgradeMemoryContextForModel(
        memoryToolAvailable,
        modelString
      );
      const finalStreamSystemContext =
        advisorToolAvailable === advisorToolEligible &&
        memoryToolAvailable === memoryToolEligible &&
        finalMemoryContext === memoryContext
          ? prePolicyStreamSystemContext
          : await (async () => {
              // Rebuild when policy/experiments changed advisor or memory tool
              // availability (stale advisor guidance / memory index must not advertise
              // absent tools), or when the post-policy memory tool enables the
              // token-budgeted hot block. On SSH this context build scans agents,
              // skills, and instruction files over many small remote ops.
              const rebuildStreamSystemContextStartedAt = Date.now();
              const rebuiltContext = await buildStreamSystemContextForToolset(
                {
                  advisorToolAvailable,
                  memoryToolAvailable,
                },
                modelString,
                finalMemoryContext
              );
              recordStartupPhaseTiming(
                "rebuildStreamSystemContextMs",
                rebuildStreamSystemContextStartedAt
              );
              return rebuiltContext;
            })();
      systemMessageTokens = finalStreamSystemContext.systemMessageTokens;
      systemMessage = finalStreamSystemContext.systemMessage;

      // Kept as a standalone prefix so the refusal-fallback prepare() can reapply
      // it to a system prompt rebuilt for the fallback model.
      let mcpWarningPrefix: string | undefined;
      if (mcpStats && mcpStats.failedServerCount > 0) {
        const failedNames = mcpStats.failedServerNames.join(", ");
        workspaceLog.warn("MCP servers failed to start", { failedNames });
        // Reapply the MCP startup warning after rebuilding the final system prompt.
        mcpWarningPrefix = `[Warning: ${mcpStats.failedServerCount} MCP server(s) failed to start: ${failedNames}. Tools from these servers are unavailable. Check MCP server configuration in Settings.]\n\n`;
        systemMessage = `${mcpWarningPrefix}${systemMessage}`;
        // Keep context-size estimation accurate after mutating the system prompt.
        const metadataModel = resolveModelForMetadata(
          modelString,
          this.providerService.getConfig()
        );
        const tokenizer = await getTokenizerForModel(modelString, metadataModel);
        systemMessageTokens = await tokenizer.countTokens(systemMessage);
      }

      // Re-activate deferred tools discovered by tool_catalog_search in earlier turns
      // without requiring a new search. Must run before the sentinel list is
      // computed so pre-activated tools are advertised in agent transitions.
      if (toolSearchRuntime?.state) {
        seedToolSearchActivationsFromMessages(toolSearchRuntime.state, messagesWithSentinel);
      }

      // Agent-transition sentinels must list only tools the model can actually
      // see on the first step: deferred, not-yet-activated MCP tools are
      // hidden by activeTools scoping, so advertising them would steer the
      // model toward unavailable tool calls.
      const toolNamesForSentinel = (
        computeActiveToolNames(toolSearchRuntime?.state) ?? Object.keys(tools)
      ).sort();

      // Run the full message preparation pipeline (inject context, transform, validate).
      // This is a purely functional pipeline with no service dependencies.
      emitStartupBreadcrumb("preparing_request");
      const prepareMessagesForProviderStartedAt = Date.now();
      const finalMessages = await prepareMessagesForProvider({
        messagesWithSentinel,
        effectiveAgentId,
        toolNamesForSentinel,
        planContentForTransition,
        planFilePath,
        changedFileAttachments,
        postCompactionAttachments,
        runtime,
        workspacePath,
        abortSignal: combinedAbortSignal,
        providerForMessages: canonicalProviderName,
        effectiveThinkingLevel,
        modelString,
        anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl,
        workspaceId,
      });
      recordStartupPhaseTiming("prepareMessagesForProviderMs", prepareMessagesForProviderStartedAt);

      captureMcpToolTelemetry({
        telemetryService: this.telemetryService,
        mcpStats,
        mcpTools,
        tools,
        mcpSetupDurationMs,
        workspaceId,
        modelString,
        effectiveAgentId,
        metadata,
        effectiveToolPolicy,
      });

      if (combinedAbortSignal.aborted) {
        return Ok(undefined);
      }

      const assistantMessage = createMuxMessage(assistantMessageId, "assistant", "", {
        timestamp: Date.now(),
        model: canonicalModelString,
        routedThroughGateway,
        systemMessageTokens,
        agentId: effectiveAgentId,
      });

      // Append to history to get historySequence assigned
      const appendResult = await this.historyService.appendToHistory(workspaceId, assistantMessage);
      if (!appendResult.success) {
        return Err({ type: "unknown", raw: appendResult.error });
      }

      // Get the assigned historySequence
      const historySequence = assistantMessage.metadata?.historySequence ?? 0;

      // Handle simulated stream scenarios (OpenAI SDK testing features).
      // These emit synthetic stream events without calling an AI provider.
      const forceContextLimitError =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.forceContextLimitError === true;
      const simulateToolPolicyNoopFlag =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.simulateToolPolicyNoop === true;

      if (forceContextLimitError || simulateToolPolicyNoopFlag) {
        const simulationCtx: SimulationContext = {
          workspaceId,
          assistantMessageId,
          canonicalModelString,
          routedThroughGateway,
          ...(routeProvider != null ? { routeProvider } : {}),
          historySequence,
          systemMessageTokens,
          effectiveAgentId,
          effectiveMode,
          metadataMode: legacyModeForMetadata,
          effectiveThinkingLevel,
          emit: (event, data) => this.emit(event, data),
        };

        if (forceContextLimitError) {
          await simulateContextLimitError(simulationCtx, this.historyService);
        } else {
          await simulateToolPolicyNoop(simulationCtx, effectiveToolPolicy, this.historyService);
        }
        return Ok(undefined);
      }

      // Build provider options based on thinking level and request-sliced message history.
      const truncationMode = openaiTruncationModeOverride;
      // Use the same boundary-sliced payload history that we send to the provider.
      // This keeps OpenAI request state aligned with the explicit history Mux sends.
      // Pass workspaceId to derive stable promptCacheKey for OpenAI caching.
      const buildProviderOptionsStartedAt = Date.now();
      const promptCacheScope = derivePromptCacheScope(metadata);
      const providerOptions = buildProviderOptions(
        modelString,
        effectiveThinkingLevel,
        providerRequestMessages,
        (id) => this.streamManager.isResponseIdLost(id),
        effectiveMuxProviderOptions,
        workspaceId,
        truncationMode,
        this.providerService.getConfig(),
        routeProvider,
        promptCacheScope,
        reasoningMode
      );
      recordStartupPhaseTiming("buildProviderOptionsMs", buildProviderOptionsStartedAt);

      // Build per-request HTTP headers (e.g., workspace correlation and
      // anthropic-beta for 1M context). This is the single injection site for
      // provider-specific headers, handling both direct and gateway-routed models
      // identically.
      const buildRequestConfigStartedAt = Date.now();
      let requestHeaders = buildRequestHeaders(
        modelString,
        effectiveMuxProviderOptions,
        workspaceId,
        this.providerService.getConfig(),
        routeProvider
      );

      // --- Model parameter overrides from providers.jsonc ---
      const providersConfig = this.config.loadProvidersConfig();
      const resolvedOverrides = resolveModelParameterOverrides(
        providersConfig,
        canonicalProviderName,
        canonicalModelString,
        effectiveModelString
      );

      // Merge provider extras (user knobs) UNDER Mux-built options (safety-critical).
      // Recursive merge within the provider namespace preserves non-conflicting nested
      // subfields (e.g., user reasoning.max_tokens alongside Mux reasoning.enabled).
      // Mux-built values win on leaf conflicts for safety of thinking/reasoning/cache.
      // Shared by the initial build and mid-turn thinking-level rebuilds so both
      // produce identically-shaped options.
      const providerOptionsNamespaceKey = resolveProviderOptionsNamespaceKey(
        canonicalProviderName,
        routeProvider
      );
      const mergeModelParameterExtras = (
        builtOptions: Record<string, unknown>
      ): Record<string, unknown> => {
        if (!resolvedOverrides.providerExtras) {
          return builtOptions;
        }
        const muxProviderNamespace = builtOptions[providerOptionsNamespaceKey];
        return {
          ...builtOptions,
          [providerOptionsNamespaceKey]: isPlainObject(muxProviderNamespace)
            ? mergeProviderExtrasUnderMux(resolvedOverrides.providerExtras, muxProviderNamespace)
            : resolvedOverrides.providerExtras,
        };
      };
      const mergedProviderOptions = mergeModelParameterExtras(
        providerOptions as Record<string, unknown>
      );

      recordStartupPhaseTiming("buildRequestConfigMs", buildRequestConfigStartedAt);

      if (Object.keys(resolvedOverrides.standard).length > 0 || resolvedOverrides.providerExtras) {
        log.debug(
          `Resolved model parameter overrides for ${canonicalModelString}`,
          resolvedOverrides
        );
      }

      // --- Mid-turn thinking-level override support ---
      // Floor resolved by AgentSession when present; internal callers fall back
      // to the model default so clamping never loosens below policy.
      const minThinkingLevel =
        providedMinThinkingLevel ??
        resolveMinimumThinkingLevel(modelString, undefined, this.providerService.getConfig());
      // Rebuilds provider options for a new level using the exact same pipeline
      // as the initial build (policy clamp → resolveEffectiveThinkingLevel →
      // buildProviderOptions → providers.jsonc extras merge). Consumed by
      // StreamManager's prepareStep; `null` ⇒ skip (no-op or model-swap level).
      const currentEffectiveLevelRef = { current: effectiveThinkingLevel };
      const rebuildProviderOptionsForThinkingLevel: RebuildProviderOptionsForThinkingLevel = (
        level
      ) => {
        const clamped = enforceThinkingPolicy(
          modelString,
          level,
          minThinkingLevel,
          this.providerService.getConfig()
        );
        const effective = resolveEffectiveThinkingLevel(
          modelString,
          clamped,
          this.providerService.getConfig()
        );
        if (effective === currentEffectiveLevelRef.current) {
          return null;
        }
        // off ↔ non-off on grok-4-1-fast selects a different model instance —
        // not expressible via provider options on the in-flight stream.
        if (
          isXaiGrokFastVariantSwap(
            canonicalModelString,
            currentEffectiveLevelRef.current,
            effective
          )
        ) {
          return null;
        }
        const rebuilt = buildProviderOptions(
          modelString,
          effective,
          providerRequestMessages,
          (id) => this.streamManager.isResponseIdLost(id),
          effectiveMuxProviderOptions,
          workspaceId,
          truncationMode,
          this.providerService.getConfig(),
          routeProvider,
          promptCacheScope,
          reasoningMode
        );
        const merged = mergeModelParameterExtras(rebuilt as Record<string, unknown>);
        currentEffectiveLevelRef.current = effective;
        return { effectiveLevel: effective, providerOptions: merged };
      };

      // Debug dump: Log the complete LLM request when MUX_DEBUG_LLM_REQUEST is set
      if (process.env.MUX_DEBUG_LLM_REQUEST === "1") {
        log.info(
          `[MUX_DEBUG_LLM_REQUEST] Full LLM request:\n${JSON.stringify(
            {
              workspaceId,
              model: modelString,
              systemMessage,
              messages: finalMessages,
              tools: Object.fromEntries(
                Object.entries(tools).map(([n, t]) => [
                  n,
                  { description: t.description, inputSchema: t.inputSchema },
                ])
              ),
              providerOptions: mergedProviderOptions,
              thinkingLevel: effectiveThinkingLevel,
              maxOutputTokens,
              mode: legacyModeForMetadata,
              agentId: effectiveAgentId,
              toolPolicy: effectiveToolPolicy,
            },
            null,
            2
          )}`
        );

        if (resolvedOverrides.standard && Object.keys(resolvedOverrides.standard).length > 0) {
          log.debug("Model parameter overrides (standard):", resolvedOverrides.standard);
        }
        if (resolvedOverrides.providerExtras) {
          log.debug(
            "Model parameter overrides (provider extras):",
            resolvedOverrides.providerExtras
          );
        }
      }

      if (combinedAbortSignal.aborted) {
        await deleteAbortedPlaceholder(assistantMessageId);
        return Ok(undefined);
      }

      // Capture request payload for the debug modal, then delegate to StreamManager.
      const snapshot: DebugLlmRequestSnapshot = {
        capturedAt: Date.now(),
        workspaceId,
        messageId: assistantMessageId,
        model: modelString,
        providerName: canonicalProviderName,
        thinkingLevel: effectiveThinkingLevel,
        mode: legacyModeForMetadata,
        agentId: effectiveAgentId,
        maxOutputTokens,
        systemMessage,
        messages: finalMessages,
      };

      try {
        this.lastLlmRequestByWorkspace.set(workspaceId, structuredClone(snapshot));
      } catch (error) {
        const errMsg = getErrorMessage(error);
        workspaceLog.warn("Failed to capture debug LLM request snapshot", { error: errMsg });
      }
      const toolsForStream = tools;

      const canQueueDevToolsRunMetadata =
        this.devToolsService?.enabled === true &&
        typeof modelResult.data.model !== "string" &&
        modelResult.data.model.specificationVersion === "v4";

      if (canQueueDevToolsRunMetadata) {
        // Correlate pending run metadata with the specific request that reaches
        // DevTools middleware to avoid cross-request policy leakage. Queue only
        // when middleware is guaranteed to run (LanguageModelV3).
        pendingRunMetadataId = String(streamToken);
        this.devToolsService.setPendingRunMetadata(workspaceId, pendingRunMetadataId, {
          toolPolicy:
            effectiveToolPolicy != null && effectiveToolPolicy.length > 0
              ? effectiveToolPolicy
              : undefined,
        });
        this.trackPendingDevToolsRunMetadata(assistantMessageId, workspaceId, pendingRunMetadataId);
        requestHeaders = {
          ...requestHeaders,
          [DEVTOOLS_RUN_METADATA_ID_HEADER]: pendingRunMetadataId,
        };
      }

      // --- Refusal fallback chain ---
      // Resolved from app config by canonical source model; task children can
      // opt out via taskOnRefusal: "fail" (see resolveWorkspaceModelFallbackChain).
      const modelFallbackChain = resolveWorkspaceModelFallbackChain(
        this.config.loadConfigOrDefault(),
        workspaceId,
        canonicalModelString
      );

      // Lazily rebuilds the per-model slice of this pipeline (model creation,
      // provider-specific message prep, provider options, headers, parameter
      // overrides) when StreamManager swaps to a fallback model after a
      // refusal. Reusing the original request verbatim would leak
      // provider-specific options/messages across providers.
      const modelFallback: ModelFallbackOptions | undefined =
        modelFallbackChain.length > 0
          ? {
              chain: modelFallbackChain,
              prepare: async (nextModelString, prepareOptions) => {
                const fallbackSourceMessages = prepareOptions?.continuation
                  ? replaceOrAppendMessageById(
                      messages,
                      prepareOptions.continuation.assistantMessage
                    )
                  : messages;

                // Re-clamp thinking for the fallback model: the source model's
                // clamped level may violate the next model's policy/floor (the
                // providerOptions builders require a policy-valid level, e.g. an
                // "off" source level on a fixed-effort model like gpt-5-pro).
                // A mid-turn thinking override folded in by StreamManager wins
                // over the send-time level.
                const nextMinThinkingLevel = resolveMinimumThinkingLevel(
                  nextModelString,
                  this.config.loadConfigOrDefault().minThinkingLevelByModel?.[
                    normalizeToCanonical(nextModelString)
                  ],
                  this.providerService.getConfig()
                );
                const nextThinkingLevel = enforceThinkingPolicy(
                  nextModelString,
                  prepareOptions?.thinkingLevelOverride ?? effectiveThinkingLevel,
                  nextMinThinkingLevel,
                  this.providerService.getConfig()
                );

                const nextModelResult = await this.providerModelFactory.resolveAndCreateModel(
                  nextModelString,
                  nextThinkingLevel,
                  effectiveMuxProviderOptions,
                  { agentInitiated, workspaceId }
                );
                if (!nextModelResult.success) {
                  return Err(formatSendMessageError(nextModelResult.error).message);
                }
                const next = nextModelResult.data;

                try {
                  // Rebuild the toolset for the fallback model: provider-native
                  // web tools and MCP schema sanitization are provider-specific
                  // (reusing Anthropic-shaped tools on OpenAI 400s, and vice
                  // versa silently drops web tooling).
                  const nextAllTools = await getToolsForModel(
                    next.canonicalModelString,
                    toolsForModelConfig,
                    workspaceId,
                    this.initStateManager,
                    toolInstructions,
                    mcpTools
                  );
                  let nextTools = await applyToolPolicyAndExperiments({
                    allTools: this.wrapToolsForDelegation(
                      workspaceId,
                      nextAllTools,
                      delegatedToolNames
                    ),
                    extraTools: this.extraTools,
                    effectiveToolPolicy,
                    experiments,
                    emitNestedToolEvent: emitNestedPtcToolEvent,
                  });
                  // Tool search: keep the per-stream state consistent with the
                  // fallback model's re-assembled toolset. rebuildToolSearchState
                  // mutates the state object in place — StreamManager's request
                  // holds a reference to it, so prepareStep reads current state.
                  if (toolSearchRuntime) {
                    if (toolSearchRuntime.state) {
                      nextTools = rebuildToolSearchState(toolSearchRuntime.state, {
                        tools: nextTools,
                        mcpToolNames: Object.keys(mcpTools ?? {}),
                        toolPolicy: effectiveToolPolicy,
                        ptcEnabled,
                      }).tools;
                    } else if (!(mcpTools && TOOL_SEARCH_TOOL_NAME in mcpTools)) {
                      // The primary-path gate deactivated deferral (e.g. every
                      // MCP tool was policy-disabled). StreamManager was never
                      // handed scoping state, so tool_catalog_search must not appear in
                      // the fallback toolset either. Skipped when an MCP tool
                      // collides with the name: that record entry is a
                      // legitimate MCP tool, not our search tool.
                      const { [TOOL_SEARCH_TOOL_NAME]: _removed, ...rest } = nextTools;
                      nextTools = rest;
                    }
                  }
                  // Same active-set scoping as the primary sentinel: never
                  // advertise deferred, not-yet-activated MCP tools.
                  const nextToolNamesForSentinel = (
                    computeActiveToolNames(toolSearchRuntime?.state) ?? Object.keys(nextTools)
                  ).sort();
                  const nextMemoryToolAvailable = nextTools.memory !== undefined;
                  const nextMemoryContext = await upgradeMemoryContextForModel(
                    nextMemoryToolAvailable,
                    next.canonicalModelString
                  );

                  // Rebuild the system prompt for the fallback model (tool
                  // instructions and "Model:" sections are model-keyed), keeping
                  // the MCP failure warning if one was applied.
                  const nextSystemContext = await buildStreamSystemContextForToolset(
                    {
                      advisorToolAvailable: nextTools.advisor !== undefined,
                      memoryToolAvailable: nextMemoryToolAvailable,
                    },
                    next.canonicalModelString,
                    nextMemoryContext
                  );
                  let nextSystem = nextSystemContext.systemMessage;
                  let nextSystemTokens = nextSystemContext.systemMessageTokens;
                  if (mcpWarningPrefix != null) {
                    nextSystem = `${mcpWarningPrefix}${nextSystem}`;
                    const nextTokenizer = await getTokenizerForModel(
                      next.canonicalModelString,
                      resolveModelForMetadata(
                        next.canonicalModelString,
                        this.providerService.getConfig()
                      )
                    );
                    nextSystemTokens = await nextTokenizer.countTokens(nextSystem);
                  }

                  const { providerRequestMessages: nextProviderRequestMessages } =
                    prepareProviderRequestMessages(
                      fallbackSourceMessages,
                      next.canonicalProviderName,
                      nextThinkingLevel
                    );
                  const nextFinalMessages = await prepareMessagesForProvider({
                    messagesWithSentinel: addInterruptedSentinel(nextProviderRequestMessages),
                    effectiveAgentId,
                    toolNamesForSentinel: nextToolNamesForSentinel,
                    planContentForTransition,
                    planFilePath,
                    changedFileAttachments,
                    postCompactionAttachments,
                    runtime,
                    workspacePath,
                    abortSignal: combinedAbortSignal,
                    providerForMessages: next.canonicalProviderName,
                    effectiveThinkingLevel: nextThinkingLevel,
                    modelString: next.canonicalModelString,
                    anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl,
                    workspaceId,
                  });

                  const nextProviderOptions = buildProviderOptions(
                    next.canonicalModelString,
                    nextThinkingLevel,
                    nextProviderRequestMessages,
                    (id) => this.streamManager.isResponseIdLost(id),
                    effectiveMuxProviderOptions,
                    workspaceId,
                    truncationMode,
                    this.providerService.getConfig(),
                    next.routeProvider,
                    promptCacheScope,
                    reasoningMode
                  );

                  // buildProviderOptions re-gates pro mode for each fallback model,
                  // so the native option never leaks onto unsupported fallbacks.
                  let nextHeaders = buildRequestHeaders(
                    next.canonicalModelString,
                    effectiveMuxProviderOptions,
                    workspaceId,
                    this.providerService.getConfig(),
                    next.routeProvider
                  );
                  if (pendingRunMetadataId != null) {
                    // Keep DevTools run correlation on fallback requests too.
                    nextHeaders = {
                      ...nextHeaders,
                      [DEVTOOLS_RUN_METADATA_ID_HEADER]: pendingRunMetadataId,
                    };
                  }

                  const nextOverrides = resolveModelParameterOverrides(
                    this.config.loadProvidersConfig(),
                    next.canonicalProviderName,
                    next.canonicalModelString,
                    next.effectiveModelString
                  );
                  const nextNamespaceKey = resolveProviderOptionsNamespaceKey(
                    next.canonicalProviderName,
                    next.routeProvider
                  );
                  // Mirrors mergeModelParameterExtras for the fallback model;
                  // shared by this baseline build and mid-turn rebuilds below.
                  const mergeNextModelParameterExtras = (
                    builtOptions: Record<string, unknown>
                  ): Record<string, unknown> => {
                    if (!nextOverrides.providerExtras) {
                      return builtOptions;
                    }
                    const nextMuxNamespace = builtOptions[nextNamespaceKey];
                    return {
                      ...builtOptions,
                      [nextNamespaceKey]: isPlainObject(nextMuxNamespace)
                        ? mergeProviderExtrasUnderMux(
                            nextOverrides.providerExtras,
                            nextMuxNamespace
                          )
                        : nextOverrides.providerExtras,
                    };
                  };
                  const nextMergedProviderOptions = mergeNextModelParameterExtras(
                    nextProviderOptions as Record<string, unknown>
                  );

                  // Rebuild closure bound to the FALLBACK model so mid-turn
                  // thinking changes keep working after the hop.
                  const nextCurrentEffectiveLevelRef = { current: nextThinkingLevel };
                  const rebuildNextProviderOptionsForThinkingLevel: RebuildProviderOptionsForThinkingLevel =
                    (level) => {
                      const clamped = enforceThinkingPolicy(
                        next.canonicalModelString,
                        level,
                        nextMinThinkingLevel,
                        this.providerService.getConfig()
                      );
                      const effective = resolveEffectiveThinkingLevel(
                        next.canonicalModelString,
                        clamped,
                        this.providerService.getConfig()
                      );
                      if (effective === nextCurrentEffectiveLevelRef.current) {
                        return null;
                      }
                      if (
                        isXaiGrokFastVariantSwap(
                          next.canonicalModelString,
                          nextCurrentEffectiveLevelRef.current,
                          effective
                        )
                      ) {
                        return null;
                      }
                      const rebuilt = buildProviderOptions(
                        next.canonicalModelString,
                        effective,
                        nextProviderRequestMessages,
                        (id) => this.streamManager.isResponseIdLost(id),
                        effectiveMuxProviderOptions,
                        workspaceId,
                        truncationMode,
                        this.providerService.getConfig(),
                        next.routeProvider,
                        promptCacheScope,
                        reasoningMode
                      );
                      const merged = mergeNextModelParameterExtras(
                        rebuilt as Record<string, unknown>
                      );
                      nextCurrentEffectiveLevelRef.current = effective;
                      return { effectiveLevel: effective, providerOptions: merged };
                    };

                  return Ok({
                    model: next.model,
                    modelString: next.canonicalModelString,
                    messages: nextFinalMessages,
                    system: nextSystem,
                    tools: nextTools,
                    providerOptions: nextMergedProviderOptions,
                    headers: nextHeaders,
                    callSettingsOverrides: nextOverrides.standard,
                    anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl ?? undefined,
                    thinkingLevel: nextThinkingLevel,
                    rebuildProviderOptionsForThinkingLevel:
                      rebuildNextProviderOptionsForThinkingLevel,
                    initialMetadataPatch: {
                      routedThroughGateway: next.routedThroughGateway,
                      ...(next.routeProvider != null ? { routeProvider: next.routeProvider } : {}),
                      // Explicit undefined clears a stale costsIncluded when falling
                      // back from a subscription-routed model to an API model.
                      costsIncluded: modelCostsIncluded(next.model) ? true : undefined,
                      systemMessageTokens: nextSystemTokens,
                    },
                  });
                } catch (error) {
                  // Release the created fallback model's transport resources when
                  // a later prepare step throws (it never reaches StreamManager,
                  // whose cleanup only covers models it took ownership of).
                  runLanguageModelCleanup(next.model);
                  throw error;
                }
              },
            }
          : undefined;

      emitStartupBreadcrumb("starting_stream");
      const startStreamStartedAt = Date.now();
      const streamResult = await this.streamManager.startStream(
        workspaceId,
        finalMessages,
        modelResult.data.model,
        modelString,
        historySequence,
        systemMessage,
        runtime,
        assistantMessageId, // Shared messageId ensures nested tool events match stream events
        combinedAbortSignal,
        toolsForStream,
        {
          systemMessageTokens,
          timestamp: Date.now(),
          agentId: effectiveAgentId,
          ...(legacyModeForMetadata != null ? { mode: legacyModeForMetadata } : {}),
          routedThroughGateway,
          // Preserve the resolved route source so stream events and persisted messages
          // keep non-gateway attribution even when the model ID itself is gateway-agnostic.
          ...(routeProvider != null ? { routeProvider } : {}),
          ...(muxMetadata !== undefined ? { muxMetadata } : {}),
          ...(acpPromptId != null ? { acpPromptId } : {}),
          ...(modelCostsIncluded(modelResult.data.model) ? { costsIncluded: true } : {}),
        },
        mergedProviderOptions,
        maxOutputTokens,
        effectiveToolPolicy,
        streamToken, // Pass the pre-generated stream token
        hasQueuedMessages,
        metadata.name,
        effectiveThinkingLevel,
        requestHeaders,
        effectiveMuxProviderOptions.anthropic?.cacheTtl ?? undefined,
        resolvedOverrides.standard,
        advisorToolEligible ? onAdvisorChunk : undefined,
        advisorToolEligible
          ? (stepMessages) => {
              advisorTranscriptRef.messages = stepMessages;
              advisorStepCaptureRef.currentStepText = "";
              advisorStepCaptureRef.currentStepReasoning = "";
              advisorStepCaptureRef.frozenSnapshotsByToolCallId.clear();
            }
          : undefined,
        runtimeTempDir,
        modelFallback,
        toolSearchRuntime?.state,
        activeTurnThinkingOverride,
        rebuildProviderOptionsForThinkingLevel
      );
      recordStartupPhaseTiming("startStreamMs", startStreamStartedAt);

      if (!streamResult.success) {
        // StreamManager failed before registering a stream. Clear queued run
        // metadata so it cannot attach to a later unrelated request.
        if (pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(assistantMessageId);
          pendingRunMetadataId = null;
        }

        logSlowStreamStartup?.({
          outcome: "stream_start_failed",
          providerName: canonicalProviderName,
          routeProvider,
          agentId: effectiveAgentId,
          mode: legacyModeForMetadata,
          runtimeType: metadata.runtimeConfig.type,
          errorType: streamResult.error.type,
          toolCount: Object.keys(toolsForStream).length,
          mcpToolCount: Object.keys(mcpTools ?? {}).length,
          mcpFailedServerCount: mcpStats?.failedServerCount ?? 0,
          providerRequestMessageCount: providerRequestMessages.length,
          finalMessageCount: finalMessages.length,
        });

        // StreamManager already returns SendMessageError
        return Err(streamResult.error);
      }

      // If we were interrupted during StreamManager startup before the stream was registered,
      // make sure we don't leave an empty assistant placeholder behind.
      if (combinedAbortSignal.aborted && !this.streamManager.isStreaming(workspaceId)) {
        if (pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(assistantMessageId);
          pendingRunMetadataId = null;
        }
        await deleteAbortedPlaceholder(assistantMessageId);
      }

      logSlowStreamStartup?.({
        outcome: "started",
        providerName: canonicalProviderName,
        routeProvider,
        agentId: effectiveAgentId,
        mode: legacyModeForMetadata,
        runtimeType: metadata.runtimeConfig.type,
        toolCount: Object.keys(toolsForStream).length,
        mcpToolCount: Object.keys(mcpTools ?? {}).length,
        mcpFailedServerCount: mcpStats?.failedServerCount ?? 0,
        providerRequestMessageCount: providerRequestMessages.length,
        finalMessageCount: finalMessages.length,
      });

      // StreamManager now handles history updates directly on stream-end
      // No need for event listener here
      return Ok(undefined);
    } catch (error) {
      if (pendingRunMetadataId != null) {
        this.clearTrackedPendingDevToolsRunMetadataById(workspaceId, pendingRunMetadataId);
        pendingRunMetadataId = null;
      }

      const errorMessage = getErrorMessage(error);
      logSlowStreamStartup?.({
        outcome: "error",
        errorMessage,
      });
      log.error("Stream message error:", error);
      // Return as unknown error type
      return Err({ type: "unknown", raw: `Failed to stream message: ${errorMessage}` });
    } finally {
      unlinkAbortSignal();
      const pending = this.pendingStreamStarts.get(workspaceId);
      if (pending?.abortController === pendingAbortController) {
        this.pendingStreamStarts.delete(workspaceId);
      }
    }
  }

  async stopStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean; abortReason?: StreamAbortReason }
  ): Promise<Result<void>> {
    const pending = this.pendingStreamStarts.get(workspaceId);
    const isActuallyStreaming =
      this.mockModeEnabled && this.mockAiStreamPlayer
        ? this.mockAiStreamPlayer.isStreaming(workspaceId)
        : this.streamManager.isStreaming(workspaceId);

    if (pending) {
      pending.abortController.abort();

      // If we're still in pre-stream startup (no StreamManager stream yet), emit a synthetic
      // stream-abort so the renderer can exit the "starting..." UI immediately.
      const abortReason = options?.abortReason ?? "startup";
      if (!isActuallyStreaming) {
        this.emit("stream-abort", {
          type: "stream-abort",
          workspaceId,
          abortReason,
          messageId: pending.syntheticMessageId,
          metadata: { duration: Date.now() - pending.startTime },
          abandonPartial: options?.abandonPartial,
          acpPromptId: pending.acpPromptId,
        } satisfies StreamAbortEvent);
      }
    }

    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      await this.mockAiStreamPlayer.stop(workspaceId);
      return Ok(undefined);
    }
    return this.streamManager.stopStream(workspaceId, options);
  }

  /**
   * Check if a workspace is currently streaming
   */
  isStreaming(workspaceId: string): boolean {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return this.mockAiStreamPlayer.isStreaming(workspaceId);
    }
    return this.streamManager.isStreaming(workspaceId);
  }

  /**
   * Get the current stream state for a workspace
   */
  getStreamState(workspaceId: string): string {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return this.mockAiStreamPlayer.isStreaming(workspaceId) ? "streaming" : "idle";
    }
    return this.streamManager.getStreamState(workspaceId);
  }

  /**
   * Get the current stream info for a workspace if actively streaming
   * Used to re-establish streaming context on frontend reconnection
   */
  getStreamInfo(workspaceId: string): ReturnType<typeof this.streamManager.getStreamInfo> {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return undefined;
    }
    return this.streamManager.getStreamInfo(workspaceId);
  }

  /**
   * Resolve the pricing/tokenization metadata model for a model string
   * (mappedToModel aliases for custom providers). Used by non-stream
   * consumers like /btw so their persisted rows price like normal chat rows.
   */
  resolveMetadataModel(modelString: string): string {
    return this.streamManager.resolveMetadataModel(modelString);
  }

  /**
   * Replay stream events
   * Emits the same events that would be emitted during live streaming
   */
  async replayStream(workspaceId: string, opts?: { afterTimestamp?: number }): Promise<void> {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      await this.mockAiStreamPlayer.replayStream(workspaceId);
      return;
    }
    await this.streamManager.replayStream(workspaceId, opts);
  }

  debugGetLastMockPrompt(workspaceId: string): Result<MuxMessage[] | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastMockPrompt: workspaceId is required");
    }

    if (!this.mockModeEnabled || !this.mockAiStreamPlayer) {
      return Ok(null);
    }

    return Ok(this.mockAiStreamPlayer.debugGetLastPrompt(workspaceId));
  }
  debugGetLastMockModel(workspaceId: string): Result<string | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastMockModel: workspaceId is required");
    }

    if (!this.mockModeEnabled || !this.mockAiStreamPlayer) {
      return Ok(null);
    }

    return Ok(this.mockAiStreamPlayer.debugGetLastModel(workspaceId));
  }

  debugGetLastLlmRequest(workspaceId: string): Result<DebugLlmRequestSnapshot | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastLlmRequest: workspaceId is required");
    }

    return Ok(this.lastLlmRequestByWorkspace.get(workspaceId) ?? null);
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(
    workspaceId: string,
    errorMessage = "Test-triggered stream error"
  ): Promise<boolean> {
    return this.streamManager.debugTriggerStreamError(workspaceId, errorMessage);
  }

  /**
   * Wait for workspace initialization to complete (if running).
   * Public wrapper for agent discovery and other callers.
   */
  async waitForInit(workspaceId: string, abortSignal?: AbortSignal): Promise<void> {
    return this.initStateManager.waitForInit(workspaceId, abortSignal);
  }

  async deleteWorkspace(workspaceId: string): Promise<Result<void>> {
    try {
      const workspaceDir = this.config.getSessionDir(workspaceId);
      await fs.rm(workspaceDir, { recursive: true, force: true });
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to delete workspace: ${message}`);
    }
  }
}
