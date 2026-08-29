import * as fs from "fs/promises";

import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import assert from "@/common/utils/assert";
import { type LanguageModel, type Tool } from "ai";

import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
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
import type { ModelMessage, MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import {
  StreamManager,
  type ModelFallbackOptions,
  type StreamTextOnChunk,
  type TurnCompletion,
  type TurnEngineEvent,
  type TurnExecutionOptions,
  type TurnStreamHandle,
} from "./streamManager";
import { emitTurnEnvelope } from "./turnEnvelope";
import {
  sharedDurableEventJournal,
  type DurableEventJournal,
} from "@/node/utils/journal/durableEventJournal";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import type { InitStateManager } from "./initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import {
  deriveToolHookConfig,
  getForcedXaiSearchToolNames,
  getToolsForModel,
  type AdvisorStepCaptureRef,
  type MCPPromptRuntime,
  type ToolConfiguration,
} from "@/common/utils/tools/tools";
import { getGoalToolAvailability } from "@/common/utils/tools/toolAvailability";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { agentPluginHookService } from "@/node/services/agentPlugins/hookService";
import { resolveAgentPluginsMcpContext } from "@/node/services/agentPlugins/mcpConfig";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
  resolveWorkspaceRootPath,
  type WorkspaceRuntimeContext,
} from "@/node/runtime/runtimeHelpers";
import type { Runtime } from "@/node/runtime/Runtime";
import { getWorkspacePathHintForProject } from "@/node/services/workspaceProjectRepos";
import { isRlmModeEnabled } from "@/node/services/branchSummary";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { getXumEnv, getRuntimeType } from "@/node/runtime/initHook";
import { getSrcBaseDir, isSSHRuntime } from "@/common/types/runtime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { secretsToRecord } from "@/common/types/secrets";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { XumToolScope } from "@/common/types/toolScope";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { log } from "./log";
import {
  addInterruptedSentinel,
  filterEmptyAssistantMessages,
} from "@/browser/utils/messages/modelMessageTransform";

import type { HistoryService } from "./historyService";
import { delegatedToolCallManager } from "./delegatedToolCallManager";
import { createErrorEvent, formatSendMessageError } from "./utils/sendMessageError";
import { findWorkspaceEntry, resolveWorkspaceModelFallbackChain } from "@/node/services/taskUtils";
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
import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import {
  coderGatewayWireProtocol,
  resolveCoderWireCanonicalModel,
} from "@/common/constants/coderOAuth";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import {
  customProviderWireOrigin,
  isCustomProviderConfig,
} from "@/common/utils/providers/customProviders";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { excludeKeepRecentTailForCompactionRequest } from "@/common/utils/messages/keepRecentTail";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import { uniqueSuffix } from "@/common/utils/hasher";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";

import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults } from "@/constants/goals";
import { mergeGoalDefaults } from "@/common/utils/goals/resolveGoalSetIntent";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { THINKING_LEVEL_OFF, type ThinkingLevel } from "@/common/types/thinking";
import {
  enforceThinkingPolicy,
  isXaiGrokFastVariantSwap,
  lookupMinThinkingLevelOverride,
  resolveEffectiveThinkingLevel,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";
import type {
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";

import type { StreamAbortEvent, StreamAbortReason } from "@/common/types/stream";
import {
  computeActiveToolNames,
  prepareToolSearch,
  rebuildToolSearchState,
  seedToolSearchActivationsFromMessages,
  TOOL_SEARCH_TOOL_NAME,
  type ToolSearchRuntime,
} from "@/common/utils/tools/toolCatalog";
import type { PTCEventWithParent } from "@/node/services/tools/code_execution";
import { DEVTOOLS_RUN_METADATA_ID_HEADER } from "./devToolsHeaderCapture";
import { ProviderModelFactory, modelCostsIncluded } from "./providerModelFactory";
import { prepareMessagesForProvider } from "./messagePipeline";
import { getLegacyModeForAgentMetadata, resolveAgentForStream } from "./agentResolution";
import { buildPlanInstructions, buildStreamSystemContext } from "./streamContextBuilder";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import {
  normalizeUsageModelKey,
  resolveModelForMetadata,
} from "@/common/utils/providers/modelEntries";
import {
  simulateContextLimitError,
  simulateToolPolicyNoop,
  type SimulationContext,
} from "./streamSimulation";
import {
  applyToolPolicyAndExperiments,
  captureMcpToolTelemetry,
  resolveBackendGatedPtcExperiments,
} from "./toolAssembly";
import { createKernelFileLoader } from "@/node/services/tools/kernelFileLoad";
import { eventSpine, type RequestAssembleContext } from "@/node/services/events/eventSpine";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubsetSchema } from "@/common/utils/jsonSchemaSubset";
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
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";

const STREAM_STARTUP_DIAGNOSTIC_THRESHOLD_MS = 1_000;

import type { SendMessageOptions } from "@/common/orpc/types";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { ErrorEvent } from "@/common/types/stream";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { FileState } from "@/node/services/agentSession";
import type { MemorySessionContext } from "@/node/services/memoryService";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";

/** Options used to prepare and execute a turn. */
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
  /** See SendMessageOptionsSchema.strictAgentResolution: explicit-agent sends fail loudly instead of falling back to exec. */
  strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
  /** ACP prompt correlation id used to match stream events to a specific request. */
  acpPromptId?: string;
  /** Invoked with each fatal pre-start error event this call emits before returning Err. */
  onPreStartError?: (event: ErrorEvent) => void;
  /** Tool names that should be delegated back to ACP clients for this request. */
  delegatedToolNames?: string[];
  recordFileState?: (filePath: string, state: FileState) => Promise<void>;
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

export function prepareProviderRequestMessages(
  messages: MuxMessage[],
  canonicalProviderName: string,
  effectiveThinkingLevel: ThinkingLevel
): {
  activeContextMessages: MuxMessage[];
  providerRequestMessages: MuxMessage[];
  contextBoundarySlicedCount: number;
} {
  // Workflow display rows are durable UI history, not main-agent context.
  const messagesWithoutWorkflowDisplay = filterWorkflowDisplayOnlyMessages(messages);
  // RLM keep-recent floor: a stamped compaction request summarizes only the
  // older head; the stamped tail is preserved verbatim after the boundary.
  // No-op (same reference) unless the trailing user row carries the durable
  // stamp, so RLM-off requests and replay stay byte-identical.
  const activeContextMessages = excludeKeepRecentTailForCompactionRequest(
    sliceMessagesForProviderFromLatestContextBoundary(messagesWithoutWorkflowDisplay)
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
    contextBoundarySlicedCount,
  };
}

// Exported for the replay builder: fallback requests append the refusal's
// partial continuation the same way production does.
export function replaceOrAppendMessageById(
  messages: MuxMessage[],
  replacement: MuxMessage
): MuxMessage[] {
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

/**
 * Recursively merge user-provided provider extras under Xum-built provider options.
 * Xum values win on leaf conflicts; both sides' non-conflicting nested fields are preserved.
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

/**
 * Pin the factory-resolved Coder instance type into a providers-config view.
 *
 * Every request builder (message prep, options, headers, overrides,
 * capability lookups, mid-turn rebuild closures) consumes ONE snapshot per
 * request instead of re-reading ProviderService. Pinning closes the residual
 * race between the factory's own config read and this capture: a concurrent
 * authoritative catalog refresh that rewrites the selected instance's type
 * would otherwise make the builders resolve a different wire than the
 * already-created SDK model. additionalProviders is the highest-precedence
 * metadata source (resolveCoderGatewayProvider consults it first), so the
 * pinned entry wins over any concurrently rewritten discovered metadata.
 * Pinning keys on the RAW selection's instance (coderSelectedInstance), not
 * on the effective route: a coder: selection that FELL BACK to a direct
 * provider still has builders resolving the raw model string (capability
 * lookups, override identity, option/header rebuilds), and a concurrent
 * retag between the factory's read and this capture would otherwise hand
 * the already-created fallback model another type's options. Non-coder
 * selections, shadowed prefixes, and unknown instances have no snapshot and
 * keep the view untouched.
 */
function pinCoderInstanceProvidersConfig(
  view: ProvidersConfigMap,
  rawModelString: string,
  instance: { name: string; type: string } | undefined
): ProvidersConfigMap {
  if (!instance || !rawModelString.startsWith("coder:")) {
    return view;
  }
  return {
    ...view,
    coder: {
      ...(view.coder ?? { apiKeySet: false, isEnabled: true, isConfigured: true }),
      additionalProviders: [{ name: instance.name, type: instance.type }],
    },
  };
}

/**
 * Raw providers.jsonc counterpart of pinCoderInstanceProvidersConfig for
 * consumers that need file-shaped config (modelParameters lookups). Same
 * rationale: additionalProviders is the highest-precedence metadata source,
 * so pinning the factory-resolved instance there keeps metadata-dependent
 * decisions (mappedToModel aliases, sampling gates) on the type the SDK
 * model was created for.
 */
function pinCoderInstanceRawProvidersConfig(
  view: ProvidersConfig | null,
  rawModelString: string,
  instance: { name: string; type: string } | undefined
): ProvidersConfig | null {
  if (!view || !instance || !rawModelString.startsWith("coder:")) {
    return view;
  }
  return {
    ...view,
    coder: {
      ...(view.coder ?? {}),
      additionalProviders: [{ name: instance.name, type: instance.type }],
    },
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

export interface TurnRequestBuildStartupState {
  pendingRunMetadataId: string | null;
  logSlowStreamStartup?: (details: Record<string, unknown>) => void;
}

export interface TurnRequestBuildContext {
  abortSignal: AbortSignal;
  syntheticMessageId: string;
  startupState: TurnRequestBuildStartupState;
  recordStartupPhaseTiming: (phase: string, phaseStartedAt: number) => void;
}

export type TurnRequestBuildOutcome =
  | { type: "finished"; result: Result<TurnStreamHandle, SendMessageError> }
  | {
      type: "ready";
      turnExecutionOptions: TurnExecutionOptions;
      assistantMessageId: string;
      deleteAbortedPlaceholder: (messageId: string) => Promise<void>;
      logStartOutcome: (outcome: "started" | "stream_start_failed", errorType?: string) => void;
    };

interface TurnRequestBuilderLateBoundDependencies {
  mcpServerManager: () => MCPServerManager | undefined;
  taskService: () => TaskService | undefined;
  memoryService: () => MemoryService | undefined;
  timelineService: () => ToolConfiguration["timelineService"];
  extraTools: () => Record<string, Tool> | undefined;
  onWorkflowRunStatusChanged: () =>
    | ((event: WorkflowRunStatusChangedEvent) => Promise<void> | void)
    | undefined;
  workflowResultContinuationSender: () => WorkflowResultContinuationSender | undefined;
  workspaceHeartbeatService: () => ToolConfiguration["workspaceHeartbeatService"];
  analyticsService: () => { executeRawQuery(sql: string): Promise<unknown> } | undefined;
  desktopSessionManager: () => DesktopSessionManager | undefined;
}

export interface TurnRequestBuilderDependencies {
  config: Config;
  historyService: HistoryService;
  initStateManager: InitStateManager;
  providerService: ProviderService;
  providerModelFactory: ProviderModelFactory;
  streamManager: StreamManager;
  workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  policyService?: PolicyService;
  telemetryService?: TelemetryService;
  backgroundProcessManager?: BackgroundProcessManager;
  sessionUsageService?: SessionUsageService;
  devToolsService?: DevToolsService;
  experimentsService?: ExperimentsService;
  lastLlmRequestByWorkspace: Map<string, DebugLlmRequestSnapshot>;
  lateBound: TurnRequestBuilderLateBoundDependencies;
  emit: (event: string, ...args: unknown[]) => boolean;
  createAbortedTurnHandle: (messageId: string) => TurnStreamHandle;
  createSettledTurnHandle: (messageId: string, completion: TurnCompletion) => TurnStreamHandle;
  getWorkspaceMetadata: (workspaceId: string) => Promise<Result<WorkspaceMetadata>>;
  createWorkspaceRuntimeContext: (
    workspaceId: string,
    metadata: WorkspaceMetadata
  ) => Result<
    WorkspaceRuntimeContext & {
      hostCheckoutRoot: string | null;
      projectCheckoutRoot: string | null;
    },
    SendMessageError
  >;
  isClaudeSkillsCompatEnabled: () => boolean;
  isAgentPluginsEnabled: () => boolean;
  wrapToolsForDelegation: (
    workspaceId: string,
    tools: Record<string, Tool>,
    delegatedToolNames?: string[]
  ) => Record<string, Tool>;
  durableEventJournalFor: (workspaceId: string) => DurableEventJournal;
  shouldAllowLegacyInvalidWorkflowAgentOutputSchema: (
    metadata: WorkspaceMetadata
  ) => Promise<boolean>;
  createModel: (
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: { agentInitiated?: boolean; workspaceId?: string; providersConfig?: ProvidersConfig }
  ) => Promise<Result<LanguageModel, SendMessageError>>;
  isStreaming: (workspaceId: string) => boolean;
  trackPendingDevToolsRunMetadata: (
    messageId: string,
    workspaceId: string,
    metadataId: string
  ) => void;
}

interface PrepareModelAttemptOptions {
  rawModelString: string;
  canonicalModelString: string;
  canonicalProviderName: string;
  effectiveModelString: string;
  optionsModelString: string;
  wireProviderName: string;
  routeProvider?: ProviderName;
  effectiveThinkingLevel: ThinkingLevel;
  minThinkingLevel: ThinkingLevel;
  providerRequestMessages: MuxMessage[];
  muxProviderOptions: MuxProviderOptions;
  workspaceId: string;
  truncationMode: Parameters<typeof buildProviderOptions>[6];
  providersConfigSnapshot: ProvidersConfigMap;
  coderSelectedInstance?: { name: string; type: string };
  promptCacheScope: string;
  reasoningMode: Parameters<typeof buildProviderOptions>[10];
  recordStartupPhaseTiming?: (phase: string, phaseStartedAt: number) => void;
}

interface PreparedModelAttempt {
  providerOptions: Record<string, unknown>;
  requestHeaders: Record<string, string> | undefined;
  resolvedOverrides: ReturnType<typeof resolveModelParameterOverrides>;
  currentEffectiveLevelRef: { current: ThinkingLevel };
  computeRebuiltProviderOptions: (
    level: ThinkingLevel,
    currentLevel: ThinkingLevel
  ) => { effectiveLevel: ThinkingLevel; providerOptions: Record<string, unknown> } | null;
  rebuildProviderOptionsForThinkingLevel: RebuildProviderOptionsForThinkingLevel;
}

export class TurnRequestBuilder {
  constructor(private readonly dependencies: TurnRequestBuilderDependencies) {}

  private get config(): Config {
    return this.dependencies.config;
  }
  private get historyService(): HistoryService {
    return this.dependencies.historyService;
  }
  private get initStateManager(): InitStateManager {
    return this.dependencies.initStateManager;
  }
  private get providerService(): ProviderService {
    return this.dependencies.providerService;
  }
  private get providerModelFactory(): ProviderModelFactory {
    return this.dependencies.providerModelFactory;
  }
  private get streamManager(): StreamManager {
    return this.dependencies.streamManager;
  }
  private get workspaceMcpOverridesService(): WorkspaceMcpOverridesService {
    return this.dependencies.workspaceMcpOverridesService;
  }
  private get policyService(): PolicyService | undefined {
    return this.dependencies.policyService;
  }
  private get telemetryService(): TelemetryService | undefined {
    return this.dependencies.telemetryService;
  }
  private get backgroundProcessManager(): BackgroundProcessManager | undefined {
    return this.dependencies.backgroundProcessManager;
  }
  private get sessionUsageService(): SessionUsageService | undefined {
    return this.dependencies.sessionUsageService;
  }
  private get devToolsService(): DevToolsService | undefined {
    return this.dependencies.devToolsService;
  }
  private get experimentsService(): ExperimentsService | undefined {
    return this.dependencies.experimentsService;
  }
  private get lastLlmRequestByWorkspace(): Map<string, DebugLlmRequestSnapshot> {
    return this.dependencies.lastLlmRequestByWorkspace;
  }
  private get mcpServerManager(): MCPServerManager | undefined {
    return this.dependencies.lateBound.mcpServerManager();
  }
  private get taskService(): TaskService | undefined {
    return this.dependencies.lateBound.taskService();
  }
  private get memoryService(): MemoryService | undefined {
    return this.dependencies.lateBound.memoryService();
  }
  private get timelineService(): ToolConfiguration["timelineService"] {
    return this.dependencies.lateBound.timelineService();
  }
  private get extraTools(): Record<string, Tool> | undefined {
    return this.dependencies.lateBound.extraTools();
  }
  private get onWorkflowRunStatusChanged():
    | ((event: WorkflowRunStatusChangedEvent) => Promise<void> | void)
    | undefined {
    return this.dependencies.lateBound.onWorkflowRunStatusChanged();
  }
  private get workflowResultContinuationSender(): WorkflowResultContinuationSender | undefined {
    return this.dependencies.lateBound.workflowResultContinuationSender();
  }
  private get workspaceHeartbeatService(): ToolConfiguration["workspaceHeartbeatService"] {
    return this.dependencies.lateBound.workspaceHeartbeatService();
  }
  private get analyticsService(): { executeRawQuery(sql: string): Promise<unknown> } | undefined {
    return this.dependencies.lateBound.analyticsService();
  }
  private get desktopSessionManager(): DesktopSessionManager | undefined {
    return this.dependencies.lateBound.desktopSessionManager();
  }

  private emit(event: string, ...args: unknown[]): boolean {
    return this.dependencies.emit(event, ...args);
  }
  private createAbortedTurnHandle(messageId: string): TurnStreamHandle {
    return this.dependencies.createAbortedTurnHandle(messageId);
  }
  private createSettledTurnHandle(messageId: string, completion: TurnCompletion): TurnStreamHandle {
    return this.dependencies.createSettledTurnHandle(messageId, completion);
  }
  private getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>> {
    return this.dependencies.getWorkspaceMetadata(workspaceId);
  }
  private createWorkspaceRuntimeContext(workspaceId: string, metadata: WorkspaceMetadata) {
    return this.dependencies.createWorkspaceRuntimeContext(workspaceId, metadata);
  }
  private isClaudeSkillsCompatEnabled(): boolean {
    return this.dependencies.isClaudeSkillsCompatEnabled();
  }
  private isAgentPluginsEnabled(): boolean {
    return this.dependencies.isAgentPluginsEnabled();
  }
  private wrapToolsForDelegation(
    workspaceId: string,
    tools: Record<string, Tool>,
    delegatedToolNames?: string[]
  ): Record<string, Tool> {
    return this.dependencies.wrapToolsForDelegation(workspaceId, tools, delegatedToolNames);
  }
  private durableEventJournalFor(workspaceId: string): DurableEventJournal {
    return this.dependencies.durableEventJournalFor(workspaceId);
  }
  private shouldAllowLegacyInvalidWorkflowAgentOutputSchema(
    metadata: WorkspaceMetadata
  ): Promise<boolean> {
    return this.dependencies.shouldAllowLegacyInvalidWorkflowAgentOutputSchema(metadata);
  }
  private createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: { agentInitiated?: boolean; workspaceId?: string; providersConfig?: ProvidersConfig }
  ) {
    return this.dependencies.createModel(modelString, muxProviderOptions, opts);
  }
  private isStreaming(workspaceId: string): boolean {
    return this.dependencies.isStreaming(workspaceId);
  }
  private trackPendingDevToolsRunMetadata(
    messageId: string,
    workspaceId: string,
    metadataId: string
  ): void {
    this.dependencies.trackPendingDevToolsRunMetadata(messageId, workspaceId, metadataId);
  }

  private resolveOverridesIdentity(
    rawModelString: string,
    canonical: string,
    canonicalProvider: string,
    providersConfig: ProvidersConfigMap
  ): { providerName: string; modelString: string; coderDerived: boolean } {
    if (rawModelString.startsWith("coder:")) {
      const metadataCanonical = resolveCoderGatewayMetadataModel(rawModelString, providersConfig);
      if (metadataCanonical != null) {
        const separator = metadataCanonical.indexOf(":");
        return {
          providerName: separator > 0 ? metadataCanonical.slice(0, separator) : canonicalProvider,
          modelString: metadataCanonical,
          coderDerived: true,
        };
      }
      const coderSection = providersConfig.coder;
      if (!isCustomProviderConfig(coderSection)) {
        const wire = resolveCoderWireCanonicalModel(
          rawModelString.slice("coder:".length),
          coderSection as
            | { discoveredProviders?: unknown; additionalProviders?: unknown }
            | undefined
        );
        if (wire) {
          return { providerName: "coder", modelString: rawModelString, coderDerived: false };
        }
      }
    }
    const separator = canonical.indexOf(":");
    return {
      providerName: separator > 0 ? canonical.slice(0, separator) : canonicalProvider,
      modelString: canonical,
      coderDerived: false,
    };
  }

  private prepareModelAttempt(options: PrepareModelAttemptOptions): PreparedModelAttempt {
    const buildProviderOptionsStartedAt = Date.now();
    const providerOptions = buildProviderOptions(
      options.optionsModelString,
      options.effectiveThinkingLevel,
      options.providerRequestMessages,
      (id) => this.streamManager.isResponseIdLost(id),
      options.muxProviderOptions,
      options.workspaceId,
      options.truncationMode,
      options.providersConfigSnapshot,
      options.routeProvider,
      options.promptCacheScope,
      options.reasoningMode
    ) as Record<string, unknown>;
    options.recordStartupPhaseTiming?.("buildProviderOptionsMs", buildProviderOptionsStartedAt);
    const buildRequestConfigStartedAt = Date.now();
    const requestHeaders = buildRequestHeaders(
      options.optionsModelString,
      options.muxProviderOptions,
      options.workspaceId,
      options.providersConfigSnapshot,
      options.routeProvider
    );
    const overridesIdentity = this.resolveOverridesIdentity(
      options.rawModelString,
      options.canonicalModelString,
      options.canonicalProviderName,
      options.providersConfigSnapshot
    );
    const resolvedOverrides = resolveModelParameterOverrides(
      pinCoderInstanceRawProvidersConfig(
        this.config.loadProvidersConfig(),
        options.rawModelString,
        options.coderSelectedInstance
      ),
      overridesIdentity.providerName,
      overridesIdentity.modelString,
      options.effectiveModelString
    );
    const namespaceKey = resolveProviderOptionsNamespaceKey(
      options.wireProviderName,
      options.routeProvider
    );
    const extrasWireCompatible =
      !overridesIdentity.coderDerived || overridesIdentity.providerName === namespaceKey;
    const mergeExtras = (builtOptions: Record<string, unknown>): Record<string, unknown> => {
      if (!resolvedOverrides.providerExtras || !extrasWireCompatible) {
        return builtOptions;
      }
      const muxProviderNamespace = builtOptions[namespaceKey];
      return {
        ...builtOptions,
        [namespaceKey]: isPlainObject(muxProviderNamespace)
          ? mergeProviderExtrasUnderMux(resolvedOverrides.providerExtras, muxProviderNamespace)
          : resolvedOverrides.providerExtras,
      };
    };
    const currentEffectiveLevelRef = { current: options.effectiveThinkingLevel };
    const computeRebuiltProviderOptions = (
      level: ThinkingLevel,
      currentLevel: ThinkingLevel
    ): { effectiveLevel: ThinkingLevel; providerOptions: Record<string, unknown> } | null => {
      const clamped = enforceThinkingPolicy(
        options.rawModelString,
        level,
        options.minThinkingLevel,
        options.providersConfigSnapshot
      );
      const effective = resolveEffectiveThinkingLevel(
        options.rawModelString,
        clamped,
        options.providersConfigSnapshot
      );
      if (
        effective === currentLevel ||
        isXaiGrokFastVariantSwap(options.canonicalModelString, currentLevel, effective)
      ) {
        return null;
      }
      const rebuilt = buildProviderOptions(
        options.optionsModelString,
        effective,
        options.providerRequestMessages,
        (id) => this.streamManager.isResponseIdLost(id),
        options.muxProviderOptions,
        options.workspaceId,
        options.truncationMode,
        options.providersConfigSnapshot,
        options.routeProvider,
        options.promptCacheScope,
        options.reasoningMode
      ) as Record<string, unknown>;
      return { effectiveLevel: effective, providerOptions: mergeExtras(rebuilt) };
    };
    const rebuildProviderOptionsForThinkingLevel: RebuildProviderOptionsForThinkingLevel = (
      level
    ) => {
      const result = computeRebuiltProviderOptions(level, currentEffectiveLevelRef.current);
      if (result != null) {
        currentEffectiveLevelRef.current = result.effectiveLevel;
      }
      return result;
    };
    options.recordStartupPhaseTiming?.("buildRequestConfigMs", buildRequestConfigStartedAt);
    return {
      providerOptions: mergeExtras(providerOptions),
      requestHeaders,
      resolvedOverrides,
      currentEffectiveLevelRef,
      computeRebuiltProviderOptions,
      rebuildProviderOptionsForThinkingLevel,
    };
  }

  async build(
    opts: StreamMessageOptions,
    context: TurnRequestBuildContext
  ): Promise<TurnRequestBuildOutcome> {
    const {
      messages,
      workspaceId,
      modelString,
      thinkingLevel,
      reasoningMode,
      toolPolicy,
      additionalSystemContext,
      additionalSystemInstructions,
      maxOutputTokens,
      muxProviderOptions,
      agentInitiated,
      agentId,
      strictAgentResolution,
      acpPromptId,
      onPreStartError,
      delegatedToolNames,
      recordFileState,
      postCompactionAttachments,
      resolveMemoryContext,
      experiments: experimentsFromOptions,
      allowAgentSetGoal,
      workspaceGoalService,
      disableWorkspaceAgents,
      hasQueuedMessages,
      openaiTruncationModeOverride,
      muxMetadata,
      minThinkingLevel: providedMinThinkingLevel,
      activeTurnThinkingOverride,
    } = opts;
    const experiments: StreamMessageOptions["experiments"] = resolveBackendGatedPtcExperiments(
      experimentsFromOptions,
      (experimentId) => this.experimentsService?.isExperimentEnabled(experimentId) === true
    );
    const combinedAbortSignal = context.abortSignal;
    const syntheticMessageId = context.syntheticMessageId;
    const recordStartupPhaseTiming = context.recordStartupPhaseTiming;
    let pendingRunMetadataId: string | null = context.startupState.pendingRunMetadataId;
    let logSlowStreamStartup: ((details: Record<string, unknown>) => void) | undefined;

    const deleteAbortedPlaceholder = async (messageId: string): Promise<void> => {
      const deleteResult = await this.historyService.deleteMessage(workspaceId, messageId);
      if (!deleteResult.success) {
        log.error(
          "Failed to delete aborted assistant placeholder (" +
            messageId +
            "): " +
            deleteResult.error
        );
      }
    };
    // Mode (plan|exec|compact) is derived from the selected agent definition.
    const effectiveMuxProviderOptions: MuxProviderOptions = muxProviderOptions ?? {};
    // Preliminary clamp for the factory call only: the factory reads the
    // thinking level solely for the xAI Grok variant swap, which never
    // depends on Coder instance metadata, so a pre-snapshot resolution is
    // safe there. The FINAL effectiveThinkingLevel is re-resolved below
    // from the pinned request snapshot — resolving it from this earlier
    // read would race a concurrent instance retag and disagree with the
    // wire the factory created the SDK model for.
    const preliminaryThinkingLevel: ThinkingLevel = resolveEffectiveThinkingLevel(
      modelString,
      thinkingLevel,
      this.providerService.getConfig()
    );

    // Resolve model string (xAI variant mapping + gateway routing) and create the model.
    const resolveAndCreateModelStartedAt = Date.now();
    const modelResult = await this.providerModelFactory.resolveAndCreateModel(
      modelString,
      preliminaryThinkingLevel,
      effectiveMuxProviderOptions,
      { agentInitiated, workspaceId }
    );
    recordStartupPhaseTiming("resolveAndCreateModelMs", resolveAndCreateModelStartedAt);
    if (!modelResult.success) {
      return { type: "finished", result: Err(modelResult.error) };
    }
    const {
      effectiveModelString,
      canonicalModelString,
      canonicalProviderName,
      wireProviderName,
      routedThroughGateway,
      routeProvider,
    } = modelResult.data;
    // ONE providers-config snapshot for every request builder (messages,
    // options, headers, overrides, capability lookups, mid-turn rebuild
    // closures). Re-reading ProviderService per builder races concurrent
    // catalog refreshes: an instance-type change mid-request would hand the
    // already-created SDK model another wire's options/headers. The
    // factory-resolved instance type is PINNED into the snapshot so every
    // coder-wire resolution matches the created model even when the change
    // lands between the factory's read and this capture.
    const requestProvidersConfig = pinCoderInstanceProvidersConfig(
      this.providerService.getConfig(),
      modelString,
      modelResult.data.coderSelectedInstance
    );
    // FINAL thinking clamp from the pinned snapshot. Models that cannot disable
    // thinking, including aliases mapped to them, get the same treatment.
    // Resolved here — not from the pre-factory read — so a
    // concurrent instance retag cannot leave the level derived from one
    // type while options/messages are built for the other's wire.
    const effectiveThinkingLevel: ThinkingLevel = resolveEffectiveThinkingLevel(
      modelString,
      thinkingLevel,
      requestProvidersConfig
    );
    // Capability lookups must see the RAW coder identity: name-based
    // canonicalization can rewrite a cross-typed instance (coder:openai/x
    // with type anthropic) to openai:x, hiding the instance metadata that
    // resolveModelForMetadata needs to derive the real capability model.
    // Non-coder strings keep the canonical form (raw gateway strings like
    // mux-gateway:origin/x would otherwise leak through unresolved).
    const capabilityModelString = resolveModelForMetadata(
      modelString.startsWith("coder:") ? modelString : canonicalModelString,
      requestProvidersConfig
    );
    // Provider-specific tool assembly keys on the WIRE identity of the
    // EFFECTIVE route: raw coder:<instance>/<model> strings parse as
    // provider "coder" inside getToolsForModel, which skips the Anthropic
    // branch (native web tools) and the OpenAI branch (MCP schema
    // sanitization). The wire variant matters too: openai-chat instance
    // types (openrouter/google/azure/openai-compat/vercel) are created via
    // provider.chat(...), so Responses-only assembly (native web_search)
    // and Responses-only providerOptions must be suppressed via the
    // existing wireFormat knob. When routing fell away from Coder, the
    // effective route IS the identity (a coder:openrouter selection that
    // fell back to direct OpenRouter must not be treated as OpenAI-wire).
    // The capability identity above stays raw-derived. A custom provider
    // shadowing the "coder" prefix keeps its raw identity; unknown
    // instances fall back to the name-canonical form.
    const resolveToolsIdentity = (
      raw: string,
      effective: string,
      canonical: string,
      // The factory's wire snapshot — resolved from the SAME config read
      // that created the SDK model. Re-reading the providers config here
      // instead would race authoritative catalog refreshes: a mid-request
      // type change would assemble another wire's tools/options for the
      // already-created model. Shadowed prefixes and unknown instances have
      // no snapshot, and their canonical form is the raw string.
      coderWire:
        | { origin: "anthropic" | "openai"; modelId: string; providerType: string }
        | undefined,
      // Snapshot the identity is resolved against; the refusal-fallback
      // path passes ITS pinned snapshot, not the primary request's.
      providersConfigSnapshot: ProvidersConfigMap
    ): { modelString: string; openaiWireFormat?: "chatCompletions" | "responses" } => {
      // Custom providers own their raw prefix (including shadowed built-in
      // ids) and speak the wire their providerType selects: tool assembly
      // must key on that wire so Responses-bound MCP schemas are sanitized
      // and provider-native tools are offered. Chat-completions custom
      // providers keep their generic identity.
      const rawSeparator = raw.indexOf(":");
      const rawPrefix = rawSeparator > 0 ? raw.slice(0, rawSeparator) : "";
      const rawCustomEntry = rawPrefix ? providersConfigSnapshot[rawPrefix] : undefined;
      if (isCustomProviderConfig(rawCustomEntry)) {
        const wireOrigin = customProviderWireOrigin(rawCustomEntry.providerType);
        if (wireOrigin === "openai") {
          // The factory always creates provider.responses() for this type.
          return {
            modelString: `openai:${raw.slice(rawSeparator + 1)}`,
            openaiWireFormat: "responses",
          };
        }
        if (wireOrigin === "anthropic") {
          return { modelString: `anthropic:${raw.slice(rawSeparator + 1)}` };
        }
        return { modelString: raw };
      }
      if (!raw.startsWith("coder:")) {
        return { modelString: raw };
      }
      if (!effective.startsWith("coder:")) {
        // Fallback away from Coder. A PASSTHROUGH gateway fallback
        // (mux-gateway:anthropic/x) must normalize to the canonical wire
        // identity: getToolsForModel only runs Anthropic/OpenAI-specific
        // assembly (native web tools, MCP schema sanitization) for direct
        // provider prefixes, and passthrough gateways forward origin-shaped
        // payloads. Transforming gateways (openrouter) keep their own
        // identity, same as a direct selection of that gateway.
        const separator = effective.indexOf(":");
        const effectiveProvider = separator > 0 ? effective.slice(0, separator) : "";
        const definition = Object.hasOwn(PROVIDER_DEFINITIONS, effectiveProvider)
          ? PROVIDER_DEFINITIONS[effectiveProvider as ProviderName]
          : undefined;
        const passthroughGateway =
          definition?.kind === "gateway" &&
          "passthrough" in definition &&
          definition.passthrough === true;
        return {
          modelString: passthroughGateway ? normalizeToCanonical(effective) : effective,
        };
      }
      if (!coderWire) {
        return { modelString: canonical };
      }
      // The factory creates Coder instances from the wire alone (openai
      // type → provider.responses, openai-chat types → provider.chat), so
      // BOTH OpenAI wire kinds must override any pre-existing wireFormat:
      // a refusal chain that starts on direct OpenAI Chat Completions and
      // falls back to an openai-typed Coder instance would otherwise build
      // Chat Completions tools/options for a Responses request.
      const wireProtocol = coderGatewayWireProtocol(coderWire.providerType);
      return {
        modelString: `${coderWire.origin}:${coderWire.modelId}`,
        ...(wireProtocol === "openai-chat"
          ? { openaiWireFormat: "chatCompletions" as const }
          : wireProtocol === "openai-responses"
            ? { openaiWireFormat: "responses" as const }
            : {}),
      };
    };
    const toolsIdentity = resolveToolsIdentity(
      modelString,
      effectiveModelString,
      canonicalModelString,
      modelResult.data.coderWire,
      requestProvidersConfig
    );
    const toolsModelString = toolsIdentity.modelString;
    // Option/header builder identity: raw selections resolve via the
    // pinned instance config (coder-routed requests need the wire), but a
    // Coder selection whose routing FELL AWAY from the gateway must build
    // options for the EFFECTIVE route. Example: coder:google/gemini-* with
    // Coder unavailable routes through the passthrough mux-gateway and
    // sends native Google bytes — resolving the raw string against the
    // pinned instance would emit the gateway wire's OpenAI options and
    // drop Google settings such as thinkingConfig. Tool assembly
    // (toolsModelString) already follows the effective route; reuse it.
    const optionsModelString =
      modelString.startsWith("coder:") && !effectiveModelString.startsWith("coder:")
        ? toolsModelString
        : modelString;
    // The user's own wireFormat, captured BEFORE wire injection: the
    // refusal-fallback prepare() must reset to it when swapping to a model
    // whose route is not an OpenAI-wire Coder instance.
    const userOpenAIWireFormat = effectiveMuxProviderOptions.openai?.wireFormat;
    if (toolsIdentity.openaiWireFormat != null) {
      // Deliberate in-place update: every downstream consumer
      // (buildProviderOptions, toolsForModelConfig.openaiWireFormat, header
      // building, mid-turn thinking rebuilds) reads this object, and the
      // actual request bytes go over Chat Completions.
      effectiveMuxProviderOptions.openai = {
        ...(effectiveMuxProviderOptions.openai ?? {}),
        wireFormat: toolsIdentity.openaiWireFormat,
      };
    }

    // Dump original messages for debugging
    log.debug_obj(`${workspaceId}/1_original_messages.json`, messages);

    // Context Boundary request slicing happens before empty-assistant filtering so
    // provider-invisible reset rows can still bound the active context window.
    // Message preparation keys on the WIRE provider (wireProviderName), not
    // the config identity: a gateway-scoped coder:<instance>/<model> request
    // sends Anthropic/OpenAI-shaped bytes, so wire-specific transforms must
    // still run for it.
    const { activeContextMessages, providerRequestMessages, contextBoundarySlicedCount } =
      prepareProviderRequestMessages(messages, wireProviderName, effectiveThinkingLevel);
    if (contextBoundarySlicedCount > 0) {
      log.debug("Prepared provider history window", {
        workspaceId,
        originalCount: messages.length,
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
    if (wireProviderName === "openai") {
      log.debug("Keeping reasoning parts for OpenAI (managed via explicit history)");
    }
    // Add [CONTINUE] sentinel to partial messages (for model context)
    const messagesWithSentinel = addInterruptedSentinel(providerRequestMessages);

    // Get workspace metadata to retrieve workspace path
    const getWorkspaceMetadataStartedAt = Date.now();
    const metadataResult = await this.getWorkspaceMetadata(workspaceId);
    recordStartupPhaseTiming("getWorkspaceMetadataMs", getWorkspaceMetadataStartedAt);
    if (!metadataResult.success) {
      return { type: "finished", result: Err({ type: "unknown", raw: metadataResult.error }) };
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

    const runtimeContextResult = this.createWorkspaceRuntimeContext(workspaceId, metadata);
    if (!runtimeContextResult.success) {
      return { type: "finished", result: Err(runtimeContextResult.error) };
    }
    const { runtime, workspacePath, hostCheckoutRoot, projectCheckoutRoot } =
      runtimeContextResult.data;

    // Wait for init to complete before any runtime I/O operations
    // (SSH/devcontainer may not be ready until init finishes pulling the container)
    emitStartupBreadcrumb("waiting_for_init");
    const waitForInitStartedAt = Date.now();
    await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
    recordStartupPhaseTiming("waitForInitMs", waitForInitStartedAt);
    if (combinedAbortSignal.aborted) {
      return { type: "finished", result: Ok(this.createAbortedTurnHandle(syntheticMessageId)) };
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
      const errorEvent = createErrorEvent(workspaceId, {
        messageId: errorMessageId,
        error: errorMessage,
        errorType,
        acpPromptId,
      });
      this.emit("error", errorEvent);
      onPreStartError?.(errorEvent);

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
    const agentPluginsExperimentEnabled = this.isAgentPluginsEnabled();
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
      strictAgentResolution,
      disableWorkspaceAgents: disableWorkspaceAgents ?? false,
      callerToolPolicy: toolPolicy,
      cfg,
      emitError: (event) => {
        this.emit("error", event);
        onPreStartError?.(event);
      },
      isAdvisorExperimentEnabled: advisorExperimentEnabled,
      includeAgentPlugins: agentPluginsExperimentEnabled,
    });
    recordStartupPhaseTiming("resolveAgentForStreamMs", resolveAgentForStreamStartedAt);
    if (!agentResult.success) {
      return { type: "finished", result: Err(agentResult.error) };
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
    // projectAutomationDisabled: benchmark harnesses opt out of automatic
    // repo hook execution (tool_env/tool_pre/tool_post) while keeping
    // config trust for sub-agent delegation.
    const sharedExecutionTrusted =
      isWorkspaceTrustedForSharedExecution(metadata, cfg.projects) && !projectAutomationDisabled();
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
    // NOTE: Stored in <workspace>/.xum/mcp.local.jsonc (not ~/.xum/config.json).
    let mcpOverrides: WorkspaceMCPOverrides | undefined;
    const loadWorkspaceMcpOverridesStartedAt = Date.now();
    try {
      mcpOverrides = (await this.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId))
        .overrides;
    } catch (error) {
      log.warn("[MCP] Failed to load workspace MCP overrides; continuing without overrides", {
        workspaceId,
        error,
      });
      mcpOverrides = undefined;
    }
    recordStartupPhaseTiming("loadWorkspaceMcpOverridesMs", loadWorkspaceMcpOverridesStartedAt);

    // Agent Plugins: discovery follows the active checkout and is disabled
    // for workspaces that exec off-host (SSH/Docker/devcontainer).
    const agentPluginsMcpContext = hostCheckoutRoot
      ? resolveAgentPluginsMcpContext(metadata, hostCheckoutRoot)
      : null;

    // Tier-1 plugin hooks (agent-plugins experiment): reconcile discovered
    // hooks.js modules with the event spine BEFORE request assembly so both
    // request.assemble and tool.execute middleware are in place for this
    // turn. Failure posture: a broken plugin never blocks a send.
    try {
      await agentPluginHookService.ensureWorkspaceHooks({
        workspaceId,
        sessionDir: this.config.getSessionDir(workspaceId),
        journal: this.durableEventJournalFor(workspaceId),
        enabled: this.isAgentPluginsEnabled(),
        xumHome: this.config.rootDir,
        // Project containers follow the same off-host gating as plugin MCP.
        projectRoot: agentPluginsMcpContext?.projectRoot,
        projectTrusted,
      });
    } catch (error) {
      log.warn("Agent plugin hooks: ensure failed; continuing without plugin hooks", { error });
    }

    // Fetch MCP server config for system prompt (before building message).
    const listMcpServersStartedAt = Date.now();
    const mcpServers = this.mcpServerManager
      ? await this.mcpServerManager.listServers(
          metadata.projectPath,
          mcpOverrides,
          projectTrusted,
          agentPluginsMcpContext
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
    recordStartupPhaseTiming("loadAdditionalSystemContextMs", loadAdditionalSystemContextStartedAt);

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

    const xumScope = resolveXumToolScope(this.config, metadata, workspacePath, projectCheckoutRoot);

    const workflowSkillStorageContext = resolveSkillStorageContext({
      runtime,
      workspacePath,
      xumScope,
      includeAgentPlugins: this.isAgentPluginsEnabled(),
    });

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
        xumScope,
        loadDesktopCapability,
        advisorToolAvailable: toolset.advisorToolAvailable,
        memoryToolAvailable: toolset.memoryToolAvailable,
        hotMemoriesBlock: contextForModel?.hotMemoriesBlock ?? undefined,
        claudeSkillsCompatEnabled: claudeSkillsCompatExperimentEnabled,
        agentPluginsEnabled: agentPluginsExperimentEnabled,
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
    const { agentSystemPromptSections, agentDefinitions, availableSkills, ancestorPlanFilePaths } =
      prePolicyStreamSystemContext;
    let systemMessageTokens = prePolicyStreamSystemContext.systemMessageTokens;
    let systemMessage = prePolicyStreamSystemContext.systemMessage;

    // Load project secrets for local tool execution and MCP server startup.
    const projectSecrets = isMultiProject(metadata)
      ? mergeMultiProjectSecrets(metadata, this.config)
      : this.config.getEffectiveSecrets(metadata.projectPath);

    // Generate stream token and create temp directory for tools
    const streamToken = this.streamManager.generateStreamToken();

    let mcpTools: Record<string, Tool> | undefined;
    let mcpToolServerNames: Record<string, string> | undefined;
    let mcpStats: MCPWorkspaceStats | undefined;
    let mcpPromptRuntime: MCPPromptRuntime | undefined;
    let mcpSetupDurationMs = 0;

    if (this.mcpServerManager) {
      const mcpServerManager = this.mcpServerManager;
      const mcpToolSetupStartedAt = Date.now();
      try {
        const result = await mcpServerManager.getToolsForWorkspace({
          workspaceId,
          projectPath: metadata.projectPath,
          runtime,
          workspacePath,
          trusted: projectTrusted,
          overrides: mcpOverrides,
          projectSecrets: await secretsToRecord(projectSecrets),
          agentPlugins: agentPluginsMcpContext,
        });

        mcpTools = result.tools;
        mcpToolServerNames = result.toolServerNames;
        mcpStats = result.stats;
        // Omit the tool when no prompts exist to avoid adding unused schema context.
        if (result.promptDescriptors.length > 0) {
          mcpPromptRuntime = {
            prompts: result.promptDescriptors,
            getPrompt: (serverName, promptName, args, options) =>
              mcpServerManager.getPrompt(workspaceId, serverName, promptName, args, options),
          };
        }
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
      capabilityModelString,
      agentSystemPromptSections,
      cfg.projects,
      claudeSkillsCompatExperimentEnabled
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
      workspaceLog.warn("Advisor tool enabled for agent without advisorModelString; suppressing", {
        effectiveAgentId,
      });
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
    // Creation-time pricing identity for tool-created models (advisor): a
    // Coder catalog refresh can remove/retag the instance while the tool
    // request runs, and resolving the identity from live config at
    // completion would price/persist the usage under a different provider.
    const toolModelMetadataModelByModelString = new Map<string, string>();
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
    const xumEnv = getXumEnv(metadata.projectPath, runtimeType, metadata.name, {
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
                projectSearchRoot: projectCheckoutRoot ?? workspacePath,
                projectTrusted: getWorkflowProjectTrusted(),
                includeAgentPlugins: this.isAgentPluginsEnabled(),
                skillStorageContext: workflowSkillStorageContext,
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
      secrets: await secretsToRecord(projectSecrets),
      xumEnv,
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
                assert(snapshot.toolName === "advisor", "advisor snapshot must belong to advisor");
                return snapshot;
              },
              createModel: async (ms: string) => {
                const advisorModelString = ms.trim();
                assert(
                  advisorModelString.length > 0,
                  "advisor model string must be non-empty when creating an advisor model"
                );
                // ONE config snapshot for both SDK model creation and the
                // pinned pricing identity: two independent reads would let
                // a catalog refresh land between them, running the request
                // on one wire while recording usage under another type.
                const advisorProvidersConfig = this.config.loadProvidersConfig() ?? {};
                // View snapshot captured at creation time for option
                // building (buildProviderOptions takes the oRPC view, not
                // the raw config shape).
                const advisorOptionsProvidersConfig = this.providerService.getConfig();
                const advisorModel = await this.createModel(advisorModelString, undefined, {
                  workspaceId,
                  providersConfig: advisorProvidersConfig,
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
                // Same effective-route rule as createModelWithPinnedMetadata:
                // a coder: selection whose gateway is unavailable falls away
                // to a direct provider inside createModel, and identity or
                // options derived from the raw selection (instance type)
                // would diverge from the model actually created.
                const advisorEffectiveModelString =
                  this.providerModelFactory.resolveEffectiveModelString(
                    advisorModelString,
                    undefined,
                    advisorProvidersConfig
                  );
                const advisorOnCoderRoute = advisorEffectiveModelString.startsWith("coder:");
                // Creation-time identity from the SAME snapshot the model
                // was created from (see map declaration).
                toolModelMetadataModelByModelString.set(
                  advisorModelString,
                  resolveModelForMetadata(
                    advisorOnCoderRoute
                      ? advisorModelString
                      : normalizeToCanonical(advisorEffectiveModelString),
                    advisorProvidersConfig
                  )
                );
                // Wire-resolved identity for option construction, same
                // snapshot: a raw coder: string carries no wire info, so
                // buildProviderOptions would emit the wrong (or no)
                // namespace for custom-named/cross-typed instances. Mirrors
                // resolveOptionsCanonicalModel's shadow + wire rules.
                const advisorOptionsModelString = (() => {
                  // Custom providers keep their RAW identity: with the
                  // pinned snapshot below, buildProviderOptions remaps the
                  // wire namespace itself while still resolving
                  // mappedToModel alias metadata from the custom entry.
                  if (!advisorModelString.startsWith("coder:")) {
                    return advisorModelString;
                  }
                  const coderSection = advisorProvidersConfig.coder;
                  if (isCustomProviderConfig(coderSection)) {
                    return advisorModelString;
                  }
                  if (!advisorOnCoderRoute) {
                    // Fallback-away: options must target the route that
                    // actually serves the request, not the instance's wire.
                    return normalizeToCanonical(advisorEffectiveModelString);
                  }
                  const wire = resolveCoderWireCanonicalModel(
                    advisorModelString.slice("coder:".length),
                    coderSection as
                      | { discoveredProviders?: unknown; additionalProviders?: unknown }
                      | undefined
                  );
                  return wire ? `${wire.origin}:${wire.modelId}` : advisorModelString;
                })();
                return {
                  model: advisorModel.data,
                  optionsModelString: advisorOptionsModelString,
                  optionsProvidersConfig: advisorOptionsProvidersConfig,
                };
              },
              abortSignal: combinedAbortSignal,
            },
          }
        : {}),
      ...(toolSearchRuntime ? { toolSearchRuntime } : {}),
      capabilityModelString,
      openaiWireFormat: effectiveMuxProviderOptions?.openai?.wireFormat,
      xaiNativeToolsEnabled: routeProvider === "xai",
      xaiSearchParameters: effectiveMuxProviderOptions.xai?.searchParameters,
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
      xumScope,
      timelineService: timelineExperimentEnabled ? this.timelineService : undefined,
      workspaceHeartbeatService: this.workspaceHeartbeatService,
      workflowService,
      goalService: workspaceGoalService,
      goalDefaults: effectiveGoalDefaults,
      enableGoalTools: goalToolAvailability,
      // Only child workspaces (tasks) can report to a parent.
      enableAgentReport: Boolean(metadata.parentWorkspaceId),
      // RLM family messaging: gate on the flags persisted on the task record at
      // spawn — NOT the live send-options experiments — so a child spawned under RLM
      // keeps task_message_parent/task_message_sibling across app restarts and
      // frontend experiment toggles. Uses the full RLM predicate (rlm AND a PTC
      // parent) rather than the bare rlm bit: the hidden sub-flag can stay true
      // after its parent is disabled, and such children run outside RLM. Workflow-
      // owned workers are excluded: they hand results to WorkflowRunner through the
      // journal path.
      enableFamilyMessaging:
        Boolean(metadata.parentWorkspaceId) &&
        metadata.workflowTask == null &&
        isRlmModeEnabled(
          findWorkspaceEntry(cfg, workspaceId)?.workspace.taskExperiments,
          undefined
        ),
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
          // Prefer the creation-time identity captured when the tool model
          // was created; models not created through the tool runtime fall
          // back to live resolution (their identity is not coder-scoped).
          const pinnedMetadataModel = toolModelMetadataModelByModelString.get(eventModel);
          const metadataModel =
            pinnedMetadataModel ??
            resolveModelForMetadata(eventModel, this.providerService.getConfig());
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
              // Ledger keys resolve Coder identities to their record-time
              // metadata identity — the CREATION-TIME pin when available,
              // mirroring StreamManager.recordSessionUsage. Non-coder
              // models keep the canonical key (their metadata identity can
              // be a mappedToModel pricing alias, not the ledger bucket).
              const canonicalModel =
                eventModel.startsWith("coder:") && pinnedMetadataModel
                  ? pinnedMetadataModel
                  : normalizeUsageModelKey(eventModel, this.providerService.getConfig());
              await this.sessionUsageService.recordUsage(workspaceId, canonicalModel, displayUsage);
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
      // host-local under xumHome, keyed by the stable project identity.
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
        agentPlugins: agentPluginsExperimentEnabled,
      },
      // Dynamic context for tool descriptions (moved from system prompt for better model attention)
      availableSubagents: agentDefinitions,
      availableSkills,
      mcpPromptRuntime,
      // Session-segment memory index advertised in the memory tool
      // description (same disclosure mechanic as skills).
      memoryIndexEntries: memoryContext?.indexEntries,
      // Trust gating: only run hooks/scripts when the full shared workspace runtime is trusted.
      trusted: sharedExecutionTrusted,
    };
    const allTools = await getToolsForModel(
      toolsModelString,
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

    // Host file loader backing mux.load (r12 bulk kernel ingestion). Built
    // from the same cwd/runtime pair the file tools use so path resolution
    // matches mux.file_read. Only honored by kernel-mode code_execution.
    // SECURITY: the loader shares the tool hook trust gate — its bulk read
    // runs through the same tool.execute pipeline as a hook-wrapped
    // file_read call, so a trusted tool_pre denying sensitive paths gates
    // mux.load too (it must not be a hook bypass for file_read).
    const kernelFileLoader = createKernelFileLoader({
      cwd: toolsForModelConfig.cwd,
      runtime: toolsForModelConfig.runtime,
      hooks: deriveToolHookConfig(toolsForModelConfig) ?? undefined,
    });

    // Apply tool policy and PTC experiments (lazy-loads PTC dependencies only when needed).
    const applyToolPolicyAndExperimentsStartedAt = Date.now();
    let tools = await applyToolPolicyAndExperiments({
      allTools: toolsWithDelegation,
      extraTools: this.extraTools,
      effectiveToolPolicy,
      experiments,
      emitNestedToolEvent: emitNestedPtcToolEvent,
      sandbox: {
        workspaceId,
        sessionDir: this.config.getSessionDir(workspaceId),
        kernelFileLoader,
      },
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
    const ptcEnabled = experiments?.programmaticToolCalling === true;
    if (toolSearchRuntime) {
      const toolSearchPrep = prepareToolSearch({
        tools,
        mcpToolNames: Object.keys(mcpTools ?? {}),
        mcpToolServers: mcpToolServerNames,
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
    const finalMemoryContext = await upgradeMemoryContextForModel(memoryToolAvailable, modelString);
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
      const metadataModel = resolveModelForMetadata(modelString, requestProvidersConfig);
      const tokenizer = await getTokenizerForModel(modelString, metadataModel);
      systemMessageTokens = await tokenizer.countTokens(systemMessage);
    }

    // Waterfall hook point: registered middleware may rewrite the final system
    // prompt or filter the toolset. Contract for future consumers: any content
    // middleware adds to a request must exist as a durable event first
    // (append-time materialization) — see eventSpine module docs. Gated on
    // hasMiddleware so the empty-pipeline hot path skips ctx construction.
    if (eventSpine.hasMiddleware("request.assemble")) {
      const assembleCtx: RequestAssembleContext = {
        workspaceId,
        modelString,
        systemMessage,
        tools,
      };
      await eventSpine.run("request.assemble", assembleCtx);
      tools = assembleCtx.tools;
      // PTC needs no post-hook bridge reconcile: bridgeable tools are not
      // in the hook-visible record, so middleware cannot invalidate the
      // ToolBridge code_execution closes over. Tools promoted to the
      // model-visible set (policy-required tools, mcp_prompt_get) are
      // excluded from the bridge at assembly time (see toolAssembly), so
      // a hook that filters or wraps them affects the only dispatch path.
      // Tool-search state was classified from the pre-hook record; a hook
      // that added/removed tools would leave allToolNames/deferred/active
      // sets stale (prepareStep scoping + sentinel names both read them).
      // Rebuild in place so the state describes the post-hook toolset.
      if (toolSearchRuntime?.state) {
        tools = rebuildToolSearchState(toolSearchRuntime.state, {
          tools,
          mcpToolNames: Object.keys(mcpTools ?? {}),
          mcpToolServers: mcpToolServerNames,
          toolPolicy: effectiveToolPolicy,
          ptcEnabled,
        }).tools;
      }
      if (assembleCtx.systemMessage !== systemMessage) {
        systemMessage = assembleCtx.systemMessage;
        // Keep context-size estimation accurate after middleware mutation.
        const metadataModel = resolveModelForMetadata(modelString, requestProvidersConfig);
        const tokenizer = await getTokenizerForModel(modelString, metadataModel);
        systemMessageTokens = await tokenizer.countTokens(systemMessage);
      }
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
      postCompactionAttachments,
      providerForMessages: wireProviderName,
      effectiveThinkingLevel,
      modelString,
      providersConfig: requestProvidersConfig,
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
      return { type: "finished", result: Ok(this.createAbortedTurnHandle(assistantMessageId)) };
    }

    const requestHistorySequence = providerRequestMessages.reduce(
      (latest, message) => Math.max(latest, message.metadata?.historySequence ?? -1),
      -1
    );
    const assistantMessage = createMuxMessage(assistantMessageId, "assistant", "", {
      ...(requestHistorySequence >= 0 ? { requestHistorySequence } : {}),
      timestamp: Date.now(),
      model: canonicalModelString,
      routedThroughGateway,
      systemMessageTokens,
      agentId: effectiveAgentId,
    });

    // Append to history to get historySequence assigned
    const appendResult = await this.historyService.appendToHistory(workspaceId, assistantMessage);
    if (!appendResult.success) {
      return { type: "finished", result: Err({ type: "unknown", raw: appendResult.error }) };
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

      // Simulations emit their synthetic events before returning, so the
      // handle settles immediately with the matching terminal outcome.
      if (forceContextLimitError) {
        const streamError = await simulateContextLimitError(simulationCtx, this.historyService);
        return Ok(
          this.createSettledTurnHandle(assistantMessageId, { status: "failed", streamError })
        );
      }
      await simulateToolPolicyNoop(simulationCtx, effectiveToolPolicy, this.historyService);
      return {
        type: "finished",
        result: Ok(this.createSettledTurnHandle(assistantMessageId, { status: "completed" })),
      };
    }

    const truncationMode = openaiTruncationModeOverride;
    const promptCacheScope = derivePromptCacheScope(metadata);
    const minThinkingLevel =
      providedMinThinkingLevel ??
      resolveMinimumThinkingLevel(modelString, undefined, requestProvidersConfig);
    const preparedModelAttempt = this.prepareModelAttempt({
      rawModelString: modelString,
      canonicalModelString,
      canonicalProviderName,
      effectiveModelString,
      optionsModelString,
      wireProviderName,
      routeProvider,
      effectiveThinkingLevel,
      minThinkingLevel,
      providerRequestMessages,
      muxProviderOptions: effectiveMuxProviderOptions,
      workspaceId,
      truncationMode,
      providersConfigSnapshot: requestProvidersConfig,
      coderSelectedInstance: modelResult.data.coderSelectedInstance,
      promptCacheScope,
      reasoningMode,
      recordStartupPhaseTiming,
    });
    let requestHeaders = preparedModelAttempt.requestHeaders;
    const mergedProviderOptions = preparedModelAttempt.providerOptions;
    const resolvedOverrides = preparedModelAttempt.resolvedOverrides;
    const currentEffectiveLevelRef = preparedModelAttempt.currentEffectiveLevelRef;
    const computeRebuiltProviderOptions = preparedModelAttempt.computeRebuiltProviderOptions;
    const rebuildProviderOptionsForThinkingLevel =
      preparedModelAttempt.rebuildProviderOptionsForThinkingLevel;
    // Debug dump: Log the complete LLM request when MUX_DEBUG_LLM_REQUEST is set
    if (resolveXumEnvironmentValue("DEBUG_LLM_REQUEST", process.env) === "1") {
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
        log.debug("Model parameter overrides (provider extras):", resolvedOverrides.providerExtras);
      }
    }

    if (combinedAbortSignal.aborted) {
      await deleteAbortedPlaceholder(assistantMessageId);
      return { type: "finished", result: Ok(this.createAbortedTurnHandle(assistantMessageId)) };
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
      context.startupState.pendingRunMetadataId = pendingRunMetadataId;
      this.devToolsService.setPendingRunMetadata(workspaceId, pendingRunMetadataId, {
        toolPolicy:
          effectiveToolPolicy != null && effectiveToolPolicy.length > 0
            ? effectiveToolPolicy
            : undefined,
        // Join key for the replay verifier: re-anchors this recorded run to
        // its turn-envelope row and assistant message (see DevToolsRun).
        ...(requestHistorySequence >= 0 ? { requestHistorySequence } : {}),
      });
      this.trackPendingDevToolsRunMetadata(assistantMessageId, workspaceId, pendingRunMetadataId);
      requestHeaders = {
        ...requestHeaders,
        [DEVTOOLS_RUN_METADATA_ID_HEADER]: pendingRunMetadataId,
      };
    }

    // --- Refusal fallback chain ---
    // Resolved from app config by the RAW selection (metadata-aware inside):
    // a cross-typed Coder instance (coder:openai/x, type anthropic) must use
    // its own gateway-scoped chain, never the direct provider's. Task
    // children can opt out via taskOnRefusal: "fail" (see
    // resolveWorkspaceModelFallbackChain).
    const modelFallbackChain = resolveWorkspaceModelFallbackChain(
      this.config.loadConfigOrDefault(),
      workspaceId,
      modelString,
      this.providerService.getConfig()
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
                ? replaceOrAppendMessageById(messages, prepareOptions.continuation.assistantMessage)
                : messages;

              // Preliminary thinking clamp for the factory call only (xAI
              // variant swap; never Coder-metadata-dependent — same split
              // as the main path). The FINAL level is recomputed below from
              // the pinned nextProvidersConfig so a concurrent instance
              // retag cannot leave the level derived from older metadata
              // than the created SDK model.
              const requestedNextThinkingLevel =
                prepareOptions?.thinkingLevelOverride ?? effectiveThinkingLevel;
              const preliminaryNextThinkingLevel = enforceThinkingPolicy(
                nextModelString,
                requestedNextThinkingLevel,
                resolveMinimumThinkingLevel(
                  nextModelString,
                  lookupMinThinkingLevelOverride(
                    this.config.loadConfigOrDefault().minThinkingLevelByModel,
                    nextModelString
                  ),
                  this.providerService.getConfig()
                ),
                this.providerService.getConfig()
              );

              // Reset the primary model's injected chat-wire format before
              // resolving the fallback: the fallback's wire is decided by
              // ITS effective route, and the factory's direct-OpenAI branch
              // reads this knob for model selection.
              if (effectiveMuxProviderOptions.openai?.wireFormat !== userOpenAIWireFormat) {
                effectiveMuxProviderOptions.openai = {
                  ...(effectiveMuxProviderOptions.openai ?? {}),
                  wireFormat: userOpenAIWireFormat,
                };
              }

              const nextModelResult = await this.providerModelFactory.resolveAndCreateModel(
                nextModelString,
                preliminaryNextThinkingLevel,
                effectiveMuxProviderOptions,
                { agentInitiated, workspaceId }
              );
              if (!nextModelResult.success) {
                return Err(formatSendMessageError(nextModelResult.error).message);
              }
              const next = nextModelResult.data;
              // Same single-snapshot rule as the main path, pinned to the
              // fallback selection's factory-resolved instance.
              const nextProvidersConfig = pinCoderInstanceProvidersConfig(
                this.providerService.getConfig(),
                nextModelString,
                next.coderSelectedInstance
              );
              // FINAL thinking clamp from the pinned snapshot: the message
              // and option builders below must agree with the wire the
              // factory created the fallback SDK model for. Re-clamps the
              // source level against the fallback model's policy/floor (a
              // mid-turn thinking override folded in by StreamManager wins
              // over the send-time level).
              const nextMinThinkingLevel = resolveMinimumThinkingLevel(
                nextModelString,
                lookupMinThinkingLevelOverride(
                  this.config.loadConfigOrDefault().minThinkingLevelByModel,
                  nextModelString
                ),
                nextProvidersConfig
              );
              const nextThinkingLevel = enforceThinkingPolicy(
                nextModelString,
                requestedNextThinkingLevel,
                nextMinThinkingLevel,
                nextProvidersConfig
              );
              const nextToolsIdentity = resolveToolsIdentity(
                nextModelString,
                next.effectiveModelString,
                next.canonicalModelString,
                next.coderWire,
                nextProvidersConfig
              );
              // Same effective-route rule as the main path's
              // optionsModelString: a Coder fallback selection that itself
              // fell away from the gateway must build options/headers for
              // its effective route, not the pinned instance's wire.
              const nextOptionsModelString =
                nextModelString.startsWith("coder:") &&
                !next.effectiveModelString.startsWith("coder:")
                  ? nextToolsIdentity.modelString
                  : nextModelString;
              if (nextToolsIdentity.openaiWireFormat != null) {
                // Same in-place injection as the main path: the primary
                // stream is dead once a refusal fallback runs, so every
                // consumer (option/header rebuilds, mid-turn thinking
                // rebuild closures) must see the fallback's wire.
                effectiveMuxProviderOptions.openai = {
                  ...(effectiveMuxProviderOptions.openai ?? {}),
                  wireFormat: nextToolsIdentity.openaiWireFormat,
                };
              }

              try {
                // Rebuild the toolset for the fallback model: provider-native
                // web tools and MCP schema sanitization are provider-specific
                // (reusing Anthropic-shaped tools on OpenAI 400s, and vice
                // versa silently drops web tooling).
                // Same raw-identity rule as the main path's capability
                // lookup: cross-typed Coder instances need the raw string.
                const nextCapabilityModelString = resolveModelForMetadata(
                  nextModelString.startsWith("coder:")
                    ? nextModelString
                    : next.canonicalModelString,
                  nextProvidersConfig
                );
                const nextAllTools = await getToolsForModel(
                  // Wire identity, mirroring the main path: provider-specific
                  // tool branches (Anthropic native web tools, OpenAI MCP
                  // schema sanitization) must key on the wire, not on the
                  // "coder" prefix or the name-canonical form.
                  nextToolsIdentity.modelString,
                  {
                    ...toolsForModelConfig,
                    capabilityModelString: nextCapabilityModelString,
                    // Snapshot from the main path is stale here: the
                    // fallback's wire decides Responses-only tool assembly.
                    openaiWireFormat: effectiveMuxProviderOptions.openai?.wireFormat,
                    xaiNativeToolsEnabled: next.routeProvider === "xai",
                  },
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
                  sandbox: {
                    workspaceId,
                    sessionDir: this.config.getSessionDir(workspaceId),
                    kernelFileLoader,
                  },
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
                      mcpToolServers: mcpToolServerNames,
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
                const nextMemoryToolAvailable = nextTools.memory !== undefined;
                // Raw identity for prompt rebuilding too (the main path
                // passes its raw modelString): "Model:"-scoped instructions
                // and tokenizer-dependent memory budgeting must see the
                // instance-typed identity, not the name-canonicalized one.
                const nextMemoryContext = await upgradeMemoryContextForModel(
                  nextMemoryToolAvailable,
                  nextModelString
                );

                // Rebuild the system prompt for the fallback model (tool
                // instructions and "Model:" sections are model-keyed), keeping
                // the MCP failure warning if one was applied.
                const nextSystemContext = await buildStreamSystemContextForToolset(
                  {
                    advisorToolAvailable: nextTools.advisor !== undefined,
                    memoryToolAvailable: nextMemoryToolAvailable,
                  },
                  nextModelString,
                  nextMemoryContext
                );
                let nextSystem = nextSystemContext.systemMessage;
                let nextSystemTokens = nextSystemContext.systemMessageTokens;
                if (mcpWarningPrefix != null) {
                  nextSystem = `${mcpWarningPrefix}${nextSystem}`;
                  // nextCapabilityModelString already resolved the raw
                  // coder identity; reuse it as the metadata model.
                  const nextTokenizer = await getTokenizerForModel(
                    nextModelString,
                    nextCapabilityModelString
                  );
                  nextSystemTokens = await nextTokenizer.countTokens(nextSystem);
                }

                // Waterfall hook point: the fallback request is rebuilt from
                // scratch, so middleware-applied tool restrictions / prompt
                // context from the primary run would otherwise be lost — run
                // request.assemble over the rebuilt request too (see the
                // primary-path run above).
                if (eventSpine.hasMiddleware("request.assemble")) {
                  const nextAssembleCtx: RequestAssembleContext = {
                    workspaceId,
                    modelString: nextModelString,
                    systemMessage: nextSystem,
                    tools: nextTools,
                  };
                  await eventSpine.run("request.assemble", nextAssembleCtx);
                  nextTools = nextAssembleCtx.tools;
                  // Same reconcile as the primary path: tool-search state
                  // must describe the post-hook toolset.
                  if (toolSearchRuntime?.state) {
                    nextTools = rebuildToolSearchState(toolSearchRuntime.state, {
                      tools: nextTools,
                      mcpToolNames: Object.keys(mcpTools ?? {}),
                      mcpToolServers: mcpToolServerNames,
                      toolPolicy: effectiveToolPolicy,
                      ptcEnabled,
                    }).tools;
                  }
                  if (nextAssembleCtx.systemMessage !== nextSystem) {
                    nextSystem = nextAssembleCtx.systemMessage;
                    const nextTokenizer = await getTokenizerForModel(
                      nextModelString,
                      nextCapabilityModelString
                    );
                    nextSystemTokens = await nextTokenizer.countTokens(nextSystem);
                  }
                }

                // Same active-set scoping as the primary sentinel: never
                // advertise deferred, not-yet-activated MCP tools. Computed
                // AFTER the request.assemble hook (like the primary path) so
                // transition guidance never advertises middleware-removed
                // tools.
                const nextToolNamesForSentinel = (
                  computeActiveToolNames(toolSearchRuntime?.state) ?? Object.keys(nextTools)
                ).sort();

                const { providerRequestMessages: nextProviderRequestMessages } =
                  prepareProviderRequestMessages(
                    fallbackSourceMessages,
                    next.wireProviderName,
                    nextThinkingLevel
                  );
                const nextFinalMessages = await prepareMessagesForProvider({
                  messagesWithSentinel: addInterruptedSentinel(nextProviderRequestMessages),
                  effectiveAgentId,
                  toolNamesForSentinel: nextToolNamesForSentinel,
                  planContentForTransition,
                  planFilePath,
                  postCompactionAttachments,
                  providerForMessages: next.wireProviderName,
                  effectiveThinkingLevel: nextThinkingLevel,
                  // RAW fallback identity, matching the main path's raw
                  // modelString: canonicalization can rewrite cross-typed
                  // Coder instances (coder:openai/x, type anthropic) to a
                  // direct-provider string, hiding the instance metadata
                  // from cache/option/header builders.
                  modelString: nextModelString,
                  providersConfig: nextProvidersConfig,
                  anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl,
                  workspaceId,
                });

                const preparedFallbackAttempt = this.prepareModelAttempt({
                  rawModelString: nextModelString,
                  canonicalModelString: next.canonicalModelString,
                  canonicalProviderName: next.canonicalProviderName,
                  effectiveModelString: next.effectiveModelString,
                  optionsModelString: nextOptionsModelString,
                  wireProviderName: next.wireProviderName,
                  routeProvider: next.routeProvider,
                  effectiveThinkingLevel: nextThinkingLevel,
                  minThinkingLevel: nextMinThinkingLevel,
                  providerRequestMessages: nextProviderRequestMessages,
                  muxProviderOptions: effectiveMuxProviderOptions,
                  workspaceId,
                  truncationMode,
                  providersConfigSnapshot: nextProvidersConfig,
                  coderSelectedInstance: next.coderSelectedInstance,
                  promptCacheScope,
                  reasoningMode,
                });
                let nextHeaders = preparedFallbackAttempt.requestHeaders;
                if (pendingRunMetadataId != null) {
                  nextHeaders = {
                    ...nextHeaders,
                    [DEVTOOLS_RUN_METADATA_ID_HEADER]: pendingRunMetadataId,
                  };
                }
                const nextMergedProviderOptions = preparedFallbackAttempt.providerOptions;
                const nextOverrides = preparedFallbackAttempt.resolvedOverrides;
                const rebuildNextProviderOptionsForThinkingLevel =
                  preparedFallbackAttempt.rebuildProviderOptionsForThinkingLevel;
                // Shared with the return payload below: the fallback stream
                // restarts at step 0, where StreamManager scopes to these
                // forced tools when present.
                const nextForcedFirstStepToolNames =
                  next.routeProvider === "xai"
                    ? getForcedXaiSearchToolNames(
                        nextCapabilityModelString,
                        effectiveMuxProviderOptions.xai?.searchParameters
                      )?.filter((toolName) => toolName in nextTools)
                    : undefined;

                // The fallback request is a different request identity
                // (model, system prompt, toolset, provider options), so it
                // needs its own envelope: pairSessionTurns compares the LAST
                // envelope per requestHistorySequence, so this row supersedes
                // the primary one and replay-verify/cache-audit see the
                // request that actually streamed. Deferred to
                // onStreamConstructed: a prepare whose stream construction
                // later fails must not supersede the primary envelope.
                // Same step-0 scoping as the primary envelope: fingerprint
                // only the tools the first fallback step actually sends.
                const nextFirstStepToolNames = new Set(
                  nextForcedFirstStepToolNames?.length
                    ? nextForcedFirstStepToolNames
                    : nextToolNamesForSentinel
                );
                const emitFallbackEnvelopeWith = async (
                  thinkingLevelForEnvelope: string,
                  providerOptionsForEnvelope: unknown
                ): Promise<void> => {
                  await emitTurnEnvelope({
                    journal: this.durableEventJournalFor(workspaceId),
                    workspaceId,
                    systemMessage: nextSystem,
                    tools: Object.fromEntries(
                      Object.entries(nextTools).filter(([name]) => nextFirstStepToolNames.has(name))
                    ),
                    modelString: nextModelString,
                    thinkingLevel: thinkingLevelForEnvelope,
                    providerOptions: providerOptionsForEnvelope,
                    requestHistorySequence,
                    sentinelToolNames: nextToolNamesForSentinel,
                    wireProviderName: next.wireProviderName,
                    anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl ?? undefined,
                    planContentForTransition,
                    planFilePath,
                    postCompactionAttachments,
                    // The continuation never reaches chat.jsonl at this
                    // sequence (the assistant row lands later), so replay
                    // needs the envelope's durable copy to rebuild the
                    // fallback request.
                    partialContinuationMessage: prepareOptions?.continuation?.assistantMessage,
                  });
                };
                const emitFallbackEnvelope = (): Promise<void> =>
                  emitFallbackEnvelopeWith(nextThinkingLevel, nextMergedProviderOptions);
                // Same step-0 race closure as the primary path, bound to the
                // fallback request's own build inputs.
                const rebuildNextFirstStepForThinkingLevel: RebuildFirstStepForThinkingLevel =
                  async (effectiveLevel, providerOptionsForEnvelope) => {
                    const { providerRequestMessages: racedNextMessages } =
                      prepareProviderRequestMessages(
                        fallbackSourceMessages,
                        next.wireProviderName,
                        effectiveLevel
                      );
                    const rebuiltFinal = await prepareMessagesForProvider({
                      messagesWithSentinel: addInterruptedSentinel(racedNextMessages),
                      effectiveAgentId,
                      toolNamesForSentinel: nextToolNamesForSentinel,
                      planContentForTransition,
                      planFilePath,
                      postCompactionAttachments,
                      providerForMessages: next.wireProviderName,
                      effectiveThinkingLevel: effectiveLevel,
                      modelString: nextModelString,
                      providersConfig: nextProvidersConfig,
                      anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl,
                      workspaceId,
                    });
                    await emitFallbackEnvelopeWith(effectiveLevel, providerOptionsForEnvelope);
                    return rebuiltFinal;
                  };

                return Ok({
                  onStreamConstructed: emitFallbackEnvelope,
                  rebuildFirstStepForThinkingLevel: rebuildNextFirstStepForThinkingLevel,
                  model: next.model,
                  // RAW identity (matching the main path's raw modelString):
                  // StreamManager keys createCachedSystemMessage /
                  // applyCacheControlToTools / metadata resolution on this,
                  // and the canonical string hides cross-typed Coder
                  // instance metadata from those lookups.
                  modelString: nextModelString,
                  messages: nextFinalMessages,
                  system: nextSystem,
                  tools: nextTools,
                  providerOptions: nextMergedProviderOptions,
                  headers: nextHeaders,
                  callSettingsOverrides: nextOverrides.standard,
                  anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl ?? undefined,
                  thinkingLevel: nextThinkingLevel,
                  forcedFirstStepToolNames: nextForcedFirstStepToolNames,
                  rebuildProviderOptionsForThinkingLevel:
                    rebuildNextProviderOptionsForThinkingLevel,
                  // Pinned snapshot for the swap's request-config rebuild
                  // and metadata resolution (see PreparedModelFallback).
                  providersConfig: nextProvidersConfig,
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

    const forcedFirstStepToolNames =
      routeProvider === "xai"
        ? getForcedXaiSearchToolNames(
            capabilityModelString,
            effectiveMuxProviderOptions.xai?.searchParameters
          )?.filter((toolName) => toolName in toolsForStream)
        : undefined;

    // Durable turn envelope: fingerprint the FINAL request identity (post
    // request.assemble middleware, post tool-policy rebuild). Deferred to
    // StreamManager's construction boundary (like the fallback envelope):
    // aborts or setup errors before a stream exists must not persist a
    // phantom request row. Emission never fails the turn.
    // Step-0 wire truth: StreamManager sends only the first step's active
    // tools (forced xAI search set, else the tool-search active subset), so
    // the envelope fingerprints that subset — deferred tools never reach
    // this request and would otherwise show as false replay divergences.
    const firstStepToolNames = new Set(
      forcedFirstStepToolNames?.length
        ? forcedFirstStepToolNames
        : (computeActiveToolNames(toolSearchRuntime?.state) ?? Object.keys(toolsForStream))
    );

    // Fold PREPARING-window pending thinking overrides into the ACTUAL
    // request build, not just the envelope: message preparation is
    // thinking-level-dependent (Anthropic signed-reasoning transforms), so
    // recording the new level while streaming old-level messages would make
    // wire and replay diverge — or send an invalid extended-thinking
    // request. Consuming pending here (applied set below) is safe:
    // createStreamAtomically seeds streamInfo.thinkingLevel from `applied`,
    // and prepareStep simply sees no pending to re-apply.
    // Loop until pending is quiescent: setActiveTurnThinkingLevel can write
    // a NEW pending while the awaited message rebuild runs, and stamping the
    // first level after the await would leave step 0 rebuilding only
    // provider options while the messages stay at the stale level.
    let streamThinkingLevel = effectiveThinkingLevel;
    let streamProviderOptions = mergedProviderOptions;
    let streamFinalMessages = finalMessages;
    while (activeTurnThinkingOverride?.pending != null) {
      const pendingPreparingLevel = activeTurnThinkingOverride.pending;
      activeTurnThinkingOverride.pending = undefined;
      const folded = computeRebuiltProviderOptions(pendingPreparingLevel, streamThinkingLevel);
      if (folded == null) {
        // No-op fold (same effective level / non-foldable variant swap):
        // re-check pending — a change may have raced the previous rebuild.
        continue;
      }
      const { providerRequestMessages: foldedRequestMessages } = prepareProviderRequestMessages(
        messages,
        wireProviderName,
        folded.effectiveLevel
      );
      streamFinalMessages = await prepareMessagesForProvider({
        messagesWithSentinel: addInterruptedSentinel(foldedRequestMessages),
        effectiveAgentId,
        toolNamesForSentinel,
        planContentForTransition,
        planFilePath,
        postCompactionAttachments,
        providerForMessages: wireProviderName,
        effectiveThinkingLevel: folded.effectiveLevel,
        modelString,
        providersConfig: requestProvidersConfig,
        anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl,
        workspaceId,
      });
      streamProviderOptions = folded.providerOptions;
      streamThinkingLevel = folded.effectiveLevel;
      activeTurnThinkingOverride.applied = folded.effectiveLevel;
      // Keep the mid-turn rebuild baseline in sync so a later identical
      // request is correctly treated as a no-op.
      currentEffectiveLevelRef.current = folded.effectiveLevel;
      // Loop re-checks pending: a change during the awaits above re-folds
      // against the level just applied.
    }

    const emitPrimaryEnvelopeWith = async (
      thinkingLevel: string,
      providerOptions: unknown
    ): Promise<void> => {
      await emitTurnEnvelope({
        journal: this.durableEventJournalFor(workspaceId),
        workspaceId,
        systemMessage,
        tools: Object.fromEntries(
          Object.entries(toolsForStream).filter(([name]) => firstStepToolNames.has(name))
        ),
        modelString,
        thinkingLevel,
        providerOptions,
        // Replay pairing key + request-time inputs that are model-visible but
        // not derivable from chat.jsonl: the resolved wire provider (instance-
        // typed gateways need live metadata), the per-send Anthropic cache TTL,
        // and the injected plan-transition / post-compaction content.
        requestHistorySequence,
        // Sentinel names are recorded separately: forced first-step scoping
        // narrows the wire manifest while the sentinel lists the full active
        // set, so replay cannot derive one from the other.
        sentinelToolNames: toolNamesForSentinel,
        wireProviderName,
        anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl ?? undefined,
        planContentForTransition,
        planFilePath,
        postCompactionAttachments,
      });
    };
    const emitPrimaryEnvelope = (): Promise<void> =>
      emitPrimaryEnvelopeWith(streamThinkingLevel, streamProviderOptions);
    // Step-0 rebuild for a thinking override that raced stream setup
    // (written during startStream's awaits, after the quiescence loop):
    // rebuild the wire messages under the consumed level and supersede the
    // envelope so replay pairing (last row per sequence) sees the request
    // that actually streamed.
    const rebuildFirstStepForThinkingLevel: RebuildFirstStepForThinkingLevel = async (
      effectiveLevel,
      providerOptions
    ) => {
      const { providerRequestMessages: racedRequestMessages } = prepareProviderRequestMessages(
        messages,
        wireProviderName,
        effectiveLevel
      );
      const rebuiltFinal = await prepareMessagesForProvider({
        messagesWithSentinel: addInterruptedSentinel(racedRequestMessages),
        effectiveAgentId,
        toolNamesForSentinel,
        planContentForTransition,
        planFilePath,
        postCompactionAttachments,
        providerForMessages: wireProviderName,
        effectiveThinkingLevel: effectiveLevel,
        modelString,
        providersConfig: requestProvidersConfig,
        anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl,
        workspaceId,
      });
      await emitPrimaryEnvelopeWith(effectiveLevel, providerOptions);
      return rebuiltFinal;
    };
    const turnExecutionOptions: TurnExecutionOptions = {
      workspaceId,
      messages: streamFinalMessages,
      model: modelResult.data.model,
      modelString,
      historySequence,
      system: systemMessage,
      runtime,
      messageId: assistantMessageId,
      abortSignal: combinedAbortSignal,
      tools: toolsForStream,
      initialMetadata: {
        ...(requestHistorySequence >= 0 ? { requestHistorySequence } : {}),
        systemMessageTokens,
        timestamp: Date.now(),
        agentId: effectiveAgentId,
        ...(legacyModeForMetadata != null ? { mode: legacyModeForMetadata } : {}),
        routedThroughGateway,
        ...(routeProvider != null ? { routeProvider } : {}),
        ...(muxMetadata !== undefined ? { muxMetadata } : {}),
        ...(acpPromptId != null ? { acpPromptId } : {}),
        ...(modelCostsIncluded(modelResult.data.model) ? { costsIncluded: true } : {}),
      },
      providerOptions: streamProviderOptions,
      maxOutputTokens,
      toolPolicy: effectiveToolPolicy,
      providedStreamToken: streamToken,
      hasQueuedMessages,
      workspaceName: metadata.name,
      thinkingLevel: streamThinkingLevel,
      headers: requestHeaders,
      anthropicCacheTtlOverride: effectiveMuxProviderOptions.anthropic?.cacheTtl ?? undefined,
      callSettingsOverrides: resolvedOverrides.standard,
      onChunk: advisorToolEligible ? onAdvisorChunk : undefined,
      onStepMessages: advisorToolEligible
        ? (stepMessages) => {
            advisorTranscriptRef.messages = stepMessages;
            advisorStepCaptureRef.currentStepText = "";
            advisorStepCaptureRef.currentStepReasoning = "";
            advisorStepCaptureRef.frozenSnapshotsByToolCallId.clear();
          }
        : undefined,
      providedRuntimeTempDir: runtimeTempDir,
      modelFallback,
      toolSearchState: toolSearchRuntime?.state,
      thinkingOverrideState: activeTurnThinkingOverride,
      rebuildProviderOptionsForThinkingLevel,
      forcedFirstStepToolNames,
      providersConfigSnapshot: requestProvidersConfig,
      onStreamConstructed: emitPrimaryEnvelope,
      rebuildFirstStepForThinkingLevel,
    };

    const logStartOutcome = (
      outcome: "started" | "stream_start_failed",
      errorType?: string
    ): void => {
      logSlowStreamStartup?.({
        outcome,
        providerName: canonicalProviderName,
        routeProvider,
        agentId: effectiveAgentId,
        mode: legacyModeForMetadata,
        runtimeType: metadata.runtimeConfig.type,
        ...(errorType != null ? { errorType } : {}),
        toolCount: Object.keys(toolsForStream).length,
        mcpToolCount: Object.keys(mcpTools ?? {}).length,
        mcpFailedServerCount: mcpStats?.failedServerCount ?? 0,
        providerRequestMessageCount: providerRequestMessages.length,
        finalMessageCount: finalMessages.length,
      });
    };

    return {
      type: "ready",
      turnExecutionOptions,
      assistantMessageId,
      deleteAbortedPlaceholder,
      logStartOutcome,
    };
  }
}
