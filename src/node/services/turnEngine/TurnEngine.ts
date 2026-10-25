/**
 * TurnEngine starts a turn: it claims the workspace's slot under the start
 * lock, opens and acquires the turn's resources, constructs and registers the
 * stream, records the turn envelope, and launches processing. start() returns
 * once the stream registers; it does not wait for the turn to end.
 * StreamManager.startStream delegates here, and the attempt loop
 * (processStreamWithCleanup) still runs in StreamManager.
 */
import { Effect, type Scope } from "effect";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";
import type { SendMessageError } from "@/common/types/errors";
import {
  SYSTEM_SECTION_RECORD_FIELDS,
  type MuxMetadata,
  type SystemSectionRecords,
} from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import assert from "@/common/utils/assert";
import type { Runtime } from "@/node/runtime/Runtime";
import type { EffectRunner } from "@/node/services/di/effectRunner";
import { createAutoThinkingEscalationState } from "@/node/services/autoThinkingEscalation";
import { log } from "@/node/services/log";
import type {
  ExecutionScope,
  ToolCallDisplayRegistry,
} from "@/node/services/toolCallDisplayRegistry";
import { PartialJournal } from "@/node/services/turnEngine/PartialJournal";
import {
  ProviderRequest,
  type StreamRequestOptions,
} from "@/node/services/turnEngine/ProviderRequest";
import { StepApply } from "@/node/services/turnEngine/StepApply";
import { convertToSendMessageError } from "@/node/services/turnEngine/streamErrors";
import { TurnRegistry } from "@/node/services/turnEngine/TurnRegistry";
import type { TurnResources, TurnStartup } from "@/node/services/turnEngine/TurnResources";
import {
  StreamState,
  type ModelFallbackOptions,
  type StepMessageTracker,
  type StreamRequestConfig,
  type StreamToken,
  type TurnCompletion,
  type TurnCompletionController,
  type TurnStreamHandle,
  type WorkspaceId,
} from "@/node/services/turnEngine/types";
import type { WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";
import { UsageLedger } from "@/node/services/turnEngine/UsageLedger";
import { nodeClock } from "@/node/utils/hostClock";

export function createTurnCompletionController(): TurnCompletionController {
  let settled = false;
  let resolveCompletion!: (completion: TurnCompletion) => void;
  const promise = new Promise<TurnCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    promise,
    settle: (completion) => {
      if (settled) return;
      settled = true;
      resolveCompletion(completion);
    },
  };
}

// Request-construction options shared by the primary turn and model-fallback
// hops (fallbacks rebuild these from the prepared fallback request).
export interface TurnExecutionOptions extends StreamRequestOptions {
  workspaceId: string;
  historySequence: number;
  runtime: Runtime;
  messageId: string;
  abortSignal?: AbortSignal;
  initialMetadata?: Partial<MuxMetadata>;
  providedStreamToken?: StreamToken;
  executionScope?: ExecutionScope;
  workspaceName?: string;
  thinkingLevel?: string;
  providedRuntimeTempDir?: string;
  modelFallback?: ModelFallbackOptions;
  onStreamConstructed?: () => Promise<void>;
  assertAdmissionCurrent?: () => Promise<void>;
  withAdmissionCurrent?: (construct: () => void) => Promise<void>;
  /**
   * Provider-start fence: false once a stop cascade latched the workspace or bumped its epoch
   * after this turn's admission. Checked synchronously right before provider construction so
   * no start can slip between the cascade's capture and the request.
   */
  stopFence?: () => boolean;
}

/**
 * Auto's thinking claim on a routing record: stamped with the level the request runs at,
 * or withdrawn (with its raises) once the user moved the slider this turn, because the
 * record must not claim a level the rest of the turn did not run at.
 */
export function withAutoThinkingClaim(
  record: AutoModelRoutingRecord,
  level: ThinkingLevel | undefined,
  manual: boolean | undefined
): AutoModelRoutingRecord {
  if (record.thinkingLevel == null) return record;
  if (manual) {
    const { thinkingLevel: _level, escalations: _escalations, ...withoutClaim } = record;
    return withoutClaim;
  }
  return level != null ? { ...record, thinkingLevel: level } : record;
}

/**
 * Report what an Auto-routed stream now runs on to the session (see
 * ActiveTurnThinkingOverride.onLiveRoutingChanged). Called after every mid-turn change to the
 * stream's model, thinking level or routing record; a no-op for streams without a record.
 */
export function publishLiveRouting(streamInfo: WorkspaceStreamInfo): void {
  const autoModelRouting = streamInfo.initialMetadata?.autoModelRouting;
  if (autoModelRouting == null) return;
  streamInfo.request.thinkingOverrideState?.onLiveRoutingChanged?.({
    model: streamInfo.model,
    thinkingLevel: coerceThinkingLevel(streamInfo.thinkingLevel),
    autoModelRouting,
  });
}

/** The row metadata after a step-0 rebuild: its records and system token count follow it. */
function withRebuiltSystemMetadata(
  metadata: Partial<MuxMetadata> | undefined,
  rebuilt: { systemRecords?: SystemSectionRecords; systemMessageTokens?: number }
): Partial<MuxMetadata> {
  const next: Partial<MuxMetadata> = {
    ...metadata,
    systemMessageTokens: rebuilt.systemMessageTokens ?? metadata?.systemMessageTokens,
  };
  // Every record follows the rebuild, an absent one included (it replaces an older one).
  for (const field of SYSTEM_SECTION_RECORD_FIELDS) next[field] = rebuilt.systemRecords?.[field];
  return next;
}

/** One startStream call's state, shared by its startup steps. */
interface StreamStart {
  readonly options: TurnExecutionOptions;
  readonly workspaceId: WorkspaceId;
  readonly completionController: TurnCompletionController;
  readonly handle: TurnStreamHandle;
  /** Set once construct() registered the stream; the stream then owns the startup resources. */
  registeredStream?: WorkspaceStreamInfo;
  /** Set when processing launched; startStream's finally then leaves the resources alone. */
  processingStarted: boolean;
}

/** Per-registration inputs startStream hands to createStreamAtomically. */
interface StreamRegistration {
  streamToken: StreamToken;
  runtimeTempDir: string;
  resourceScope: Scope.Closeable;
  abortController: AbortController;
  /** Unlinks the caller's abort signal; closeStreamResources calls it. */
  unlinkAbortSignal?: () => void;
  completionController: TurnCompletionController;
}

/** The stream's MCP execution scope: the caller's, which must belong to this stream, or a new one. */
export function resolveExecutionScope(
  options: Pick<TurnExecutionOptions, "workspaceId" | "messageId" | "executionScope">,
  streamToken: StreamToken
): ExecutionScope {
  const { messageId } = options;
  const executionScope = options.executionScope ?? {
    workspaceId: options.workspaceId,
    messageId,
    token: streamToken,
  };
  assert(
    executionScope.workspaceId === options.workspaceId &&
      executionScope.messageId === messageId &&
      executionScope.token === streamToken,
    "MCP execution scope must belong to the stream being registered"
  );
  return executionScope;
}

/** A new stream's record in STARTING state, before its hooks are wired. */
export function createStreamInfo(
  options: TurnExecutionOptions,
  ctx: StreamRegistration & {
    executionScope: ExecutionScope;
    streamResult: WorkspaceStreamInfo["streamResult"];
    request: StreamRequestConfig;
    stepTracker: StepMessageTracker;
    metadataModel: string;
  }
): WorkspaceStreamInfo {
  const {
    messageId,
    modelString,
    historySequence,
    workspaceName,
    thinkingLevel,
    initialMetadata,
    modelFallback,
    maxOutputTokens,
    runtime,
  } = options;
  const { executionScope, streamResult, request, stepTracker, metadataModel } = ctx;
  // Record time: wall clock until #7282 moves its consumers to HostClock.
  const startTime = nodeClock.nowMs();
  const streamInfo: WorkspaceStreamInfo = {
    state: StreamState.STARTING,
    streamResult,
    workspaceName,
    abortController: ctx.abortController,
    unlinkAbortSignal: ctx.unlinkAbortSignal,
    messageId,
    token: ctx.streamToken,
    executionScope,
    startTime,
    lastPartTimestamp: startTime,
    toolCompletionTimestamps: new Map(),
    pendingWorkflowRunAttachments: new Map(),
    pendingNestedCalls: new Map(),
    pendingToolExecutionStarts: new Map(),
    model: modelString,
    metadataModel,
    thinkingLevel,
    initialMetadata,
    didRetryPreviousResponseIdAtStep: false,
    didRetryAfterEmptyOutput: false,
    ...(modelFallback && modelFallback.chain.length > 0
      ? {
          modelFallback: {
            options: modelFallback,
            requestedModel: normalizeToCanonical(modelString),
            refusedModels: [],
            // Pre-wrap inputs (NOT request.maxOutputTokens, which may already
            // carry call-settings overrides for the original model).
            original: { maxOutputTokens },
          },
        }
      : {}),
    stepTracker,
    receivedTerminalEvent: false,
    currentStepStartIndex: 0,
    stepStartIndices: [0],
    streamStepOrdinals: [],
    request,
    historySequence,
    parts: [], // Initialize empty parts array
    ...PartialJournal.initialState(), // Never written: the first write is immediate
    processingPromise: Promise.resolve(), // Placeholder, overwritten in startStream
    softInterrupt: { pending: false },
    completionController: ctx.completionController,
    runtimeTempDir: ctx.runtimeTempDir, // Stream-scoped temp directory for tool outputs
    runtime, // Runtime for temp directory cleanup
    resourceScope: ctx.resourceScope, // Owns temp-dir release + debounce fiber
    // Initialize cumulative tracking for multi-step streams
    ...UsageLedger.initialState(),
  };
  return streamInfo;
}

/** Route the step tracker's same-turn rebuild hooks to the stream's row metadata. */
export function wireStepTrackerHooks(streamInfo: WorkspaceStreamInfo): void {
  const { stepTracker } = streamInfo;
  // Single source for same-turn rebuilds: the receipt lives on initialMetadata (#5886).
  stepTracker.hasAnthropicReplayReceipt = () =>
    streamInfo.initialMetadata?.anthropicThinkingReplay === "off";
  stepTracker.recordSystemSections = (rebuilt) => {
    StepApply.setInitialMetadata(
      streamInfo,
      withRebuiltSystemMetadata(streamInfo.initialMetadata, rebuilt)
    );
  };
}

/**
 * Route a mid-turn thinking override's applied levels into the stream. `initialMetadata`
 * is the turn's metadata as the caller passed it (its routing record seeds the raises).
 */
export function wireThinkingOverride(
  streamInfo: WorkspaceStreamInfo,
  initialMetadata: Partial<MuxMetadata> | undefined
): void {
  const { request } = streamInfo;
  // Mid-turn thinking override: route applied levels into this stream's
  // metadata (partials, stream-end, final assistant message). Wired before
  // any step can run; the catch-up sync covers a holder that already applied
  // a level (e.g. re-attachment on retry paths).
  if (request.thinkingOverrideState) {
    const holder = request.thinkingOverrideState;
    holder.onApplied = (level) => {
      ProviderRequest.setThinkingLevel(streamInfo, level);
      const autoModelRouting = streamInfo.initialMetadata?.autoModelRouting;
      if (holder.manual && autoModelRouting != null) {
        StepApply.setInitialMetadata(streamInfo, {
          ...streamInfo.initialMetadata,
          autoModelRouting: withAutoThinkingClaim(autoModelRouting, undefined, true),
        });
      }
      publishLiveRouting(streamInfo);
    };
    if (holder.applied) {
      ProviderRequest.setThinkingLevel(streamInfo, holder.applied);
    }
    wireAutoThinkingEscalation(streamInfo, initialMetadata);
  }
}

/** Let a thinking level Auto chose raise itself mid-turn (see autoThinkingEscalation.ts). */
function wireAutoThinkingEscalation(
  streamInfo: WorkspaceStreamInfo,
  initialMetadata: Partial<MuxMetadata> | undefined
): void {
  const { stepTracker } = streamInfo;
  // A thinking level Auto chose may raise itself mid-turn (see autoThinkingEscalation.ts);
  // the raises land on the routing record the stream-end metadata spreads.
  const routedThinkingLevel = initialMetadata?.autoModelRouting?.thinkingLevel;
  if (routedThinkingLevel != null) {
    stepTracker.autoThinkingEscalation = createAutoThinkingEscalationState(
      routedThinkingLevel,
      initialMetadata?.autoModelRouting?.escalations ?? [],
      (escalations) => {
        const autoModelRouting = streamInfo.initialMetadata?.autoModelRouting;
        if (autoModelRouting == null) return;
        StepApply.setInitialMetadata(streamInfo, {
          ...streamInfo.initialMetadata,
          autoModelRouting: { ...autoModelRouting, escalations },
        });
        publishLiveRouting(streamInfo);
      }
    );
  }
}

export interface TurnEngineDeps {
  /** Runs start's Effect (StreamManager's runner). */
  readonly effectRunner: EffectRunner;
  readonly turnRegistry: TurnRegistry;
  readonly turnResources: TurnResources;
  readonly providerRequest: Pick<ProviderRequest, "buildStreamRequestConfig">;
  readonly toolCallDisplayRegistry: Pick<ToolCallDisplayRegistry, "open" | "close">;
  readonly resolveMetadataModel: (
    modelString: string,
    providersConfigSnapshot?: ProvidersConfigMap
  ) => string;
  readonly handleToolExecutionStart: (
    workspaceId: WorkspaceId,
    messageId: string,
    toolCallId: string
  ) => void;
  /** StreamManager.createStreamResult, read at call time (whitebox tests replace it). */
  readonly createStreamResult: (
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker: StepMessageTracker
  ) => WorkspaceStreamInfo["streamResult"];
  /** StreamManager's attempt loop, which owns the stream once processing starts. */
  readonly processStreamWithCleanup: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ) => Promise<void>;
}

/** One awaited start step: a rejection fails start's Effect and reaches failStreamStart. */
function attempt<A>(step: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: async () => step(), catch: (error) => error });
}

export class TurnEngine {
  constructor(private readonly deps: TurnEngineDeps) {}

  start(options: TurnExecutionOptions): Promise<Result<TurnStreamHandle, SendMessageError>> {
    return this.deps.effectRunner.runPromise(this.startTurn(options));
  }

  /**
   * start's steps as one Effect. The start lock and the startup resources belong to
   * its scope: on exit the startup resources are released first (unless processing
   * took them), then the lock. Uninterruptible like the Promise it replaces: a stop
   * cancels a start through its AbortSignal, never by interrupting this fiber.
   */
  private startTurn(
    options: TurnExecutionOptions
  ): Effect.Effect<Result<TurnStreamHandle, SendMessageError>> {
    const { workspaceId, messages, modelString, historySequence, messageId, abortSignal } = options;
    const completionController = createTurnCompletionController();
    const start: StreamStart = {
      options,
      workspaceId: workspaceId as WorkspaceId,
      completionController,
      handle: { messageId, completion: completionController.promise },
      processingStarted: false,
    };

    if (messages.length === 0) {
      return Effect.succeed(
        Err({
          type: "unknown",
          raw: "Invalid prompt: messages must not be empty",
        })
      );
    }

    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        // Only one start per workspace; released when this scope closes.
        yield* this.deps.turnRegistry.claimStartLock(workspaceId);

        // DEBUG: Log stream start
        log.debug(
          `[STREAM START] workspaceId=${workspaceId} historySequence=${historySequence} model=${modelString}`
        );

        // Owns this stream's abort controller and Effect-managed resources (temp dir,
        // debounce fiber) until the stream registers (TurnResources.openStartup).
        const startup = yield* this.deps.turnResources.startup(abortSignal, (opened) =>
          start.processingStarted ? Promise.resolve() : this.cleanupStartup(start, opened)
        );
        return yield* this.runStreamStartup(start, startup);
      })
    ).pipe(
      // A failed step or a failed release ends the start here, after the lock is released.
      Effect.catch((error) => this.failStreamStart(start, error)),
      Effect.catchDefect((defect) => this.failStreamStart(start, defect)),
      Effect.uninterruptible
    );
  }

  /** Release a start's resources; once registered, the stream owns them (releaseStartup). */
  private cleanupStartup(start: StreamStart, startup: TurnStartup): Promise<void> {
    return this.deps.turnResources.releaseStartup(
      startup,
      start.options.model,
      start.registeredStream
    );
  }

  /** Settle a start that ends before processing as a startup abort; its handle still returns. */
  private settleStartupAbort(start: StreamStart): Result<TurnStreamHandle, SendMessageError> {
    start.completionController.settle({
      status: "aborted",
      abortReason: this.deps.turnRegistry.getStartupAbortReason(start.options.abortSignal),
    });
    return Ok(start.handle);
  }

  /** startStream's steps once the start lock is held; each may end the start as an abort. */
  private runStreamStartup(
    start: StreamStart,
    startup: TurnStartup
  ): Effect.Effect<Result<TurnStreamHandle, SendMessageError>, unknown> {
    return Effect.gen({ self: this }, function* () {
      const prepared = yield* this.prepareStreamStartup(start, startup);
      if (!prepared) return this.settleStartupAbort(start);
      const streamInfo = yield* attempt(() =>
        this.registerStartingStream(start, startup, prepared)
      );
      if (!streamInfo) return this.settleStartupAbort(start);
      if (!(yield* attempt(() => this.admitRegisteredStream(start, startup, streamInfo)))) {
        return this.settleStartupAbort(start);
      }

      // Step 5: Track the processing promise for guaranteed cleanup
      // This allows cancelStreamSafely to wait for full exit
      start.processingStarted = true;
      TurnRegistry.trackProcessing(
        streamInfo,
        this.deps
          .processStreamWithCleanup(start.workspaceId, streamInfo, start.options.historySequence)
          .catch((error) => {
            log.error("Unexpected error in stream processing:", error);
          })
      );

      return Ok(start.handle);
    });
  }

  /**
   * Steps 1 to 3: cancel the workspace's existing stream, pick the token and
   * acquire the temp directory. Undefined when the start was aborted meanwhile.
   */
  private prepareStreamStartup(
    start: StreamStart,
    startup: TurnStartup
  ): Effect.Effect<{ streamToken: StreamToken; runtimeTempDir: string } | undefined, unknown> {
    return Effect.gen({ self: this }, function* () {
      const { options } = start;
      const streamAbortController = startup.abortController;
      // Step 1: Cancel any existing stream before proceeding
      // This must happen regardless of whether a token was provided
      const generatedStreamToken = yield* attempt(() =>
        this.deps.turnRegistry.ensureStreamSafety(start.workspaceId)
      );

      // Step 2: Use provided stream token or the generated one
      const streamToken = options.providedStreamToken ?? generatedStreamToken;

      // If the stream was interrupted while we were waiting on async setup (mutex,
      // temp dir creation, etc), avoid starting the stream entirely.
      if (streamAbortController.signal.aborted) {
        yield* attempt(() => this.cleanupStartup(start, startup));
        return undefined;
      }

      // Step 3: Acquire the temp directory for this stream as a scoped resource.
      const runtimeTempDir = yield* this.deps.turnResources.tempDir(
        startup.resourceScope,
        streamToken,
        options.runtime,
        options.providedRuntimeTempDir
      );

      if (streamAbortController.signal.aborted) {
        yield* attempt(() => this.cleanupStartup(start, startup));
        return undefined;
      }

      // Construction invokes the provider: validate after every startup resource await.
      yield* attempt(async () => options.assertAdmissionCurrent?.());
      if (streamAbortController.signal.aborted) return undefined;
      return { streamToken, runtimeTempDir };
    });
  }

  /** Construct and register the stream; undefined when a stop fenced the start first. */
  private async registerStartingStream(
    start: StreamStart,
    startup: TurnStartup,
    prepared: { streamToken: StreamToken; runtimeTempDir: string }
  ): Promise<WorkspaceStreamInfo | undefined> {
    const { options } = start;
    const streamAbortController = startup.abortController;
    // The persisted comparison and synchronous provider registration share one lock.
    // Record cleanup ownership inside the callback, even if releasing the lock fails.
    const construct = () => {
      if (streamAbortController.signal.aborted) return;
      // Final synchronous gate before the provider is invoked: a stop that latched after
      // the earlier checks settles this start as a startup abort instead of a request.
      if (options.stopFence?.() === false) {
        streamAbortController.abort("startup");
        return;
      }
      const registeredStream = this.createStreamAtomically(options, {
        streamToken: prepared.streamToken,
        runtimeTempDir: prepared.runtimeTempDir,
        resourceScope: startup.resourceScope,
        abortController: streamAbortController,
        unlinkAbortSignal: startup.unlinkAbortSignal,
        completionController: start.completionController,
      });
      start.registeredStream = registeredStream;
      // Scope close must own STARTING streams before the fence's release can await.
      this.deps.turnRegistry.superviseEngine(start.workspaceId, registeredStream);
    };
    if (options.withAdmissionCurrent) await options.withAdmissionCurrent(construct);
    else construct();
    return start.registeredStream;
  }

  /**
   * Record the turn envelope and re-check admission for a registered stream.
   * False when a stop or a replacement superseded it; its resources are released then.
   */
  private async admitRegisteredStream(
    start: StreamStart,
    startup: TurnStartup,
    streamInfo: WorkspaceStreamInfo
  ): Promise<boolean> {
    const { workspaceId, options } = start;
    const { onStreamConstructed } = options;
    const streamAbortController = startup.abortController;
    // Guard against a narrow race:
    // - stopStream() may abort while we're between the last aborted-check and stream registration.
    // - If we start processStreamWithCleanup anyway, it would emit stream-start, but no one would
    //   subsequently call stopStream() again (it already ran), so we'd never emit stream-abort/end.
    // In that case, immediately drop the registered stream and rely on the caller to handle UI.
    if (streamAbortController.signal.aborted) {
      if (this.deps.turnRegistry.workspaceStreams.get(workspaceId) === streamInfo)
        this.deps.turnRegistry.workspaceStreams.delete(workspaceId);
      await this.cleanupStartup(start, startup);
      return false;
    }

    // Stream constructed + registered: durable request-describing side
    // effects (turn envelope) may be recorded now.
    await onStreamConstructed?.();
    // The envelope may wait on storage after construction; do not begin processing a
    // superseded request. Existing failure cleanup owns its registered stream and handle.
    if (
      !streamAbortController.signal.aborted &&
      this.deps.turnRegistry.workspaceStreams.get(workspaceId) === streamInfo
    )
      await options.assertAdmissionCurrent?.();

    // A hard interrupt during the awaited envelope write finds the
    // registered STARTING stream, aborts it, awaits its placeholder
    // processingPromise, and deletes the registration — a replacement
    // stream may already occupy this workspace's slot. Launching
    // processing now would emit stream-start after the abort and its
    // cleanup would later delete that replacement. Bail out; startStream's
    // finally releases this never-processed stream's resources.
    if (
      streamAbortController.signal.aborted ||
      this.deps.turnRegistry.workspaceStreams.get(workspaceId) !== streamInfo
    ) {
      // The envelope may return while abort persistence/raw delivery is still held.
      // Joining its existing fence preserves the first reason and attempt registration.
      await streamInfo.cancelPromise;
      await this.cleanupStartup(start, startup);
      if (this.deps.turnRegistry.workspaceStreams.get(workspaceId) === streamInfo)
        this.deps.turnRegistry.workspaceStreams.delete(workspaceId);
      return false;
    }
    return true;
  }

  /** A start that threw: free the slot it may hold and settle its unreturned handle. */
  private failStreamStart(
    start: StreamStart,
    error: unknown
  ): Effect.Effect<Result<TurnStreamHandle, SendMessageError>> {
    return Effect.promise(async () => this.settleFailedStart(start, error));
  }

  private async settleFailedStart(
    start: StreamStart,
    error: unknown
  ): Promise<Result<TurnStreamHandle, SendMessageError>> {
    const { registeredStream } = start;
    // An envelope failure may arrive after an old stop and replacement registration.
    // Preserve both the captured cancellation fence and the replacement's map entry.
    await registeredStream?.cancelPromise;
    if (
      registeredStream &&
      this.deps.turnRegistry.workspaceStreams.get(start.workspaceId) === registeredStream
    ) {
      this.deps.turnRegistry.workspaceStreams.delete(start.workspaceId);
    }
    // No handle is handed out on this path, so the completion is observed only
    // by a supervisor forked at registration: settle it so that fiber exits
    // instead of cancelling this never-started stream at shutdown.
    start.completionController.settle({
      status: "aborted",
      abortReason: this.deps.turnRegistry.getStartupAbortReason(start.options.abortSignal),
    });
    // Convert to strongly-typed error
    return Err(convertToSendMessageError(error));
  }

  /**
   * Atomically creates a new stream with all necessary setup
   */
  private createStreamAtomically(
    options: TurnExecutionOptions,
    ctx: StreamRegistration
  ): WorkspaceStreamInfo {
    // ctx.abortController is created and linked to the caller-provided abortSignal in startStream().
    const workspaceId = options.workspaceId as WorkspaceId;
    const { messageId, modelString } = options;
    // The tail hook is wired to streamInfo below, once it exists.
    const stepTracker: StepMessageTracker = {
      workspaceId: options.workspaceId,
      recordSystemSections: () => undefined,
    };
    const metadataModel = this.deps.resolveMetadataModel(
      modelString,
      options.providersConfigSnapshot
    );
    const request = this.deps.providerRequest.buildStreamRequestConfig({
      ...options,
      onToolExecutionStart: (toolCallId) =>
        this.deps.handleToolExecutionStart(workspaceId, messageId, toolCallId),
    });

    const executionScope = resolveExecutionScope(options, ctx.streamToken);
    this.deps.toolCallDisplayRegistry.open(executionScope);
    // Start streaming - this can throw immediately if API key is missing
    let streamResult;
    try {
      streamResult = this.deps.createStreamResult(request, ctx.abortController, stepTracker);
    } catch (error) {
      // Clean up abort controller if stream creation fails
      this.deps.toolCallDisplayRegistry.close(executionScope);
      ctx.abortController.abort();
      // Re-throw the error to be caught by startStream
      throw error;
    }

    const streamInfo = createStreamInfo(options, {
      ...ctx,
      executionScope,
      streamResult,
      request,
      stepTracker,
      metadataModel,
    });
    wireStepTrackerHooks(streamInfo);
    wireThinkingOverride(streamInfo, options.initialMetadata);

    // Atomically register the stream
    this.deps.turnRegistry.workspaceStreams.set(workspaceId, streamInfo);

    return streamInfo;
  }
}
