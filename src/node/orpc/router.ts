import { os, ORPCError } from "@orpc/server";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import * as schemas from "@/common/orpc/schemas";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ORPCContext } from "./context";
import { OnePasswordService } from "@/node/services/onePasswordService";
import {
  MUX_GATEWAY_ORIGIN,
  MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
} from "@/common/constants/muxGatewayOAuth";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults } from "@/constants/goals";
import { Err, Ok } from "@/common/types/result";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import { isErrnoWithCode } from "@/node/utils/fs";
import { isPathInsideDir, stripTrailingSlashes } from "@/node/utils/pathUtils";
import { generateWorkspaceIdentity } from "@/node/services/workspaceTitleGenerator";
import {
  WorkspaceGoalChildWorkspaceError,
  WorkspaceGoalTransitionError,
} from "@/node/services/workspaceGoalService";
import type {
  UpdateStatus,
  WorkspaceActivitySnapshot,
  WorkspaceChatMessage,
  WorkspaceStatsSnapshot,
  FrontendWorkspaceMetadataSchemaType,
  SendMessageOptions,
} from "@/common/orpc/types";
import type { TimelineSubscriptionEvent } from "@/common/orpc/schemas/timeline";
import { TIMELINE_DEFAULT_PAGE_LIMIT } from "@/node/services/timelineService";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { SshPromptEvent, SshPromptRequest } from "@/common/orpc/schemas/ssh";
import {
  createAuthMiddleware,
  extractClientIpAddress,
  extractCookieValues,
  getFirstHeaderValue,
} from "./authMiddleware";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { clearLogFiles, getLogFilePath } from "@/node/services/log";
import type { LogEntry } from "@/node/services/logBuffer";
import { clearLogEntries, subscribeLogFeed } from "@/node/services/logBuffer";
import { createReplayBufferedStreamMessageRelay } from "./replayBufferedStreamMessageRelay";

import { createRuntime, checkRuntimeAvailability } from "@/node/runtime/runtimeFactory";
import {
  appendSubProjectRelativePath,
  createRuntimeForWorkspace,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import {
  parseMemoryPath,
  resolveMemoryProjectIdentity,
  type MemoryChangeEvent,
  type MemoryScopeContext,
} from "@/node/services/memoryService";
import type {
  MemoryChangeEventPayload,
  MemoryConsolidationStatusChangeEventPayload,
} from "@/common/orpc/schemas/memory";
import { memoryLogicalKey } from "@/node/services/memoryMeta";
import { secretsToRecord } from "@/common/types/secrets";
import { roundToBase2 } from "@/common/telemetry/utils";
import { createAsyncEventQueue } from "@/common/utils/asyncEventIterator";
import { withQueueHeartbeat } from "@/common/utils/withQueueHeartbeat";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  isLayoutPresetsConfigEmpty,
  normalizeLayoutPresetsConfig,
} from "@/common/types/uiLayouts";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import { isValidModelFormat, normalizeSelectedModel } from "@/common/utils/ai/models";
import { sanitizeModelFallbacks } from "@/common/utils/ai/modelFallbacks";
import {
  DEFAULT_TASK_SETTINGS,
  deriveLegacySubagentAiDefaultsFromAgentDefaults,
  normalizeSubagentAiDefaults,
  normalizeTaskSettings,
} from "@/common/types/tasks";
import {
  normalizeRuntimeEnablement,
  RUNTIME_ENABLEMENT_IDS,
  type RuntimeEnablementId,
} from "@/common/types/runtime";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  discoverAgentSkills,
  discoverAgentSkillsDiagnostics,
  readAgentSkill,
} from "@/node/services/agentSkills/agentSkillsService";
import {
  discoverAgentDefinitions,
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveAgentVisibility } from "@/node/services/agentDefinitions/agentVisibility";
import { isWorkspaceArchived } from "@/common/utils/archive";
import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";
import * as path from "node:path";

import type { DevToolsEvent } from "@/common/types/devtools";
import type { WorkflowRunStreamEvent } from "@/common/types/workflow";
import type { MuxMessage } from "@/common/types/message";
import { coerceThinkingLevel } from "@/common/types/thinking";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import { log } from "@/node/services/log";
import { BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH } from "@/node/orpc/wsPaths";
import { SERVER_AUTH_SESSION_COOKIE_NAME } from "@/node/services/serverAuthService";
import {
  readSubagentTranscriptArtifactsFile,
  type SubagentTranscriptArtifactIndexEntry,
} from "@/node/services/subagentTranscriptArtifacts";
import { getErrorMessage } from "@/common/utils/errors";
import { CHAT_FILE_NAME, CHAT_ARCHIVE_FILE_NAME } from "@/common/constants/paths";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { workflowRunStreamHub } from "@/node/services/workflows/workflowRunStreamHub";
import { discoverWorkflowScripts } from "@/node/services/workflows/workflowScriptDiscovery";
import {
  WorkflowService,
  type WorkflowBackgroundRunTerminalEvent,
} from "@/node/services/workflows/WorkflowService";
import {
  DEFAULT_WORKFLOW_AGENT_ID,
  WorkflowTaskServiceAdapter,
} from "@/node/services/workflows/WorkflowTaskServiceAdapter";
import { WorkflowArgsValidationError } from "@/node/services/workflows/workflowArgs";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import { isProjectTrusted, isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";

import {
  WORKFLOW_RESULT_METADATA_TYPE,
  buildWorkflowResultContextMessage,
} from "@/common/utils/workflowRunMessages";

const RAW_QUERY_USER_ERROR_PATTERNS = [
  /^parser error:/i,
  /^binder error:/i,
  /^catalog error:/i,
  /^conversion error:/i,
  /^invalid input error:/i,
  /^out of range error:/i,
  /^not implemented error:/i,
  /query contains disallowed sql/i,
  /string literals cannot be used as table sources/i,
] as const;

function shouldExposeRawQueryError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return RAW_QUERY_USER_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

const WORKFLOW_CONTINUATION_RETRY_DELAY_MS = 1_000;
const WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE = "Workspace is busy; idle-only send was skipped.";

function isWorkspaceBusyIdleOnlySend(error: { type: string; raw?: string }): boolean {
  return (
    error.type === "unknown" && error.raw?.includes(WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE) === true
  );
}

export async function sendWorkflowRunTerminalContinuation(input: {
  context: ORPCContext;
  workspaceId: string;
  rawCommand: string;
  name: string;
  event: WorkflowBackgroundRunTerminalEvent;
  continuationOptions?: SendMessageOptions;
}): Promise<void> {
  const { context, workspaceId, rawCommand, name, event } = input;
  const { runId, status, result, run } = event;
  const commandPrefix = rawCommand.split(/\s+/u)[0] ?? name;
  const workflowResultMessage = buildWorkflowResultContextMessage({
    rawCommand,
    name,
    runId,
    status,
    result,
    run,
  });
  let continuationOptions = input.continuationOptions ?? null;

  for (;;) {
    const invocationCurrent = await context.workspaceService.isWorkflowInvocationCurrent(
      workspaceId,
      runId
    );
    if (!invocationCurrent) {
      log.debug("Skipping superseded workflow continuation", { workspaceId, runId });
      return;
    }

    continuationOptions ??=
      context.workspaceService.getWorkflowContinuationSendOptions(workspaceId);
    if (continuationOptions == null) {
      log.warn("Skipping workflow continuation without send options", { workspaceId, runId });
      return;
    }

    const sendResult = await context.workspaceService.sendMessage(
      workspaceId,
      workflowResultMessage,
      {
        ...continuationOptions,
        skipAiSettingsPersistence: true,
        muxMetadata: {
          type: WORKFLOW_RESULT_METADATA_TYPE,
          rawCommand,
          commandPrefix,
          runId,
          requestedModel: continuationOptions.model,
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
      log.warn("Failed to continue workflow after completion", {
        workspaceId,
        runId,
        error: sendResult.error,
      });
      return;
    }
    await waitForWorkflowContinuationRetry();
  }
}

function waitForWorkflowContinuationRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WORKFLOW_CONTINUATION_RETRY_DELAY_MS));
}

/**
 * Resolves runtime and discovery path for agent operations.
 * - When workspaceId is provided: uses workspace's runtime config (SSH, local, worktree)
 * - When only projectPath is provided: uses local runtime with project path
 * - When disableWorkspaceAgents is true: still uses workspace runtime but discovers from projectPath
 */
async function resolveAgentDiscoveryContext(
  context: ORPCContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
): Promise<{
  runtime: ReturnType<typeof createRuntime>;
  discoveryPath: string;
  metadata?: WorkspaceMetadata;
}> {
  if (!input.projectPath && !input.workspaceId) {
    throw new Error("Either projectPath or workspaceId must be provided");
  }

  if (input.workspaceId) {
    const metadataResult = await context.aiService.getWorkspaceMetadata(input.workspaceId);
    if (!metadataResult.success) {
      throw new Error(metadataResult.error);
    }
    const metadata = metadataResult.data;
    const runtime = createRuntimeForWorkspace(metadata);
    // When workspace agents disabled, discover from project path instead of worktree
    // (but still use the workspace's runtime for SSH compatibility)
    const discoveryPath = input.disableWorkspaceAgents
      ? metadata.projectPath
      : runtime.getWorkspacePath(metadata.projectPath, metadata.name);
    return { runtime, discoveryPath, metadata };
  }

  // No workspace - use local runtime with project path
  const runtime = createRuntime(
    { type: "local", srcBaseDir: context.config.srcDir },
    { projectPath: input.projectPath! }
  );
  return { runtime, discoveryPath: input.projectPath! };
}

function isTrustedProjectPath(context: ORPCContext, projectPath?: string | null): boolean {
  return isProjectTrusted(context.config, projectPath);
}

function assertDynamicWorkflowsEnabled(context: ORPCContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Dynamic workflows are disabled",
    });
  }
}

function throwWorkflowStartOrpcError(error: unknown): never {
  if (error instanceof WorkflowArgsValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

/** Server-side enforcement: memory.* routes reject while the experiment is off. */
function assertMemoryEnabled(context: ORPCContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MEMORY)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Agent memory is disabled",
    });
  }
}

/**
 * Resolve a workspace's MemoryScopeContext (runtime + checkout cwd) the same
 * way plan-file IPC does. Returns null for unknown workspaces. A nullish
 * workspaceId (Settings → Memory manages global files without any workspace)
 * yields a stub context where only the global scope is reachable —
 * MemoryService fails project/workspace paths with a recoverable error.
 */
async function resolveMemoryScopeContext(
  context: ORPCContext,
  workspaceId: string | null | undefined
): Promise<{ projectPath: string; scopeCtx: MemoryScopeContext } | null> {
  if (workspaceId == null) {
    return {
      projectPath: "",
      scopeCtx: { runtime: null, checkoutCwd: "", workspaceId: "", projectPath: "" },
    };
  }
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata) {
    return null;
  }
  const runtime = createRuntimeForWorkspace(metadata);
  // "" for multi-project workspaces: metadata.projectPath is the first
  // project's path, not a single stable identity.
  const projectPath = resolveMemoryProjectIdentity(metadata);
  return {
    projectPath,
    scopeCtx: { runtime, checkoutCwd: "", workspaceId, projectPath },
  };
}

/**
 * Build a fully-wired WorkflowService for one workspace. Exported so CLI/server
 * entry points share exactly the same construction as the workflows.* routes.
 */
export async function resolveWorkflowContext(
  context: ORPCContext,
  workspaceId: string,
  options: {
    onBackgroundRunTerminal?: (event: WorkflowBackgroundRunTerminalEvent) => Promise<void> | void;
    notifyInterruptedBackgroundRunTerminal?: boolean;
    projectPath?: string;
  } = {}
): Promise<{
  service: WorkflowService;
  projectTrusted: boolean;
  workflowExecutionProjectPath: string;
  runtime: Runtime;
  workspacePath: string;
}> {
  assert(workspaceId.length > 0, "resolveWorkflowContext: workspaceId is required");
  assertDynamicWorkflowsEnabled(context);
  await context.aiService.waitForInit(workspaceId);
  const metadataResult = await context.aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) {
    throw new Error(metadataResult.error);
  }
  const metadata = metadataResult.data;
  const requestedWorkflowProjectPath = options.projectPath?.trim();
  const hasRequestedWorkflowProjectPath =
    requestedWorkflowProjectPath != null && requestedWorkflowProjectPath.length > 0;
  const workflowProjectPath = hasRequestedWorkflowProjectPath
    ? requestedWorkflowProjectPath
    : metadata.projectPath;
  // Workspace-default trust must be metadata-aware: scratch chats are trusted
  // by design but their projectPath is an app-managed workdir, not a config key.
  const resolveWorkflowProjectTrusted = () =>
    hasRequestedWorkflowProjectPath
      ? isTrustedProjectPath(context, workflowProjectPath)
      : isWorkspaceProjectTrusted(context.config, metadata);
  const projectTrusted = resolveWorkflowProjectTrusted();
  const runtime = createRuntimeForWorkspace(metadata);
  const workspaceRootPath = resolveWorkspaceRootPath(metadata, runtime);
  const workflowExecutionProjectPath = hasRequestedWorkflowProjectPath
    ? appendSubProjectRelativePath(
        { ...metadata, subProjectPath: workflowProjectPath },
        runtime,
        workspaceRootPath
      )
    : appendSubProjectRelativePath(metadata, runtime, workspaceRootPath);
  const workspacePath = workflowExecutionProjectPath;
  const workflowRuntimeTempDir = runtime.normalizePath(".mux/tmp", workspacePath);

  return {
    workflowExecutionProjectPath,
    runtime,
    workspacePath,
    projectTrusted,
    service: new WorkflowService({
      notifyInterruptedBackgroundRunTerminal:
        options.notifyInterruptedBackgroundRunTerminal === true,
      runStore: new WorkflowRunStore({ sessionDir: context.config.getSessionDir(workspaceId) }),
      runtimeFactory: context.workflowRuntimeFactory,
      taskAdapterFactory: (runId, workflowName) =>
        new WorkflowTaskServiceAdapter({
          taskService: context.taskService,
          parentWorkspaceId: workspaceId,
          workflowRunId: runId,
          workflowName,
          defaultAgentId: DEFAULT_WORKFLOW_AGENT_ID,
          patchToolConfig: {
            workspaceId,
            cwd: workspacePath,
            runtime,
            runtimeTempDir: workflowRuntimeTempDir,
            workspaceSessionDir: context.config.getSessionDir(workspaceId),
            trusted: projectTrusted,
          },
          getProjectTrusted: resolveWorkflowProjectTrusted,
          experiments: {
            dynamicWorkflows: true,
          },
        }),
      resolveWorkflowScript: (scriptPath) =>
        resolveWorkflowScript({
          scriptPath,
          runtime,
          workspacePath,
          projectTrusted: resolveWorkflowProjectTrusted(),
        }),
      onRunStatusChanged: (event) => context.workspaceService.emitWorkflowRunActivity(event),
      ...(options.onBackgroundRunTerminal != null
        ? { onBackgroundRunTerminal: options.onBackgroundRunTerminal }
        : {}),
      getCurrentProjectTrusted: resolveWorkflowProjectTrusted,
      runnerId: `workflow-runner:${workspaceId}`,
    }),
  };
}

function normalizeOptionalConfigString(value: string | null | undefined): string | undefined {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return undefined;
  }

  return trimmedValue;
}

function normalizeOptionalConfigThinkingLevel(value: string | null | undefined) {
  return coerceThinkingLevel(value);
}

function normalizeAdvisorMaxUsesPerTurn(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  assert(Number.isInteger(value), "Advisor max uses per turn must be an integer");
  assert(value > 0, "Advisor max uses per turn must be positive");
  return value;
}

function normalizeAdvisorMaxOutputTokens(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  assert(Number.isInteger(value), "Advisor max output tokens must be an integer");
  assert(value > 0, "Advisor max output tokens must be positive");
  return value;
}

function mergeTaskSettingsForConfigSave(current: unknown, input: unknown) {
  const inputRecord = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const definedInput: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputRecord)) {
    if (value !== undefined) {
      definedInput[key] = value;
    }
  }

  // saveConfig predates optional task flags. Preserve existing values when a client only sends
  // the required numeric limits; otherwise unrelated settings saves can silently disable toggles
  // like preserveSubagentsUntilArchive before task cleanup evaluates them.
  return normalizeTaskSettings({ ...normalizeTaskSettings(current), ...definedInput });
}

function normalizeMuxMessageFromDisk(value: unknown): MuxMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  // Older history may have createdAt serialized as a string; coerce back to Date for ORPC.
  const obj = value as { createdAt?: unknown };
  if (typeof obj.createdAt === "string") {
    const parsed = new Date(obj.createdAt);
    if (Number.isFinite(parsed.getTime())) {
      obj.createdAt = parsed;
    } else {
      delete obj.createdAt;
    }
  }

  return normalizeLegacyMuxMetadata(value as MuxMessage);
}

async function readChatJsonlAllowMissing(params: {
  chatPath: string;
  logLabel: string;
}): Promise<MuxMessage[] | null> {
  try {
    const data = await fsPromises.readFile(params.chatPath, "utf-8");
    const lines = data.split("\n").filter((line) => line.trim());
    const messages: MuxMessage[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]) as unknown;
        const message = normalizeMuxMessageFromDisk(parsed);
        if (message) {
          messages.push(message);
        }
      } catch (parseError) {
        log.warn(
          `Skipping malformed JSON at line ${i + 1} in ${params.logLabel}:`,
          getErrorMessage(parseError),
          "\nLine content:",
          lines[i].substring(0, 100) + (lines[i].length > 100 ? "..." : "")
        );
      }
    }

    return messages;
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

async function readPartialJsonBestEffort(partialPath: string): Promise<MuxMessage | null> {
  try {
    const raw = await fsPromises.readFile(partialPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeMuxMessageFromDisk(parsed);
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }

    // Never fail transcript viewing because partial.json is corrupted.
    log.warn("Failed to read partial.json for transcript", {
      partialPath,
      error: getErrorMessage(error),
    });
    return null;
  }
}

function mergePartialIntoHistory(messages: MuxMessage[], partial: MuxMessage | null): MuxMessage[] {
  if (!partial) {
    return messages;
  }

  const partialSeq = partial.metadata?.historySequence;
  if (partialSeq === undefined) {
    return [...messages, partial];
  }

  const existingIndex = messages.findIndex((m) => m.metadata?.historySequence === partialSeq);
  if (existingIndex >= 0) {
    const existing = messages[existingIndex];
    const shouldReplace = (partial.parts?.length ?? 0) > (existing.parts?.length ?? 0);
    if (!shouldReplace) {
      return messages;
    }

    const next = [...messages];
    next[existingIndex] = partial;
    return next;
  }

  // Insert by historySequence to keep ordering stable.
  const insertIndex = messages.findIndex((m) => {
    const seq = m.metadata?.historySequence;
    return typeof seq === "number" && seq > partialSeq;
  });

  if (insertIndex < 0) {
    return [...messages, partial];
  }

  const next = [...messages];
  next.splice(insertIndex, 0, partial);
  return next;
}

async function findSubagentTranscriptEntryByScanningSessions(params: {
  sessionsDir: string;
  taskId: string;
}): Promise<{ workspaceId: string; entry: SubagentTranscriptArtifactIndexEntry } | null> {
  let best: { workspaceId: string; entry: SubagentTranscriptArtifactIndexEntry } | null = null;

  let dirents: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    dirents = await fsPromises.readdir(params.sessionsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const workspaceId = dirent.name;
    if (!workspaceId) {
      continue;
    }

    const sessionDir = path.join(params.sessionsDir, workspaceId);
    const artifacts = await readSubagentTranscriptArtifactsFile(sessionDir);
    const entry = artifacts.artifactsByChildTaskId[params.taskId];
    if (!entry) {
      continue;
    }

    if (!best || entry.updatedAtMs > best.entry.updatedAtMs) {
      best = { workspaceId, entry };
    }
  }

  return best;
}

async function getCurrentServerAuthSessionId(context: ORPCContext): Promise<string | null> {
  const sessionTokens = extractCookieValues(
    context.headers?.cookie,
    SERVER_AUTH_SESSION_COOKIE_NAME
  );
  if (sessionTokens.length === 0) {
    return null;
  }

  for (const sessionToken of sessionTokens) {
    const validation = await context.serverAuthService.validateSessionToken(sessionToken, {
      userAgent: getFirstHeaderValue(context.headers, "user-agent"),
      ipAddress: extractClientIpAddress(context.headers),
    });

    if (validation?.sessionId) {
      return validation.sessionId;
    }
  }

  return null;
}

/**
 * Translate goal-board service errors (`WorkspaceGoalTransitionError`,
 * `WorkspaceGoalChildWorkspaceError`) into `ORPCError("BAD_REQUEST", …)`
 * so the original message reaches the renderer. Without this wrapper,
 * the oRPC server normalizes thrown plain Errors to the generic
 * `INTERNAL_SERVER_ERROR` ("Internal server error"), making the UI
 * unable to explain why a click did nothing. Unrelated errors are
 * rethrown untouched so the existing logging path still fires.
 */
async function withGoalErrorTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof WorkspaceGoalTransitionError ||
      error instanceof WorkspaceGoalChildWorkspaceError
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: error.message,
        cause: error,
        data: { code: error.code },
      });
    }
    throw error;
  }
}

interface BrowserCommandLoadingParams<T extends { success: boolean }> {
  context: ORPCContext;
  workspaceId: string;
  sessionName: string;
  run: () => Promise<T>;
}

// Browser commands mark the preview loading before they run; callers validate the session
// before invoking this helper, so the URL refresh can skip the duplicate discovery pass.
async function markBrowserCommandLoadedFromCurrentUrl(params: {
  context: ORPCContext;
  workspaceId: string;
  sessionName: string;
  commandToken: number;
}): Promise<void> {
  try {
    const urlResult = await params.context.browserControlService.getUrl(
      params.workspaceId,
      params.sessionName,
      { skipSessionValidation: true }
    );
    params.context.browserSessionStateHub.markLoaded(
      params.workspaceId,
      params.sessionName,
      urlResult.error == null ? urlResult.url : undefined,
      params.commandToken
    );
  } catch {
    params.context.browserSessionStateHub.markLoaded(
      params.workspaceId,
      params.sessionName,
      undefined,
      params.commandToken
    );
  }
}

async function runBrowserCommandWithLoadingState<T extends { success: boolean }>(
  params: BrowserCommandLoadingParams<T>
): Promise<T> {
  const commandToken = params.context.browserSessionStateHub.markLoading(
    params.workspaceId,
    params.sessionName
  );

  try {
    const result = await params.run();
    if (result.success) {
      await markBrowserCommandLoadedFromCurrentUrl({ ...params, commandToken });
    } else {
      params.context.browserSessionStateHub.markLoaded(
        params.workspaceId,
        params.sessionName,
        undefined,
        commandToken
      );
    }
    return result;
  } catch (error) {
    await markBrowserCommandLoadedFromCurrentUrl({ ...params, commandToken });
    throw error;
  }
}

export const router = (authToken?: string) => {
  const t = os.$context<ORPCContext>().use(createAuthMiddleware(authToken));

  return t.router({
    tokenizer: {
      countTokens: t
        .input(schemas.tokenizer.countTokens.input)
        .output(schemas.tokenizer.countTokens.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.countTokens(input.model, input.text);
        }),
      countTokensBatch: t
        .input(schemas.tokenizer.countTokensBatch.input)
        .output(schemas.tokenizer.countTokensBatch.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.countTokensBatch(input.model, input.texts);
        }),
      calculateStats: t
        .input(schemas.tokenizer.calculateStats.input)
        .output(schemas.tokenizer.calculateStats.output)
        .handler(async ({ context, input }) => {
          const metadataResult = await context.aiService.getWorkspaceMetadata(input.workspaceId);
          const parentWorkspaceId = metadataResult.success
            ? (metadataResult.data.parentWorkspaceId ?? null)
            : null;

          return context.tokenizerService.calculateStats(
            input.workspaceId,
            input.messages,
            input.model,
            context.providerService.getConfig(),
            parentWorkspaceId
          );
        }),
    },
    splashScreens: {
      getViewedSplashScreens: t
        .input(schemas.splashScreens.getViewedSplashScreens.input)
        .output(schemas.splashScreens.getViewedSplashScreens.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          return config.viewedSplashScreens ?? [];
        }),
      markSplashScreenViewed: t
        .input(schemas.splashScreens.markSplashScreenViewed.input)
        .output(schemas.splashScreens.markSplashScreenViewed.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const viewed = config.viewedSplashScreens ?? [];
            if (!viewed.includes(input.splashId)) {
              viewed.push(input.splashId);
            }
            return {
              ...config,
              viewedSplashScreens: viewed,
            };
          });
        }),
    },
    server: {
      getLaunchProject: t
        .input(schemas.server.getLaunchProject.input)
        .output(schemas.server.getLaunchProject.output)
        .handler(async ({ context }) => {
          return context.serverService.getLaunchProject();
        }),
      getSshHost: t
        .input(schemas.server.getSshHost.input)
        .output(schemas.server.getSshHost.output)
        .handler(({ context }) => {
          return context.serverService.getSshHost() ?? null;
        }),
      setSshHost: t
        .input(schemas.server.setSshHost.input)
        .output(schemas.server.setSshHost.output)
        .handler(async ({ context, input }) => {
          // Update in-memory value
          context.serverService.setSshHost(input.sshHost ?? undefined);
          // Persist to config file
          await context.config.editConfig((config) => ({
            ...config,
            serverSshHost: input.sshHost ?? undefined,
          }));
        }),
      getApiServerStatus: t
        .input(schemas.server.getApiServerStatus.input)
        .output(schemas.server.getApiServerStatus.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          const configuredBindHost = config.apiServerBindHost ?? null;
          const configuredServeWebUi = config.apiServerServeWebUi === true;
          const configuredPort = config.apiServerPort ?? null;

          const info = context.serverService.getServerInfo();

          return {
            running: info !== null,
            baseUrl: info?.baseUrl ?? null,
            bindHost: info?.bindHost ?? null,
            port: info?.port ?? null,
            networkBaseUrls: info?.networkBaseUrls ?? [],
            tailscaleBindHosts: context.serverService.getTailscaleBindHosts(),
            token: info?.token ?? null,
            configuredBindHost,
            configuredPort,
            configuredServeWebUi,
          };
        }),
      setApiServerSettings: t
        .input(schemas.server.setApiServerSettings.input)
        .output(schemas.server.setApiServerSettings.output)
        .handler(async ({ context, input }) => {
          const prevConfig = context.config.loadConfigOrDefault();
          const prevBindHost = prevConfig.apiServerBindHost;
          const prevServeWebUi = prevConfig.apiServerServeWebUi;
          const prevPort = prevConfig.apiServerPort;
          const wasRunning = context.serverService.isServerRunning();

          const bindHost = input.bindHost?.trim() ? input.bindHost.trim() : undefined;
          const serveWebUi =
            input.serveWebUi === undefined
              ? prevServeWebUi
              : input.serveWebUi === true
                ? true
                : undefined;
          const port = input.port === null || input.port === 0 ? undefined : input.port;

          if (wasRunning) {
            await context.serverService.stopServer();
          }

          await context.config.editConfig((config) => {
            config.apiServerServeWebUi = serveWebUi;
            config.apiServerBindHost = bindHost;
            config.apiServerPort = port;
            return config;
          });

          if (process.env.MUX_NO_API_SERVER !== "1") {
            const authToken = context.serverService.getApiAuthToken();
            if (!authToken) {
              throw new Error("API server auth token not initialized");
            }

            const envPort = process.env.MUX_SERVER_PORT
              ? Number.parseInt(process.env.MUX_SERVER_PORT, 10)
              : undefined;
            const portToUse = envPort ?? port ?? 0;
            const hostToUse = bindHost ?? "127.0.0.1";

            try {
              await context.serverService.startServer({
                muxHome: context.config.rootDir,
                context,
                authToken,
                serveStatic: serveWebUi === true,
                host: hostToUse,
                port: portToUse,
              });
            } catch (error) {
              await context.config.editConfig((config) => {
                config.apiServerServeWebUi = prevServeWebUi;
                config.apiServerBindHost = prevBindHost;
                config.apiServerPort = prevPort;
                return config;
              });

              if (wasRunning) {
                const portToRestore = envPort ?? prevPort ?? 0;
                const hostToRestore = prevBindHost ?? "127.0.0.1";

                try {
                  await context.serverService.startServer({
                    muxHome: context.config.rootDir,
                    context,
                    serveStatic: prevServeWebUi === true,
                    authToken,
                    host: hostToRestore,
                    port: portToRestore,
                  });
                } catch {
                  // Best effort - we'll surface the original error.
                }
              }

              throw error;
            }
          }

          const nextConfig = context.config.loadConfigOrDefault();
          const configuredBindHost = nextConfig.apiServerBindHost ?? null;
          const configuredServeWebUi = nextConfig.apiServerServeWebUi === true;
          const configuredPort = nextConfig.apiServerPort ?? null;

          const info = context.serverService.getServerInfo();

          return {
            running: info !== null,
            baseUrl: info?.baseUrl ?? null,
            bindHost: info?.bindHost ?? null,
            port: info?.port ?? null,
            networkBaseUrls: info?.networkBaseUrls ?? [],
            tailscaleBindHosts: context.serverService.getTailscaleBindHosts(),
            token: info?.token ?? null,
            configuredBindHost,
            configuredPort,
            configuredServeWebUi,
          };
        }),
    },
    serverAuth: {
      listSessions: t
        .input(schemas.serverAuth.listSessions.input)
        .output(schemas.serverAuth.listSessions.output)
        .handler(async ({ context }) => {
          const currentSessionId = await getCurrentServerAuthSessionId(context);
          return context.serverAuthService.listSessions(currentSessionId);
        }),
      revokeSession: t
        .input(schemas.serverAuth.revokeSession.input)
        .output(schemas.serverAuth.revokeSession.output)
        .handler(async ({ context, input }) => {
          const removed = await context.serverAuthService.revokeSession(input.sessionId);
          return { removed };
        }),
      revokeOtherSessions: t
        .input(schemas.serverAuth.revokeOtherSessions.input)
        .output(schemas.serverAuth.revokeOtherSessions.output)
        .handler(async ({ context }) => {
          const currentSessionId = await getCurrentServerAuthSessionId(context);
          const revokedCount =
            await context.serverAuthService.revokeOtherSessions(currentSessionId);
          return { revokedCount };
        }),
    },
    config: {
      getConfig: t
        .input(schemas.config.getConfig.input)
        .output(schemas.config.getConfig.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          // Determine governor enrollment: requires both URL and token
          const muxGovernorUrl = config.muxGovernorUrl ?? null;
          const muxGovernorEnrolled = Boolean(config.muxGovernorUrl && config.muxGovernorToken);
          return {
            userPreferencesInitialized: config.migrations?.userPreferencesInitialized === true,
            userPreferences: config.userPreferences,
            taskSettings: config.taskSettings ?? DEFAULT_TASK_SETTINGS,
            muxGatewayEnabled: config.muxGatewayEnabled,
            muxGatewayModels: config.muxGatewayModels,
            routePriority: config.routePriority,
            routeOverrides: config.routeOverrides,
            minThinkingLevelByModel: config.minThinkingLevelByModel,
            modelFallbacks: config.modelFallbacks,
            defaultModel: config.defaultModel,
            advisorModelString: config.advisorModelString ?? null,
            advisorThinkingLevel: config.advisorThinkingLevel ?? null,
            advisorMaxUsesPerTurn: config.advisorMaxUsesPerTurn,
            advisorMaxOutputTokens: config.advisorMaxOutputTokens,
            hiddenModels: config.hiddenModels,
            coderWorkspaceArchiveBehavior:
              config.coderWorkspaceArchiveBehavior ?? DEFAULT_CODER_ARCHIVE_BEHAVIOR,
            worktreeArchiveBehavior: config.worktreeArchiveBehavior ?? "keep",
            runtimeEnablement: normalizeRuntimeEnablement(config.runtimeEnablement),
            defaultRuntime: config.defaultRuntime ?? null,
            agentAiDefaults: config.agentAiDefaults ?? {},
            // Subagent defaults: exec is canonical active storage, non-exec entries
            // support legacy mirror compatibility.
            subagentAiDefaults: config.subagentAiDefaults ?? {},
            // Mux Governor enrollment status (safe fields only - token never exposed)
            muxGovernorUrl,
            muxGovernorEnrolled,
            chatTranscriptFullWidth: config.chatTranscriptFullWidth === true,
            llmDebugLogs: config.llmDebugLogs === true,
            heartbeatDefaultPrompt: config.heartbeatDefaultPrompt ?? undefined,
            heartbeatDefaultIntervalMs: config.heartbeatDefaultIntervalMs ?? undefined,
            goalDefaults: normalizeGoalDefaults(config.goalDefaults ?? DEFAULT_GOAL_DEFAULTS),
            onePasswordAccountName: config.onePasswordAccountName ?? null,
          };
        }),
      onConfigChanged: t
        .input(schemas.config.onConfigChanged.input)
        .output(schemas.config.onConfigChanged.output)
        .handler(async function* ({ context, signal }) {
          let resolveNext: (() => void) | null = null;
          let pendingNotification = false;
          let ended = false;

          const push = () => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          const unsubscribe = context.config.onConfigChanged(push);

          // Consumers often cancel this subscription while there are no pending config changes.
          // If we block on a never-resolving Promise, AbortSignal cancellation can't unwind the
          // generator, and we leak EventEmitter listeners across tests.
          const onAbort = () => {
            if (ended) return;
            ended = true;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            while (!ended) {
              if (pendingNotification) {
                pendingNotification = false;
                if (ended) break;
                yield undefined;
                continue;
              }

              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });

              if (ended) break;
              yield undefined;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      updateAgentAiDefaults: t
        .input(schemas.config.updateAgentAiDefaults.input)
        .output(schemas.config.updateAgentAiDefaults.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalized = normalizeAgentAiDefaults(input.agentAiDefaults);

            const legacySubagentDefaults = deriveLegacySubagentAiDefaultsFromAgentDefaults({
              agentAiDefaults: normalized,
              preservedExec: config.subagentAiDefaults?.exec,
            });

            return {
              ...config,
              agentAiDefaults: Object.keys(normalized).length > 0 ? normalized : undefined,
              // Subagent defaults: exec is canonical active storage, non-exec entries
              // support legacy mirror compatibility.
              subagentAiDefaults:
                Object.keys(legacySubagentDefaults).length > 0 ? legacySubagentDefaults : undefined,
            };
          });
        }),
      updateMuxGatewayPrefs: t
        .input(schemas.config.updateMuxGatewayPrefs.input)
        .output(schemas.config.updateMuxGatewayPrefs.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const nextModels = Array.from(new Set(input.muxGatewayModels));
            nextModels.sort();

            return {
              ...config,
              muxGatewayEnabled: input.muxGatewayEnabled ? undefined : false,
              // Persist explicit empty selections so startup migration doesn't
              // rehydrate stale legacy localStorage values.
              muxGatewayModels: nextModels,
            };
          });
          // Notify subscribers (useProvidersConfig) so the frontend picks up the
          // new gateway enabled/models state without needing localStorage.
          context.providerService.notifyConfigChanged();
        }),
      updateRoutePreferences: t
        .input(schemas.config.updateRoutePreferences.input)
        .output(schemas.config.updateRoutePreferences.output)
        .handler(async ({ context, input }) => {
          const routeOverrides =
            input.routeOverrides ?? context.config.loadConfigOrDefault().routeOverrides ?? {};
          const validation = context.providerService.validateRouteOverrides(routeOverrides);
          if (!validation.success) {
            throw new Error(validation.error);
          }

          await context.config.editConfig((config) => ({
            ...config,
            routePriority: input.routePriority,
            routeOverrides,
          }));
        }),
      updateMinThinkingLevels: t
        .input(schemas.config.updateMinThinkingLevels.input)
        .output(schemas.config.updateMinThinkingLevels.output)
        .handler(async ({ context, input }) => {
          // Full-map replacement; the frontend drops entries that match the default floor
          // so the stored map stays sparse.
          await context.config.editConfig((config) => ({
            ...config,
            minThinkingLevelByModel: input.minThinkingLevelByModel,
          }));
        }),
      updateModelFallbacks: t
        .input(schemas.config.updateModelFallbacks.input)
        .output(schemas.config.updateModelFallbacks.output)
        .handler(async ({ context, input }) => {
          // Full-map replacement. Strict-on-write sanitization: canonical keys,
          // self-fallbacks/duplicates dropped, chain length capped, empty
          // chains removed.
          const sanitized = sanitizeModelFallbacks(input.modelFallbacks);
          await context.config.editConfig((config) => ({
            ...config,
            modelFallbacks: Object.keys(sanitized).length > 0 ? sanitized : undefined,
          }));
        }),
      updateModelPreferences: t
        .input(schemas.config.updateModelPreferences.input)
        .output(schemas.config.updateModelPreferences.output)
        .handler(async ({ context, input }) => {
          const normalizeModelString = (value: string): string | undefined => {
            const trimmed = value.trim();
            if (!trimmed) {
              return undefined;
            }

            // Reject malformed mux-gateway strings ("mux-gateway:provider" without "/model").
            if (trimmed.startsWith("mux-gateway:") && !trimmed.includes("/")) {
              return undefined;
            }

            const normalized = normalizeSelectedModel(trimmed);
            if (!isValidModelFormat(normalized)) {
              return undefined;
            }

            return normalized;
          };

          await context.config.editConfig((config) => {
            const next = { ...config };

            if (input.defaultModel !== undefined) {
              next.defaultModel = normalizeModelString(input.defaultModel);
            }

            if (input.hiddenModels !== undefined) {
              const seen = new Set<string>();
              const normalizedHidden: string[] = [];

              for (const modelString of input.hiddenModels) {
                const normalized = normalizeModelString(modelString);
                if (!normalized) continue;
                if (seen.has(normalized)) continue;
                seen.add(normalized);
                normalizedHidden.push(normalized);
              }

              next.hiddenModels = normalizedHidden;
            }

            return next;
          });
        }),
      updateCoderPrefs: t
        .input(schemas.config.updateCoderPrefs.input)
        .output(schemas.config.updateCoderPrefs.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            return {
              ...config,
              coderWorkspaceArchiveBehavior: input.coderWorkspaceArchiveBehavior,
              worktreeArchiveBehavior: input.worktreeArchiveBehavior,
            };
          });
        }),
      updateOnePasswordAccountName: t
        .input(schemas.config.updateOnePasswordAccountName.input)
        .output(schemas.config.updateOnePasswordAccountName.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const trimmedAccountName = input.onePasswordAccountName?.trim() ?? undefined;
            const normalizedAccountName =
              trimmedAccountName === "" ? undefined : trimmedAccountName;
            return {
              ...config,
              onePasswordAccountName: normalizedAccountName,
            };
          });
        }),
      updateRuntimeEnablement: t
        .input(schemas.config.updateRuntimeEnablement.input)
        .output(schemas.config.updateRuntimeEnablement.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const shouldUpdateRuntimeEnablement = input.runtimeEnablement !== undefined;
            const shouldUpdateDefaultRuntime = input.defaultRuntime !== undefined;
            const shouldUpdateOverridesEnabled = input.runtimeOverridesEnabled !== undefined;
            const projectPath = input.projectPath?.trim();

            if (
              !shouldUpdateRuntimeEnablement &&
              !shouldUpdateDefaultRuntime &&
              !shouldUpdateOverridesEnabled
            ) {
              return config;
            }

            const runtimeEnablementOverrides =
              input.runtimeEnablement == null
                ? undefined
                : (() => {
                    const normalized = normalizeRuntimeEnablement(input.runtimeEnablement);
                    const disabled: Partial<Record<RuntimeEnablementId, false>> = {};

                    for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
                      if (!normalized[runtimeId]) {
                        disabled[runtimeId] = false;
                      }
                    }

                    return Object.keys(disabled).length > 0 ? disabled : undefined;
                  })();

            const defaultRuntime = input.defaultRuntime ?? undefined;
            const runtimeOverridesEnabled =
              input.runtimeOverridesEnabled === true ? true : undefined;

            if (projectPath) {
              const project = config.projects.get(projectPath);
              if (!project) {
                log.warn("Runtime settings update requested for missing project", { projectPath });
                return config;
              }

              const nextProject = { ...project };

              if (shouldUpdateRuntimeEnablement) {
                if (runtimeEnablementOverrides) {
                  nextProject.runtimeEnablement = runtimeEnablementOverrides;
                } else {
                  delete nextProject.runtimeEnablement;
                }
              }

              if (shouldUpdateDefaultRuntime) {
                if (defaultRuntime !== undefined) {
                  nextProject.defaultRuntime = defaultRuntime;
                } else {
                  delete nextProject.defaultRuntime;
                }
              }

              if (shouldUpdateOverridesEnabled) {
                if (runtimeOverridesEnabled) {
                  nextProject.runtimeOverridesEnabled = true;
                } else {
                  delete nextProject.runtimeOverridesEnabled;
                }
              }
              const nextProjects = new Map(config.projects);
              nextProjects.set(projectPath, nextProject);
              return { ...config, projects: nextProjects };
            }

            const next = { ...config };
            if (shouldUpdateRuntimeEnablement) {
              next.runtimeEnablement = runtimeEnablementOverrides;
            }

            if (shouldUpdateDefaultRuntime) {
              next.defaultRuntime = defaultRuntime;
            }

            return next;
          });
        }),
      saveConfig: t
        .input(schemas.config.saveConfig.input)
        .output(schemas.config.saveConfig.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const result = { ...config };

            if (input.taskSettings != null) {
              result.taskSettings = mergeTaskSettingsForConfigSave(
                config.taskSettings,
                input.taskSettings
              );
            }

            if (input.userPreferences !== undefined) {
              result.userPreferences = normalizeUserPreferences(input.userPreferences);
              result.migrations = {
                ...(result.migrations ?? {}),
                userPreferencesInitialized: true,
              };
            }

            if (input.advisorModelString !== undefined) {
              result.advisorModelString = normalizeOptionalConfigString(input.advisorModelString);
            }

            if (input.advisorThinkingLevel !== undefined) {
              result.advisorThinkingLevel = normalizeOptionalConfigThinkingLevel(
                input.advisorThinkingLevel
              );
            }

            if (input.advisorMaxUsesPerTurn !== undefined) {
              result.advisorMaxUsesPerTurn = normalizeAdvisorMaxUsesPerTurn(
                input.advisorMaxUsesPerTurn
              );
            }

            if (input.advisorMaxOutputTokens !== undefined) {
              result.advisorMaxOutputTokens = normalizeAdvisorMaxOutputTokens(
                input.advisorMaxOutputTokens
              );
            }

            if (input.agentAiDefaults !== undefined) {
              const normalized = normalizeAgentAiDefaults(input.agentAiDefaults);
              result.agentAiDefaults = Object.keys(normalized).length > 0 ? normalized : undefined;

              if (input.subagentAiDefaults === undefined) {
                const legacySubagentDefaults = deriveLegacySubagentAiDefaultsFromAgentDefaults({
                  agentAiDefaults: normalized,
                  preservedExec: config.subagentAiDefaults?.exec,
                });
                result.subagentAiDefaults =
                  Object.keys(legacySubagentDefaults).length > 0
                    ? legacySubagentDefaults
                    : undefined;
              }
            }

            if (input.subagentAiDefaults !== undefined) {
              const normalizedDefaults = normalizeSubagentAiDefaults(input.subagentAiDefaults);
              result.subagentAiDefaults =
                Object.keys(normalizedDefaults).length > 0 ? normalizedDefaults : undefined;

              // Compatibility: keep agentAiDefaults in sync with non-exec subagent entries.
              // Only mutate keys previously managed by subagentAiDefaults so we don't clobber other
              // agent defaults (e.g., UI-selectable custom agents).
              const previousLegacy = config.subagentAiDefaults ?? {};
              const nextAgentAiDefaults: Record<string, unknown> = {
                ...(result.agentAiDefaults ?? config.agentAiDefaults ?? {}),
              };

              for (const legacyAgentType of Object.keys(previousLegacy)) {
                if (
                  legacyAgentType === "plan" ||
                  legacyAgentType === "exec" ||
                  legacyAgentType === "compact"
                ) {
                  continue;
                }
                if (!(legacyAgentType in normalizedDefaults)) {
                  const existing = nextAgentAiDefaults[legacyAgentType];
                  if (existing && typeof existing === "object") {
                    const nonAiDefaults: Record<string, unknown> = {
                      ...(existing as Record<string, unknown>),
                    };
                    delete nonAiDefaults.modelString;
                    delete nonAiDefaults.thinkingLevel;

                    // Preserve non-AI fields (enabled, advisorEnabled) when the legacy mirrored AI
                    // entry is dropped, so customer agent enable/advisor toggles do not silently reset.
                    if (Object.keys(nonAiDefaults).length > 0) {
                      nextAgentAiDefaults[legacyAgentType] = nonAiDefaults;
                    } else {
                      delete nextAgentAiDefaults[legacyAgentType];
                    }
                  } else {
                    delete nextAgentAiDefaults[legacyAgentType];
                  }
                }
              }

              for (const [agentType, entry] of Object.entries(normalizedDefaults)) {
                if (agentType === "plan" || agentType === "exec" || agentType === "compact")
                  continue;
                nextAgentAiDefaults[agentType] = entry;
              }

              const normalizedAgent = normalizeAgentAiDefaults(nextAgentAiDefaults);
              result.agentAiDefaults =
                Object.keys(normalizedAgent).length > 0 ? normalizedAgent : undefined;
            }

            return result;
          });

          // Re-evaluate task queue in case more slots opened up
          await context.taskService.maybeStartQueuedTasks();
        }),
      updateChatTranscriptFullWidth: t
        .input(schemas.config.updateChatTranscriptFullWidth.input)
        .output(schemas.config.updateChatTranscriptFullWidth.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            if (input.enabled) {
              config.chatTranscriptFullWidth = true;
            } else {
              delete config.chatTranscriptFullWidth;
            }
            return config;
          });
        }),
      updateLlmDebugLogs: t
        .input(schemas.config.updateLlmDebugLogs.input)
        .output(schemas.config.updateLlmDebugLogs.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            config.llmDebugLogs = input.enabled;
            return config;
          });
        }),
      updateHeartbeatDefaultPrompt: t
        .input(schemas.config.updateHeartbeatDefaultPrompt.input)
        .output(schemas.config.updateHeartbeatDefaultPrompt.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const trimmed = input.defaultPrompt?.trim();
            if (trimmed && trimmed.length > 0) {
              config.heartbeatDefaultPrompt = trimmed;
            } else {
              delete config.heartbeatDefaultPrompt;
            }
            return config;
          });
        }),
      updateHeartbeatDefaultIntervalMs: t
        .input(schemas.config.updateHeartbeatDefaultIntervalMs.input)
        .output(schemas.config.updateHeartbeatDefaultIntervalMs.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            if (input.intervalMs != null) {
              config.heartbeatDefaultIntervalMs = input.intervalMs;
            } else {
              delete config.heartbeatDefaultIntervalMs;
            }
            return config;
          });
        }),
      updateGoalDefaults: t
        .input(schemas.config.updateGoalDefaults.input)
        .output(schemas.config.updateGoalDefaults.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            config.goalDefaults = normalizeGoalDefaults(input.goalDefaults);
            return config;
          });
        }),
      unenrollMuxGovernor: t
        .input(schemas.config.unenrollMuxGovernor.input)
        .output(schemas.config.unenrollMuxGovernor.output)
        .handler(async ({ context }) => {
          await context.config.editConfig((config) => {
            const { muxGovernorUrl: _url, muxGovernorToken: _token, ...rest } = config;
            return rest;
          });

          await context.policyService.refreshNow();
        }),
    },
    devtools: {
      getRuns: t
        .input(schemas.devtools.getRuns.input)
        .output(schemas.devtools.getRuns.output)
        .handler(async ({ context, input }) => {
          return context.devToolsService.getRuns(input.workspaceId);
        }),
      getRunDetail: t
        .input(schemas.devtools.getRunDetail.input)
        .output(schemas.devtools.getRunDetail.output)
        .handler(async ({ context, input }) => {
          return context.devToolsService.getRunWithSteps(input.workspaceId, input.runId);
        }),
      clear: t
        .input(schemas.devtools.clear.input)
        .output(schemas.devtools.clear.output)
        .handler(async ({ context, input }) => {
          await context.devToolsService.clear(input.workspaceId);
          return { success: true };
        }),
      subscribe: t
        .input(schemas.devtools.subscribe.input)
        .output(schemas.devtools.subscribe.output)
        .handler(async function* ({ context, input, signal }) {
          const service = context.devToolsService;
          let resolveNext: ((value: DevToolsEvent | null) => void) | null = null;
          const queue: DevToolsEvent[] = [];
          let ended = false;

          const push = (event: DevToolsEvent) => {
            if (ended) {
              return;
            }

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(event);
              return;
            }

            queue.push(event);
          };

          const eventName = `update:${input.workspaceId}`;
          const onEvent = (event: DevToolsEvent) => {
            push(event);
          };

          service.on(eventName, onEvent);

          const onAbort = () => {
            if (ended) {
              return;
            }

            ended = true;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            const runs = await service.getRuns(input.workspaceId);
            yield { type: "snapshot", runs };

            while (!ended) {
              const queuedEvent = queue.shift();
              if (queuedEvent) {
                yield queuedEvent;
                continue;
              }

              const event = await new Promise<DevToolsEvent | null>((resolve) => {
                resolveNext = resolve;
              });

              if (event == null || ended) {
                break;
              }

              yield event;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            service.off(eventName, onEvent);
          }
        }),
    },
    browser: {
      listSessions: t
        .input(schemas.browser.listSessions.input)
        .output(schemas.browser.listSessions.output)
        .handler(async ({ context, input }) => {
          const sessionGroups = await context.browserSessionDiscoveryService.listSessionGroups(
            input.workspaceId
          );
          return {
            sessions: sessionGroups.sessions.map((session) => ({
              sessionName: session.sessionName,
              status: session.status,
            })),
            otherSessions: sessionGroups.otherSessions.map((session) => ({
              sessionName: session.sessionName,
              status: session.status,
              cwd: session.cwd,
            })),
          };
        }),
      listTabs: t
        .input(schemas.browser.listTabs.input)
        .output(schemas.browser.listTabs.output)
        .handler(async ({ context, input }) => {
          return await context.browserControlService.listTabs(input);
        }),
      getBootstrap: t
        .input(schemas.browser.getBootstrap.input)
        .output(schemas.browser.getBootstrap.output)
        .handler(async ({ context, input }) => {
          const serverInfo = context.serverService.getServerInfo();
          if (serverInfo == null) {
            throw new Error("Browser bridge bootstrap failed: API server unavailable");
          }

          const allowOtherWorkspaceSession = input.allowOtherWorkspaceSession === true;
          const connection = await context.browserSessionDiscoveryService.ensureSessionAttachable(
            input.workspaceId,
            input.sessionName,
            { allowOtherWorkspaceSession }
          );

          const token = context.browserBridgeTokenManager.mint(
            input.workspaceId,
            connection.sessionName,
            connection.streamPort,
            { allowOtherWorkspaceSession }
          );

          return {
            bridgePath: BROWSER_BRIDGE_WS_PATH,
            token,
            localBridgeBaseUrl: serverInfo.baseUrl,
          };
        }),
      control: t
        .input(schemas.browser.control.input)
        .output(schemas.browser.control.output)
        .handler(async ({ context, input }) => {
          return await runBrowserCommandWithLoadingState({
            context,
            workspaceId: input.workspaceId,
            sessionName: input.sessionName,
            run: () => context.browserControlService.executeControl(input),
          });
        }),
      selectTab: t
        .input(schemas.browser.selectTab.input)
        .output(schemas.browser.selectTab.output)
        .handler(async ({ context, input }) => {
          return await runBrowserCommandWithLoadingState({
            context,
            workspaceId: input.workspaceId,
            sessionName: input.sessionName,
            run: () => context.browserControlService.selectTab(input),
          });
        }),
      getUrl: t
        .input(schemas.browser.getUrl.input)
        .output(schemas.browser.getUrl.output)
        .handler(async ({ context, input }) => {
          return await context.browserControlService.getUrl(input.workspaceId, input.sessionName, {
            allowOtherWorkspaceSession: input.allowOtherWorkspaceSession === true,
          });
        }),
    },
    uiLayouts: {
      getAll: t
        .input(schemas.uiLayouts.getAll.input)
        .output(schemas.uiLayouts.getAll.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          return config.layoutPresets ?? DEFAULT_LAYOUT_PRESETS_CONFIG;
        }),
      saveAll: t
        .input(schemas.uiLayouts.saveAll.input)
        .output(schemas.uiLayouts.saveAll.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalized = normalizeLayoutPresetsConfig(input.layoutPresets);
            return {
              ...config,
              layoutPresets: isLayoutPresetsConfigEmpty(normalized) ? undefined : normalized,
            };
          });
        }),
    },
    agents: {
      list: t
        .input(schemas.agents.list.input)
        .output(schemas.agents.list.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }

          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);

          const descriptors = await discoverAgentDefinitions(runtime, discoveryPath);

          const cfg = context.config.loadConfigOrDefault();

          const resolved = await Promise.all(
            descriptors.map(async (descriptor) => {
              try {
                const resolvedFrontmatter = await resolveAgentFrontmatter(
                  runtime,
                  discoveryPath,
                  descriptor.id,
                  {
                    skipScopesAbove: getSkipScopesAboveForKnownScope(descriptor.scope),
                  }
                );

                const effectivelyDisabled = isAgentEffectivelyDisabled({
                  cfg,
                  agentId: descriptor.id,
                  resolvedFrontmatter,
                });

                // By default, disabled agents are omitted from discovery so they cannot be
                // selected or cycled in the UI.
                //
                // Settings passes includeDisabled: true so users can opt in/out locally.
                if (effectivelyDisabled && input.includeDisabled !== true) {
                  return null;
                }

                const { selectable: uiSelectableBase } = resolveAgentVisibility(
                  resolvedFrontmatter.ui
                );

                return {
                  kind: "resolved" as const,
                  descriptor,
                  resolvedFrontmatter,
                  uiSelectableBase,
                };
              } catch {
                return { kind: "fallback" as const, descriptor };
              }
            })
          );

          return resolved.flatMap((entry) => {
            if (!entry) {
              return [];
            }
            if (entry.kind === "fallback") {
              return [entry.descriptor];
            }

            return [
              {
                ...entry.descriptor,
                name: entry.resolvedFrontmatter.name,
                description: entry.resolvedFrontmatter.description,
                uiSelectable: entry.uiSelectableBase,
                uiColor: entry.resolvedFrontmatter.ui?.color,
                subagentRunnable: entry.resolvedFrontmatter.subagent?.runnable ?? false,
                base: entry.resolvedFrontmatter.base,
                aiDefaults: entry.resolvedFrontmatter.ai,
                tools: entry.resolvedFrontmatter.tools,
              },
            ];
          });
        }),
      get: t
        .input(schemas.agents.get.input)
        .output(schemas.agents.get.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          return readAgentDefinition(runtime, discoveryPath, input.agentId);
        }),
    },
    agentSkills: {
      list: t
        .input(schemas.agentSkills.list.input)
        .output(schemas.agentSkills.list.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before agent discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          return discoverAgentSkills(runtime, discoveryPath, {
            // claude-skills-compat experiment: surface read-only .claude skills in the UI listing.
            includeClaudeSkills: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
            ),
          });
        }),
      listDiagnostics: t
        .input(schemas.agentSkills.listDiagnostics.input)
        .output(schemas.agentSkills.listDiagnostics.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before agent discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          const diagnostics = await discoverAgentSkillsDiagnostics(runtime, discoveryPath, {
            includeClaudeSkills: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
            ),
          });
          return diagnostics;
        }),
      get: t
        .input(schemas.agentSkills.get.input)
        .output(schemas.agentSkills.get.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before agent discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          const result = await readAgentSkill(runtime, discoveryPath, input.skillName, {
            includeClaudeSkills: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
            ),
          });
          return result.package;
        }),
    },
    workflows: {
      listRuns: t
        .input(schemas.workflows.listRuns.input)
        .output(schemas.workflows.listRuns.output)
        .handler(async ({ context, input }) => {
          const { service, projectTrusted } = await resolveWorkflowContext(
            context,
            input.workspaceId
          );
          await service.resumeCrashedRuns({ workspaceId: input.workspaceId, projectTrusted });
          return service.listRuns({ workspaceId: input.workspaceId });
        }),
      getRun: t
        .input(schemas.workflows.getRun.input)
        .output(schemas.workflows.getRun.output)
        .handler(async ({ context, input }) => {
          const { service } = await resolveWorkflowContext(context, input.workspaceId);
          return service.getRun({ workspaceId: input.workspaceId, runId: input.runId });
        }),
      interrupt: t
        .input(schemas.workflows.interrupt.input)
        .output(schemas.workflows.interrupt.output)
        .handler(async ({ context, input }) => {
          const { service } = await resolveWorkflowContext(context, input.workspaceId);
          return service.interruptRun({ workspaceId: input.workspaceId, runId: input.runId });
        }),
      resume: t
        .input(schemas.workflows.resume.input)
        .output(schemas.workflows.resume.output)
        .handler(async ({ context, input }) => {
          const { service, projectTrusted } = await resolveWorkflowContext(
            context,
            input.workspaceId
          );
          return service.resumeRunInBackground({
            workspaceId: input.workspaceId,
            runId: input.runId,
            projectTrusted,
          });
        }),
      // Retry actions arrive from a fresh oRPC request, so rebuild the terminal continuation
      // callback here instead of relying on the original WorkflowService instance still existing.
      retryFromCheckpoint: t
        .input(schemas.workflows.retryFromCheckpoint.input)
        .output(schemas.workflows.retryFromCheckpoint.output)
        .handler(async ({ context, input }) => {
          const { service, projectTrusted } = await resolveWorkflowContext(
            context,
            input.workspaceId,
            {
              onBackgroundRunTerminal: (event) =>
                sendWorkflowRunTerminalContinuation({
                  context,
                  workspaceId: input.workspaceId,
                  rawCommand: `workflow_run ${event.run.workflow.sourcePath ?? event.run.workflow.name}`,
                  name: event.run.workflow.sourcePath ?? event.run.workflow.name,
                  event,
                }),
            }
          );
          return service.retryRunFromCheckpointInBackground({
            workspaceId: input.workspaceId,
            runId: input.runId,
            projectTrusted,
          });
        }),
      start: t
        .input(schemas.workflows.start.input)
        .output(schemas.workflows.start.output)
        .handler(async ({ context, input, signal }) => {
          assertDynamicWorkflowsEnabled(context);
          let invocationMessagePersisted: boolean | undefined;
          let resolveInvocationPersistence: (persisted: boolean) => void = () => undefined;
          const invocationPersistence = new Promise<boolean>((resolve) => {
            resolveInvocationPersistence = resolve;
          });
          const rawCommandForContinuation = input.rawCommand;
          const continuationOptions = input.continuationOptions;
          const onBackgroundRunTerminal =
            rawCommandForContinuation != null && continuationOptions != null
              ? async (event: WorkflowBackgroundRunTerminalEvent) => {
                  const persistedInvocation =
                    invocationMessagePersisted === true ? true : await invocationPersistence;
                  if (persistedInvocation !== true) {
                    log.warn("Skipping slash workflow continuation without persisted invocation", {
                      workspaceId: input.workspaceId,
                      runId: event.runId,
                    });
                    return;
                  }
                  await sendWorkflowRunTerminalContinuation({
                    context,
                    workspaceId: input.workspaceId,
                    rawCommand: rawCommandForContinuation,
                    name: input.scriptPath,
                    event,
                    continuationOptions,
                  });
                }
              : undefined;
          if (input.rawCommand != null) {
            // Slash workflow commands are user follow-ups, just like normal composer sends.
            // Wait for the active chat turn (including compaction follow-ups and queued messages)
            // to finish before starting the workflow or appending its invocation to history.
            await context.workspaceService.waitForWorkspaceIdle(input.workspaceId, {
              signal,
              manualFollowUp: true,
            });
          }
          const { service, workflowExecutionProjectPath, projectTrusted, runtime, workspacePath } =
            await resolveWorkflowContext(context, input.workspaceId, { onBackgroundRunTerminal });
          const script = await resolveWorkflowScript({
            scriptPath: input.scriptPath,
            runtime,
            workspacePath,
            projectTrusted,
          });
          if (input.rawCommand != null) {
            await context.workspaceService.prepareManualWorkflowInvocation(input.workspaceId);
          }
          // Slash workflow commands run from the active project/sub-project; expose that
          // server-resolved context as schema defaults without adding hidden fields to
          // persisted command args.
          const workflowStartArgs = {
            script,
            workspaceId: input.workspaceId,
            projectTrusted,
            // Default to {} only when args is omitted; an explicit `null` is passed
            // through verbatim (not coerced via `?? {}`) so argsSchema normalization
            // validates it instead of silently treating it as "no args".
            args: input.args === undefined ? {} : input.args,
            ...(input.rawCommand != null
              ? { defaultArgs: { projectPath: workflowExecutionProjectPath } }
              : {}),
          };
          const persistInvocation = async (details: {
            runId: string;
            status: string;
            result: unknown;
            run?: NonNullable<Awaited<ReturnType<typeof service.getRun>>>;
          }) => {
            assert(input.rawCommand != null, "Workflow invocation persistence requires rawCommand");
            try {
              invocationMessagePersisted =
                await context.workspaceService.appendWorkflowRunInvocation({
                  workspaceId: input.workspaceId,
                  rawCommand: input.rawCommand,
                  scriptPath: input.scriptPath,
                  args: workflowStartArgs.args,
                  runId: details.runId,
                  status: details.status,
                  result: details.result,
                  ...(details.run != null ? { run: details.run } : {}),
                });
            } finally {
              resolveInvocationPersistence(invocationMessagePersisted === true);
            }
          };
          let result: Awaited<ReturnType<typeof service.startWorkflow>>;
          try {
            result =
              input.runInBackground === true
                ? await service.startWorkflowInBackground({
                    ...workflowStartArgs,
                    ...(input.rawCommand != null
                      ? { onBackgroundRunCreated: persistInvocation }
                      : {}),
                  })
                : await service.startWorkflow({ ...workflowStartArgs, abortSignal: signal });
          } catch (error) {
            throwWorkflowStartOrpcError(error);
          }
          if (input.rawCommand == null) {
            return result;
          }
          if (input.runInBackground !== true) {
            const run = await service.getRun({
              workspaceId: input.workspaceId,
              runId: result.runId,
            });
            await persistInvocation({
              runId: result.runId,
              status: result.status,
              result: result.result,
              ...(run != null ? { run } : {}),
            });
          }
          return { ...result, invocationMessagePersisted };
        }),
      // Live run stream for the Workflows tab. Mirrors devtools.subscribe (queue +
      // resolve-next async generator). The event source is the module-level
      // workflowRunStreamHub, fed by WorkflowRunStore on every durable write, so
      // updates surface regardless of which flow is executing the run.
      subscribe: t
        .input(schemas.workflows.subscribe.input)
        .output(schemas.workflows.subscribe.output)
        .handler(async function* ({ context, input, signal }) {
          assertDynamicWorkflowsEnabled(context);
          let resolveNext: ((value: WorkflowRunStreamEvent | null) => void) | null = null;
          const queue: WorkflowRunStreamEvent[] = [];
          let ended = false;

          const push = (event: WorkflowRunStreamEvent) => {
            if (ended) {
              return;
            }
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(event);
              return;
            }
            queue.push(event);
          };

          // Register before snapshotting so writes between the two are queued, not dropped.
          // Only top-level runs are surfaced (mirrors listRuns); nested child runs are an
          // implementation detail of their parent.
          const unsubscribe = workflowRunStreamHub.subscribe(input.workspaceId, (run) => {
            if (run.parentWorkflow != null) {
              return;
            }
            push({ type: "run-changed", run });
          });

          const onAbort = () => {
            if (ended) {
              return;
            }
            ended = true;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            const { service, projectTrusted } = await resolveWorkflowContext(
              context,
              input.workspaceId
            );
            await service.resumeCrashedRuns({ workspaceId: input.workspaceId, projectTrusted });
            const runs = await service.listRuns({ workspaceId: input.workspaceId });
            yield { type: "snapshot", runs };

            while (!ended) {
              const queuedEvent = queue.shift();
              if (queuedEvent) {
                yield queuedEvent;
                continue;
              }

              const event = await new Promise<WorkflowRunStreamEvent | null>((resolve) => {
                resolveNext = resolve;
              });

              if (event == null || ended) {
                break;
              }

              yield event;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      listScripts: t
        .input(schemas.workflows.listScripts.input)
        .output(schemas.workflows.listScripts.output)
        .handler(async ({ context, input }) => {
          const { runtime, workspacePath, projectTrusted } = await resolveWorkflowContext(
            context,
            input.workspaceId
          );
          return discoverWorkflowScripts({ runtime, workspacePath, projectTrusted });
        }),
    },
    providers: {
      list: t
        .input(schemas.providers.list.input)
        .output(schemas.providers.list.output)
        .handler(({ context }) => context.providerService.list()),
      getConfig: t
        .input(schemas.providers.getConfig.input)
        .output(schemas.providers.getConfig.output)
        .handler(({ context }) => context.providerService.getConfig()),
      addCustomOpenAICompatibleProvider: t
        .input(schemas.providers.addCustomOpenAICompatibleProvider.input)
        .output(schemas.providers.addCustomOpenAICompatibleProvider.output)
        .handler(({ context, input }) =>
          context.providerService.addCustomOpenAICompatibleProvider(input)
        ),
      removeCustomProvider: t
        .input(schemas.providers.removeCustomProvider.input)
        .output(schemas.providers.removeCustomProvider.output)
        .handler(({ context, input }) =>
          context.providerService.removeCustomProvider(input.provider)
        ),
      setProviderConfig: t
        .input(schemas.providers.setProviderConfig.input)
        .output(schemas.providers.setProviderConfig.output)
        .handler(async ({ context, input }) => {
          const result = await context.providerService.setConfig(
            input.provider,
            input.keyPath,
            input.value
          );
          return result;
        }),
      setModels: t
        .input(schemas.providers.setModels.input)
        .output(schemas.providers.setModels.output)
        .handler(({ context, input }) =>
          context.providerService.setModels(input.provider, input.models)
        ),
      onConfigChanged: t
        .input(schemas.providers.onConfigChanged.input)
        .output(schemas.providers.onConfigChanged.output)
        .handler(async function* ({ context, signal }) {
          let resolveNext: (() => void) | null = null;
          let pendingNotification = false;
          let ended = false;

          const push = () => {
            if (ended) return;
            if (resolveNext) {
              // Listener is waiting - wake it up
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              // No listener waiting yet - queue the notification
              pendingNotification = true;
            }
          };

          const unsubscribe = context.providerService.onConfigChanged(push);

          // Consumers often cancel this subscription while there are no pending provider changes.
          // If we block on a never-resolving Promise, AbortSignal cancellation can't unwind the
          // generator, and we leak EventEmitter listeners across tests.
          const onAbort = () => {
            if (ended) return;
            ended = true;
            // Wake up the iterator if it's currently waiting.
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            while (!ended) {
              // If notification arrived before we started waiting, yield immediately
              if (pendingNotification) {
                pendingNotification = false;
                if (ended) break;
                yield undefined;
                continue;
              }

              // Wait for next notification (or abort)
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });

              if (ended) break;
              yield undefined;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
    },
    policy: {
      get: t
        .input(schemas.policy.get.input)
        .output(schemas.policy.get.output)
        .handler(({ context }) => context.policyService.getPolicyGetResponse()),
      onChanged: t
        .input(schemas.policy.onChanged.input)
        .output(schemas.policy.onChanged.output)
        .handler(async function* ({ context, signal }) {
          let resolveNext: (() => void) | null = null;
          let pendingNotification = false;
          let ended = false;

          const push = () => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          const unsubscribe = context.policyService.onPolicyChanged(push);

          const onAbort = () => {
            if (ended) return;
            ended = true;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            while (!ended) {
              if (pendingNotification) {
                pendingNotification = false;
                if (ended) break;
                yield undefined;
                continue;
              }

              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });

              if (ended) break;
              yield undefined;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      refreshNow: t
        .input(schemas.policy.refreshNow.input)
        .output(schemas.policy.refreshNow.output)
        .handler(async ({ context }) => {
          const result = await context.policyService.refreshNow();
          if (!result.success) {
            return Err(result.error);
          }
          return Ok(context.policyService.getPolicyGetResponse());
        }),
    },
    muxGateway: {
      getAccountStatus: t
        .input(schemas.muxGateway.getAccountStatus.input)
        .output(schemas.muxGateway.getAccountStatus.output)
        .handler(async ({ context }) => {
          const providersConfig = context.config.loadProvidersConfig() ?? {};
          const muxConfig = (providersConfig["mux-gateway"] ?? {}) as Record<string, unknown>;
          const creds = resolveProviderCredentials("mux-gateway", {
            couponCode: typeof muxConfig.couponCode === "string" ? muxConfig.couponCode : undefined,
            voucher: typeof muxConfig.voucher === "string" ? muxConfig.voucher : undefined,
          });

          if (!creds.isConfigured || !creds.couponCode) {
            return Err("Mux Gateway is not logged in");
          }

          let response: Awaited<ReturnType<typeof fetch>>;
          try {
            response = await fetch(`${MUX_GATEWAY_ORIGIN}/api/v1/balance`, {
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${creds.couponCode}`,
              },
            });
          } catch (error) {
            const message = getErrorMessage(error);
            return Err(`Mux Gateway balance request failed: ${message}`);
          }

          if (response.status === 401) {
            try {
              // Best-effort auto-logout: clear local mux-gateway creds on session expiry.
              await context.providerService.setConfig("mux-gateway", ["couponCode"], "");
              await context.providerService.setConfig("mux-gateway", ["voucher"], "");
            } catch {
              // Ignore failures clearing local credentials
            }

            return Err(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE);
          }

          if (!response.ok) {
            let body = "";
            try {
              body = await response.text();
            } catch {
              // Ignore errors reading response body
            }
            const prefix = body.trim().slice(0, 200);
            return Err(
              `Mux Gateway balance request failed (HTTP ${response.status}): ${
                prefix || response.statusText
              }`
            );
          }

          let json: unknown;
          try {
            json = await response.json();
          } catch (error) {
            const message = getErrorMessage(error);
            return Err(`Mux Gateway balance response was not valid JSON: ${message}`);
          }

          const payload = json as {
            remaining_microdollars?: unknown;
            ai_gateway_concurrent_requests_per_user?: unknown;
          };

          const remaining = payload.remaining_microdollars;
          const concurrency = payload.ai_gateway_concurrent_requests_per_user;

          if (
            typeof remaining !== "number" ||
            !Number.isFinite(remaining) ||
            !Number.isInteger(remaining) ||
            remaining < 0 ||
            typeof concurrency !== "number" ||
            !Number.isFinite(concurrency) ||
            !Number.isInteger(concurrency) ||
            concurrency < 0
          ) {
            return Err("Mux Gateway returned an invalid balance payload");
          }

          return Ok({
            remaining_microdollars: remaining,
            ai_gateway_concurrent_requests_per_user: concurrency,
          });
        }),
    },

    muxGatewayOauth: {
      startDesktopFlow: t
        .input(schemas.muxGatewayOauth.startDesktopFlow.input)
        .output(schemas.muxGatewayOauth.startDesktopFlow.output)
        .handler(({ context }) => {
          return context.muxGatewayOauthService.startDesktopFlow();
        }),
      waitForDesktopFlow: t
        .input(schemas.muxGatewayOauth.waitForDesktopFlow.input)
        .output(schemas.muxGatewayOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.muxGatewayOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.muxGatewayOauth.cancelDesktopFlow.input)
        .output(schemas.muxGatewayOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.muxGatewayOauthService.cancelDesktopFlow(input.flowId);
        }),
    },
    copilotOauth: {
      startDeviceFlow: t
        .input(schemas.copilotOauth.startDeviceFlow.input)
        .output(schemas.copilotOauth.startDeviceFlow.output)
        .handler(({ context }) => {
          return context.copilotOauthService.startDeviceFlow();
        }),
      waitForDeviceFlow: t
        .input(schemas.copilotOauth.waitForDeviceFlow.input)
        .output(schemas.copilotOauth.waitForDeviceFlow.output)
        .handler(({ context, input }) => {
          return context.copilotOauthService.waitForDeviceFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDeviceFlow: t
        .input(schemas.copilotOauth.cancelDeviceFlow.input)
        .output(schemas.copilotOauth.cancelDeviceFlow.output)
        .handler(({ context, input }) => {
          context.copilotOauthService.cancelDeviceFlow(input.flowId);
        }),
    },
    muxGovernorOauth: {
      startDesktopFlow: t
        .input(schemas.muxGovernorOauth.startDesktopFlow.input)
        .output(schemas.muxGovernorOauth.startDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.muxGovernorOauthService.startDesktopFlow({
            governorOrigin: input.governorOrigin,
          });
        }),
      waitForDesktopFlow: t
        .input(schemas.muxGovernorOauth.waitForDesktopFlow.input)
        .output(schemas.muxGovernorOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.muxGovernorOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.muxGovernorOauth.cancelDesktopFlow.input)
        .output(schemas.muxGovernorOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.muxGovernorOauthService.cancelDesktopFlow(input.flowId);
        }),
    },
    codexOauth: {
      startDesktopFlow: t
        .input(schemas.codexOauth.startDesktopFlow.input)
        .output(schemas.codexOauth.startDesktopFlow.output)
        .handler(({ context }) => {
          return context.codexOauthService.startDesktopFlow();
        }),
      waitForDesktopFlow: t
        .input(schemas.codexOauth.waitForDesktopFlow.input)
        .output(schemas.codexOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.codexOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.codexOauth.cancelDesktopFlow.input)
        .output(schemas.codexOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.codexOauthService.cancelDesktopFlow(input.flowId);
        }),
      startDeviceFlow: t
        .input(schemas.codexOauth.startDeviceFlow.input)
        .output(schemas.codexOauth.startDeviceFlow.output)
        .handler(({ context }) => {
          return context.codexOauthService.startDeviceFlow();
        }),
      waitForDeviceFlow: t
        .input(schemas.codexOauth.waitForDeviceFlow.input)
        .output(schemas.codexOauth.waitForDeviceFlow.output)
        .handler(({ context, input }) => {
          return context.codexOauthService.waitForDeviceFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDeviceFlow: t
        .input(schemas.codexOauth.cancelDeviceFlow.input)
        .output(schemas.codexOauth.cancelDeviceFlow.output)
        .handler(async ({ context, input }) => {
          await context.codexOauthService.cancelDeviceFlow(input.flowId);
        }),
      disconnect: t
        .input(schemas.codexOauth.disconnect.input)
        .output(schemas.codexOauth.disconnect.output)
        .handler(({ context }) => {
          return context.codexOauthService.disconnect();
        }),
    },
    general: {
      listDirectory: t
        .input(schemas.general.listDirectory.input)
        .output(schemas.general.listDirectory.output)
        .handler(async ({ context, input }) => {
          return context.projectService.listDirectory(input.path);
        }),
      createDirectory: t
        .input(schemas.general.createDirectory.input)
        .output(schemas.general.createDirectory.output)
        .handler(async ({ context, input }) => {
          return context.projectService.createDirectory(input.path);
        }),
      ping: t
        .input(schemas.general.ping.input)
        .output(schemas.general.ping.output)
        .handler(({ input }) => {
          return `Pong: ${input}`;
        }),
      tick: t
        .input(schemas.general.tick.input)
        .output(schemas.general.tick.output)
        .handler(async function* ({ input }) {
          for (let i = 1; i <= input.count; i++) {
            yield { tick: i, timestamp: Date.now() };
            if (i < input.count) {
              await new Promise((r) => setTimeout(r, input.intervalMs));
            }
          }
        }),
      getLogPath: t
        .input(schemas.general.getLogPath.input)
        .output(schemas.general.getLogPath.output)
        .handler(() => {
          return { path: getLogFilePath() };
        }),
      clearLogs: t
        .input(schemas.general.clearLogs.input)
        .output(schemas.general.clearLogs.output)
        .handler(async () => {
          try {
            await clearLogFiles();
            clearLogEntries();
            return { success: true };
          } catch (err) {
            const message = getErrorMessage(err);
            return { success: false, error: message };
          }
        }),
      subscribeLogs: t
        .input(schemas.general.subscribeLogs.input)
        .output(schemas.general.subscribeLogs.output)
        .handler(async function* ({ input, signal }) {
          const LOG_LEVEL_PRIORITY: Record<LogEntry["level"], number> = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3,
          };

          function shouldInclude(
            entryLevel: LogEntry["level"],
            minLevel: LogEntry["level"]
          ): boolean {
            return (
              (LOG_LEVEL_PRIORITY[entryLevel] ?? LOG_LEVEL_PRIORITY.debug) <=
              (LOG_LEVEL_PRIORITY[minLevel] ?? LOG_LEVEL_PRIORITY.info)
            );
          }

          const minLevel = input.level ?? "info";

          const queue = createAsyncMessageQueue<
            | { type: "snapshot"; epoch: number; entries: LogEntry[] }
            | { type: "append"; epoch: number; entries: LogEntry[] }
            | { type: "reset"; epoch: number }
          >();

          // Atomic handshake: register listener + snapshot in one step.
          // No events can be lost between snapshot and subscription.
          const { snapshot, unsubscribe } = subscribeLogFeed((event) => {
            if (signal?.aborted) {
              return;
            }

            if (event.type === "append") {
              if (shouldInclude(event.entry.level, minLevel)) {
                queue.push({ type: "append", epoch: event.epoch, entries: [event.entry] });
              }
              return;
            }

            queue.push({ type: "reset", epoch: event.epoch });
          }, minLevel);

          queue.push({
            type: "snapshot",
            epoch: snapshot.epoch,
            entries: snapshot.entries.filter((e) => shouldInclude(e.level, minLevel)),
          });

          const onAbort = () => {
            queue.end();
          };
          signal?.addEventListener("abort", onAbort);

          try {
            yield* queue.iterate();
          } finally {
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
            queue.end();
          }
        }),
      restartApp: t
        .input(schemas.general.restartApp.input)
        .output(schemas.general.restartApp.output)
        .handler(({ context }) => {
          return context.windowService.restartApp();
        }),
      openInEditor: t
        .input(schemas.general.openInEditor.input)
        .output(schemas.general.openInEditor.output)
        .handler(async ({ context, input }) => {
          return context.editorService.openInEditor(
            input.workspaceId,
            input.targetPath,
            input.editorConfig
          );
        }),
    },
    secrets: {
      get: t
        .input(schemas.secrets.get.input)
        .output(schemas.secrets.get.output)
        .handler(({ context, input }) => {
          const projectPath =
            typeof input.projectPath === "string" && input.projectPath.trim().length > 0
              ? input.projectPath
              : undefined;

          return projectPath
            ? context.config.getProjectSecrets(projectPath)
            : context.config.getGlobalSecrets();
        }),
      getInjectedGlobals: t
        .input(schemas.secrets.getInjectedGlobals.input)
        .output(schemas.secrets.getInjectedGlobals.output)
        .handler(({ context, input }) => {
          const projectPath =
            typeof input.projectPath === "string" && input.projectPath.trim().length > 0
              ? input.projectPath
              : undefined;

          if (!projectPath) {
            return [];
          }

          return context.config.getInjectedGlobalSecrets(projectPath).map((secret) => secret.key);
        }),
      update: t
        .input(schemas.secrets.update.input)
        .output(schemas.secrets.update.output)
        .handler(async ({ context, input }) => {
          const projectPath =
            typeof input.projectPath === "string" && input.projectPath.trim().length > 0
              ? input.projectPath
              : undefined;

          try {
            if (projectPath) {
              await context.config.updateProjectSecrets(projectPath, input.secrets);
            } else {
              await context.config.updateGlobalSecrets(input.secrets);
            }

            return Ok(undefined);
          } catch (error) {
            const message = getErrorMessage(error);
            return Err(message);
          }
        }),
    },
    mcp: {
      list: t
        .input(schemas.mcp.list.input)
        .output(schemas.mcp.list.output)
        .handler(async ({ context, input }) => {
          const servers = await context.mcpConfigService.listServers(
            input.projectPath,
            isTrustedProjectPath(context, input.projectPath)
          );

          if (!context.policyService.isEnforced()) {
            return servers;
          }

          const filtered: typeof servers = {};
          for (const [name, info] of Object.entries(servers)) {
            if (context.policyService.isMcpTransportAllowed(info.transport)) {
              filtered[name] = info;
            }
          }

          return filtered;
        }),
      add: t
        .input(schemas.mcp.add.input)
        .output(schemas.mcp.add.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const existingServer = existing[input.name];

          const transport = input.transport ?? "stdio";
          if (context.policyService.isEnforced()) {
            if (!context.policyService.isMcpTransportAllowed(transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const hasHeaders = Boolean(input.headers && Object.keys(input.headers).length > 0);
          const usesSecretHeaders = Boolean(
            input.headers &&
            Object.values(input.headers).some(
              (v) => typeof v === "object" && v !== null && "secret" in v
            )
          );

          const action = (() => {
            if (!existingServer) {
              return "add";
            }

            if (
              existingServer.transport !== "stdio" &&
              transport !== "stdio" &&
              existingServer.transport === transport &&
              existingServer.url === input.url &&
              JSON.stringify(existingServer.headers ?? {}) !== JSON.stringify(input.headers ?? {})
            ) {
              return "set_headers";
            }

            return "edit";
          })();

          const result = await context.mcpConfigService.addServer(input.name, {
            transport,
            command: input.command,
            url: input.url,
            headers: input.headers,
          });

          if (result.success) {
            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action,
                transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
              },
            });
          }

          return result;
        }),
      remove: t
        .input(schemas.mcp.remove.input)
        .output(schemas.mcp.remove.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const server = existing[input.name];

          if (context.policyService.isEnforced() && server) {
            if (!context.policyService.isMcpTransportAllowed(server.transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpConfigService.removeServer(input.name);

          if (result.success && server) {
            const hasHeaders =
              server.transport !== "stdio" &&
              Boolean(server.headers && Object.keys(server.headers).length > 0);
            const usesSecretHeaders =
              server.transport !== "stdio" &&
              Boolean(
                server.headers &&
                Object.values(server.headers).some(
                  (v) => typeof v === "object" && v !== null && "secret" in v
                )
              );

            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action: "remove",
                transport: server.transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
              },
            });
          }

          return result;
        }),
      test: t
        .input(schemas.mcp.test.input)
        .output(schemas.mcp.test.output)
        .handler(async ({ context, input }) => {
          const start = Date.now();

          const projectPathProvided =
            typeof input.projectPath === "string" && input.projectPath.trim().length > 0;
          const resolvedProjectPath = projectPathProvided
            ? input.projectPath!
            : context.config.rootDir;
          const trusted = projectPathProvided
            ? isTrustedProjectPath(context, resolvedProjectPath)
            : false;
          const opResolver = context.onePasswordService?.resolve.bind(context.onePasswordService);

          const secrets = await secretsToRecord(
            projectPathProvided
              ? context.config.getEffectiveSecrets(resolvedProjectPath)
              : context.config.getGlobalSecrets(),
            opResolver
          );

          const configuredTransport = input.name
            ? (
                await context.mcpConfigService.listServers(
                  projectPathProvided ? resolvedProjectPath : undefined,
                  trusted
                )
              )[input.name]?.transport
            : undefined;

          const transport =
            configuredTransport ?? (input.command ? "stdio" : (input.transport ?? "auto"));

          if (context.policyService.isEnforced()) {
            if (!context.policyService.isMcpTransportAllowed(transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpServerManager.test({
            projectPath: resolvedProjectPath,
            trusted,
            name: input.name,
            command: input.command,
            transport: input.transport,
            url: input.url,
            headers: input.headers,
            projectSecrets: secrets,
          });

          const durationMs = Date.now() - start;

          const categorizeError = (
            error: string
          ): "timeout" | "connect" | "http_status" | "unknown" => {
            const lower = error.toLowerCase();
            if (lower.includes("timed out")) {
              return "timeout";
            }
            if (
              lower.includes("econnrefused") ||
              lower.includes("econnreset") ||
              lower.includes("enotfound") ||
              lower.includes("ehostunreach")
            ) {
              return "connect";
            }
            if (/\b(400|401|403|404|405|500|502|503)\b/.test(lower)) {
              return "http_status";
            }
            return "unknown";
          };

          context.telemetryService.capture({
            event: "mcp_server_tested",
            properties: {
              transport,
              success: result.success,
              duration_ms_b2: roundToBase2(durationMs),
              ...(result.success ? {} : { error_category: categorizeError(result.error) }),
            },
          });

          return result;
        }),
      setEnabled: t
        .input(schemas.mcp.setEnabled.input)
        .output(schemas.mcp.setEnabled.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const server = existing[input.name];

          if (context.policyService.isEnforced() && server) {
            if (!context.policyService.isMcpTransportAllowed(server.transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpConfigService.setServerEnabled(input.name, input.enabled);

          if (result.success && server) {
            const hasHeaders =
              server.transport !== "stdio" &&
              Boolean(server.headers && Object.keys(server.headers).length > 0);
            const usesSecretHeaders =
              server.transport !== "stdio" &&
              Boolean(
                server.headers &&
                Object.values(server.headers).some(
                  (v) => typeof v === "object" && v !== null && "secret" in v
                )
              );

            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action: input.enabled ? "enable" : "disable",
                transport: server.transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
              },
            });
          }

          return result;
        }),
      setToolAllowlist: t
        .input(schemas.mcp.setToolAllowlist.input)
        .output(schemas.mcp.setToolAllowlist.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const server = existing[input.name];

          if (context.policyService.isEnforced() && server) {
            if (!context.policyService.isMcpTransportAllowed(server.transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpConfigService.setToolAllowlist(
            input.name,
            input.toolAllowlist
          );

          if (result.success && server) {
            const hasHeaders =
              server.transport !== "stdio" &&
              Boolean(server.headers && Object.keys(server.headers).length > 0);
            const usesSecretHeaders =
              server.transport !== "stdio" &&
              Boolean(
                server.headers &&
                Object.values(server.headers).some(
                  (v) => typeof v === "object" && v !== null && "secret" in v
                )
              );

            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action: "set_tool_allowlist",
                transport: server.transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
                tool_allowlist_size_b2: roundToBase2(input.toolAllowlist.length),
              },
            });
          }

          return result;
        }),
    },
    mcpOauth: {
      startDesktopFlow: t
        .input(schemas.mcpOauth.startDesktopFlow.input)
        .output(schemas.mcpOauth.startDesktopFlow.output)
        .handler(async ({ context, input }) => {
          // Global MCP settings can start OAuth without selecting a project.
          // Use mux home as a stable fallback so existing flow codepaths remain unchanged.
          const projectPath = input.projectPath ?? context.config.rootDir;

          return context.mcpOauthService.startDesktopFlow({ ...input, projectPath });
        }),
      waitForDesktopFlow: t
        .input(schemas.mcpOauth.waitForDesktopFlow.input)
        .output(schemas.mcpOauth.waitForDesktopFlow.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.mcpOauth.cancelDesktopFlow.input)
        .output(schemas.mcpOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.mcpOauthService.cancelDesktopFlow(input.flowId);
        }),
      startServerFlow: t
        .input(schemas.mcpOauth.startServerFlow.input)
        .output(schemas.mcpOauth.startServerFlow.output)
        .handler(async ({ context, input }) => {
          // Global MCP settings can start OAuth without selecting a project.
          // Use mux home as a stable fallback so existing flow codepaths remain unchanged.
          const projectPath = input.projectPath ?? context.config.rootDir;

          const headers = context.headers;

          const origin = typeof headers?.origin === "string" ? headers.origin.trim() : "";
          if (origin) {
            try {
              const redirectUri = new URL("/auth/mcp-oauth/callback", origin).toString();
              return context.mcpOauthService.startServerFlow({
                ...input,
                projectPath,
                redirectUri,
              });
            } catch {
              // Fall back to Host header.
            }
          }

          const hostHeader = headers?.["x-forwarded-host"] ?? headers?.host;
          const host = typeof hostHeader === "string" ? hostHeader.split(",")[0]?.trim() : "";
          if (!host) {
            return Err("Missing Host header");
          }

          const protoHeader = headers?.["x-forwarded-proto"];
          const forwardedProto =
            typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : "";
          const proto = forwardedProto.length ? forwardedProto : "http";

          const redirectUri = `${proto}://${host}/auth/mcp-oauth/callback`;

          return context.mcpOauthService.startServerFlow({
            ...input,
            projectPath,
            redirectUri,
          });
        }),
      waitForServerFlow: t
        .input(schemas.mcpOauth.waitForServerFlow.input)
        .output(schemas.mcpOauth.waitForServerFlow.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.waitForServerFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelServerFlow: t
        .input(schemas.mcpOauth.cancelServerFlow.input)
        .output(schemas.mcpOauth.cancelServerFlow.output)
        .handler(async ({ context, input }) => {
          await context.mcpOauthService.cancelServerFlow(input.flowId);
        }),
      getAuthStatus: t
        .input(schemas.mcpOauth.getAuthStatus.input)
        .output(schemas.mcpOauth.getAuthStatus.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.getAuthStatus({ serverUrl: input.serverUrl });
        }),
      logout: t
        .input(schemas.mcpOauth.logout.input)
        .output(schemas.mcpOauth.logout.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.logout({ serverUrl: input.serverUrl });
        }),
    },
    projects: {
      list: t
        .input(schemas.projects.list.input)
        .output(schemas.projects.list.output)
        .handler(({ context }) => {
          return context.projectService.list();
        }),
      create: t
        .input(schemas.projects.create.input)
        .output(schemas.projects.create.output)
        .handler(async ({ context, input }) => {
          return context.projectService.create(input.projectPath);
        }),
      getDefaultProjectDir: t
        .input(schemas.projects.getDefaultProjectDir.input)
        .output(schemas.projects.getDefaultProjectDir.output)
        .handler(({ context }) => {
          return context.projectService.getDefaultProjectDir();
        }),
      setDefaultProjectDir: t
        .input(schemas.projects.setDefaultProjectDir.input)
        .output(schemas.projects.setDefaultProjectDir.output)
        .handler(async ({ context, input }) => {
          await context.projectService.setDefaultProjectDir(input.path);
        }),
      clone: t
        .input(schemas.projects.clone.input)
        .output(schemas.projects.clone.output)
        .handler(async function* ({ context, input, signal }) {
          yield* context.projectService.cloneWithProgress(input, signal);
        }),
      pickDirectory: t
        .input(schemas.projects.pickDirectory.input)
        .output(schemas.projects.pickDirectory.output)
        .handler(async ({ context, input }) => {
          return context.projectService.pickDirectory(input?.initialPath ?? null);
        }),
      getFileCompletions: t
        .input(schemas.projects.getFileCompletions.input)
        .output(schemas.projects.getFileCompletions.output)
        .handler(async ({ context, input }) => {
          return context.projectService.getFileCompletions(
            input.projectPath,
            input.query,
            input.limit
          );
        }),
      runtimeAvailability: t
        .input(schemas.projects.runtimeAvailability.input)
        .output(schemas.projects.runtimeAvailability.output)
        .handler(async ({ input }) => {
          return checkRuntimeAvailability(input.projectPath);
        }),
      listBranches: t
        .input(schemas.projects.listBranches.input)
        .output(schemas.projects.listBranches.output)
        .handler(async ({ context, input }) => {
          return context.projectService.listBranches(input.projectPath);
        }),
      gitInit: t
        .input(schemas.projects.gitInit.input)
        .output(schemas.projects.gitInit.output)
        .handler(async ({ context, input }) => {
          return context.projectService.gitInit(input.projectPath);
        }),
      setTrust: t
        .input(schemas.projects.setTrust.input)
        .output(schemas.projects.setTrust.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalizedPath = stripTrailingSlashes(input.projectPath);
            let project = config.projects.get(normalizedPath);
            if (!project) {
              // Create a minimal project entry so trust can be set before
              // the first workspace.create (which normally adds the project)
              project = { workspaces: [] };
              config.projects.set(normalizedPath, project);
            }
            project.trusted = input.trusted;
            return config;
          });
        }),
      setDisplayName: t
        .input(schemas.projects.setDisplayName.input)
        .output(schemas.projects.setDisplayName.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalizedPath = stripTrailingSlashes(input.projectPath);
            const project = config.projects.get(normalizedPath);
            if (!project) {
              throw new Error(`Project not found: ${normalizedPath}`);
            }
            project.displayName = input.displayName ?? undefined;
            return config;
          });
        }),
      setColor: t
        .input(schemas.projects.setColor.input)
        .output(schemas.projects.setColor.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalizedPath = stripTrailingSlashes(input.projectPath);
            const project = config.projects.get(normalizedPath);
            if (!project) {
              throw new Error(`Project not found: ${normalizedPath}`);
            }
            project.color = input.color ?? undefined;
            return config;
          });
        }),
      remove: t
        .input(schemas.projects.remove.input)
        .output(schemas.projects.remove.output)
        .handler(async ({ context, input }) => {
          return context.projectService.remove(input.projectPath, input.force ?? false);
        }),
      secrets: {
        get: t
          .input(schemas.projects.secrets.get.input)
          .output(schemas.projects.secrets.get.output)
          .handler(({ context, input }) => {
            return context.projectService.getSecrets(input.projectPath);
          }),
        update: t
          .input(schemas.projects.secrets.update.input)
          .output(schemas.projects.secrets.update.output)
          .handler(async ({ context, input }) => {
            return context.projectService.updateSecrets(input.projectPath, input.secrets);
          }),
      },
      mcp: {
        list: t
          .input(schemas.projects.mcp.list.input)
          .output(schemas.projects.mcp.list.output)
          .handler(async ({ context, input }) => {
            const servers = await context.mcpConfigService.listServers(
              input.projectPath,
              isTrustedProjectPath(context, input.projectPath)
            );

            if (!context.policyService.isEnforced()) {
              return servers;
            }

            const filtered: typeof servers = {};
            for (const [name, info] of Object.entries(servers)) {
              if (context.policyService.isMcpTransportAllowed(info.transport)) {
                filtered[name] = info;
              }
            }

            return filtered;
          }),
        add: t
          .input(schemas.projects.mcp.add.input)
          .output(schemas.projects.mcp.add.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const existingServer = existing[input.name];

            const transport = input.transport ?? "stdio";
            if (context.policyService.isEnforced()) {
              if (!context.policyService.isMcpTransportAllowed(transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }
            const hasHeaders = Boolean(input.headers && Object.keys(input.headers).length > 0);
            const usesSecretHeaders = Boolean(
              input.headers &&
              Object.values(input.headers).some(
                (v) => typeof v === "object" && v !== null && "secret" in v
              )
            );

            const action = (() => {
              if (!existingServer) {
                return "add";
              }

              if (
                existingServer.transport !== "stdio" &&
                transport !== "stdio" &&
                existingServer.transport === transport &&
                existingServer.url === input.url &&
                JSON.stringify(existingServer.headers ?? {}) !== JSON.stringify(input.headers ?? {})
              ) {
                return "set_headers";
              }

              return "edit";
            })();

            const result = await context.mcpConfigService.addServer(input.name, {
              transport,
              command: input.command,
              url: input.url,
              headers: input.headers,
            });

            if (result.success) {
              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action,
                  transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                },
              });
            }

            return result;
          }),
        remove: t
          .input(schemas.projects.mcp.remove.input)
          .output(schemas.projects.mcp.remove.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const server = existing[input.name];

            if (context.policyService.isEnforced() && server) {
              if (!context.policyService.isMcpTransportAllowed(server.transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpConfigService.removeServer(input.name);

            if (result.success && server) {
              const hasHeaders =
                server.transport !== "stdio" &&
                Boolean(server.headers && Object.keys(server.headers).length > 0);
              const usesSecretHeaders =
                server.transport !== "stdio" &&
                Boolean(
                  server.headers &&
                  Object.values(server.headers).some(
                    (v) => typeof v === "object" && v !== null && "secret" in v
                  )
                );

              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action: "remove",
                  transport: server.transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                },
              });
            }

            return result;
          }),
        test: t
          .input(schemas.projects.mcp.test.input)
          .output(schemas.projects.mcp.test.output)
          .handler(async ({ context, input }) => {
            const start = Date.now();
            const opResolver = context.onePasswordService?.resolve.bind(context.onePasswordService);
            const secrets = await secretsToRecord(
              context.config.getEffectiveSecrets(input.projectPath),
              opResolver
            );

            const configuredTransport = input.name
              ? (
                  await context.mcpConfigService.listServers(
                    input.projectPath,
                    isTrustedProjectPath(context, input.projectPath)
                  )
                )[input.name]?.transport
              : undefined;

            const transport =
              configuredTransport ?? (input.command ? "stdio" : (input.transport ?? "auto"));

            if (context.policyService.isEnforced()) {
              if (!context.policyService.isMcpTransportAllowed(transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpServerManager.test({
              projectPath: input.projectPath,
              trusted: isTrustedProjectPath(context, input.projectPath),
              name: input.name,
              command: input.command,
              transport: input.transport,
              url: input.url,
              headers: input.headers,
              projectSecrets: secrets,
            });

            const durationMs = Date.now() - start;

            const categorizeError = (
              error: string
            ): "timeout" | "connect" | "http_status" | "unknown" => {
              const lower = error.toLowerCase();
              if (lower.includes("timed out")) {
                return "timeout";
              }
              if (
                lower.includes("econnrefused") ||
                lower.includes("econnreset") ||
                lower.includes("enotfound") ||
                lower.includes("ehostunreach")
              ) {
                return "connect";
              }
              if (/\b(400|401|403|404|405|500|502|503)\b/.test(lower)) {
                return "http_status";
              }
              return "unknown";
            };

            context.telemetryService.capture({
              event: "mcp_server_tested",
              properties: {
                transport,
                success: result.success,
                duration_ms_b2: roundToBase2(durationMs),
                ...(result.success ? {} : { error_category: categorizeError(result.error) }),
              },
            });

            return result;
          }),
        setEnabled: t
          .input(schemas.projects.mcp.setEnabled.input)
          .output(schemas.projects.mcp.setEnabled.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const server = existing[input.name];

            if (context.policyService.isEnforced() && server) {
              if (!context.policyService.isMcpTransportAllowed(server.transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpConfigService.setServerEnabled(
              input.name,
              input.enabled
            );

            if (result.success && server) {
              const hasHeaders =
                server.transport !== "stdio" &&
                Boolean(server.headers && Object.keys(server.headers).length > 0);
              const usesSecretHeaders =
                server.transport !== "stdio" &&
                Boolean(
                  server.headers &&
                  Object.values(server.headers).some(
                    (v) => typeof v === "object" && v !== null && "secret" in v
                  )
                );

              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action: input.enabled ? "enable" : "disable",
                  transport: server.transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                },
              });
            }

            return result;
          }),
        setToolAllowlist: t
          .input(schemas.projects.mcp.setToolAllowlist.input)
          .output(schemas.projects.mcp.setToolAllowlist.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const server = existing[input.name];

            if (context.policyService.isEnforced() && server) {
              if (!context.policyService.isMcpTransportAllowed(server.transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpConfigService.setToolAllowlist(
              input.name,
              input.toolAllowlist
            );

            if (result.success && server) {
              const hasHeaders =
                server.transport !== "stdio" &&
                Boolean(server.headers && Object.keys(server.headers).length > 0);
              const usesSecretHeaders =
                server.transport !== "stdio" &&
                Boolean(
                  server.headers &&
                  Object.values(server.headers).some(
                    (v) => typeof v === "object" && v !== null && "secret" in v
                  )
                );

              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action: "set_tool_allowlist",
                  transport: server.transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                  tool_allowlist_size_b2: roundToBase2(input.toolAllowlist.length),
                },
              });
            }

            return result;
          }),
      },
      mcpOauth: {
        startDesktopFlow: t
          .input(schemas.projects.mcpOauth.startDesktopFlow.input)
          .output(schemas.projects.mcpOauth.startDesktopFlow.output)
          .handler(async ({ context, input }) => {
            return context.mcpOauthService.startDesktopFlow(input);
          }),
        waitForDesktopFlow: t
          .input(schemas.projects.mcpOauth.waitForDesktopFlow.input)
          .output(schemas.projects.mcpOauth.waitForDesktopFlow.output)
          .handler(async ({ context, input }) => {
            return context.mcpOauthService.waitForDesktopFlow(input.flowId, {
              timeoutMs: input.timeoutMs,
            });
          }),
        cancelDesktopFlow: t
          .input(schemas.projects.mcpOauth.cancelDesktopFlow.input)
          .output(schemas.projects.mcpOauth.cancelDesktopFlow.output)
          .handler(async ({ context, input }) => {
            await context.mcpOauthService.cancelDesktopFlow(input.flowId);
          }),
        startServerFlow: t
          .input(schemas.projects.mcpOauth.startServerFlow.input)
          .output(schemas.projects.mcpOauth.startServerFlow.output)
          .handler(async ({ context, input }) => {
            const headers = context.headers;

            const origin = typeof headers?.origin === "string" ? headers.origin.trim() : "";
            if (origin) {
              try {
                const redirectUri = new URL("/auth/mcp-oauth/callback", origin).toString();
                return context.mcpOauthService.startServerFlow({ ...input, redirectUri });
              } catch {
                // Fall back to Host header.
              }
            }

            const hostHeader = headers?.["x-forwarded-host"] ?? headers?.host;
            const host = typeof hostHeader === "string" ? hostHeader.split(",")[0]?.trim() : "";
            if (!host) {
              return Err("Missing Host header");
            }

            const protoHeader = headers?.["x-forwarded-proto"];
            const forwardedProto =
              typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : "";
            const proto = forwardedProto.length ? forwardedProto : "http";

            const redirectUri = `${proto}://${host}/auth/mcp-oauth/callback`;

            return context.mcpOauthService.startServerFlow({ ...input, redirectUri });
          }),
        waitForServerFlow: t
          .input(schemas.projects.mcpOauth.waitForServerFlow.input)
          .output(schemas.projects.mcpOauth.waitForServerFlow.output)
          .handler(async ({ context, input }) => {
            return context.mcpOauthService.waitForServerFlow(input.flowId, {
              timeoutMs: input.timeoutMs,
            });
          }),
        cancelServerFlow: t
          .input(schemas.projects.mcpOauth.cancelServerFlow.input)
          .output(schemas.projects.mcpOauth.cancelServerFlow.output)
          .handler(async ({ context, input }) => {
            await context.mcpOauthService.cancelServerFlow(input.flowId);
          }),
        getAuthStatus: t
          .input(schemas.projects.mcpOauth.getAuthStatus.input)
          .output(schemas.projects.mcpOauth.getAuthStatus.output)
          .handler(async ({ context, input }) => {
            const servers = await context.mcpConfigService.listServers(
              input.projectPath,
              isTrustedProjectPath(context, input.projectPath)
            );
            const server = servers[input.serverName];

            if (!server || server.transport === "stdio") {
              return { isLoggedIn: false, hasRefreshToken: false };
            }

            return context.mcpOauthService.getAuthStatus({ serverUrl: server.url });
          }),
        logout: t
          .input(schemas.projects.mcpOauth.logout.input)
          .output(schemas.projects.mcpOauth.logout.output)
          .handler(async ({ context, input }) => {
            const servers = await context.mcpConfigService.listServers(
              input.projectPath,
              isTrustedProjectPath(context, input.projectPath)
            );
            const server = servers[input.serverName];

            if (!server || server.transport === "stdio") {
              return Ok(undefined);
            }

            return context.mcpOauthService.logout({ serverUrl: server.url });
          }),
      },
      idleCompaction: {
        get: t
          .input(schemas.projects.idleCompaction.get.input)
          .output(schemas.projects.idleCompaction.get.output)
          .handler(({ context, input }) => ({
            hours: context.projectService.getIdleCompactionHours(input.projectPath),
          })),
        set: t
          .input(schemas.projects.idleCompaction.set.input)
          .output(schemas.projects.idleCompaction.set.output)
          .handler(({ context, input }) =>
            context.projectService.setIdleCompactionHours(input.projectPath, input.hours)
          ),
      },
      subProjects: {
        assignWorkspace: t
          .input(schemas.projects.subProjects.assignWorkspace.input)
          .output(schemas.projects.subProjects.assignWorkspace.output)
          .handler(async ({ context, input }) => {
            const result = await context.projectService.assignWorkspaceToSubProject(
              input.projectPath,
              input.workspaceId,
              input.subProjectPath
            );
            if (result.success) {
              await context.workspaceService.refreshAndEmitMetadata(input.workspaceId);
            }
            return result;
          }),
      },
    },
    nameGeneration: {
      generate: t
        .input(schemas.nameGeneration.generate.input)
        .output(schemas.nameGeneration.generate.output)
        .handler(async ({ context, input }) => {
          // Frontend provides ordered candidate list; gateway routing resolved by createModel.
          // Backend tries candidates in order with retry on API errors.
          const result = await generateWorkspaceIdentity(
            input.message,
            input.candidates,
            context.aiService
          );
          if (!result.success) {
            return result;
          }
          return {
            success: true,
            data: {
              name: result.data.name,
              title: result.data.title,
              modelUsed: result.data.modelUsed,
            },
          };
        }),
    },
    coder: {
      getInfo: t
        .input(schemas.coder.getInfo.input)
        .output(schemas.coder.getInfo.output)
        .handler(async ({ context }) => {
          return context.coderService.getCoderInfo();
        }),
      listTemplates: t
        .input(schemas.coder.listTemplates.input)
        .output(schemas.coder.listTemplates.output)
        .handler(async ({ context }) => {
          return context.coderService.listTemplates();
        }),
      listPresets: t
        .input(schemas.coder.listPresets.input)
        .output(schemas.coder.listPresets.output)
        .handler(async ({ context, input }) => {
          return context.coderService.listPresets(input.template, input.org);
        }),
      listWorkspaces: t
        .input(schemas.coder.listWorkspaces.input)
        .output(schemas.coder.listWorkspaces.output)
        .handler(async ({ context }) => {
          return context.coderService.listWorkspaces();
        }),
    },
    memory: {
      list: t
        .input(schemas.memory.list.input)
        .output(schemas.memory.list.output)
        .handler(async ({ context, input }) => {
          assertMemoryEnabled(context);
          const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
          if (!resolved) {
            return {
              success: false as const,
              error: `Workspace not found: ${input.workspaceId ?? "<none>"}`,
            };
          }
          const entries = await context.memoryService.listIndexEntries(resolved.scopeCtx);
          const meta = await context.memoryMetaService.getEntries();
          const ids = { projectPath: resolved.projectPath, workspaceId: input.workspaceId ?? "" };
          return {
            success: true as const,
            data: {
              files: entries.map((entry) => {
                const stats = meta.get(memoryLogicalKey(entry.scope, entry.relPath, ids));
                return {
                  path: entry.path,
                  scope: entry.scope,
                  description: entry.description,
                  pinned: stats?.pinned ?? false,
                  accessCount: stats?.accessCount ?? 0,
                  lastAccessedAt: stats?.lastAccessedAt ?? null,
                };
              }),
            },
          };
        }),
      read: t
        .input(schemas.memory.read.input)
        .output(schemas.memory.read.output)
        .handler(async ({ context, input }) => {
          assertMemoryEnabled(context);
          const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
          if (!resolved) {
            return {
              success: false as const,
              error: `Workspace not found: ${input.workspaceId ?? "<none>"}`,
            };
          }
          return context.memoryService.readFileWithSha(resolved.scopeCtx, input.path);
        }),
      save: t
        .input(schemas.memory.save.input)
        .output(schemas.memory.save.output)
        .handler(async ({ context, input }) => {
          assertMemoryEnabled(context);
          const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
          if (!resolved) {
            return {
              success: false as const,
              error: {
                kind: "error" as const,
                message: `Workspace not found: ${input.workspaceId ?? "<none>"}`,
              },
            };
          }
          return context.memoryService.saveFile(
            resolved.scopeCtx,
            input.path,
            input.content,
            input.expectedSha256,
            "user"
          );
        }),
      delete: t
        .input(schemas.memory.delete.input)
        .output(schemas.memory.delete.output)
        .handler(async ({ context, input }) => {
          assertMemoryEnabled(context);
          const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
          if (!resolved) {
            return {
              success: false as const,
              error: `Workspace not found: ${input.workspaceId ?? "<none>"}`,
            };
          }
          // Stale pin/stats hygiene happens inside deletePath (the MemoryService
          // chokepoint drops sidecar entries for the deleted subtree).
          const result = await context.memoryService.deletePath(
            resolved.scopeCtx,
            input.path,
            "user"
          );
          if (!result.success) {
            return { success: false as const, error: result.error };
          }
          return { success: true as const, data: undefined };
        }),
      setPinned: t
        .input(schemas.memory.setPinned.input)
        .output(schemas.memory.setPinned.output)
        .handler(async ({ context, input }) => {
          assertMemoryEnabled(context);
          const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
          if (!resolved) {
            return {
              success: false as const,
              error: `Workspace not found: ${input.workspaceId ?? "<none>"}`,
            };
          }
          let scope;
          let relPath;
          try {
            ({ scope, relPath } = parseMemoryPath(input.path));
          } catch (error) {
            return { success: false as const, error: getErrorMessage(error) };
          }
          if (scope === null || relPath === "") {
            return { success: false as const, error: `Cannot pin a directory: ${input.path}` };
          }
          // Pins bypass MemoryService stores, so mirror its scope guards here:
          // without a workspace, only global files have a stable logical key.
          if (input.workspaceId == null && scope !== "global") {
            return {
              success: false as const,
              error: `${scope === "project" ? "Project" : "Workspace"} memory is unavailable: no workspace is associated with this request`,
            };
          }
          if (scope === "project" && resolved.projectPath === "") {
            return {
              success: false as const,
              error: "Project memory is unavailable: no project is associated with this session",
            };
          }
          await context.memoryMetaService.setPinned(
            memoryLogicalKey(scope, relPath, {
              projectPath: resolved.projectPath,
              workspaceId: input.workspaceId ?? "",
            }),
            input.pinned
          );
          return { success: true as const, data: undefined };
        }),
      consolidationStatus: t
        .input(schemas.memory.consolidationStatus.input)
        .output(schemas.memory.consolidationStatus.output)
        .handler(async ({ context, input }) => {
          assertMemoryEnabled(context);
          const status = await context.memoryConsolidationService.getStatus(input.workspaceId);
          return { success: true as const, data: status };
        }),
      consolidate: t
        .input(schemas.memory.consolidate.input)
        .output(schemas.memory.consolidate.output)
        .handler(async ({ context, input }) => {
          assertMemoryEnabled(context);
          const result = await context.memoryConsolidationService.maybeRun(
            input.workspaceId,
            "manual"
          );
          return result.success
            ? { success: true as const, data: result.data }
            : { success: false as const, error: result.error };
        }),
      onChange: t
        .input(schemas.memory.onChange.input)
        .output(schemas.memory.onChange.output)
        .handler(async function* ({ context, input, signal }) {
          assertMemoryEnabled(context);
          // Resolve the subscriber's identity once: the same virtual path in
          // another workspace (workspace scope) or another project (project
          // scope) is a physically different file, so those events are
          // dropped here rather than badging unrelated files in the UI.
          const boundWorkspaceId = input.workspaceId ?? null;
          const boundMetadata = boundWorkspaceId
            ? await context.workspaceService.getInfo(boundWorkspaceId)
            : null;
          // Same identity resolution as the scope context: multi-project
          // subscribers bind "" so no project-keyed events match.
          const boundProjectPath = boundMetadata
            ? resolveMemoryProjectIdentity(boundMetadata)
            : null;
          const queue = createAsyncEventQueue<MemoryChangeEventPayload>();

          // Global file events are always forwarded (shared across everything).
          const onChange = (event: MemoryChangeEvent) => {
            if (event.scope === "workspace" && event.workspaceId !== boundWorkspaceId) return;
            // Project memory is keyed by project identity: the same virtual
            // path in another project is a different file.
            if (event.scope === "project" && event.projectPath !== boundProjectPath) {
              return;
            }
            queue.push(event);
          };
          // Consolidation status includes global coverage, so every open Memory
          // tab should refetch when a run completes, even if it made no file changes.
          const onStatusChange = (event: MemoryConsolidationStatusChangeEventPayload) => {
            queue.push(event);
          };
          context.memoryService.on("change", onChange);
          context.memoryConsolidationService.on("statusChange", onStatusChange);

          const onAbort = () => queue.end();
          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            yield* queue.iterate();
          } finally {
            queue.end();
            signal?.removeEventListener("abort", onAbort);
            context.memoryService.off("change", onChange);
            context.memoryConsolidationService.off("statusChange", onStatusChange);
          }
        }),
    },
    workspace: {
      list: t
        .input(schemas.workspace.list.input)
        .output(schemas.workspace.list.output)
        .handler(async ({ context, input }) => {
          const allWorkspaces = await context.workspaceService.list();
          // Filter by archived status (derived from timestamps via shared utility)
          if (input?.archived) {
            return allWorkspaces.filter((w) => isWorkspaceArchived(w.archivedAt, w.unarchivedAt));
          }
          // Default: return non-archived workspaces
          return allWorkspaces.filter((w) => !isWorkspaceArchived(w.archivedAt, w.unarchivedAt));
        }),
      create: t
        .input(schemas.workspace.create.input)
        .output(schemas.workspace.create.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.create(
            stripTrailingSlashes(input.projectPath),
            input.branchName,
            input.trunkBranch,
            input.title,
            input.runtimeConfig,
            input.subProjectPath,
            input.pendingAutoTitle,
            input.tags
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, metadata: result.data.metadata };
        }),
      createScratch: t
        .input(schemas.workspace.createScratch.input)
        .output(schemas.workspace.createScratch.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.createScratch(input.title);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, metadata: result.data.metadata };
        }),
      createMultiProject: t
        .input(schemas.workspace.createMultiProject.input)
        .output(schemas.workspace.createMultiProject.output)
        .handler(async ({ context, input }) => {
          if (
            !context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)
          ) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Multi-project workspaces experiment is disabled",
            });
          }

          const result = await context.workspaceService.createMultiProject(
            input.projects.map((project) => ({
              projectPath: stripTrailingSlashes(project.projectPath),
              projectName: project.projectName,
            })),
            input.branchName,
            input.trunkBranch,
            input.title,
            input.runtimeConfig
          );

          if (!result.success) {
            throw new Error(result.error);
          }

          return result.data;
        }),
      remove: t
        .input(schemas.workspace.remove.input)
        .output(schemas.workspace.remove.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.remove(
            input.workspaceId,
            input.options?.force
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true };
        }),
      timeline: {
        list: t
          .input(schemas.workspace.timeline.list.input)
          .output(schemas.workspace.timeline.list.output)
          .handler(({ context, input }) => {
            const { workspaceId, ...listInput } = input;
            return context.timelineService.list(workspaceId, listInput);
          }),
        subscribe: t
          .input(schemas.workspace.timeline.subscribe.input)
          .output(schemas.workspace.timeline.subscribe.output)
          .handler(async function* ({ context, input, signal }) {
            const queue = createAsyncEventQueue<TimelineSubscriptionEvent>();
            const pendingEvents: TimelineSubscriptionEvent["events"] = [];
            let snapshotSequence: number | undefined;
            const onAppended = (event: {
              workspaceId: string;
              events: TimelineSubscriptionEvent["events"];
            }) => {
              if (event.workspaceId !== input.workspaceId) {
                return;
              }
              const currentSequence = snapshotSequence;
              if (currentSequence == null) {
                pendingEvents.push(...event.events);
                return;
              }
              const events = event.events.filter((item) => item.seq > currentSequence);
              if (events.length > 0) {
                queue.push({ type: "appended", events });
              }
            };
            context.timelineService.on("appended", onAppended);
            const onAbort = () => queue.end();
            if (signal) {
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener("abort", onAbort, { once: true });
              }
            }

            try {
              const snapshotMaxSequence = await context.timelineService.getLastSequence(
                input.workspaceId
              );
              snapshotSequence = snapshotMaxSequence;
              const snapshot = await context.timelineService.list(input.workspaceId, {
                cursor: snapshotMaxSequence + 1,
                limit: TIMELINE_DEFAULT_PAGE_LIMIT,
              });
              const appended = pendingEvents.filter((event) => event.seq > snapshotMaxSequence);
              if (appended.length > 0) {
                queue.push({ type: "appended", events: appended });
              }
              yield {
                type: "snapshot" as const,
                events: snapshot.events,
                nextCursor: snapshot.nextCursor,
                hasOlder: snapshot.hasOlder,
              };
              yield* queue.iterate();
            } finally {
              queue.end();
              signal?.removeEventListener("abort", onAbort);
              context.timelineService.off("appended", onAppended);
            }
          }),
        preview: t
          .input(schemas.workspace.timeline.preview.input)
          .output(schemas.workspace.timeline.preview.output)
          .handler(({ context, input }) => {
            const { workspaceId, ...anchor } = input;
            return context.timelineService.previewAnchor(workspaceId, anchor);
          }),
      },
      heartbeat: {
        get: t
          .input(schemas.workspace.heartbeat.get.input)
          .output(schemas.workspace.heartbeat.get.output)
          .handler(({ context, input }) =>
            context.workspaceService.getHeartbeatSettings(input.workspaceId)
          ),
        set: t
          .input(schemas.workspace.heartbeat.set.input)
          .output(schemas.workspace.heartbeat.set.output)
          .handler(async ({ context, input }) => {
            const result = await context.workspaceService.setHeartbeatSettings(input.workspaceId, {
              enabled: input.enabled,
              intervalMs: input.intervalMs,
              ...(input.message != null ? { message: input.message } : {}),
              ...(input.contextMode != null ? { contextMode: input.contextMode } : {}),
              // trigger/whenBusy use key-presence semantics: a present key with null clears the
              // persisted value back to unset (read-time default), an absent key preserves it.
              ...("trigger" in input ? { trigger: input.trigger ?? null } : {}),
              ...("whenBusy" in input ? { whenBusy: input.whenBusy ?? null } : {}),
            });
            if (!result.success) {
              return result;
            }
            return Ok(undefined);
          }),
      },
      goalDefaults: {
        // Per-workspace override of the global `goalDefaults` block.
        // `get` returns `null` when this workspace has no override.
        // `set` accepts a sparse shape — passing `null` for every field
        // clears the record entirely (so workspace falls back to global).
        get: t
          .input(schemas.workspace.goalDefaults.get.input)
          .output(schemas.workspace.goalDefaults.get.output)
          .handler(({ context, input }) =>
            context.workspaceService.getWorkspaceGoalDefaults(input.workspaceId)
          ),
        set: t
          .input(schemas.workspace.goalDefaults.set.input)
          .output(schemas.workspace.goalDefaults.set.output)
          .handler(({ context, input }) =>
            context.workspaceService.setWorkspaceGoalDefaults(input.workspaceId, {
              defaultBudgetCents: input.defaultBudgetCents,
              defaultTurnCap: input.defaultTurnCap,
              alwaysRequireExplicitBudget: input.alwaysRequireExplicitBudget,
            })
          ),
      },
      updateAgentAISettings: t
        .input(schemas.workspace.updateAgentAISettings.input)
        .output(schemas.workspace.updateAgentAISettings.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.updateAgentAISettings(
            input.workspaceId,
            input.agentId,
            input.aiSettings,
            { persistSelectedAgentId: input.persistSelectedAgentId === true }
          );
        }),
      rename: t
        .input(schemas.workspace.rename.input)
        .output(schemas.workspace.rename.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.rename(input.workspaceId, input.newName);
        }),
      updateModeAISettings: t
        .input(schemas.workspace.updateModeAISettings.input)
        .output(schemas.workspace.updateModeAISettings.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.updateModeAISettings(
            input.workspaceId,
            input.mode,
            input.aiSettings
          );
        }),
      setActiveTurnThinkingLevel: t
        .input(schemas.workspace.setActiveTurnThinkingLevel.input)
        .output(schemas.workspace.setActiveTurnThinkingLevel.output)
        .handler(({ context, input }) => {
          return context.workspaceService.setActiveTurnThinkingLevel(
            input.workspaceId,
            input.thinkingLevel
          );
        }),
      updateTitle: t
        .input(schemas.workspace.updateTitle.input)
        .output(schemas.workspace.updateTitle.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.updateTitle(input.workspaceId, input.title);
        }),
      setPinned: t
        .input(schemas.workspace.setPinned.input)
        .output(schemas.workspace.setPinned.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.setPinned(input.workspaceId, input.pinned);
        }),
      reorderPinned: t
        .input(schemas.workspace.reorderPinned.input)
        .output(schemas.workspace.reorderPinned.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.reorderPinned(input.workspaceIds);
        }),
      updateTags: t
        .input(schemas.workspace.updateTags.input)
        .output(schemas.workspace.updateTags.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.updateTags(input.workspaceId, input.tags);
        }),
      regenerateTitle: t
        .input(schemas.workspace.regenerateTitle.input)
        .output(schemas.workspace.regenerateTitle.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.regenerateTitle(input.workspaceId);
        }),
      preflightArchive: t
        .input(schemas.workspace.preflightArchive.input)
        .output(schemas.workspace.preflightArchive.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.preflightArchive(input.workspaceId);
        }),
      archive: t
        .input(schemas.workspace.archive.input)
        .output(schemas.workspace.archive.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.archive(
            input.workspaceId,
            input.acknowledgedUntrackedPaths ?? undefined
          );
        }),
      unarchive: t
        .input(schemas.workspace.unarchive.input)
        .output(schemas.workspace.unarchive.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.unarchive(input.workspaceId);
        }),
      deleteWorktree: t
        .input(schemas.workspace.deleteWorktree.input)
        .output(schemas.workspace.deleteWorktree.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.deleteWorktree(input.workspaceId);
        }),
      stopRuntime: t
        .input(schemas.workspace.stopRuntime.input)
        .output(schemas.workspace.stopRuntime.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.stopRuntime(input.workspaceId);
        }),
      getRuntimeStatuses: t
        .input(schemas.workspace.getRuntimeStatuses.input)
        .output(schemas.workspace.getRuntimeStatuses.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getRuntimeStatuses(input.workspaceIds);
        }),
      getProjectGitStatuses: t
        .input(schemas.workspace.getProjectGitStatuses.input)
        .output(schemas.workspace.getProjectGitStatuses.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getProjectGitStatuses(input.workspaceId, input.baseRef);
        }),
      archiveMergedInProject: t
        .input(schemas.workspace.archiveMergedInProject.input)
        .output(schemas.workspace.archiveMergedInProject.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.archiveMergedInProject(input.projectPath);
        }),
      fork: t
        .input(schemas.workspace.fork.input)
        .output(schemas.workspace.fork.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.fork(
            input.sourceWorkspaceId,
            input.newName,
            input.sourceMessageId,
            input.pendingAutoTitle
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return {
            success: true,
            metadata: result.data.metadata,
            projectPath: result.data.projectPath,
          };
        }),
      stageAttachment: t
        .input(schemas.workspace.stageAttachment.input)
        .output(schemas.workspace.stageAttachment.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.stageAttachment(input);
        }),
      downloadStagedAttachment: t
        .input(schemas.workspace.downloadStagedAttachment.input)
        .output(schemas.workspace.downloadStagedAttachment.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.downloadStagedAttachment(input);
        }),
      sendMessage: t
        .input(schemas.workspace.sendMessage.input)
        .output(schemas.workspace.sendMessage.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.sendMessage(
            input.workspaceId,
            input.message,
            input.options
          );

          if (!result.success) {
            return { success: false, error: result.error };
          }

          return { success: true, data: {} };
        }),
      sideQuestion: t
        .input(schemas.workspace.sideQuestion.input)
        .output(schemas.workspace.sideQuestion.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.askSideQuestion(input.workspaceId, input.question);
        }),
      answerAskUserQuestion: t
        .input(schemas.workspace.answerAskUserQuestion.input)
        .output(schemas.workspace.answerAskUserQuestion.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.answerAskUserQuestion(
            input.workspaceId,
            input.toolCallId,
            input.answers
          );

          if (!result.success) {
            return { success: false, error: result.error };
          }

          return { success: true, data: undefined };
        }),
      answerDelegatedToolCall: t
        .input(schemas.workspace.answerDelegatedToolCall.input)
        .output(schemas.workspace.answerDelegatedToolCall.output)
        .handler(({ context, input }) => {
          const result = context.workspaceService.answerDelegatedToolCall(
            input.workspaceId,
            input.toolCallId,
            input.result
          );

          if (!result.success) {
            return { success: false, error: result.error };
          }

          return { success: true, data: undefined };
        }),
      resumeStream: t
        .input(schemas.workspace.resumeStream.input)
        .output(schemas.workspace.resumeStream.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.resumeStream(
            input.workspaceId,
            input.options
          );
          if (!result.success) {
            const error =
              typeof result.error === "string"
                ? { type: "unknown" as const, raw: result.error }
                : result.error;
            return { success: false, error };
          }
          return { success: true, data: result.data };
        }),
      setAutoRetryEnabled: t
        .input(schemas.workspace.setAutoRetryEnabled.input)
        .output(schemas.workspace.setAutoRetryEnabled.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.setAutoRetryEnabled(
            input.workspaceId,
            input.enabled,
            input.persist ?? true
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      getStartupAutoRetryModel: t
        .input(schemas.workspace.getStartupAutoRetryModel.input)
        .output(schemas.workspace.getStartupAutoRetryModel.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.getStartupAutoRetryModel(input.workspaceId);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      setAutoCompactionThreshold: t
        .input(schemas.workspace.setAutoCompactionThreshold.input)
        .output(schemas.workspace.setAutoCompactionThreshold.output)
        .handler(({ context, input }) => {
          const result = context.workspaceService.setAutoCompactionThreshold(
            input.workspaceId,
            input.threshold
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      interruptStream: t
        .input(schemas.workspace.interruptStream.input)
        .output(schemas.workspace.interruptStream.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.interruptStream(
            input.workspaceId,
            input.options
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      clearQueue: t
        .input(schemas.workspace.clearQueue.input)
        .output(schemas.workspace.clearQueue.output)
        .handler(({ context, input }) => {
          const result = context.workspaceService.clearQueue(input.workspaceId);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      truncateHistory: t
        .input(schemas.workspace.truncateHistory.input)
        .output(schemas.workspace.truncateHistory.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.truncateHistory(
            input.workspaceId,
            input.percentage
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      resetContext: t
        .input(schemas.workspace.resetContext.input)
        .output(schemas.workspace.resetContext.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.resetContext(input.workspaceId);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      replaceChatHistory: t
        .input(schemas.workspace.replaceChatHistory.input)
        .output(schemas.workspace.replaceChatHistory.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.replaceHistory(
            input.workspaceId,
            input.summaryMessage,
            { mode: input.mode, deletePlanFile: input.deletePlanFile }
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      getDevcontainerInfo: t
        .input(schemas.workspace.getDevcontainerInfo.input)
        .output(schemas.workspace.getDevcontainerInfo.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getDevcontainerInfo(input.workspaceId);
        }),
      getInfo: t
        .input(schemas.workspace.getInfo.input)
        .output(schemas.workspace.getInfo.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getInfo(input.workspaceId);
        }),
      getLastLlmRequest: t
        .input(schemas.workspace.getLastLlmRequest.input)
        .output(schemas.workspace.getLastLlmRequest.output)
        .handler(({ context, input }) => {
          return context.aiService.debugGetLastLlmRequest(input.workspaceId);
        }),
      getFullReplay: t
        .input(schemas.workspace.getFullReplay.input)
        .output(schemas.workspace.getFullReplay.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getFullReplay(input.workspaceId);
        }),
      getSubagentTranscript: t
        .input(schemas.workspace.getSubagentTranscript.input)
        .output(schemas.workspace.getSubagentTranscript.output)
        .handler(async ({ context, input }) => {
          const taskId = input.taskId.trim();
          assert(taskId.length > 0, "workspace.getSubagentTranscript: taskId must be non-empty");

          const requestingWorkspaceIdTrimmed = input.workspaceId?.trim();
          const requestingWorkspaceId =
            requestingWorkspaceIdTrimmed && requestingWorkspaceIdTrimmed.length > 0
              ? requestingWorkspaceIdTrimmed
              : null;

          const tryLoadFromWorkspace = async (
            workspaceId: string
          ): Promise<{
            workspaceId: string;
            entry: SubagentTranscriptArtifactIndexEntry;
          } | null> => {
            const sessionDir = context.config.getSessionDir(workspaceId);
            const artifacts = await readSubagentTranscriptArtifactsFile(sessionDir);
            const entry = artifacts.artifactsByChildTaskId[taskId] ?? null;
            return entry ? { workspaceId, entry } : null;
          };

          const tryLoadFromDescendantWorkspaces = async (
            ancestorWorkspaceId: string
          ): Promise<{
            workspaceId: string;
            entry: SubagentTranscriptArtifactIndexEntry;
          } | null> => {
            // If a grandchild task has already been cleaned up, its transcript is archived into the
            // immediate parent workspace's session dir. Until that parent workspace is cleaned up and
            // its artifacts are rolled up, the requesting workspace won't have the transcript index.
            const descendants = context.taskService.listDescendantAgentTasks(ancestorWorkspaceId);

            // Prefer shallower tasks first so we find the owning parent quickly.
            descendants.sort((a, b) => a.depth - b.depth);

            for (const descendant of descendants) {
              const loaded = await tryLoadFromWorkspace(descendant.taskId);
              if (loaded) return loaded;
            }

            return null;
          };

          // Auth: allow if the task is a descendant OR if we have an on-disk transcript artifact entry.
          // The descendant check is best-effort: if it throws (corrupt config), we fall back to the
          // artifact existence check to keep the UI usable.
          let isDescendant = false;
          if (requestingWorkspaceId) {
            try {
              isDescendant = await context.taskService.isDescendantAgentTask(
                requestingWorkspaceId,
                taskId
              );
            } catch (error: unknown) {
              log.warn("workspace.getSubagentTranscript: descendant check failed", {
                requestingWorkspaceId,
                taskId,
                error: getErrorMessage(error),
              });
            }
          }

          const readTranscriptFromPaths = async (params: {
            workspaceId: string;
            chatPath?: string;
            /** Sealed pre-boundary history (chat-archive.jsonl) for live sessions. */
            chatArchivePath?: string;
            partialPath?: string;
            logLabel: string;
          }): Promise<MuxMessage[]> => {
            const workspaceSessionDir = context.config.getSessionDir(params.workspaceId);

            // Defense-in-depth: refuse path traversal from a corrupted index file.
            if (params.chatPath && !isPathInsideDir(workspaceSessionDir, params.chatPath)) {
              throw new Error("Refusing to read transcript outside workspace session dir");
            }
            if (
              params.chatArchivePath &&
              !isPathInsideDir(workspaceSessionDir, params.chatArchivePath)
            ) {
              throw new Error("Refusing to read transcript archive outside workspace session dir");
            }
            if (params.partialPath && !isPathInsideDir(workspaceSessionDir, params.partialPath)) {
              throw new Error("Refusing to read partial outside workspace session dir");
            }

            const partial = params.partialPath
              ? await readPartialJsonBestEffort(params.partialPath)
              : null;
            // Live sessions may have rotated sealed history into chat-archive.jsonl
            // (older rows), which precedes chat.jsonl (active epoch).
            const archivedMessages = params.chatArchivePath
              ? await readChatJsonlAllowMissing({
                  chatPath: params.chatArchivePath,
                  logLabel: `${params.logLabel} (archive)`,
                })
              : null;
            const messages = params.chatPath
              ? await readChatJsonlAllowMissing({
                  chatPath: params.chatPath,
                  logLabel: params.logLabel,
                })
              : null;

            // If we only archived partial.json (e.g. interrupted stream), still allow viewing.
            if (!messages && !archivedMessages && !partial) {
              throw new Error(`Transcript not found (missing ${params.logLabel})`);
            }

            return mergePartialIntoHistory(
              [...(archivedMessages ?? []), ...(messages ?? [])],
              partial
            );
          };

          let resolved: {
            workspaceId: string;
            entry: SubagentTranscriptArtifactIndexEntry;
          } | null = null;
          let hasArtifactInRequestingTree = false;

          if (requestingWorkspaceId !== null) {
            resolved = await tryLoadFromWorkspace(requestingWorkspaceId);
            if (resolved) {
              hasArtifactInRequestingTree = true;
            } else {
              resolved = await tryLoadFromDescendantWorkspaces(requestingWorkspaceId);
              hasArtifactInRequestingTree = resolved !== null;
            }
          } else {
            resolved = await findSubagentTranscriptEntryByScanningSessions({
              sessionsDir: context.config.sessionsDir,
              taskId,
            });
          }

          // If the transcript hasn't been archived yet (common while patch artifacts are pending),
          // fall back to reading from the task's live session dir while it still exists.
          if (!resolved) {
            if (requestingWorkspaceId && isDescendant) {
              const taskSessionDir = context.config.getSessionDir(taskId);
              const messages = await readTranscriptFromPaths({
                workspaceId: taskId,
                chatPath: path.join(taskSessionDir, CHAT_FILE_NAME),
                chatArchivePath: path.join(taskSessionDir, CHAT_ARCHIVE_FILE_NAME),
                partialPath: path.join(taskSessionDir, "partial.json"),
                logLabel: `${taskId}/chat.jsonl`,
              });

              const metaResult = await context.aiService.getWorkspaceMetadata(taskId);
              const model =
                metaResult.success &&
                typeof metaResult.data.taskModelString === "string" &&
                metaResult.data.taskModelString.trim().length > 0
                  ? metaResult.data.taskModelString.trim()
                  : undefined;
              const thinkingLevel = metaResult.success
                ? coerceThinkingLevel(metaResult.data.taskThinkingLevel)
                : undefined;

              return { messages, model, thinkingLevel };
            }

            // Helpful error message for UI.
            throw new Error(
              requestingWorkspaceId
                ? `No transcript found for task ${taskId} in workspace ${requestingWorkspaceId}`
                : `No transcript found for task ${taskId}`
            );
          }

          if (requestingWorkspaceId && !isDescendant && !hasArtifactInRequestingTree) {
            throw new Error("Task is not a descendant of this workspace");
          }

          const messages = await readTranscriptFromPaths({
            workspaceId: resolved.workspaceId,
            chatPath: resolved.entry.chatPath,
            partialPath: resolved.entry.partialPath,
            logLabel: `${resolved.workspaceId}/subagent-transcripts/${taskId}/chat.jsonl`,
          });

          const model =
            typeof resolved.entry.model === "string" && resolved.entry.model.trim().length > 0
              ? resolved.entry.model.trim()
              : undefined;
          const thinkingLevel = coerceThinkingLevel(resolved.entry.thinkingLevel);

          return { messages, model, thinkingLevel };
        }),
      executeBash: t
        .input(schemas.workspace.executeBash.input)
        .output(schemas.workspace.executeBash.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.executeBash(
            input.workspaceId,
            input.script,
            {
              ...(input.options ?? {}),
            },
            input.command ?? undefined,
            input.args ?? undefined
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      getFileCompletions: t
        .input(schemas.workspace.getFileCompletions.input)
        .output(schemas.workspace.getFileCompletions.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getFileCompletions(
            input.workspaceId,
            input.query,
            input.limit
          );
        }),
      onChat: t
        .input(schemas.workspace.onChat.input)
        .output(schemas.workspace.onChat.output)
        .handler(async function* ({ context, input, signal }) {
          const session = context.workspaceService.getOrCreateSession(input.workspaceId);
          if (typeof input.legacyAutoRetryEnabled === "boolean") {
            session.setLegacyAutoRetryEnabledHint(input.legacyAutoRetryEnabled);
          }

          const queue = withQueueHeartbeat(createAsyncMessageQueue<WorkspaceChatMessage>(), {
            type: "heartbeat" as const,
          });

          const onAbort = () => {
            // Ensure we tear down the async generator even if the client stops iterating without
            // calling iterator.return(). This prevents orphaned heartbeat timers.
            queue.end();
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          // 1. Subscribe to new events (including those triggered by replay)
          //
          // IMPORTANT: We subscribe before replay so we can receive stream replay (`replayStream()`)
          // and init replay events (which now set `replay: true` like other replayed payloads).
          //
          // Live stream deltas can overlap with replayed deltas on reconnect. Buffer live stream
          // events during replay and flush after `caught-up`, skipping any deltas already delivered
          // by replay.
          const replayRelay = createReplayBufferedStreamMessageRelay(queue.push);

          const unsubscribe = session.onChatEvent(({ message }) => {
            replayRelay.handleSessionMessage(message);
          });

          // 2. Replay history (sends caught-up at the end)
          await session.replayHistory(({ message }) => {
            queue.push(message);
          }, input.mode);

          replayRelay.finishReplay();

          // Startup recovery: after replay catches the client up, recover any
          // crash-stranded compaction follow-ups and then evaluate auto-retry.
          session.scheduleStartupRecovery();

          try {
            yield* queue.iterate();
          } finally {
            signal?.removeEventListener("abort", onAbort);
            queue.end();
            unsubscribe();
          }
        }),
      onMetadata: t
        .input(schemas.workspace.onMetadata.input)
        .output(schemas.workspace.onMetadata.output)
        .handler(async function* ({ context, signal }) {
          const service = context.workspaceService;

          interface MetadataEvent {
            workspaceId: string;
            metadata: FrontendWorkspaceMetadataSchemaType | null;
          }

          let resolveNext: ((value: MetadataEvent | null) => void) | null = null;
          const queue: MetadataEvent[] = [];
          let ended = false;

          const push = (event: MetadataEvent) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(event);
            } else {
              queue.push(event);
            }
          };

          const onMetadata = (event: MetadataEvent) => {
            push(event);
          };

          service.on("metadata", onMetadata);

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }

              const event = await new Promise<MetadataEvent | null>((resolve) => {
                resolveNext = resolve;
              });

              if (event === null || ended) {
                break;
              }

              yield event;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            service.off("metadata", onMetadata);
          }
        }),
      activity: {
        list: t
          .input(schemas.workspace.activity.list.input)
          .output(schemas.workspace.activity.list.output)
          .handler(async ({ context }) => {
            return context.workspaceService.getActivityList();
          }),
        subscribe: t
          .input(schemas.workspace.activity.subscribe.input)
          .output(schemas.workspace.activity.subscribe.output)
          .handler(async function* ({ context, signal }) {
            const service = context.workspaceService;

            interface ActivityEvent {
              type: "activity";
              workspaceId: string;
              activity: WorkspaceActivitySnapshot | null;
            }

            const queue = withQueueHeartbeat(
              createAsyncEventQueue<ActivityEvent | { type: "heartbeat" }>(),
              {
                type: "heartbeat" as const,
              }
            );

            const onActivity = (event: {
              workspaceId: string;
              activity: WorkspaceActivitySnapshot | null;
            }) => {
              queue.push({
                type: "activity" as const,
                workspaceId: event.workspaceId,
                activity: event.activity,
              });
            };

            service.on("activity", onActivity);

            const onAbort = () => {
              queue.end();
            };

            if (signal) {
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener("abort", onAbort, { once: true });
              }
            }

            try {
              // Bootstrap snapshots are the responsibility of workspace.activity.list().
              // This subscription emits only live activity deltas and heartbeats to
              // preserve strict event ordering — replaying historical snapshots here
              // could overwrite fresher live events queued by the listener above.
              yield* queue.iterate();
            } finally {
              signal?.removeEventListener("abort", onAbort);
              queue.end();
              service.off("activity", onActivity);
            }
          }),
      },
      history: {
        loadMore: t
          .input(schemas.workspace.history.loadMore.input)
          .output(schemas.workspace.history.loadMore.output)
          .handler(async ({ context, input }) => {
            return context.workspaceService.getHistoryLoadMore(input.workspaceId, input.cursor);
          }),
        lastUserPrompt: t
          .input(schemas.workspace.history.lastUserPrompt.input)
          .output(schemas.workspace.history.lastUserPrompt.output)
          .handler(async ({ context, input }) => {
            return context.workspaceService.getLastUserPrompt(input.workspaceId);
          }),
      },
      getPlanContent: t
        .input(schemas.workspace.getPlanContent.input)
        .output(schemas.workspace.getPlanContent.output)
        .handler(async ({ context, input }) => {
          // Get workspace metadata to determine runtime and paths
          const metadata = await context.workspaceService.getInfo(input.workspaceId);
          if (!metadata) {
            return {
              success: false as const,
              error: `Workspace not found: ${input.workspaceId ?? "<none>"}`,
            };
          }

          // Create runtime to read plan file (supports both local and SSH)
          const runtime = createRuntimeForWorkspace(metadata);

          const result = await readPlanFile(
            runtime,
            metadata.name,
            metadata.projectName,
            input.workspaceId
          );

          if (!result.exists) {
            return { success: false as const, error: `Plan file not found at ${result.path}` };
          }
          return { success: true as const, data: { content: result.content, path: result.path } };
        }),
      backgroundBashes: {
        subscribe: t
          .input(schemas.workspace.backgroundBashes.subscribe.input)
          .output(schemas.workspace.backgroundBashes.subscribe.output)
          .handler(async function* ({ context, input, signal }) {
            const service = context.workspaceService;
            const { workspaceId } = input;

            if (signal?.aborted) {
              return;
            }

            const getState = async () => ({
              processes: await service.listBackgroundProcesses(workspaceId),
              foregroundToolCallIds: service.getForegroundToolCallIds(workspaceId),
            });

            const queue = createAsyncEventQueue<Awaited<ReturnType<typeof getState>>>();

            const onAbort = () => {
              queue.end();
            };

            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }

            const onChange = (changedWorkspaceId: string) => {
              if (changedWorkspaceId === workspaceId) {
                void getState().then(queue.push);
              }
            };

            service.onBackgroundBashChange(onChange);

            try {
              // Emit initial state immediately
              yield await getState();
              yield* queue.iterate();
            } finally {
              signal?.removeEventListener("abort", onAbort);
              queue.end();
              service.offBackgroundBashChange(onChange);
            }
          }),
        terminate: t
          .input(schemas.workspace.backgroundBashes.terminate.input)
          .output(schemas.workspace.backgroundBashes.terminate.output)
          .handler(async ({ context, input }) => {
            const result = await context.workspaceService.terminateBackgroundProcess(
              input.workspaceId,
              input.processId
            );
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return { success: true, data: undefined };
          }),
        sendToBackground: t
          .input(schemas.workspace.backgroundBashes.sendToBackground.input)
          .output(schemas.workspace.backgroundBashes.sendToBackground.output)
          .handler(({ context, input }) => {
            const result = context.workspaceService.sendToBackground(input.toolCallId);
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return { success: true, data: undefined };
          }),
        getOutput: t
          .input(schemas.workspace.backgroundBashes.getOutput.input)
          .output(schemas.workspace.backgroundBashes.getOutput.output)
          .handler(async ({ context, input }) => {
            const result = await context.workspaceService.getBackgroundProcessOutput(
              input.workspaceId,
              input.processId,
              { fromOffset: input.fromOffset, tailBytes: input.tailBytes }
            );
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return { success: true, data: result.data };
          }),
      },
      getPostCompactionState: t
        .input(schemas.workspace.getPostCompactionState.input)
        .output(schemas.workspace.getPostCompactionState.output)
        .handler(({ context, input }) => {
          return context.workspaceService.getPostCompactionState(input.workspaceId);
        }),
      setPostCompactionExclusion: t
        .input(schemas.workspace.setPostCompactionExclusion.input)
        .output(schemas.workspace.setPostCompactionExclusion.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.setPostCompactionExclusion(
            input.workspaceId,
            input.itemId,
            input.excluded
          );
        }),
      getGoal: t
        .input(schemas.workspace.getGoal.input)
        .output(schemas.workspace.getGoal.output)
        .handler(async ({ context, input }) => {
          const workspace = await context.workspaceService.getInfo(input.workspaceId);
          if (!workspace) {
            return { goal: null };
          }
          return { goal: await context.workspaceGoalService.getGoal(input.workspaceId) };
        }),
      setGoal: t
        .input(schemas.workspace.setGoal.input)
        .output(schemas.workspace.setGoal.output)
        .handler(async ({ context, input }) => {
          const workspace = await context.workspaceService.getInfo(input.workspaceId);
          if (!workspace) {
            return {
              success: false,
              error: { type: "invalid_transition", message: "Workspace not found." },
            };
          }
          return context.workspaceGoalService.setGoal(input);
        }),
      clearGoal: t
        .input(schemas.workspace.clearGoal.input)
        .output(schemas.workspace.clearGoal.output)
        .handler(async ({ context, input }) => {
          const workspace = await context.workspaceService.getInfo(input.workspaceId);
          if (!workspace) {
            return { cleared: false };
          }
          const cleared = await context.workspaceGoalService.clearGoal(input.workspaceId);
          return { cleared: cleared !== null };
        }),
      // ────────────────────────────────────────────────────────────────
      // Goal board (multi-goal queue) endpoints. Each handler forwards
      // to `workspaceGoalService` after a missing-workspace short-circuit
      // so the renderer can race a board fetch against workspace deletion
      // without hitting a 500.
      // ────────────────────────────────────────────────────────────────
      getGoalBoard: t
        .input(schemas.workspace.getGoalBoard.input)
        .output(schemas.workspace.getGoalBoard.output)
        .handler(async ({ context, input }) => {
          const workspace = await context.workspaceService.getInfo(input.workspaceId);
          if (!workspace) return { entries: [] };
          return context.workspaceGoalService.getGoalBoard(input.workspaceId);
        }),
      addUpcomingGoal: t
        .input(schemas.workspace.addUpcomingGoal.input)
        .output(schemas.workspace.addUpcomingGoal.output)
        .handler(async ({ context, input }) => {
          return withGoalErrorTranslation(() =>
            context.workspaceGoalService.addUpcomingGoal({
              workspaceId: input.workspaceId,
              objective: input.objective,
              budgetCents: input.budgetCents,
              turnCap: input.turnCap,
            })
          );
        }),
      archiveGoal: t
        .input(schemas.workspace.archiveGoal.input)
        .output(schemas.workspace.archiveGoal.output)
        .handler(async ({ context, input }) => {
          await withGoalErrorTranslation(() =>
            context.workspaceGoalService.archiveGoal(input.workspaceId, input.goalId)
          );
        }),
      reviveArchivedGoal: t
        .input(schemas.workspace.reviveArchivedGoal.input)
        .output(schemas.workspace.reviveArchivedGoal.output)
        .handler(async ({ context, input }) => {
          await withGoalErrorTranslation(() =>
            context.workspaceGoalService.reviveArchivedGoal(input.workspaceId, input.goalId)
          );
        }),
      reorderUpcomingGoals: t
        .input(schemas.workspace.reorderUpcomingGoals.input)
        .output(schemas.workspace.reorderUpcomingGoals.output)
        .handler(async ({ context, input }) => {
          await withGoalErrorTranslation(() =>
            context.workspaceGoalService.reorderUpcomingGoals(input.workspaceId, input.upcomingIds)
          );
        }),
      promoteUpcomingGoal: t
        .input(schemas.workspace.promoteUpcomingGoal.input)
        .output(schemas.workspace.promoteUpcomingGoal.output)
        .handler(async ({ context, input }) => {
          return withGoalErrorTranslation(() =>
            context.workspaceGoalService.promoteUpcomingGoal(input.workspaceId, input.goalId)
          );
        }),
      updateUpcomingGoal: t
        .input(schemas.workspace.updateUpcomingGoal.input)
        .output(schemas.workspace.updateUpcomingGoal.output)
        .handler(async ({ context, input }) => {
          return withGoalErrorTranslation(() =>
            context.workspaceGoalService.updateUpcomingGoal({
              workspaceId: input.workspaceId,
              goalId: input.goalId,
              objective: input.objective,
              budgetCents: input.budgetCents,
              turnCap: input.turnCap,
            })
          );
        }),
      getSessionUsage: t
        .input(schemas.workspace.getSessionUsage.input)
        .output(schemas.workspace.getSessionUsage.output)
        .handler(async ({ context, input }) => {
          return context.sessionUsageService.getSessionUsage(input.workspaceId);
        }),
      getSessionUsageBatch: t
        .input(schemas.workspace.getSessionUsageBatch.input)
        .output(schemas.workspace.getSessionUsageBatch.output)
        .handler(async ({ context, input }) => {
          return context.sessionUsageService.getSessionUsageBatch(input.workspaceIds);
        }),
      getInstructions: t
        .input(schemas.workspace.getInstructions.input)
        .output(schemas.workspace.getInstructions.output)
        .handler(async ({ context, input }) => {
          return context.instructionsService.getWorkspaceInstructions(
            input.workspaceId,
            input.model
          );
        }),
      getAdditionalSystemContext: t
        .input(schemas.workspace.getAdditionalSystemContext.input)
        .output(schemas.workspace.getAdditionalSystemContext.output)
        .handler(async ({ context, input }) => {
          return context.instructionsService.getAdditionalSystemContext(input.workspaceId);
        }),
      setAdditionalSystemContext: t
        .input(schemas.workspace.setAdditionalSystemContext.input)
        .output(schemas.workspace.setAdditionalSystemContext.output)
        .handler(async ({ context, input }) => {
          return context.instructionsService.setAdditionalSystemContext(
            input.workspaceId,
            input.content,
            input.enabled
          );
        }),
      stats: {
        subscribe: t
          .input(schemas.workspace.stats.subscribe.input)
          .output(schemas.workspace.stats.subscribe.output)
          .handler(async function* ({ context, input, signal }) {
            const workspaceId = input.workspaceId;

            if (signal?.aborted) {
              return;
            }

            context.sessionTimingService.addSubscriber(workspaceId);

            const queue = (() => {
              // Coalesce snapshots: keep only the most recent snapshot to avoid an
              // unbounded queue under high-frequency stream deltas.
              let buffered: WorkspaceStatsSnapshot | undefined;
              let hasBuffered = false;
              let resolveNext: ((value: WorkspaceStatsSnapshot | null) => void) | null = null;
              let ended = false;

              const push = (value: WorkspaceStatsSnapshot) => {
                if (ended) return;

                if (resolveNext) {
                  const resolve = resolveNext;
                  resolveNext = null;
                  resolve(value);
                  return;
                }

                buffered = value;
                hasBuffered = true;
              };

              async function* iterate(): AsyncGenerator<WorkspaceStatsSnapshot> {
                while (true) {
                  if (ended) {
                    return;
                  }

                  if (hasBuffered) {
                    const value = buffered;
                    buffered = undefined;
                    hasBuffered = false;
                    if (value !== undefined) {
                      yield value;
                    }
                    continue;
                  }

                  const next = await new Promise<WorkspaceStatsSnapshot | null>((resolve) => {
                    resolveNext = resolve;
                  });

                  if (ended || next === null) {
                    return;
                  }

                  yield next;
                }
              }

              const end = () => {
                ended = true;
                if (resolveNext) {
                  const resolve = resolveNext;
                  resolveNext = null;
                  resolve(null);
                }
              };

              return { push, iterate, end };
            })();

            // Snapshot computation is async; without coalescing, we can build an unbounded
            // backlog when token deltas arrive quickly.
            const SNAPSHOT_THROTTLE_MS = 100;

            let lastPushedAtMs = 0;
            let inFlight = false;
            let pendingTimer: ReturnType<typeof setTimeout> | undefined;
            let pendingSnapshot = false;
            let closed = false;

            const onAbort = () => {
              closed = true;

              if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
              }

              queue.end();
            };

            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }

            const pushSnapshot = async () => {
              if (closed) return;
              if (inFlight) return;
              if (!pendingSnapshot) return;

              pendingSnapshot = false;
              inFlight = true;

              try {
                const snapshot = await context.sessionTimingService.getSnapshot(workspaceId);
                if (closed) return;

                lastPushedAtMs = snapshot.generatedAt;
                queue.push(snapshot);
              } finally {
                inFlight = false;

                if (!closed && pendingSnapshot) {
                  scheduleSnapshot();
                }
              }
            };

            const runPushSnapshot = () => {
              void pushSnapshot().catch(() => {
                // Defensive: a failed snapshot fetch should never brick the subscription.
              });
            };

            const scheduleSnapshot = () => {
              pendingSnapshot = true;

              if (closed) {
                return;
              }

              if (inFlight) {
                return;
              }

              if (pendingTimer) {
                return;
              }

              const now = Date.now();
              const timeSinceLastPush = now - lastPushedAtMs;

              if (timeSinceLastPush >= SNAPSHOT_THROTTLE_MS) {
                runPushSnapshot();
                return;
              }

              const remaining = SNAPSHOT_THROTTLE_MS - timeSinceLastPush;
              pendingTimer = setTimeout(() => {
                pendingTimer = undefined;
                runPushSnapshot();
              }, remaining);

              // Avoid keeping Node (or Jest workers) alive due to a leaked throttle timer.
              pendingTimer.unref?.();
            };

            const onChange = (changedWorkspaceId: string) => {
              if (changedWorkspaceId !== workspaceId) {
                return;
              }
              scheduleSnapshot();
            };

            // Subscribe before awaiting the initial snapshot so we don't miss a
            // stats-change event that happens while getSnapshot() is in-flight.
            //
            // Treat the initial snapshot fetch as inFlight to prevent scheduleSnapshot()
            // from starting a concurrent fetch that could push a newer snapshot before
            // the initial one.
            inFlight = true;
            context.sessionTimingService.onStatsChange(onChange);

            try {
              const initial = await context.sessionTimingService.getSnapshot(workspaceId);
              lastPushedAtMs = initial.generatedAt;
              queue.push(initial);
            } finally {
              inFlight = false;

              if (!closed && pendingSnapshot) {
                scheduleSnapshot();
              }
            }

            try {
              yield* queue.iterate();
            } finally {
              closed = true;
              signal?.removeEventListener("abort", onAbort);
              if (pendingTimer) {
                clearTimeout(pendingTimer);
              }

              queue.end();
              context.sessionTimingService.offStatsChange(onChange);
              context.sessionTimingService.removeSubscriber(workspaceId);
            }
          }),
        clear: t
          .input(schemas.workspace.stats.clear.input)
          .output(schemas.workspace.stats.clear.output)
          .handler(async ({ context, input }) => {
            try {
              await context.sessionTimingService.clearTimingFile(input.workspaceId);
              return { success: true, data: undefined };
            } catch (error) {
              const message = getErrorMessage(error);
              return { success: false, error: message };
            }
          }),
      },
      mcp: {
        get: t
          .input(schemas.workspace.mcp.get.input)
          .output(schemas.workspace.mcp.get.output)
          .handler(async ({ context, input }) => {
            const policy = context.policyService.getEffectivePolicy();
            const mcpDisabledByPolicy =
              context.policyService.isEnforced() &&
              policy?.mcp.allowUserDefined.stdio === false &&
              policy.mcp.allowUserDefined.remote === false;

            if (mcpDisabledByPolicy) {
              return {};
            }

            try {
              return await context.workspaceMcpOverridesService.getOverridesForWorkspace(
                input.workspaceId
              );
            } catch {
              // Defensive: overrides must never brick workspace UI.
              return {};
            }
          }),
        set: t
          .input(schemas.workspace.mcp.set.input)
          .output(schemas.workspace.mcp.set.output)
          .handler(async ({ context, input }) => {
            try {
              await context.workspaceMcpOverridesService.setOverridesForWorkspace(
                input.workspaceId,
                input.overrides
              );
              return { success: true, data: undefined };
            } catch (error) {
              const message = getErrorMessage(error);
              return { success: false, error: message };
            }
          }),
      },
    },
    tasks: {
      create: t
        .input(schemas.tasks.create.input)
        .output(schemas.tasks.create.output)
        .handler(({ context, input }) => {
          const thinkingLevel =
            input.thinkingLevel === "off" ||
            input.thinkingLevel === "low" ||
            input.thinkingLevel === "medium" ||
            input.thinkingLevel === "high" ||
            input.thinkingLevel === "xhigh"
              ? input.thinkingLevel
              : undefined;

          return context.taskService.create({
            parentWorkspaceId: input.parentWorkspaceId,
            kind: input.kind,
            agentId: input.agentId,
            agentType: input.agentType,
            prompt: input.prompt,
            title: input.title,
            modelString: input.modelString,
            thinkingLevel,
            sticky: input.sticky,
          });
        }),
    },
    window: {
      setTitle: t
        .input(schemas.window.setTitle.input)
        .output(schemas.window.setTitle.output)
        .handler(({ context, input }) => {
          return context.windowService.setTitle(input.title);
        }),
    },
    terminal: {
      create: t
        .input(schemas.terminal.create.input)
        .output(schemas.terminal.create.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.create(input);
        }),
      close: t
        .input(schemas.terminal.close.input)
        .output(schemas.terminal.close.output)
        .handler(({ context, input }) => {
          return context.terminalService.close(input.sessionId);
        }),
      resize: t
        .input(schemas.terminal.resize.input)
        .output(schemas.terminal.resize.output)
        .handler(({ context, input }) => {
          return context.terminalService.resize(input);
        }),
      sendInput: t
        .input(schemas.terminal.sendInput.input)
        .output(schemas.terminal.sendInput.output)
        .handler(({ context, input }) => {
          context.terminalService.sendInput(input.sessionId, input.data);
        }),
      onOutput: t
        .input(schemas.terminal.onOutput.input)
        .output(schemas.terminal.onOutput.output)
        .handler(async function* ({ context, input, signal }) {
          if (signal?.aborted) {
            return;
          }

          let resolveNext: ((value: string | null) => void) | null = null;
          const queue: string[] = [];
          let ended = false;

          const push = (data: string) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(data);
            } else {
              queue.push(data);
            }
          };

          const unsubscribe = context.terminalService.onOutput(input.sessionId, push);

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }

              const data = await new Promise<string | null>((resolve) => {
                resolveNext = resolve;
              });

              if (data === null || ended) {
                break;
              }

              yield data;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      attach: t
        .input(schemas.terminal.attach.input)
        .output(schemas.terminal.attach.output)
        .handler(async function* ({ context, input, signal }) {
          if (signal?.aborted) {
            return;
          }

          type AttachMessage =
            | { type: "screenState"; data: string }
            | { type: "output"; data: string };

          let resolveNext: ((value: AttachMessage | null) => void) | null = null;
          const queue: AttachMessage[] = [];
          let ended = false;

          const push = (msg: AttachMessage) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(msg);
            } else {
              queue.push(msg);
            }
          };

          // CRITICAL: Subscribe to output FIRST, BEFORE capturing screen state.
          // This ensures any output that arrives during/after getScreenState() is queued.
          const unsubscribe = context.terminalService.onOutput(input.sessionId, (data) => {
            push({ type: "output", data });
          });

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            // Capture screen state AFTER subscription is set up - guarantees no missed output
            const screenState = context.terminalService.getScreenState(input.sessionId);

            // First message is always the screen state (may be empty for new sessions)
            yield { type: "screenState" as const, data: screenState };

            // Now yield any queued output and continue with live stream
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }

              const msg = await new Promise<AttachMessage | null>((resolve) => {
                resolveNext = resolve;
              });

              if (msg === null || ended) {
                break;
              }

              yield msg;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      onExit: t
        .input(schemas.terminal.onExit.input)
        .output(schemas.terminal.onExit.output)
        .handler(async function* ({ context, input, signal }) {
          if (signal?.aborted) {
            return;
          }

          let resolveNext: ((value: number | null) => void) | null = null;
          const queue: number[] = [];
          let ended = false;

          const push = (code: number) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(code);
            } else {
              queue.push(code);
            }
          };

          const unsubscribe = context.terminalService.onExit(input.sessionId, push);

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                // Terminal only exits once, so we can finish the stream
                break;
              }

              const code = await new Promise<number | null>((resolve) => {
                resolveNext = resolve;
              });

              if (code === null || ended) {
                break;
              }

              yield code;
              break;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      openWindow: t
        .input(schemas.terminal.openWindow.input)
        .output(schemas.terminal.openWindow.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.openWindow(input.workspaceId, input.sessionId);
        }),
      closeWindow: t
        .input(schemas.terminal.closeWindow.input)
        .output(schemas.terminal.closeWindow.output)
        .handler(({ context, input }) => {
          return context.terminalService.closeWindow(input.workspaceId);
        }),
      listSessions: t
        .input(schemas.terminal.listSessions.input)
        .output(schemas.terminal.listSessions.output)
        .handler(({ context, input }) => {
          return context.terminalService.getWorkspaceSessionIds(input.workspaceId);
        }),
      openNative: t
        .input(schemas.terminal.openNative.input)
        .output(schemas.terminal.openNative.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.openNative(input.workspaceId);
        }),
      activity: {
        subscribe: t
          .input(schemas.terminal.activity.subscribe.input)
          .output(schemas.terminal.activity.subscribe.output)
          .handler(async function* ({ context, signal }) {
            if (signal?.aborted) {
              return;
            }

            const queue = withQueueHeartbeat(
              createAsyncEventQueue<
                | {
                    type: "update";
                    workspaceId: string;
                    activity: { activeCount: number; totalSessions: number };
                  }
                | { type: "heartbeat" }
              >(),
              { type: "heartbeat" as const }
            );

            const unsubscribe = context.terminalService.onActivityChange((workspaceId: string) => {
              queue.push({
                type: "update" as const,
                workspaceId,
                activity: context.terminalService.getWorkspaceActivity(workspaceId),
              });
            });

            const onAbort = () => {
              queue.end();
            };

            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }

            try {
              // Yield initial snapshot (listener registered before snapshot, so no transition lost)
              yield {
                type: "snapshot" as const,
                workspaces: context.terminalService.getAllWorkspaceActivity(),
              };

              yield* queue.iterate();
            } finally {
              signal?.removeEventListener("abort", onAbort);
              queue.end();
              unsubscribe();
            }
          }),
      },
    },
    desktop: {
      getPrereqStatus: t
        .input(schemas.desktop.getPrereqStatus.input)
        .output(schemas.desktop.getPrereqStatus.output)
        .handler(({ context }) => {
          return context.desktopSessionManager.getPrereqStatus();
        }),
      getCapability: t
        .input(schemas.desktop.getCapability.input)
        .output(schemas.desktop.getCapability.output)
        .handler(async ({ context, input }) => {
          return context.desktopSessionManager.getCapability(input.workspaceId);
        }),
      getBootstrap: t
        .input(schemas.desktop.getBootstrap.input)
        .output(schemas.desktop.getBootstrap.output)
        .handler(async ({ context, input }) => {
          const capability = await context.desktopSessionManager.getCapability(input.workspaceId);
          if (!capability.available) {
            return { capability };
          }

          const serverInfo = context.serverService.getServerInfo();
          if (serverInfo == null) {
            log.error("Desktop bootstrap failed: API server unavailable", {
              workspaceId: input.workspaceId,
            });
            return {
              capability: { available: false as const, reason: "startup_failed" as const },
            };
          }

          try {
            const session = await context.desktopSessionManager.ensureStarted(input.workspaceId);
            const sessionInfo = session.getSessionInfo();
            const startedCapability = {
              available: true as const,
              width: sessionInfo.width,
              height: sessionInfo.height,
              sessionId: sessionInfo.sessionId ?? capability.sessionId,
            };
            const token = context.desktopTokenManager.mint(
              input.workspaceId,
              startedCapability.sessionId
            );
            return {
              capability: startedCapability,
              bridgePath: DESKTOP_WS_PATH,
              token,
              localBridgeBaseUrl: serverInfo.baseUrl,
            };
          } catch (error) {
            log.error("Desktop bootstrap failed", {
              workspaceId: input.workspaceId,
              error,
            });
            return {
              capability: { available: false as const, reason: "startup_failed" as const },
            };
          }
        }),
    },
    update: {
      check: t
        .input(schemas.update.check.input)
        .output(schemas.update.check.output)
        .handler(async ({ context, input }) => {
          return context.updateService.check(input ?? undefined);
        }),
      download: t
        .input(schemas.update.download.input)
        .output(schemas.update.download.output)
        .handler(async ({ context }) => {
          return context.updateService.download();
        }),
      install: t
        .input(schemas.update.install.input)
        .output(schemas.update.install.output)
        .handler(({ context }) => {
          return context.updateService.install();
        }),
      onStatus: t
        .input(schemas.update.onStatus.input)
        .output(schemas.update.onStatus.output)
        .handler(async function* ({ context, signal }) {
          if (signal?.aborted) {
            return;
          }

          const queue = createAsyncEventQueue<UpdateStatus>();
          const unsubscribe = context.updateService.onStatus(queue.push);

          const onAbort = () => {
            queue.end();
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            yield* queue.iterate();
          } finally {
            signal?.removeEventListener("abort", onAbort);
            queue.end();
            unsubscribe();
          }
        }),
      getChannel: t
        .input(schemas.update.getChannel.input)
        .output(schemas.update.getChannel.output)
        .handler(({ context }) => {
          return context.updateService.getChannel();
        }),
      setChannel: t
        .input(schemas.update.setChannel.input)
        .output(schemas.update.setChannel.output)
        .handler(async ({ context, input }) => {
          await context.updateService.setChannel(input.channel);
        }),
    },
    menu: {
      onOpenSettings: t
        .input(schemas.menu.onOpenSettings.input)
        .output(schemas.menu.onOpenSettings.output)
        .handler(async function* ({ context, signal }) {
          if (signal?.aborted) {
            return;
          }

          // Use a sentinel value to signal events since void/undefined can't be queued
          const queue = createAsyncEventQueue<true>();
          const unsubscribe = context.menuEventService.onOpenSettings(() => queue.push(true));

          const onAbort = () => {
            queue.end();
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            for await (const _ of queue.iterate()) {
              yield undefined;
            }
          } finally {
            signal?.removeEventListener("abort", onAbort);
            queue.end();
            unsubscribe();
          }
        }),
    },
    voice: {
      transcribe: t
        .input(schemas.voice.transcribe.input)
        .output(schemas.voice.transcribe.output)
        .handler(async ({ context, input }) => {
          return context.voiceService.transcribe(input.audioBase64);
        }),
    },
    experiments: {
      getAll: t
        .input(schemas.experiments.getAll.input)
        .output(schemas.experiments.getAll.output)
        .handler(({ context }) => {
          return context.experimentsService.getAll();
        }),
      setOverride: t
        .input(schemas.experiments.setOverride.input)
        .output(schemas.experiments.setOverride.output)
        .handler(async ({ context, input }) => {
          await context.experimentsService.setOverride(input.experimentId, input.enabled);
        }),
      reload: t
        .input(schemas.experiments.reload.input)
        .output(schemas.experiments.reload.output)
        .handler(async ({ context }) => {
          await context.experimentsService.refreshAll();
        }),
    },
    debug: {
      triggerStreamError: t
        .input(schemas.debug.triggerStreamError.input)
        .output(schemas.debug.triggerStreamError.output)
        .handler(({ context, input }) => {
          return context.workspaceService.debugTriggerStreamError(
            input.workspaceId,
            input.errorMessage
          );
        }),
    },
    telemetry: {
      track: t
        .input(schemas.telemetry.track.input)
        .output(schemas.telemetry.track.output)
        .handler(({ context, input }) => {
          context.telemetryService.capture(input);
        }),
      status: t
        .input(schemas.telemetry.status.input)
        .output(schemas.telemetry.status.output)
        .handler(({ context }) => {
          return {
            enabled: context.telemetryService.isEnabled(),
            explicit: context.telemetryService.isExplicitlyDisabled(),
          };
        }),
    },
    analytics: {
      getSummary: t
        .input(schemas.analytics.getSummary.input)
        .output(schemas.analytics.getSummary.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSummary(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getSpendOverTime: t
        .input(schemas.analytics.getSpendOverTime.input)
        .output(schemas.analytics.getSpendOverTime.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSpendOverTime(input);
        }),
      getSpendByProject: t
        .input(schemas.analytics.getSpendByProject.input)
        .output(schemas.analytics.getSpendByProject.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSpendByProject(input.from ?? null, input.to ?? null);
        }),
      getSpendByModel: t
        .input(schemas.analytics.getSpendByModel.input)
        .output(schemas.analytics.getSpendByModel.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSpendByModel(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getTokensByModel: t
        .input(schemas.analytics.getTokensByModel.input)
        .output(schemas.analytics.getTokensByModel.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getTokensByModel(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getTimingDistribution: t
        .input(schemas.analytics.getTimingDistribution.input)
        .output(schemas.analytics.getTimingDistribution.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getTimingDistribution(
            input.metric,
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getAgentCostBreakdown: t
        .input(schemas.analytics.getAgentCostBreakdown.input)
        .output(schemas.analytics.getAgentCostBreakdown.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getAgentCostBreakdown(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getCacheHitRatioByProvider: t
        .input(schemas.analytics.getCacheHitRatioByProvider.input)
        .output(schemas.analytics.getCacheHitRatioByProvider.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getCacheHitRatioByProvider(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getDelegationSummary: t
        .input(schemas.analytics.getDelegationSummary.input)
        .output(schemas.analytics.getDelegationSummary.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getDelegationSummary(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      executeRawQuery: t
        .input(schemas.analytics.executeRawQuery.input)
        .output(schemas.analytics.executeRawQuery.output)
        .handler(async ({ context, input }) => {
          try {
            return await context.analyticsService.executeRawQuery(input.sql);
          } catch (error) {
            if (error instanceof ORPCError) {
              throw error;
            }

            // Only surface user-authored SQL issues as BAD_REQUEST. Worker/service
            // infrastructure faults must remain internal errors for correct health
            // signaling and retry semantics.
            if (!shouldExposeRawQueryError(error)) {
              throw error;
            }

            throw new ORPCError("BAD_REQUEST", {
              message: getErrorMessage(error),
              cause: error,
            });
          }
        }),

      getSavedQueries: t
        .input(schemas.analytics.getSavedQueries.input)
        .output(schemas.analytics.getSavedQueries.output)
        .handler(async ({ context }) => {
          return context.analyticsService.getSavedQueries();
        }),
      saveQuery: t
        .input(schemas.analytics.saveQuery.input)
        .output(schemas.analytics.saveQuery.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.saveQuery(input);
        }),
      updateSavedQuery: t
        .input(schemas.analytics.updateSavedQuery.input)
        .output(schemas.analytics.updateSavedQuery.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.updateSavedQuery(input);
        }),
      deleteSavedQuery: t
        .input(schemas.analytics.deleteSavedQuery.input)
        .output(schemas.analytics.deleteSavedQuery.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.deleteSavedQuery(input);
        }),

      rebuildDatabase: t
        .input(schemas.analytics.rebuildDatabase.input)
        .output(schemas.analytics.rebuildDatabase.output)
        .handler(async ({ context }) => {
          return context.analyticsService.rebuildAll();
        }),
    },
    onePassword: {
      isAvailable: t
        .output(schemas.onePassword.isAvailable.output)
        .handler(async ({ context }) => ({
          available: (await context.onePasswordService?.isAvailable()) ?? false,
        })),
      listVaults: t.output(schemas.onePassword.listVaults.output).handler(async ({ context }) => {
        if (!context.onePasswordService) return [];
        return context.onePasswordService.listVaults();
      }),
      listItems: t
        .input(schemas.onePassword.listItems.input)
        .output(schemas.onePassword.listItems.output)
        .handler(async ({ context, input }) => {
          if (!context.onePasswordService) return [];
          return context.onePasswordService.listItems(input.vaultId);
        }),
      getItemFields: t
        .input(schemas.onePassword.getItemFields.input)
        .output(schemas.onePassword.getItemFields.output)
        .handler(async ({ context, input }) => {
          if (!context.onePasswordService) return [];
          return context.onePasswordService.getItemFields(input.vaultId, input.itemId);
        }),
      buildReference: t
        .input(schemas.onePassword.buildReference.input)
        .output(schemas.onePassword.buildReference.output)
        .handler(({ input }) => ({
          reference: OnePasswordService.buildReference(
            input.vaultId,
            input.itemId,
            input.fieldId,
            input.sectionId ?? undefined
          ),
          label: OnePasswordService.buildLabel(
            input.vaultTitle ?? input.vaultId,
            input.itemTitle ?? input.itemId,
            input.fieldTitle ?? input.fieldId,
            input.sectionTitle ?? input.sectionId ?? undefined
          ),
        })),
    },
    ssh: {
      prompt: {
        subscribe: t
          .input(schemas.ssh.prompt.subscribe.input)
          .output(schemas.ssh.prompt.subscribe.output)
          .handler(async function* ({ context, signal }) {
            if (signal?.aborted) return;

            const service = context.sshPromptService;
            const releaseResponder = service.registerInteractiveResponder();
            const queue = createAsyncEventQueue<SshPromptEvent>();

            const onRequest = (req: SshPromptRequest) =>
              queue.push({ type: "request" as const, ...req });
            const onRemoved = (requestId: string) =>
              queue.push({ type: "removed" as const, requestId });

            // Atomic handshake: register listener + snapshot in one step.
            // No requests can be lost between snapshot and subscription.
            const { snapshot, unsubscribe } = service.subscribeRequests(onRequest, onRemoved);
            for (const req of snapshot) {
              queue.push({ type: "request" as const, ...req });
            }

            const onAbort = () => queue.end();
            signal?.addEventListener("abort", onAbort, { once: true });

            try {
              yield* queue.iterate();
            } finally {
              signal?.removeEventListener("abort", onAbort);
              releaseResponder();
              queue.end();
              unsubscribe();
            }
          }),
        respond: t
          .input(schemas.ssh.prompt.respond.input)
          .output(schemas.ssh.prompt.respond.output)
          .handler(({ context, input }) => {
            context.sshPromptService.respond(input.requestId, input.response);
            return Ok(undefined);
          }),
      },
    },
  });
};

export type AppRouter = ReturnType<typeof router>;
