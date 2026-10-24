import { createAssistantMessageId } from "@/node/services/utils/messageIds";
import {
  eventSpine,
  type RequestAssemblySnapshot,
  type TurnStopContext,
} from "./events/eventSpine";
import { codexPluginHookService } from "./agentPlugins/codexHookService";
import { prepareWorkspaceRequestHooks } from "./agentPlugins/requestHooks";
import {
  runMessageSendHooks,
  runTurnStopHooks,
  type MessageSendHookInput,
  type MessageSendHookOutcome,
  type TurnStopHookOutcome,
} from "./agentPlugins/promptHooks";
import * as path from "path";
import { EventEmitter } from "events";

import assert from "@/common/utils/assert";
import { type LanguageModel, type Tool } from "ai";

import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import {
  TurnRequestBuilder,
  type LoopHostServices,
  type TurnRequestBuilderBindings,
  resolveXumToolScope,
  type StreamMessageOptions,
  type PreparedStreamMessage,
  type PreparedTurnRequest,
  type TurnRequestBuildContext,
} from "./turnRequestBuilder";
export { replaceOrAppendMessageById } from "./turnRequestBuilder";
export type { StreamMessageOptions } from "./turnRequestBuilder";

import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import { LRUCache } from "lru-cache";
import {
  DEBUG_LLM_REQUEST_MAX_BYTES,
  DEBUG_LLM_REQUEST_MAX_WORKSPACES,
} from "@/constants/debugLlmRequest";

import type { SendMessageError } from "@/common/types/errors";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getSrcBaseDir, isSSHRuntime } from "@/common/types/runtime";
import type { XumToolScope } from "@/common/types/toolScope";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import {
  ProvidersConfigStore,
  SecretsStore,
  type Config,
  type WorkspaceMetadataOptions,
} from "@/node/config";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
  resolveWorkspaceRootPath,
  type WorkspaceRuntimeContext,
} from "@/node/runtime/runtimeHelpers";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { ProviderService } from "@/node/services/providerService";
import { getWorkspacePathHintForProject } from "@/node/services/workspaceProjectRepos";
import {
  sharedDurableEventJournal,
  type DurableEventJournal,
} from "@/node/utils/journal/durableEventJournal";
import type { InitStateManager } from "./initStateManager";
import { log } from "./log";
import { nodeClock } from "@/node/utils/hostClock";
import { resolveAgentForStream } from "./agentResolution";
import { formatSendMessageError } from "./utils/sendMessageError";
import {
  StreamManager,
  type TurnCompletion,
  type TurnEngineEvent,
  type TurnStreamHandle,
  type StopStreamOptions,
} from "./streamManager";

import { normalizeToCanonical } from "@/common/utils/ai/models";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { TelemetryService } from "@/node/services/telemetryService";
import { delegatedToolCallManager } from "./delegatedToolCallManager";
import type { HistoryService } from "./historyService";
import type { SessionUsageService } from "./sessionUsageService";

import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import {
  resolveMemoryProjectIdentity,
  type MemorySessionContext,
} from "@/node/services/memoryService";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubsetSchema } from "@/common/utils/jsonSchemaSubset";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { MockAiStreamPlayer } from "./mock/mockAiStreamPlayer";
import { isMockAiMode } from "./mock/mockAiMode";
import { ProviderModelFactory } from "./providerModelFactory";

interface ToolExecutionContext {
  toolCallId?: string;
  abortSignal?: AbortSignal;
}

function isToolExecutionContext(value: unknown): value is ToolExecutionContext {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.toolCallId == null || typeof record.toolCallId === "string") &&
    (record.abortSignal == null || record.abortSignal instanceof AbortSignal)
  );
}

/**
 * One JSON pass per set, the same order of cost as the structuredClone every set already does.
 * A snapshot JSON cannot serialize (a BigInt) counts as the whole limit, so it is kept alone.
 */
function estimateDebugSnapshotBytes(snapshot: DebugLlmRequestSnapshot): number {
  return jsonBytes(snapshot) ?? DEBUG_LLM_REQUEST_MAX_BYTES;
}

/** UTF-8 bytes of the value's JSON, or undefined when JSON cannot serialize it (a BigInt). */
function jsonBytes(value: unknown): number | undefined {
  try {
    // UTF-8 bytes, not UTF-16 units: a CJK character is one unit but three bytes.
    return Math.max(1, Buffer.byteLength(JSON.stringify(value), "utf8"));
  } catch {
    return undefined;
  }
}

/** `{...request, response}` serializes as the request's JSON plus this key and the response. */
const RESPONSE_FIELD_JSON_BYTES = Buffer.byteLength(',"response":', "utf8");

/**
 * JSON bytes of `{...request, response}` from the request's stored size, without serializing
 * the request again. Any doubt (no stored size, a request or response JSON cannot serialize)
 * returns undefined, so the cache measures the whole snapshot as before.
 */
function attachedSnapshotBytes(requestBytes: number | undefined, response: unknown) {
  if (requestBytes == null || requestBytes >= DEBUG_LLM_REQUEST_MAX_BYTES) return undefined;
  const responseBytes = jsonBytes(response);
  return responseBytes == null
    ? undefined
    : requestBytes + RESPONSE_FIELD_JSON_BYTES + responseBytes;
}

export class AIService extends EventEmitter {
  private readonly streamManager: StreamManager;
  private readonly turnRequestBuilder: TurnRequestBuilder;
  private readonly historyService: HistoryService;
  private readonly config: Config;
  private readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  private readonly telemetryService?: TelemetryService;
  private readonly initStateManager: InitStateManager;
  private mockModeEnabled: boolean;
  public mockAiStreamPlayer?: MockAiStreamPlayer;
  private readonly backgroundProcessManager?: BackgroundProcessManager;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly providerService: ProviderService;
  private readonly providerModelFactory: ProviderModelFactory;
  private readonly devToolsService?: DevToolsService;
  private readonly providersConfigStore: ProvidersConfigStore;
  private readonly experimentsService?: ExperimentsService;

  /**
   * Tracks queued DevTools run metadata by assistant message id so stream-end/abort
   * can clear orphaned entries when a stream starts but never reaches middleware run creation.
   */
  private readonly pendingDevToolsRunMetadataByMessageId = new Map<
    string,
    { workspaceId: string; metadataId: string }
  >();

  // Debug: captured LLM request payloads for last send per workspace
  // Bounded by count and by bytes: each snapshot is a full copy of a request and its response,
  // and an unbounded map kept one per workspace the server ever sent from (F12, #6754). Removal
  // and archive drop their entry too (handleWorkspaceMetadata).
  private readonly lastLlmRequestByWorkspace = new LRUCache<string, DebugLlmRequestSnapshot>({
    max: DEBUG_LLM_REQUEST_MAX_WORKSPACES,
    maxSize: DEBUG_LLM_REQUEST_MAX_BYTES,
    sizeCalculation: estimateDebugSnapshotBytes,
  });

  constructor(
    config: Config,
    historyService: HistoryService,
    initStateManager: InitStateManager,
    providerService: ProviderService,
    backgroundProcessManager?: BackgroundProcessManager,
    sessionUsageService?: SessionUsageService,
    workspaceMcpOverridesService?: WorkspaceMcpOverridesService,
    telemetryService?: TelemetryService,
    devToolsService?: DevToolsService,
    experimentsService?: ExperimentsService,
    streamManager?: StreamManager,
    public readonly turnRequestBuilderBindings: TurnRequestBuilderBindings = {},
    providersConfigStore?: ProvidersConfigStore,
    private readonly secretsStore: Pick<SecretsStore, "getEffectiveSecrets"> = new SecretsStore(
      config.rootDir
    ),
    /** Absent members: the Node layer (`new AIService(` in tests passes none). */
    hostServices: LoopHostServices = {}
  ) {
    super();
    // No listener cap: every live AgentSession adds one listener per forwarded event, and a
    // session lives from first use of its workspace until archive, removal or shutdown, so the
    // count tracks how many workspaces this process has touched. Any fixed cap is a false
    // MaxListenersExceededWarning for a user with many workspaces or sub-agents. A leak (a
    // disposed session that keeps its listeners) is caught by
    // workspaceService.sessionListeners.test.ts instead.
    this.setMaxListeners(0);
    this.workspaceMcpOverridesService =
      workspaceMcpOverridesService ?? new WorkspaceMcpOverridesService(config);
    this.providersConfigStore = providersConfigStore ?? new ProvidersConfigStore(config.rootDir);
    this.config = config;
    this.historyService = historyService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.sessionUsageService = sessionUsageService;
    this.telemetryService = telemetryService;
    this.experimentsService = experimentsService;
    this.providerService = providerService;
    this.providerService.onConfigChanged(() => this.emit("providers-config-changed"));
    this.streamManager =
      streamManager ??
      new StreamManager(historyService, sessionUsageService, () =>
        this.providerService.getConfig()
      );
    this.streamManager.setEventSink((event) => this.emitEngineEvent(event));
    this.devToolsService = devToolsService;
    this.providerModelFactory = new ProviderModelFactory(
      config,
      providerService,
      turnRequestBuilderBindings,
      devToolsService,
      this.providersConfigStore
    );
    this.turnRequestBuilder = new TurnRequestBuilder({
      config: this.config,
      providersConfigStore: this.providersConfigStore,
      secretsStore: this.secretsStore,
      historyService: this.historyService,
      initStateManager: this.initStateManager,
      providerService: this.providerService,
      providerModelFactory: this.providerModelFactory,
      streamManager: this.streamManager,
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
      telemetryService: this.telemetryService,
      backgroundProcessManager: this.backgroundProcessManager,
      sessionUsageService: this.sessionUsageService,
      devToolsService: this.devToolsService,
      experimentsService: this.experimentsService,
      lastLlmRequestByWorkspace: this.lastLlmRequestByWorkspace,
      bindings: this.turnRequestBuilderBindings,
      hostServices,
      emit: (event, ...args) => this.emit(event, ...args),
      createAbortedTurnHandle: (messageId, signal) =>
        this.createAbortedTurnHandle(messageId, signal),
      createSettledTurnHandle: (messageId, completion) =>
        this.createSettledTurnHandle(messageId, completion),
      getWorkspaceMetadata: (workspaceId) => this.getWorkspaceMetadata(workspaceId),
      createWorkspaceRuntimeContext: (workspaceId, metadata) =>
        this.createWorkspaceRuntimeContext(workspaceId, metadata),
      isClaudeSkillsCompatEnabled: () => this.isClaudeSkillsCompatEnabled(),
      wrapToolsForDelegation: (workspaceId, tools, delegatedToolNames) =>
        this.wrapToolsForDelegation(workspaceId, tools, delegatedToolNames),
      durableEventJournalFor: (workspaceId) => this.durableEventJournalFor(workspaceId),
      shouldAllowLegacyInvalidWorkflowAgentOutputSchema: (metadata) =>
        this.shouldAllowLegacyInvalidWorkflowAgentOutputSchema(metadata),
      isStreaming: (workspaceId) => this.streamManager.isStreaming(workspaceId),
      trackPendingDevToolsRunMetadata: (messageId, workspaceId, metadataId) =>
        this.trackPendingDevToolsRunMetadata(messageId, workspaceId, metadataId),
    });
    void this.ensureSessionsDir();
    this.mockModeEnabled = false;

    if (isMockAiMode()) {
      log.info("AIService running in MUX_MOCK_AI mode");
      this.enableMockMode();
    }
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
   * Build the session-segment memory context: the index snapshot advertised
   * in the memory tool description. Returns null when the memory experiment
   * is off.
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
    // The memory context does not depend on the model; the parameter keeps
    // AgentSession's per-model cache contract unchanged.
    _modelString: string
  ): Promise<MemorySessionContext | null> {
    if (!this.turnRequestBuilderBindings.memoryService) return null;
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
      const indexEntries =
        await this.turnRequestBuilderBindings.memoryService.listIndexEntries(ctx);
      return { indexEntries };
    } catch (error) {
      // Self-healing: memory context is best-effort, never a stream blocker.
      log.warn("Failed to build memory session context", { workspaceId, error });
      return null;
    }
  }

  getProvidersConfig(): ProvidersConfigMap | null {
    return this.providerService.getConfig();
  }

  private emitEngineEvent(event: TurnEngineEvent): void | Promise<void> {
    if (event.type === "error") {
      this.clearTrackedPendingDevToolsRunMetadata(event.messageId);
      this.emit("error", event);
      return;
    }

    if (event.type === "stream-end") {
      this.clearTrackedPendingDevToolsRunMetadata(event.messageId);

      this.attachDebugLlmResponse(event);

      this.emit("stream-end", event);
      return;
    }

    if (event.type === "stream-abort") {
      this.clearTrackedPendingDevToolsRunMetadata(event.messageId);
      // Persistence belongs to the captured engine attempt. Synthetic/empty startup
      // terminals have no authority to mutate whichever partial occupies this workspace.
      this.emit("stream-abort", event);
      return;
    }

    this.emit(event.type, event);
  }

  /** Adds stream-end's response to the workspace's debug LLM request snapshot. */
  private attachDebugLlmResponse(event: Extract<TurnEngineEvent, { type: "stream-end" }>): void {
    try {
      const snapshot = this.lastLlmRequestByWorkspace.get(event.workspaceId);
      if (snapshot == null) return;
      if (snapshot.messageId != null && snapshot.messageId !== event.messageId) return;
      // The request half is already this cache's own copy (the turn builder cloned it), so
      // copy and measure only the response. Re-cloning and re-serializing the whole request
      // here doubled the per-turn event-loop cost at a full context (#6912).
      const response = structuredClone({
        // Record time: wall clock until #7282 moves its consumers to HostClock.
        capturedAt: nodeClock.nowMs(),
        metadata: event.metadata,
        parts: event.parts,
      });
      // The size stored with the request. Not used when a response is already attached,
      // because that size counts the earlier response too.
      const size = attachedSnapshotBytes(
        snapshot.response == null
          ? this.lastLlmRequestByWorkspace.info(event.workspaceId)?.size
          : undefined,
        response
      );
      this.lastLlmRequestByWorkspace.set(
        event.workspaceId,
        { ...snapshot, response },
        size == null ? undefined : { size }
      );
    } catch (error) {
      const errMsg = getErrorMessage(error);
      log.warn("Failed to capture debug LLM response snapshot", { error: errMsg });
    }
  }

  private createSettledTurnHandle(messageId: string, completion: TurnCompletion): TurnStreamHandle {
    return { messageId, completion: Promise.resolve(completion) };
  }

  private createAbortedTurnHandle(messageId: string, signal?: AbortSignal): TurnStreamHandle {
    return this.createSettledTurnHandle(messageId, {
      status: "aborted",
      abortReason: this.streamManager.getStartupAbortReason(signal),
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
        sessionDir: path.join(this.config.sessionsDir, metadata.parentWorkspaceId),
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
      await this.historyService.files.ensurePrivateDir(this.config.sessionsDir);
    } catch (error) {
      log.error("Failed to create sessions directory:", error);
    }
  }

  /**
   * Journal for the workspace's session dir — always the process-shared
   * instance so sequence assignment stays coordinated with the sandbox host's
   * vars-snapshot writer (independent instances would corrupt seq ordering).
   */
  private durableEventJournalFor(workspaceId: string): DurableEventJournal {
    return sharedDurableEventJournal(path.join(this.config.sessionsDir, workspaceId));
  }

  /** Reconcile lazy workspace hooks before pinning a rollover's request-assembly contract. */
  async captureRequestAssemblySnapshot(
    workspaceId: string
  ): Promise<Result<RequestAssemblySnapshot, SendMessageError>> {
    const metadata = await this.getWorkspaceMetadata(workspaceId);
    if (!metadata.success) return Err({ type: "unknown", raw: metadata.error });
    const runtimeContext = this.createWorkspaceRuntimeContext(workspaceId, metadata.data);
    if (!runtimeContext.success) return runtimeContext;
    await prepareWorkspaceRequestHooks({
      config: this.config,
      metadata: metadata.data,
      hostCheckoutRoot: runtimeContext.data.hostCheckoutRoot,
      journal: this.durableEventJournalFor(workspaceId),
      mcpServerManager: this.turnRequestBuilderBindings.mcpServerManager,
    });
    return Ok(eventSpine.captureRequestAssembly(workspaceId));
  }

  /**
   * Load the workspace's lazy hooks, then report whether any message.send hook applies to it.
   * The accepted-send check reads this: before the load, a first send after a restart saw no
   * hook and skipped the check, so a retry could run a stateful hook twice (Codex
   * PRRT_kwDOPxxmWM6rSBny). Another workspace's hooks do not count (PRRT_kwDOPxxmWM6rQd90).
   */
  async prepareMessageSendHooks(workspaceId: string): Promise<boolean> {
    await this.loadRequestHooksForPrompt(workspaceId);
    return eventSpine.hasMiddlewareFor("message.send", workspaceId);
  }

  /**
   * Run the message.send prompt-hook chain for one new message (fail-open). Loads the
   * workspace's lazy hooks first (the same setup as request building), so the first send after a
   * restart sees them too.
   */
  async runMessageSendHooks(
    workspaceId: string,
    input: MessageSendHookInput,
    cancelSignal?: AbortSignal,
    /** prepareMessageSendHooks already ran the lazy load for this send. */
    hooksLoaded = false
  ): Promise<MessageSendHookOutcome> {
    if (!hooksLoaded) await this.loadRequestHooksForPrompt(workspaceId);
    // Codex UserPromptSubmit hooks call their plugin's MCP server, which the turn only starts
    // after this chain: start it first (the turn's own startup, bounded), or the first prompt
    // after a restart misses the hooks. A canceled send ends this wait and its hook calls (see
    // MessageSendContext.signal).
    await codexPluginHookService.prepareForPromptHooks(
      workspaceId,
      (signal) => this.turnRequestBuilder.startWorkspaceMcpServers(workspaceId, signal),
      cancelSignal
    );
    // After the setup above, so the check sees the hooks it loaded.
    const cwd = eventSpine.hasMiddlewareFor("message.send", workspaceId)
      ? await this.resolvePromptHookCwd(workspaceId)
      : undefined;
    return runMessageSendHooks(eventSpine, workspaceId, { ...input, cwd, signal: cancelSignal });
  }

  /** Run the turn.stop prompt-hook chain for one finished turn (fail-open). */
  async runTurnStopHooks(
    workspaceId: string,
    input: Pick<TurnStopContext, "messageId" | "lastAssistantMessage" | "stopHookActive" | "model">
  ): Promise<TurnStopHookOutcome> {
    const cwd = eventSpine.hasMiddlewareFor("turn.stop", workspaceId)
      ? await this.resolvePromptHookCwd(workspaceId)
      : undefined;
    return runTurnStopHooks(eventSpine, workspaceId, { ...input, cwd });
  }

  /** The lazy hook setup of request building, fail-soft: the hooks already loaded still run. */
  private async loadRequestHooksForPrompt(workspaceId: string): Promise<void> {
    const snapshot = await this.captureRequestAssemblySnapshot(workspaceId).catch(
      (error: unknown) => {
        log.warn("Prompt hooks: hook setup failed; running the hooks already loaded", {
          workspaceId,
          error: getErrorMessage(error),
        });
        return null;
      }
    );
    if (snapshot?.success === false) {
      log.debug("Prompt hooks: hook setup skipped", { workspaceId, error: snapshot.error });
    }
  }

  /** The workspace path prompt hooks see as `cwd` (the tools' cwd); undefined when unreadable. */
  private async resolvePromptHookCwd(workspaceId: string): Promise<string | undefined> {
    try {
      const metadata = await this.getWorkspaceMetadata(workspaceId);
      if (!metadata.success) return undefined;
      const context = this.createWorkspaceRuntimeContext(workspaceId, metadata.data);
      return context.success ? context.data.workspacePath : undefined;
    } catch {
      return undefined; // fail open: the hook runs without cwd
    }
  }

  releaseMockStreamStartGate(workspaceId: string): void {
    this.mockAiStreamPlayer?.releaseStreamStartGate(workspaceId);
  }

  /** Release a mock stream held before its tool calls (MockAiRouterReply.holdToolCalls). */
  releaseMockToolCalls(workspaceId: string): void {
    assert(this.mockAiStreamPlayer, "mock mode is off");
    this.mockAiStreamPlayer.releaseToolCalls(workspaceId);
  }

  enableMockMode(): void {
    this.mockModeEnabled = true;

    this.mockAiStreamPlayer ??= new MockAiStreamPlayer({
      aiService: this,
      historyService: this.historyService,
      sessionsDir: this.config.sessionsDir,
    });
    this.streamManager.setMockStreamLifecycle(this.mockAiStreamPlayer);
  }

  async getWorkspaceMetadata(
    workspaceId: string,
    options?: Pick<WorkspaceMetadataOptions, "persistMigrations">
  ): Promise<Result<WorkspaceMetadata>> {
    try {
      const metadata = await this.config.getWorkspaceMetadataById(workspaceId, options);

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
    opts?: {
      agentInitiated?: boolean;
      workspaceId?: string;
      /** Snapshot pass-through (see ProviderModelFactory.createModel). */
      providersConfig?: ProvidersConfig;
    }
  ): Promise<Result<LanguageModel, SendMessageError>> {
    return this.providerModelFactory.createModel(modelString, muxProviderOptions, opts);
  }

  /**
   * Create a model AND its pricing/metadata identity from ONE providers.jsonc
   * snapshot. For headless callers (status generation, memory sweeps) that
   * record usage via recordHeadlessUsage: resolving the identity at
   * completion (or from a second read) races catalog refreshes — a Coder
   * instance removed/retagged mid-request would attribute the spend to an
   * unknown or different upstream than the wire the model was created for.
   */
  async createModelWithPinnedMetadata(
    modelString: string,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<{ model: LanguageModel; metadataModel: string }, SendMessageError>> {
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const result = await this.providerModelFactory.createModel(modelString, undefined, {
      ...opts,
      providersConfig,
    });
    if (!result.success) {
      return result;
    }
    // The identity must follow the EFFECTIVE route (same snapshot, same
    // resolution createModel dispatched on): a coder: selection whose gateway
    // is unavailable falls away inside createModel (e.g. cross-typed
    // coder:openai/<claude>, type anthropic, creates a direct OpenAI model),
    // and pricing/bucketing from the raw selection would attribute that spend
    // to the instance's type instead of the route that actually served it.
    const effectiveModelString = this.providerModelFactory.resolveEffectiveModelString(
      modelString,
      undefined,
      providersConfig
    );
    const metadataSeed = effectiveModelString.startsWith("coder:")
      ? modelString
      : normalizeToCanonical(effectiveModelString);
    return Ok({
      model: result.data,
      metadataModel: resolveModelForMetadata(metadataSeed, providersConfig),
    });
  }

  createModelWithPinnedOptions(
    modelString: string,
    opts?: Parameters<ProviderModelFactory["createModelWithPinnedOptions"]>[1]
  ): ReturnType<ProviderModelFactory["createModelWithPinnedOptions"]> {
    return this.providerModelFactory.createModelWithPinnedOptions(modelString, opts);
  }

  /** Evaluation model for the workflow `evaluate()` primitive (see ProviderModelFactory). */
  createEvaluationModel(
    modelString: string
  ): ReturnType<ProviderModelFactory["createEvaluationModel"]> {
    return this.providerModelFactory.createEvaluationModel(modelString);
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

  /**
   * Pre-dispatch check for an automatic goal turn (#5402): the same strict resolution its stream
   * runs, returning why the agent cannot run, or null. The stream-time resolution stays the
   * authoritative gate, so a failed check (runtime unreachable, not ready) returns null.
   */
  async getAutomaticGoalTurnAgentRefusal(
    workspaceId: string,
    options: Pick<SendMessageOptions, "agentId" | "disableWorkspaceAgents">
  ): Promise<string | null> {
    try {
      const metadata = await this.getWorkspaceMetadata(workspaceId);
      if (!metadata.success) return null;
      const context = this.createWorkspaceRuntimeContext(workspaceId, metadata.data);
      if (!context.success) return null;
      const ready = await context.data.runtime.ensureReady();
      if (!ready.ready) return null;
      const resolution = await resolveAgentForStream({
        workspaceId,
        metadata: metadata.data,
        runtime: context.data.runtime,
        workspacePath: context.data.workspacePath,
        requestedAgentId: options.agentId,
        disableWorkspaceAgents: options.disableWorkspaceAgents ?? false,
        automaticGoalTurn: true,
        callerToolPolicy: undefined,
        cfg: this.config.loadConfigOrDefault(),
        emitError: () => undefined,
      });
      return resolution.success ? null : formatSendMessageError(resolution.error).message;
    } catch {
      return null; // unreadable runtime: the stream-time gate decides
    }
  }

  /** Builds the runtime context shared by stream startup and MCP prompt discovery. */
  createWorkspaceRuntimeContext(
    workspaceId: string,
    metadata: WorkspaceMetadata
  ): Result<
    WorkspaceRuntimeContext & {
      hostCheckoutRoot: string | null;
      projectCheckoutRoot: string | null;
    },
    SendMessageError
  > {
    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) {
      return Err({ type: "unknown", raw: `Workspace ${workspaceId} not found in config` });
    }

    const metadataWithPath = {
      ...metadata,
      // Existing SSH workspaces may use a persisted root that differs from the
      // canonical hashed layout.
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
        : // Multi-project containers start at their shared root so sibling repos remain addressable.
          runtime.getWorkspacePath(metadata.projectPath, metadata.name));

    const projectCheckoutRoot = singleProjectContext
      ? resolveWorkspaceRootPath(metadataWithPath, runtime)
      : null;
    // Agent Plugin containers use the host checkout root, not a subproject directory.
    const hostCheckoutRoot =
      projectCheckoutRoot != null &&
      metadata.runtimeConfig.type !== "ssh" &&
      metadata.runtimeConfig.type !== "docker"
        ? projectCheckoutRoot
        : null;

    return Ok({ runtime, workspacePath, hostCheckoutRoot, projectCheckoutRoot });
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
   * Host-evaluated gate for the claude-skills-compat experiment. When enabled,
   * read paths include Claude's skills roots and ~/.claude/CLAUDE.md as read-only,
   * lowest-precedence compatibility sources. Public so every consumer shares the gate.
   */
  isClaudeSkillsCompatEnabled(): boolean {
    return (
      this.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT) === true
    );
  }

  /**
   * Resolve the XumToolScope a workspace's tools receive, including the checkout
   * boundary used for subproject skill inheritance. Host-local scopes also use
   * this root to anchor Agent Plugins containers.
   */
  resolveXumToolScopeForWorkspace(
    metadata: WorkspaceMetadata,
    runtime: Runtime,
    workspacePath: string
  ): XumToolScope {
    const projectCheckoutRoot = !isMultiProject(metadata)
      ? resolveWorkspaceRootPath(metadata, runtime)
      : null;
    return resolveXumToolScope(this.config, metadata, workspacePath, projectCheckoutRoot);
  }

  /** Build a candidate without publishing stream ownership or touching accepted history. */
  async prepareStreamMessage(
    opts: StreamMessageOptions
  ): Promise<Result<PreparedStreamMessage, SendMessageError>> {
    if (this.mockModeEnabled)
      return Ok({
        start: (options) => this.streamMessage(options),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      });
    const controller = new AbortController();
    const startupPhaseTimingsMs: Record<string, number> = {};
    const context: TurnRequestBuildContext = {
      abortSignal: opts.abortSignal
        ? AbortSignal.any([opts.abortSignal, controller.signal])
        : controller.signal,
      syntheticMessageId: createAssistantMessageId(),
      startTime: this.streamManager.hostClock.nowMs(),
      startupPhaseTimingsMs,
      startupState: { pendingRunMetadataId: null },
      recordStartupPhaseTiming: (phase, started) => {
        startupPhaseTimingsMs[phase] = this.streamManager.hostClock.nowMs() - started;
      },
      admissionOnly: true,
    };
    try {
      const result = await this.turnRequestBuilder.prepare(opts, context);
      if (result.type === "finished")
        return result.result.success
          ? Err({ type: "unknown", raw: "Request preparation was canceled." })
          : result.result;
      return Ok({
        start: (options) => {
          assert(
            options.workspaceId === opts.workspaceId && options.modelString === opts.modelString,
            "Prepared request must retain its admitted workspace and model"
          );
          return this.streamMessage(options, { request: result.request, controller, context });
        },
        [Symbol.asyncDispose]: () => result.request[Symbol.asyncDispose](),
      });
    } catch (error) {
      return Err({ type: "unknown", raw: "Failed to prepare request: " + getErrorMessage(error) });
    }
  }

  /** Stream a message conversation to the AI model. */
  async streamMessage(
    opts: StreamMessageOptions,
    prepared?: {
      request: PreparedTurnRequest;
      controller: AbortController;
      context: TurnRequestBuildContext;
    }
  ): Promise<Result<TurnStreamHandle, SendMessageError>> {
    const { messages, workspaceId, modelString, thinkingLevel, abortSignal, agentId, muxMetadata } =
      opts;
    // Register before the first await so interrupts can cancel slow preparation.
    const pendingStart = this.streamManager.beginStreamStart({
      workspaceId,
      abortSignal,
      acpPromptId: opts.acpPromptId,
    });
    const startTime = prepared?.context.startTime ?? this.streamManager.hostClock.nowMs();
    const syntheticMessageId = pendingStart.syntheticMessageId;
    opts.onStreamStarting?.(syntheticMessageId);
    const combinedAbortSignal = pendingStart.abortSignal;
    const startupPhaseTimingsMs: Record<string, number> =
      prepared?.context.startupPhaseTimingsMs ?? {};
    const forwardCancellation = () => prepared?.controller.abort(combinedAbortSignal.reason);
    if (combinedAbortSignal.aborted) forwardCancellation();
    else combinedAbortSignal.addEventListener("abort", forwardCancellation, { once: true });
    const recordStartupPhaseTiming = (phase: string, phaseStartedAt: number): void => {
      startupPhaseTimingsMs[phase] = this.streamManager.hostClock.nowMs() - phaseStartedAt;
    };
    const startupState = prepared?.context.startupState ?? {
      pendingRunMetadataId: null as string | null,
      logSlowStreamStartup: undefined as ((details: Record<string, unknown>) => void) | undefined,
    };

    try {
      if (this.mockModeEnabled && this.mockAiStreamPlayer) {
        await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
        if (combinedAbortSignal.aborted) {
          return Ok(this.createAbortedTurnHandle(syntheticMessageId, combinedAbortSignal));
        }
        if (!combinedAbortSignal.aborted) await opts.assertAdmissionCurrent?.();
        if (combinedAbortSignal.aborted)
          return Ok(this.createAbortedTurnHandle(syntheticMessageId, combinedAbortSignal));
        const result = await this.mockAiStreamPlayer.play(messages, workspaceId, {
          model: modelString,
          agentId,
          thinkingLevel,
          muxMetadata,
          abortSignal: combinedAbortSignal,
        });
        if (!result.success) {
          return result;
        }
        return Ok(
          result.data ?? this.createAbortedTurnHandle(syntheticMessageId, combinedAbortSignal)
        );
      }

      const lastMessage = messages[messages.length - 1];
      log.debug(
        "[STREAM MESSAGE] workspaceId=" +
          workspaceId +
          " messageCount=" +
          messages.length +
          " lastRole=" +
          lastMessage?.role
      );

      const commitPartialStartedAt = this.streamManager.hostClock.nowMs();
      await this.historyService.commitPartial(workspaceId);
      recordStartupPhaseTiming("commitPartialMs", commitPartialStartedAt);

      const buildOutcome = prepared
        ? await prepared.request.start(opts.activeTurnThinkingOverride)
        : await this.turnRequestBuilder.build(opts, {
            abortSignal: combinedAbortSignal,
            syntheticMessageId,
            startTime,
            startupPhaseTimingsMs,
            startupState,
            recordStartupPhaseTiming,
          });
      if (buildOutcome.type === "finished") {
        if (startupState.pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadataById(
            workspaceId,
            startupState.pendingRunMetadataId
          );
          startupState.pendingRunMetadataId = null;
        }
        return buildOutcome.result;
      }

      // Prepared candidates must use the final caller's admission, not their earlier preview.
      buildOutcome.turnExecutionOptions.assertAdmissionCurrent = opts.assertAdmissionCurrent;
      buildOutcome.turnExecutionOptions.withAdmissionCurrent = opts.withAdmissionCurrent;
      buildOutcome.turnExecutionOptions.stopFence = opts.stopFence;
      // Stop-cascade fence: a turn admitted before the stop latched (so the cascade's single
      // stopStream could not capture it) must not reach the provider. Abort the pending start
      // instead; startStream then settles it through the existing startup-abort path.
      if (opts.stopFence?.() === false) {
        buildOutcome.logStartOutcome("stream_start_failed", "stop_in_progress");
        pendingStart.abort("startup");
      }
      const startStreamStartedAt = this.streamManager.hostClock.nowMs();
      const streamResult = await this.streamManager.startStream(buildOutcome.turnExecutionOptions);
      recordStartupPhaseTiming("startStreamMs", startStreamStartedAt);

      if (!streamResult.success) {
        if (startupState.pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(buildOutcome.assistantMessageId);
          startupState.pendingRunMetadataId = null;
        }
        buildOutcome.logStartOutcome("stream_start_failed", streamResult.error.type);
        return Err(streamResult.error);
      }

      if (combinedAbortSignal.aborted && !this.streamManager.isStreaming(workspaceId)) {
        if (startupState.pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(buildOutcome.assistantMessageId);
          startupState.pendingRunMetadataId = null;
        }
        await buildOutcome.deleteAbortedPlaceholder(buildOutcome.assistantMessageId);
      }

      buildOutcome.logStartOutcome("started");
      return Ok(streamResult.data);
    } catch (error) {
      if (startupState.pendingRunMetadataId != null) {
        this.clearTrackedPendingDevToolsRunMetadataById(
          workspaceId,
          startupState.pendingRunMetadataId
        );
        startupState.pendingRunMetadataId = null;
      }
      const errorMessage = getErrorMessage(error);
      startupState.logSlowStreamStartup?.({ outcome: "error", errorMessage });
      log.error("Stream message error:", error);
      return Err({ type: "unknown", raw: "Failed to stream message: " + errorMessage });
    } finally {
      combinedAbortSignal.removeEventListener("abort", forwardCancellation);
      pendingStart.finish();
    }
  }

  async stopStream(workspaceId: string, options?: StopStreamOptions): Promise<Result<void>> {
    return this.streamManager.stopStream(workspaceId, options);
  }

  /**
   * Check if a workspace is currently streaming
   */
  isStreaming(workspaceId: string): boolean {
    return this.streamManager.isStreaming(workspaceId);
  }

  debugGetLastLlmRequest(workspaceId: string): Result<DebugLlmRequestSnapshot | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastLlmRequest: workspaceId is required");
    }

    return Ok(this.lastLlmRequestByWorkspace.get(workspaceId) ?? null);
  }

  /**
   * Wired to WorkspaceService "metadata" events (like ComputerUseService): a removed (null) or
   * archived workspace drops its in-memory request-building state, so it does not grow for the
   * whole app run. An un-archived workspace rebuilds that state on its next send.
   */
  handleWorkspaceMetadata(event: {
    workspaceId: string;
    metadata: { archivedAt?: string; unarchivedAt?: string } | null;
  }): void {
    if (
      event.metadata != null &&
      !isWorkspaceArchived(event.metadata.archivedAt, event.metadata.unarchivedAt)
    ) {
      return;
    }
    this.turnRequestBuilder.forgetWorkspace(event.workspaceId);
    this.lastLlmRequestByWorkspace.delete(event.workspaceId);
  }

  async deleteWorkspace(workspaceId: string): Promise<Result<void>> {
    try {
      const workspaceDir = path.join(this.config.sessionsDir, workspaceId);
      await this.historyService.files.promises.rm(workspaceDir, { recursive: true, force: true });
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to delete workspace: ${message}`);
    }
  }
}
