/**
 * Chat command execution utilities
 * Handles executing workspace operations from slash commands
 *
 * These utilities are shared between ChatInput command handlers and UI components
 * to ensure consistent behavior and avoid duplication.
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type {
  FilePart,
  ProviderModelEntry,
  ProvidersConfigMap,
  SendMessageOptions,
} from "@/common/orpc/types";
import {
  type MuxMessageMetadata,
  type CompactionRequestData,
  type CompactionFollowUpRequest,
  type CompactionFollowUpInput,
  pickPreservedSendOptions,
} from "@/common/types/message";
import type { GoalRecordV1, GoalSetError, GoalStatus } from "@/common/types/goal";
import type { ReviewNoteData } from "@/common/types/review";
import {
  isTerminalWorkflowRunStatus,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { RUNTIME_MODE, parseRuntimeModeAndHost } from "@/common/types/runtime";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import type { Toast } from "@/browser/features/ChatInput/ChatInputToast";
import {
  formatCompactionCommandLine,
  getFollowUpContentText,
} from "@/browser/utils/compaction/format";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { type GoalDefaults } from "@/constants/goals";
import {
  hasBudgetedResumableGoal,
  hasGoalBudgetLimit,
  modelHasPricingData,
  UNPRICED_CURRENT_MODEL_GOAL_MESSAGE,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import { getContextResetSuccessMessage } from "@/browser/utils/contextResetFeedback";
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";
import {
  WORKSPACE_ONLY_COMMAND_KEYS,
  WORKSPACE_ONLY_COMMAND_TYPES,
  type WorkspaceOnlyCommandType,
} from "@/constants/slashCommands";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { resolveCompactionModel } from "@/browser/utils/messages/compactionModelPreference";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import type { ChatAttachment } from "../features/ChatInput/ChatAttachments";
import { dispatchWorkspaceSwitch } from "./workspaceEvents";
import { getRuntimeKey, copyWorkspaceStorage } from "@/common/constants/storage";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { isValidProvider } from "@/common/constants/providers";
import { openInEditor } from "@/browser/utils/openInEditor";
import {
  appendStagedAttachmentNotice,
  getStagedAttachments,
} from "@/browser/features/ChatInput/stagedAttachments";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

// ============================================================================
// Workspace Creation
// ============================================================================

import {
  createCommandToast,
  createInvalidCompactModelToast,
} from "@/browser/features/ChatInput/ChatInputToasts";
import { trackCommandUsed } from "@/common/telemetry";
import {
  addEphemeralMessage,
  getDisplayedRefineProposalHash,
} from "@/browser/stores/WorkspaceStore";
import { setGoalWithConflictRetry } from "@/browser/utils/goals/setGoalWithConflictRetry";
import { loadGoalDefaults, resolveGoalSetIntent } from "@/browser/utils/goals/resolveGoalSetIntent";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  buildWorkflowResultContextMessage,
} from "@/common/utils/workflowRunMessages";

const BUILT_IN_MODEL_SET = new Set<string>(Object.values(KNOWN_MODELS).map((model) => model.id));

export interface ForkOptions {
  client: RouterClient<AppRouter>;
  sourceWorkspaceId: string;
  newName?: string;
  sourceMessageId?: string;
  startMessage?: string;
  sendMessageOptions?: SendMessageOptions;
}

export interface ForkResult {
  success: boolean;
  workspaceInfo?: FrontendWorkspaceMetadata;
  error?: string;
}

/**
 * Fork a workspace and switch to it
 * Handles copying storage, dispatching switch event, and optionally sending start message
 *
 * Caller is responsible for error handling, logging, and showing toasts
 */
export async function forkWorkspace(options: ForkOptions): Promise<ForkResult> {
  const { client } = options;
  const result = await client.workspace.fork({
    sourceWorkspaceId: options.sourceWorkspaceId,
    newName: options.newName,
    sourceMessageId: options.sourceMessageId,
    pendingAutoTitle: Boolean(options.startMessage && options.sendMessageOptions),
  });

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to fork workspace" };
  }

  // Copy UI state to the new workspace
  copyWorkspaceStorage(options.sourceWorkspaceId, result.metadata.id);

  // Get workspace info for switching
  const workspaceInfo = await client.workspace.getInfo({ workspaceId: result.metadata.id });
  if (!workspaceInfo) {
    return { success: false, error: "Failed to get workspace info after fork" };
  }

  // Dispatch event to switch workspace
  dispatchWorkspaceSwitch(workspaceInfo);

  // If there's a start message, defer until React finishes rendering and WorkspaceStore subscribes
  // Using requestAnimationFrame ensures we wait for:
  // 1. React to process the workspace switch and update state
  // 2. Effects to run (workspaceStore.syncWorkspaces in App.tsx)
  // 3. WorkspaceStore to subscribe to the new workspace's IPC channel
  const startMessage = options.startMessage;
  const sendMessageOptions = options.sendMessageOptions;
  if (startMessage && sendMessageOptions) {
    requestAnimationFrame(() => {
      client.workspace
        .sendMessage({
          workspaceId: result.metadata.id,
          message: startMessage,
          options: sendMessageOptions,
        })
        .catch(() => {
          // Best-effort: the user can send the message manually if this fails.
        });
    });
  }

  return { success: true, workspaceInfo };
}

export interface SlashCommandContext extends Omit<CommandHandlerContext, "workspaceId" | "api"> {
  api: RouterClient<AppRouter> | null;
  workspaceId?: string;
  variant: "workspace" | "creation";
  projectPath?: string | null;
  openSettings?: (section?: string) => void;

  /** Original slash command text as typed, for durable command display. */
  rawInput?: string;

  /** Current dynamic-workflows experiment assignment for executable workflow commands. */
  dynamicWorkflowsEnabled?: boolean;

  // Global Actions
  setPreferredModel: (model: string) => void;
  setVimEnabled: (cb: (prev: boolean) => boolean) => void;

  // Workspace Actions
  onResetContext?: () => Promise<"reset" | "noop">;
  onTruncateHistory?: (percentage?: number) => Promise<void>;
  resetInputHeight: () => void;
  /** Read the latest composer text so async command failures don't overwrite newer drafts. */
  getInput?: () => string;
  /** Token identifying the command invocation that launched async follow-up work. */
  asyncCommandToken?: number;
  /** Return false when an async command completion belongs to a stale workspace/input. */
  isAsyncCommandCurrent?: (token: number, workspaceId: string) => boolean;
  /** Callback to trigger message-sent side effects (auto-scroll, auto-background) */
  onMessageSent?: (dispatchMode: QueueDispatchMode) => void;
  /** Callback to detach review context from the composer without marking it checked */
  onDetachAllReviews?: () => void;
  /** Callback to mark review IDs as checked after successful send */
  onCheckReviews?: (reviewIds: string[]) => void;
  /** Review IDs that are attached (for marking as checked on success) */
  attachedReviewIds?: string[];
}

export const WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE =
  "Freeform workflow arguments are unsupported. Use JSON args or ask the agent to run the workflow.";
const WORKFLOW_COMMAND_SUPERSEDED_MESSAGE = "Workflow command was superseded.";
const WORKFLOW_POLL_INTERVAL_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForWorkflowTerminalRun(input: {
  client: RouterClient<AppRouter>;
  workspaceId: string;
  runId: string;
  initialStatus: WorkflowRunStatus;
  isCurrent?: () => boolean;
}): Promise<WorkflowRunRecord | null> {
  let run = await input.client.workflows.getRun({
    workspaceId: input.workspaceId,
    runId: input.runId,
  });
  let status = run?.status ?? input.initialStatus;

  while (!isTerminalWorkflowRunStatus(status)) {
    if (input.isCurrent?.() === false) {
      throw new Error(WORKFLOW_COMMAND_SUPERSEDED_MESSAGE);
    }
    await delay(WORKFLOW_POLL_INTERVAL_MS);
    run = await input.client.workflows.getRun({
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
    status = run?.status ?? status;
  }

  if (input.isCurrent?.() === false) {
    throw new Error(WORKFLOW_COMMAND_SUPERSEDED_MESSAGE);
  }

  return run;
}

function parseWorkflowSlashArgs(argsText: string | undefined): unknown {
  const trimmed = argsText?.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE);
  }
}

// ============================================================================
// Command Dispatcher
// ============================================================================

/** Compiles only when T is a subset of U; used to pin constants to the parser's union. */
type SubsetOf<T extends U, U> = T;

// A typo or stale entry in WORKSPACE_ONLY_COMMAND_TYPE_LIST fails this subset
// constraint at compile time instead of being silently dropped by Extract
// (which would leave the dispatch switch exhaustive while the real command
// falls through unhandled).
type CheckedWorkspaceOnlyCommandType = SubsetOf<
  WorkspaceOnlyCommandType,
  NonNullable<ParsedCommand>["type"]
>;

type WorkspaceOnlyParsedCommand = Extract<
  NonNullable<ParsedCommand>,
  { type: CheckedWorkspaceOnlyCommandType }
>;

/**
 * Narrow a parsed command to the workspace-only subset so the dispatch switch
 * below stays compiler-checked exhaustive: adding a type to
 * WORKSPACE_ONLY_COMMAND_TYPE_LIST without a handler fails lint instead of
 * silently falling through to the generic toast path.
 */
function isWorkspaceOnlyParsedCommand(
  parsed: NonNullable<ParsedCommand>
): parsed is WorkspaceOnlyParsedCommand {
  return WORKSPACE_ONLY_COMMAND_TYPES.has(parsed.type);
}

/**
 * Process any slash command
 * Returns true if the command was handled (even if it failed)
 * Returns false if it's not a command (should be sent as message) - though parsed usually implies it is a command
 */
export async function processSlashCommand(
  parsed: ParsedCommand,
  context: SlashCommandContext
): Promise<CommandHandlerResult> {
  if (!parsed) return { clearInput: false, toastShown: false };
  const { api: client, setInput, setToast, variant, setVimEnabled, setPreferredModel } = context;

  const requireClient = (): RouterClient<AppRouter> | null => {
    if (client) return client;
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "Not connected to server",
    });
    return null;
  };

  // 1. Global Commands
  if (parsed.type === "model-set") {
    const modelString = parsed.modelString;

    const activeClient = client;
    const normalized = normalizeModelInput(modelString);

    if (!normalized.model) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: `Invalid model format: expected "provider:model"`,
      });
      return { clearInput: false, toastShown: true };
    }

    const selectedModel = normalized.model;
    const separatorIndex = selectedModel.indexOf(":");
    const provider = selectedModel.slice(0, separatorIndex);
    const modelId = selectedModel.slice(separatorIndex + 1);
    const canonicalModel = normalizeToCanonical(selectedModel);
    const explicitGateway = getExplicitGatewayPrefix(selectedModel);

    try {
      let providersConfig: ProvidersConfigMap | null = null;
      let providersConfigLoadFailed = false;
      if (activeClient) {
        try {
          providersConfig = await activeClient.providers.getConfig();
        } catch (error) {
          providersConfigLoadFailed = true;
          console.error("Failed to load provider settings:", error);
        }
      }

      const providerConfig = providersConfig?.[provider];
      if (!isValidProvider(provider) && !isCustomProviderConfig(providerConfig)) {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: providersConfigLoadFailed
            ? `Could not verify provider "${provider}": backend unreachable. Please retry.`
            : `Unknown provider "${provider}"`,
        });
        return { clearInput: false, toastShown: true };
      }

      if (
        !modelHasPricingData(selectedModel, providersConfig ?? null) &&
        (await hasBudgetedResumableGoalForWorkspaceModelSwitch(context))
      ) {
        showUnpricedModelGoalToast(setToast, "target");
        return { clearInput: false, toastShown: true };
      }

      // Align with settings behavior: only persist non-built-in direct-provider models.
      if (
        activeClient &&
        providersConfig &&
        !BUILT_IN_MODEL_SET.has(canonicalModel) &&
        !explicitGateway
      ) {
        try {
          const existingModels: ProviderModelEntry[] = providerConfig?.models ?? [];
          if (!existingModels.some((entry) => getProviderModelEntryId(entry) === modelId)) {
            // Add model via the same API as settings
            await activeClient.providers.setModels({
              provider,
              models: [...existingModels, modelId],
            });
          }
        } catch (error) {
          console.error("Failed to sync model settings:", error);
        }
      }

      setInput("");
      setPreferredModel(selectedModel);
      trackCommandUsed("model");
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: `Model changed to ${selectedModel}`,
      });
      return { clearInput: true, toastShown: true };
    } catch (error) {
      console.error("Failed to update model:", error);
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: error instanceof Error ? error.message : "Failed to update model",
      });
      return { clearInput: false, toastShown: true };
    }
  }

  // model-oneshot ("/<model-alias> ...") is handled directly in ChatInput.
  // This keeps the command parsing centralized, but routes actual sending through the
  // normal message-send flow (so side effects like review completion and last-read
  // tracking can't drift).

  if (parsed.type === "model-oneshot") {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "Model one-shot is handled in the chat input.",
    });
    return { clearInput: false, toastShown: true };
  }

  if (parsed.type === "workflow-run") {
    const workflowsEnabled =
      context.dynamicWorkflowsEnabled ??
      isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS) === true;
    if (!workflowsEnabled) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: "Dynamic workflows are disabled",
      });
      return { clearInput: false, toastShown: true };
    }

    const activeClient = requireClient();
    if (!activeClient) {
      return { clearInput: false, toastShown: true };
    }
    if (!context.workspaceId) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: "No workspace selected",
      });
      return { clearInput: false, toastShown: true };
    }

    let args: unknown;
    try {
      args = parseWorkflowSlashArgs(parsed.argsText);
    } catch (error) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: error instanceof Error ? error.message : "Invalid workflow arguments",
      });
      return { clearInput: false, toastShown: true };
    }

    const workspaceId = context.workspaceId;
    const scriptPath = parsed.scriptPath;
    const rawInput = context.rawInput?.trim();
    const rawCommand = rawInput && rawInput.length > 0 ? rawInput : `/${scriptPath}`;
    const commandPrefix = rawCommand.split(/\s+/u)[0] ?? `/${scriptPath}`;
    const isCurrent =
      context.asyncCommandToken != null && context.isAsyncCommandCurrent != null
        ? () => context.isAsyncCommandCurrent?.(context.asyncCommandToken!, workspaceId) !== false
        : undefined;

    setInput("");
    let sendingStateActive = false;
    const setWorkflowSendingState = (active: boolean) => {
      if (sendingStateActive === active) {
        return;
      }
      sendingStateActive = active;
      context.setSendingState(active);
    };

    setWorkflowSendingState(true);
    try {
      const result = await activeClient.workflows.start({
        workspaceId,
        scriptPath,
        runInBackground: true,
        args,
        continuationOptions: context.sendMessageOptions,
        rawCommand,
      });
      // The workflow is durable and backgrounded; do not pin the composer while polling for
      // completion, otherwise the user cannot supersede a long-running slash workflow.
      setWorkflowSendingState(false);
      if (result.invocationMessagePersisted === true) {
        trackCommandUsed("workflow");
        setToast({
          id: Date.now().toString(),
          type: "success",
          message: `Workflow ${scriptPath} started`,
        });
        return { clearInput: true, toastShown: true };
      }
      const run = await waitForWorkflowTerminalRun({
        client: activeClient,
        workspaceId,
        runId: result.runId,
        initialStatus: result.status,
        isCurrent,
      });
      const terminalStatus = run?.status ?? result.status;
      if (terminalStatus === "interrupted") {
        trackCommandUsed("workflow");
        setToast({
          id: Date.now().toString(),
          type: "success",
          message: `Workflow ${scriptPath} interrupted`,
        });
        return { clearInput: true, toastShown: true };
      }
      const workflowResultMessage = buildWorkflowResultContextMessage({
        rawCommand,
        name: scriptPath,
        runId: result.runId,
        status: terminalStatus,
        result: result.result,
        run,
      });
      // Keep workflow outputs model-visible but UI-hidden: rawCommand drives transcript display,
      // while the XML block below gives the main agent the completed workflow result.
      setWorkflowSendingState(true);
      const sendResult = await activeClient.workspace.sendMessage({
        workspaceId,
        message: workflowResultMessage,
        options: {
          ...context.sendMessageOptions,
          muxMetadata: {
            type: WORKFLOW_RESULT_METADATA_TYPE,
            rawCommand,
            commandPrefix,
            runId: result.runId,
            requestedModel: context.sendMessageOptions.model,
          },
        },
      });
      if (!sendResult.success) {
        throw new Error("Failed to send workflow result to the agent");
      }
      context.onMessageSent?.(context.sendMessageOptions.queueDispatchMode ?? "tool-end");
      trackCommandUsed("workflow");
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: `Workflow ${scriptPath} ${terminalStatus}`,
      });
      return { clearInput: true, toastShown: true };
    } catch (error) {
      if (error instanceof Error && error.message === WORKFLOW_COMMAND_SUPERSEDED_MESSAGE) {
        return { clearInput: true, toastShown: false };
      }
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: error instanceof Error ? error.message : "Failed to run workflow",
      });
      const currentInput = context.getInput?.();
      const shouldRestoreCommand = currentInput === undefined || currentInput.trim().length === 0;
      return { clearInput: !shouldRestoreCommand, toastShown: true };
    } finally {
      setWorkflowSendingState(false);
    }
  }

  if (parsed.type === "debug-llm-request") {
    setInput("");
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST));
    return { clearInput: true, toastShown: false };
  }

  if (parsed.type === "idle-compaction") {
    const activeClient = requireClient();
    if (!activeClient) {
      return { clearInput: false, toastShown: true };
    }

    if (!context.projectPath) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: "No project selected",
      });
      return { clearInput: false, toastShown: true };
    }

    setInput("");

    try {
      const result = await activeClient.projects.idleCompaction.set({
        projectPath: context.projectPath,
        hours: parsed.hours,
      });

      if (!result.success) {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: result.error ?? "Failed to update setting",
        });
        return { clearInput: false, toastShown: true };
      }

      setToast({
        id: Date.now().toString(),
        type: "success",
        message: parsed.hours
          ? `Idle compaction set to ${parsed.hours} hours`
          : "Idle compaction disabled",
      });
      return { clearInput: true, toastShown: true };
    } catch (error) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: error instanceof Error ? error.message : "Failed to update setting",
      });
      return { clearInput: false, toastShown: true };
    }
  }

  if (parsed.type === "heartbeat-set") {
    const activeClient = requireClient();
    if (!activeClient) {
      return { clearInput: false, toastShown: true };
    }

    // Manual /heartbeat invocations stay gated until the experiment is explicitly enabled.
    // Guard the experiment check so non-browser test environments treat it as disabled safely.
    let heartbeatExperimentEnabled: boolean | undefined;
    try {
      heartbeatExperimentEnabled = isExperimentEnabled(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS);
    } catch {
      heartbeatExperimentEnabled = false;
    }
    if (!heartbeatExperimentEnabled) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message:
          "Heartbeat configuration requires the Workspace Heartbeats experiment to be enabled",
      });
      return { clearInput: false, toastShown: true };
    }

    if (!context.workspaceId) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: "No workspace selected",
      });
      return { clearInput: false, toastShown: true };
    }

    setInput("");

    try {
      // Best-effort read: malformed persisted heartbeat settings should not block a command that
      // can repair them by writing a fresh interval or disabling the feature.
      let currentHeartbeatSettings: Awaited<
        ReturnType<typeof activeClient.workspace.heartbeat.get>
      > | null = null;
      try {
        currentHeartbeatSettings = await activeClient.workspace.heartbeat.get({
          workspaceId: context.workspaceId,
        });
      } catch {
        currentHeartbeatSettings = null;
      }

      // Preserve the stored cadence when toggling heartbeats off so re-enabling restores it,
      // and keep any saved custom heartbeat message when commands only change cadence.
      const intervalMs =
        parsed.minutes === null
          ? (currentHeartbeatSettings?.intervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS)
          : parsed.minutes * 60 * 1000;
      const result = await activeClient.workspace.heartbeat.set({
        workspaceId: context.workspaceId,
        enabled: parsed.minutes !== null,
        intervalMs,
        // Omit message when the best-effort read failed; WorkspaceService preserves the
        // persisted custom message when this field is absent.
        ...(currentHeartbeatSettings?.message != null
          ? { message: currentHeartbeatSettings.message }
          : {}),
      });

      if (!result.success) {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: result.error ?? "Failed to update setting",
        });
        return { clearInput: false, toastShown: true };
      }

      setToast({
        id: Date.now().toString(),
        type: "success",
        message:
          parsed.minutes === null
            ? "Heartbeat disabled"
            : `Heartbeat set to every ${parsed.minutes} minutes`,
      });
      return { clearInput: true, toastShown: true };
    } catch (error) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: error instanceof Error ? error.message : "Failed to update setting",
      });
      return { clearInput: false, toastShown: true };
    }
  }

  if (parsed.type === "vim-toggle") {
    setInput("");
    setVimEnabled((prev) => !prev);
    trackCommandUsed("vim");
    return { clearInput: true, toastShown: false };
  }

  // 2. Workspace Commands
  // Use command keys for help/invalid variants so creation mode doesn't surface workspace-only help text.
  const workspaceOnlyKey = (() => {
    switch (parsed.type) {
      case "command-missing-args":
      case "command-invalid-args":
      case "command-unknown-flag":
      case "unknown-command":
        return parsed.command;
      default:
        return null;
    }
  })();

  const isWorkspaceCommandType = isWorkspaceOnlyParsedCommand(parsed);
  const isWorkspaceOnlyCommand =
    isWorkspaceCommandType ||
    (workspaceOnlyKey ? WORKSPACE_ONLY_COMMAND_KEYS.has(workspaceOnlyKey) : false);

  if (isWorkspaceOnlyCommand && variant !== "workspace") {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "Command not available during workspace creation",
    });
    return { clearInput: false, toastShown: true };
  }

  if (isWorkspaceCommandType) {
    // Dispatch workspace commands
    switch (parsed.type) {
      case "clear":
        return handleClearCommand(parsed, context);
      case "compact":
        // handleCompactCommand expects workspaceId in context
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handleCompactCommand(parsed, {
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "dream": {
        if (!context.workspaceId) throw new Error("Workspace ID required");
        const dreamClient = requireClient();
        if (!dreamClient) {
          return { clearInput: false, toastShown: true };
        }
        // Fire-and-forget by design (PRD #3534): the dream run is background
        // housekeeping; results surface in the Memory tab, not the chat. The
        // only toast is the settle toast — an optimistic "started" success
        // toast would flash green-then-red whenever the backend rejects
        // immediately (experiment off, debounced, run already in flight).
        const dreamWorkspaceId = context.workspaceId;
        void dreamClient.memory
          .consolidate({ workspaceId: dreamWorkspaceId })
          .then((result) => {
            // "Changes" counts applied ops only; the journal also records
            // rejected/failed commands, which are not changes.
            const applied = result.success ? result.data.ops.filter((op) => op.applied).length : 0;
            context.setToast(
              result.success
                ? {
                    id: Date.now().toString(),
                    type: "success",
                    message:
                      applied === 0
                        ? "Memory consolidation: no changes needed"
                        : `Memory consolidated: ${applied} change(s)`,
                  }
                : {
                    id: Date.now().toString(),
                    type: "error",
                    message: `Memory consolidation failed: ${result.error}`,
                  }
            );
          })
          .catch((error: unknown) => {
            context.setToast({
              id: Date.now().toString(),
              type: "error",
              message: `Memory consolidation failed: ${String(error)}`,
            });
          });
        return { clearInput: true, toastShown: true };
      }
      case "refine": {
        if (!context.workspaceId) throw new Error("Workspace ID required");
        const refineClient = requireClient();
        if (!refineClient) {
          return { clearInput: false, toastShown: true };
        }
        // Fire-and-forget like /dream: the pass runs in the background and
        // posts its own labeled summary row into the chat when edits were
        // staged/applied. Only the settle toast is shown — an optimistic
        // "started" toast would flash green-then-red when the backend rejects
        // immediately (RLM off, run already in flight). Plain /refine only
        // STAGES edits (security: model output is never auto-applied);
        // /refine apply is the explicit approval step.
        const refineWorkspaceId = context.workspaceId;
        const refineApply = parsed.apply === true;
        // Ride the renderer's effective experiment flags with the request:
        // backend override persistence is asynchronous/best-effort, so a
        // backend-only gate could refuse /refine while this client already
        // offers the command and runs with the RLM kernel.
        const refineExperiments = context.sendMessageOptions.experiments;
        // r64: bind approval to the proposal THIS window rendered. The shared
        // transcript can hold a newer foreign proposal (second app instance
        // over the same root) that this renderer never displayed; the backend
        // refuses to apply when the staged set no longer hashes to the
        // proposal we send here.
        const displayedProposalHash = refineApply
          ? getDisplayedRefineProposalHash(refineWorkspaceId)
          : null;
        if (refineApply && displayedProposalHash === null) {
          context.setToast({
            id: Date.now().toString(),
            type: "error",
            message:
              "Refine failed: no staged /refine proposal is visible in this chat; run /refine first",
          });
          return { clearInput: true, toastShown: true };
        }
        void (
          refineApply && displayedProposalHash !== null
            ? refineClient.refinements.apply({
                workspaceId: refineWorkspaceId,
                approvedProposalHash: displayedProposalHash,
                experiments: refineExperiments,
              })
            : refineClient.refinements.run({
                workspaceId: refineWorkspaceId,
                experiments: refineExperiments,
              })
        )
          .then((result) => {
            // untrackedApplied: edits that succeeded but could not be
            // journaled (no rollback id) — still real, so counted.
            const appliedCount = result.success
              ? result.data.applied.length + (result.data.untrackedApplied ?? 0)
              : 0;
            const failedCount = result.success ? (result.data.failed?.length ?? 0) : 0;
            // r55: an apply where every edit failed (e.g. all staged targets
            // changed) returns success:true with zero applied edits — a green
            // "0 edit(s) applied, N failed" toast would read like the
            // approved changes landed. Surface it as an error instead.
            const allFailed =
              result.success &&
              refineApply &&
              !result.data.noOp &&
              appliedCount === 0 &&
              failedCount > 0;
            context.setToast(
              result.success
                ? {
                    id: Date.now().toString(),
                    type: allFailed ? "error" : "success",
                    message: result.data.noOp
                      ? refineApply
                        ? "Refine: nothing was applied"
                        : "Refine: nothing worth distilling"
                      : refineApply
                        ? `Refine: ${appliedCount} edit(s) applied${
                            failedCount > 0 ? `, ${failedCount} failed` : ""
                          } (see chat summary)`
                        : `Refine: ${result.data.staged?.length ?? 0} edit(s) staged — approve with /refine apply`,
                  }
                : {
                    id: Date.now().toString(),
                    type: "error",
                    message: `Refine failed: ${result.error}`,
                  }
            );
          })
          .catch((error: unknown) => {
            context.setToast({
              id: Date.now().toString(),
              type: "error",
              message: `Refine failed: ${String(error)}`,
            });
          });
        return { clearInput: true, toastShown: true };
      }
      case "fork":
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handleForkCommand(parsed, {
          ...context,
          api: client,
        });
      case "new":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handleNewCommand(parsed, {
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "plan-show":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handlePlanShowCommand({
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "plan-open":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handlePlanOpenCommand({
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "goal-show":
      case "goal-set":
      case "goal-budget":
      case "goal-pause":
      case "goal-resume":
      case "goal-complete":
      case "goal-clear":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handleGoalCommand(parsed, {
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      // No default: parsed is narrowed to workspace-only commands (minus
      // workflow-run/heartbeat-set, which returned above), so adding a type
      // to WORKSPACE_ONLY_COMMAND_TYPE_LIST without a case fails the
      // switch-exhaustiveness lint here.
    }
  }

  // 3. Fallback / Help / Unknown
  const commandToast = createCommandToast(parsed);
  if (commandToast) {
    setToast(commandToast);
    return { clearInput: false, toastShown: true };
  }

  return { clearInput: false, toastShown: false };
}

// ============================================================================
// Command Handlers
// ============================================================================

// Slash-command intents only ever produce user-facing transitions; the
// internal `budget_limited` status is now excluded from the public oRPC
// `setGoal` input shape (Coder-agents-review nit DEREM-53).
type PublicSetGoalStatus = Exclude<GoalStatus, "budget_limited">;

interface GoalSetCommandIntent {
  objective?: string | null;
  status?: PublicSetGoalStatus | null;
  budgetCents?: number | null;
  turnCap?: number | null;
  completionSummary?: string | null;
}

type GoalSetCommandResult =
  | { success: true; goal: GoalRecordV1 }
  | { success: false; error: GoalSetError };

async function setGoalWithSingleConflictRetry(
  context: CommandHandlerContext,
  intent: GoalSetCommandIntent
): Promise<GoalSetCommandResult> {
  // Shared retry helper centralized in `@/browser/utils/goals/` to avoid the
  // three-way drift Coder-agents-review P3 DEREM-25 flagged. Adapts the raw
  // API result to the typed `GoalSetCommandResult` this caller exposes.
  const result = await setGoalWithConflictRetry(context.api, context.workspaceId, intent);
  if (result.success) {
    return { success: true, goal: result.data };
  }
  return { success: false, error: result.error };
}

async function getGoalDefaults(context: CommandHandlerContext): Promise<GoalDefaults> {
  // Centralized in `@/browser/utils/goals/` so the slash command path and
  // the command palette path read defaults the same way (Coder-agents-
  // review P3 DEREM-27). Pass the workspaceId so the helper layers any
  // per-workspace override on top of the global default — workspace rules
  // win for `/goal` invocations inside that workspace.
  return loadGoalDefaults(context.api, context.workspaceId);
}

function resolveSlashGoalSetIntent(
  parsed: Extract<ParsedCommand, { type: "goal-set" }>,
  defaults: GoalDefaults
): GoalSetCommandIntent {
  // The slash command's parser leaves `budgetCents`/`turnCap` undefined
  // when omitted (rather than `null`), so we forward as-is to the shared
  // resolver which treats `undefined` as "apply default".
  return resolveGoalSetIntent(
    {
      objective: parsed.objective,
      ...(Object.hasOwn(parsed, "budgetCents") ? { budgetCents: parsed.budgetCents ?? null } : {}),
      ...(Object.hasOwn(parsed, "turnCap") ? { turnCap: parsed.turnCap ?? null } : {}),
    },
    defaults
  );
}

async function hasBudgetedResumableGoalForWorkspaceModelSwitch(
  context: SlashCommandContext
): Promise<boolean> {
  if (context.variant !== "workspace" || !context.api || !context.workspaceId) {
    return false;
  }

  try {
    const result = await context.api.workspace.getGoal({ workspaceId: context.workspaceId });
    return hasBudgetedResumableGoal(result.goal);
  } catch {
    return false;
  }
}

async function currentModelHasPricingData(context: CommandHandlerContext): Promise<boolean> {
  let providersConfig: unknown = null;
  try {
    providersConfig = await context.api.providers.getConfig();
  } catch {
    providersConfig = null;
  }
  return modelHasPricingData(context.sendMessageOptions.model, providersConfig);
}

function showUnpricedModelGoalToast(
  setToast: (toast: Toast) => void,
  modelPosition: "current" | "target" = "current"
): void {
  setToast({
    id: Date.now().toString(),
    type: "error",
    message:
      modelPosition === "current"
        ? UNPRICED_CURRENT_MODEL_GOAL_MESSAGE
        : UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
  });
}

function getGoalSetErrorMessage(error: GoalSetError): string {
  if (error.type === "goal_conflict") {
    return "Goal changed in another window. Please try again.";
  }
  return error.message;
}

function showGoalSetErrorToast(setToast: (toast: Toast) => void, error: GoalSetError): void {
  setToast({
    id: Date.now().toString(),
    type: "error",
    message: getGoalSetErrorMessage(error),
  });
}

async function handleGoalCommand(
  parsed: Extract<
    ParsedCommand,
    {
      type:
        | "goal-show"
        | "goal-set"
        | "goal-budget"
        | "goal-pause"
        | "goal-resume"
        | "goal-complete"
        | "goal-clear";
    }
  >,
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const { api, workspaceId, setInput, setToast } = context;

  setInput("");

  try {
    if (parsed.type === "goal-show") {
      const result = await api.workspace.getGoal({ workspaceId });
      if (result.goal) {
        window.dispatchEvent?.(createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId }));
        return { clearInput: true, toastShown: false };
      }

      setToast({
        id: Date.now().toString(),
        type: "success",
        message: "No goal is set. Use /goal <objective> to create one.",
      });
      return { clearInput: true, toastShown: true };
    }

    if (parsed.type === "goal-pause") {
      const result = await setGoalWithSingleConflictRetry(context, { status: "paused" });
      if (!result.success) {
        showGoalSetErrorToast(setToast, result.error);
        return { clearInput: false, toastShown: true };
      }
      setToast({ id: Date.now().toString(), type: "success", message: "Goal paused" });
      trackCommandUsed("goal");
      return { clearInput: true, toastShown: true };
    }

    if (parsed.type === "goal-resume") {
      const currentGoal = await api.workspace.getGoal({ workspaceId });
      if (
        hasBudgetedResumableGoal(currentGoal.goal) &&
        !(await currentModelHasPricingData(context))
      ) {
        showUnpricedModelGoalToast(setToast);
        return { clearInput: false, toastShown: true };
      }

      const result = await setGoalWithSingleConflictRetry(context, { status: "active" });
      if (!result.success) {
        showGoalSetErrorToast(setToast, result.error);
        return { clearInput: false, toastShown: true };
      }
      setToast({ id: Date.now().toString(), type: "success", message: "Goal resumed" });
      trackCommandUsed("goal");
      return { clearInput: true, toastShown: true };
    }

    if (parsed.type === "goal-complete") {
      if (!parsed.summary) {
        window.dispatchEvent?.(
          createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, {
            workspaceId,
            openCompleteInput: true,
          })
        );
        return { clearInput: true, toastShown: false };
      }

      const result = await setGoalWithSingleConflictRetry(context, {
        status: "complete",
        completionSummary: parsed.summary,
      });
      if (!result.success) {
        showGoalSetErrorToast(setToast, result.error);
        return { clearInput: false, toastShown: true };
      }
      setToast({ id: Date.now().toString(), type: "success", message: "Goal marked complete" });
      window.dispatchEvent?.(createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId }));
      trackCommandUsed("goal");
      return { clearInput: true, toastShown: true };
    }

    if (parsed.type === "goal-clear") {
      const result = await api.workspace.clearGoal({ workspaceId });
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: result.cleared ? "Goal cleared" : "No goal was set",
      });
      trackCommandUsed("goal");
      return { clearInput: true, toastShown: true };
    }

    if (parsed.type === "goal-budget") {
      if (hasGoalBudgetLimit(parsed.budgetCents) && !(await currentModelHasPricingData(context))) {
        showUnpricedModelGoalToast(setToast);
        return { clearInput: false, toastShown: true };
      }

      const result = await setGoalWithSingleConflictRetry(context, {
        budgetCents: parsed.budgetCents,
      });
      if (!result.success) {
        showGoalSetErrorToast(setToast, result.error);
        return { clearInput: false, toastShown: true };
      }
      setToast({ id: Date.now().toString(), type: "success", message: "Goal budget updated" });
      window.dispatchEvent?.(createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId }));
      trackCommandUsed("goal");
      return { clearInput: true, toastShown: true };
    }

    const goalDefaults = await getGoalDefaults(context);
    const goalSetIntent = resolveSlashGoalSetIntent(parsed, goalDefaults);
    if (
      hasGoalBudgetLimit(goalSetIntent.budgetCents) &&
      !(await currentModelHasPricingData(context))
    ) {
      showUnpricedModelGoalToast(setToast);
      return { clearInput: false, toastShown: true };
    }

    const result = await setGoalWithSingleConflictRetry(context, goalSetIntent);
    if (!result.success) {
      showGoalSetErrorToast(setToast, result.error);
      return { clearInput: false, toastShown: true };
    }
    window.dispatchEvent?.(createCustomEvent(CUSTOM_EVENTS.OPEN_GOAL_TAB, { workspaceId }));
    trackCommandUsed("goal");
    return { clearInput: true, toastShown: false };
  } catch (error) {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: error instanceof Error ? error.message : "Goal command failed",
    });
    return { clearInput: false, toastShown: true };
  }
}

async function handleClearCommand(
  parsed: Extract<ParsedCommand, { type: "clear" }>,
  context: SlashCommandContext
): Promise<CommandHandlerResult> {
  const {
    setInput,
    setAttachments,
    onDetachAllReviews,
    onResetContext,
    onTruncateHistory,
    resetInputHeight,
    setToast,
  } = context;

  if (parsed.mode === "soft") {
    if (!onResetContext) return { clearInput: true, toastShown: false };

    try {
      const result = await onResetContext();
      setInput("");
      resetInputHeight();
      if (result === "reset") {
        setAttachments([]);
        onDetachAllReviews?.();
      }
      trackCommandUsed("clear:soft");
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: getContextResetSuccessMessage(result),
      });
      return { clearInput: true, toastShown: true };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Failed to reset context");
      console.error("Failed to reset context:", normalized);
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: normalized.message,
      });
      return { clearInput: false, toastShown: true };
    }
  }

  setInput("");
  resetInputHeight();

  if (!onTruncateHistory) return { clearInput: true, toastShown: false };

  try {
    await onTruncateHistory(1.0);
    setAttachments([]);
    onDetachAllReviews?.();
    trackCommandUsed("clear:hard");
    setToast({
      id: Date.now().toString(),
      type: "success",
      message: "Chat history cleared",
    });
    return { clearInput: true, toastShown: true };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Failed to clear history");
    console.error("Failed to clear history:", normalized);
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: normalized.message,
    });
    return { clearInput: false, toastShown: true };
  }
}

async function handleForkCommand(
  parsed: Extract<ParsedCommand, { type: "fork" }>,
  context: SlashCommandContext
): Promise<CommandHandlerResult> {
  const {
    api: client,
    workspaceId,
    sendMessageOptions,
    setInput,
    setSendingState,
    setToast,
  } = context;

  setInput(""); // Clear input immediately
  setSendingState(true);

  try {
    // Note: workspaceId is required for fork, but SlashCommandContext allows undefined workspaceId.
    // If we are here, variant === "workspace", so workspaceId should be defined.
    if (!workspaceId) throw new Error("Workspace ID required for fork");

    if (!client) throw new Error("Client required for fork");
    const forkResult = await forkWorkspace({
      client,
      sourceWorkspaceId: workspaceId,
      startMessage: parsed.startMessage,
      sendMessageOptions,
    });

    if (!forkResult.success) {
      const errorMsg = forkResult.error ?? "Failed to fork workspace";
      console.error("Failed to fork workspace:", errorMsg);
      setToast({
        id: Date.now().toString(),
        type: "error",
        title: "Fork Failed",
        message: errorMsg,
      });
      return { clearInput: false, toastShown: true };
    } else {
      trackCommandUsed("fork");
      const displayName =
        forkResult.workspaceInfo?.title ?? forkResult.workspaceInfo?.name ?? "new workspace";
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: `Forked to workspace "${displayName}"`,
      });
      return { clearInput: true, toastShown: true };
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Failed to fork workspace");
    console.error("Fork error:", normalized);
    setToast({
      id: Date.now().toString(),
      type: "error",
      title: "Fork Failed",
      message: normalized.message,
    });
    return { clearInput: false, toastShown: true };
  } finally {
    setSendingState(false);
  }
}

/**
 * Parse runtime string from -r flag into RuntimeConfig for backend.
 * Uses shared parseRuntimeModeAndHost for parsing, then converts to RuntimeConfig.
 *
 * Supports formats:
 * - "ssh <host>" or "ssh <user@host>" -> SSH runtime
 * - "docker <image>" -> Docker container runtime
 * - "worktree" -> Worktree runtime (git worktrees)
 * - "local" -> Local runtime (project-dir, no isolation)
 * - "devcontainer <configPath>" -> Dev container runtime
 * - undefined -> Worktree runtime (default)
 */
export function parseRuntimeString(runtime: string | undefined): RuntimeConfig | undefined {
  // Use shared parser from common/types/runtime
  const parsed = parseRuntimeModeAndHost(runtime);

  // null means invalid input (e.g., "ssh" without host, "docker" without image)
  if (parsed === null) {
    // Determine which error to throw based on input
    const trimmed = runtime?.trim().toLowerCase() ?? "";
    if (trimmed === RUNTIME_MODE.SSH || trimmed.startsWith("ssh ")) {
      throw new Error("SSH runtime requires host (e.g., 'ssh hostname' or 'ssh user@host')");
    }
    if (trimmed === RUNTIME_MODE.DOCKER || trimmed.startsWith("docker ")) {
      throw new Error("Docker runtime requires image (e.g., 'docker ubuntu:22.04')");
    }
    if (trimmed === RUNTIME_MODE.DEVCONTAINER || trimmed.startsWith("devcontainer")) {
      throw new Error(
        "Dev container runtime requires a config path (e.g., 'devcontainer .devcontainer/devcontainer.json')"
      );
    }
    throw new Error(
      `Unknown runtime type: '${runtime ?? ""}'. Use 'ssh <host>', 'docker <image>', 'devcontainer <config>', 'worktree', or 'local'`
    );
  }

  // Convert ParsedRuntime to RuntimeConfig
  switch (parsed.mode) {
    case RUNTIME_MODE.WORKTREE:
      return undefined; // Let backend use default worktree config

    case RUNTIME_MODE.LOCAL:
      return { type: RUNTIME_MODE.LOCAL };

    case RUNTIME_MODE.SSH:
      return {
        type: RUNTIME_MODE.SSH,
        host: parsed.host,
        // Stable SSH remote layout is still ~/mux (same as buildRuntimeConfig /
        // CLI parseRuntimeConfig). Local Xum home and SSH product-home compat
        // live elsewhere; this default is a persisted remote path contract.
        srcBaseDir: "~/mux",
      };

    case RUNTIME_MODE.DEVCONTAINER: {
      const configPath = parsed.configPath.trim();
      if (!configPath) {
        throw new Error(
          "Dev container runtime requires a config path (e.g., 'devcontainer .devcontainer/devcontainer.json')"
        );
      }
      return {
        type: RUNTIME_MODE.DEVCONTAINER,
        configPath,
      };
    }
    case RUNTIME_MODE.DOCKER:
      return {
        type: RUNTIME_MODE.DOCKER,
        image: parsed.image,
      };
  }
}

export interface CreateWorkspaceOptions {
  client: RouterClient<AppRouter>;
  projectPath: string;
  /**
   * Workspace branch name. When omitted, the backend auto-generates one
   * (e.g., "workspace-1", "workspace-2") so /new can mirror /fork's
   * seamless creation flow.
   */
  workspaceName?: string;
  trunkBranch?: string;
  runtime?: string;
  startMessage?: string;
  sendMessageOptions?: SendMessageOptions;
  /**
   * When true, ask the backend to mark the workspace with `pendingAutoTitle`
   * so the start message drives LLM-based title generation (mirrors /fork).
   */
  pendingAutoTitle?: boolean;
}

export interface CreateWorkspaceResult {
  success: boolean;
  workspaceInfo?: FrontendWorkspaceMetadata;
  error?: string;
}

/**
 * Create a new workspace and switch to it
 * Handles backend creation, dispatching switch event, and optionally sending start message
 *
 * Shared between /new command and NewWorkspaceModal
 */
export async function createNewWorkspace(
  options: CreateWorkspaceOptions
): Promise<CreateWorkspaceResult> {
  // Get recommended trunk if not provided
  let effectiveTrunk = options.trunkBranch;
  if (!effectiveTrunk) {
    const { recommendedTrunk } = await options.client.projects.listBranches({
      projectPath: options.projectPath,
    });
    effectiveTrunk = recommendedTrunk ?? "main";
  }

  // Use saved default runtime preference if not explicitly provided
  let effectiveRuntime = options.runtime;
  if (effectiveRuntime === undefined) {
    const runtimeKey = getRuntimeKey(options.projectPath);
    const savedRuntime = localStorage.getItem(runtimeKey);
    if (savedRuntime) {
      effectiveRuntime = savedRuntime;
    }
  }

  // Parse runtime config if provided.
  const runtimeConfig = parseRuntimeString(effectiveRuntime);

  const result = await options.client.workspace.create({
    projectPath: options.projectPath,
    branchName: options.workspaceName,
    trunkBranch: effectiveTrunk,
    runtimeConfig,
    pendingAutoTitle: options.pendingAutoTitle,
  });

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to create workspace" };
  }

  // Get workspace info for switching
  const workspaceInfo = await options.client.workspace.getInfo({ workspaceId: result.metadata.id });
  if (!workspaceInfo) {
    return { success: false, error: "Failed to get workspace info after creation" };
  }

  // Dispatch event to switch workspace
  dispatchWorkspaceSwitch(workspaceInfo);

  // If there's a start message, defer until React finishes rendering and WorkspaceStore subscribes
  const startMessage = options.startMessage;
  const sendMessageOptions = options.sendMessageOptions;
  const client = options.client;
  if (startMessage && sendMessageOptions) {
    requestAnimationFrame(() => {
      client.workspace
        .sendMessage({
          workspaceId: result.metadata.id,
          message: startMessage,
          options: sendMessageOptions,
        })
        .catch(() => {
          // Best-effort: the user can send the message manually if this fails.
        });
    });
  }

  return { success: true, workspaceInfo };
}

// ============================================================================
// Workspace Forking (Inline implementation)
// ============================================================================

// ============================================================================
// Compaction
// ============================================================================

export interface CompactionOptions {
  api?: RouterClient<AppRouter>;
  workspaceId: string;
  maxOutputTokens?: number;
  /**
   * Content to continue with after compaction.
   * Accepts CompactionFollowUpInput (without model/agentId) - prepareCompactionMessage
   * will add model/agentId from sendMessageOptions to produce CompactionFollowUpRequest.
   */
  followUpContent?: CompactionFollowUpInput;
  model?: string;
  sendMessageOptions: SendMessageOptions;
  editMessageId?: string;
  /** Source of compaction request (e.g., "idle-compaction" for auto-triggered) */
  source?: "idle-compaction";
}

export interface CompactionResult {
  success: boolean;
  error?: string;
}

/**
 * Prepare compaction message from options
 * Returns the actual message text (summarization request), metadata, and options
 */
export function prepareCompactionMessage(options: CompactionOptions): {
  messageText: string;
  metadata: MuxMessageMetadata;
  sendOptions: SendMessageOptions;
} {
  // followUpContent is the content that will be auto-sent after compaction.
  // For forced compaction (no explicit follow-up), we inject a short resume sentinel ("Continue").
  // Keep that sentinel out of the *compaction prompt* (summarization request), otherwise the model can
  // misread it as a competing instruction. We still keep it in metadata so the backend resumes.
  // Only treat it as the default resume when there's no other queued content (images/reviews).
  //
  // Convert CompactionFollowUpInput to CompactionFollowUpRequest by adding model/agentId.
  // Compaction uses its own agentId ("compact") and potentially a different model for
  // summarization, so we capture the user's original settings for the follow-up message.
  //
  // In compaction recovery (retrying a failed /compact), followUpContent may already be
  // a CompactionFollowUpRequest with preserved model/agentId. Only fill in missing fields
  // to avoid overwriting the original settings when the user changes model/agent before retry.
  let fc: CompactionFollowUpRequest | undefined;
  if (options.followUpContent) {
    // Check if already a CompactionFollowUpRequest (has model/agentId from previous compaction)
    const existingModel =
      "model" in options.followUpContent &&
      typeof options.followUpContent.model === "string" &&
      options.followUpContent.model
        ? options.followUpContent.model
        : undefined;
    const existingAgentId =
      "agentId" in options.followUpContent &&
      typeof options.followUpContent.agentId === "string" &&
      options.followUpContent.agentId
        ? options.followUpContent.agentId
        : undefined;

    fc = {
      ...options.followUpContent,
      model: existingModel ?? options.sendMessageOptions.model,
      agentId: existingAgentId ?? options.sendMessageOptions.agentId ?? WORKSPACE_DEFAULTS.agentId,
      ...pickPreservedSendOptions(options.sendMessageOptions),
    };
  }

  // Build compaction message with optional continue context.
  // Shared helper is also used by backend-triggered idle compaction.
  const messageText = buildCompactionMessageText({
    maxOutputTokens: options.maxOutputTokens,
    followUpContent: fc,
  });

  // Handle model preference (sticky globally)
  const effectiveModel = resolveCompactionModel(options.model);

  const commandLine = formatCompactionCommandLine(options);
  const continueText = getFollowUpContentText(fc);
  const fullRawCommand = continueText ? `${commandLine}\n${continueText}` : commandLine;

  const compactData: CompactionRequestData = {
    model: effectiveModel,
    maxOutputTokens: options.maxOutputTokens,
    followUpContent: fc,
  };

  // Apply compaction overrides
  const sendOptions = applyCompactionOverrides(options.sendMessageOptions, compactData);

  const metadata: MuxMessageMetadata = {
    type: "compaction-request",
    rawCommand: fullRawCommand,
    commandPrefix: commandLine,
    parsed: compactData,
    // requestedModel keeps the "starting" banner aligned with compaction overrides.
    requestedModel: sendOptions.model,
    ...(options.source === "idle-compaction" && {
      source: options.source,
      displayStatus: { emoji: "💤", message: "Compacting idle workspace..." },
    }),
  };

  return { messageText, metadata, sendOptions };
}

/**
 * Execute a compaction command
 */
export async function executeCompaction(
  options: CompactionOptions & { api: RouterClient<AppRouter> }
): Promise<CompactionResult> {
  const { messageText, metadata, sendOptions } = prepareCompactionMessage(options);

  const result = await options.api.workspace.sendMessage({
    workspaceId: options.workspaceId,
    message: messageText,
    options: {
      ...sendOptions,
      muxMetadata: metadata,
      editMessageId: options.editMessageId,
    },
  });

  if (!result.success) {
    // Convert SendMessageError to string for error display
    const errorString = result.error
      ? typeof result.error === "string"
        ? result.error
        : "type" in result.error
          ? result.error.type
          : "Failed to compact"
      : undefined;
    return { success: false, error: errorString };
  }

  return { success: true };
}

// ============================================================================
// Command Handler Types
// ============================================================================

export interface CommandHandlerContext {
  api: RouterClient<AppRouter>;
  workspaceId: string;
  currentModel?: string | null;
  sendMessageOptions: SendMessageOptions;
  attachments?: ChatAttachment[];
  fileParts?: FilePart[];
  /** Reviews attached to the message (from code review panel) */
  reviews?: ReviewNoteData[];
  editMessageId?: string;
  setInput: (value: string) => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
  /** Increment/decrement the sending counter. Pass true to increment, false to decrement. */
  setSendingState: (increment: boolean) => void;
  setToast: (toast: Toast) => void;
  onCancelEdit?: () => void;
}

export interface CommandHandlerResult {
  /** Whether the input should be cleared */
  clearInput: boolean;
  /** Whether to show a toast (already set via context.setToast) */
  toastShown: boolean;
}

/**
 * Handle /new command execution.
 *
 * Mirrors /fork's seamless flow: no modal, no required workspace name. The
 * backend auto-generates a branch name, and when a start message is supplied
 * we ask it to fill in the workspace title from that message via
 * `pendingAutoTitle`.
 */
export async function handleNewCommand(
  parsed: Extract<ParsedCommand, { type: "new" }>,
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const {
    api: client,
    workspaceId,
    sendMessageOptions,
    setInput,
    setSendingState,
    setToast,
  } = context;

  setInput(""); // Clear input immediately, like /fork.
  setSendingState(true);

  try {
    // Get workspace info to extract projectPath. /new is a workspace-only
    // command, so the parent workspace's project becomes the new workspace's
    // project.
    const workspaceInfo = await client.workspace.getInfo({ workspaceId });
    if (!workspaceInfo) {
      throw new Error("Failed to get workspace info");
    }

    // Treat blank/whitespace-only payloads the same as no message — pendingAutoTitle
    // only makes sense when there is real content for the LLM to title from.
    const trimmedStartMessage = parsed.startMessage?.trim() ?? "";
    const startMessage = trimmedStartMessage.length > 0 ? trimmedStartMessage : undefined;

    const createResult = await createNewWorkspace({
      client,
      projectPath: workspaceInfo.projectPath,
      // workspaceName intentionally omitted — backend auto-generates (like /fork).
      startMessage,
      sendMessageOptions,
      // Match /fork: only flag pendingAutoTitle when there is a message to
      // generate the title from.
      pendingAutoTitle: Boolean(startMessage),
    });

    if (!createResult.success) {
      const errorMsg = createResult.error ?? "Failed to create workspace";
      console.error("Failed to create workspace:", errorMsg);
      setToast({
        id: Date.now().toString(),
        type: "error",
        title: "Create Failed",
        message: errorMsg,
      });
      return { clearInput: false, toastShown: true };
    }

    trackCommandUsed("new");
    const displayName =
      createResult.workspaceInfo?.title ?? createResult.workspaceInfo?.name ?? "new workspace";
    setToast({
      id: Date.now().toString(),
      type: "success",
      message: `Created workspace "${displayName}"`,
    });
    return { clearInput: true, toastShown: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Failed to create workspace";
    console.error("Create error:", error);
    setToast({
      id: Date.now().toString(),
      type: "error",
      title: "Create Failed",
      message: errorMsg,
    });
    return { clearInput: false, toastShown: true };
  } finally {
    setSendingState(false);
  }
}

/**
 * Handle /compact command execution
 */
export async function handleCompactCommand(
  parsed: Extract<ParsedCommand, { type: "compact" }>,
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const {
    api,
    workspaceId,
    sendMessageOptions,
    editMessageId,
    setInput,
    setAttachments,
    setSendingState,
    setToast,
    onCancelEdit,
  } = context;

  // normalizeModelInput handles null/empty — returns { model: null } for empty input
  const normalizedModel = normalizeModelInput(parsed.model);

  // Validate model format early - fail fast before sending to backend
  if (parsed.model && !normalizedModel.model) {
    setToast(createInvalidCompactModelToast(parsed.model));
    return { clearInput: false, toastShown: true };
  }

  setInput("");
  setAttachments([]);
  setSendingState(true);

  try {
    // Build followUpContent directly from parsed command + context.
    const stagedAttachments = context.attachments ? getStagedAttachments(context.attachments) : [];
    const hasContent =
      parsed.continueMessage ??
      context.fileParts?.length ??
      context.reviews?.length ??
      stagedAttachments.length;
    const followUpContent: CompactionFollowUpInput | undefined = hasContent
      ? {
          text: appendStagedAttachmentNotice(parsed.continueMessage ?? "", stagedAttachments),
          fileParts: context.fileParts,
          reviews: context.reviews,
        }
      : undefined;

    const resolvedModel = normalizedModel.model ?? undefined;

    const result = await executeCompaction({
      api,
      workspaceId,
      maxOutputTokens: parsed.maxOutputTokens,
      followUpContent,
      model: resolvedModel,
      sendMessageOptions,
      editMessageId,
    });

    if (!result.success) {
      console.error("Failed to initiate compaction:", result.error);
      const errorMsg = result.error ?? "Failed to start compaction";
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: errorMsg,
      });
      return { clearInput: false, toastShown: true };
    }

    trackCommandUsed("compact");
    setToast({
      id: Date.now().toString(),
      type: "success",
      message: parsed.continueMessage
        ? "Compaction started. Will continue automatically after completion."
        : "Compaction started. AI will summarize the conversation.",
    });

    // Clear editing state on success
    if (editMessageId && onCancelEdit) {
      onCancelEdit();
    }

    return { clearInput: true, toastShown: true };
  } catch (error) {
    console.error("Compaction error:", error);
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: error instanceof Error ? error.message : "Failed to start compaction",
    });
    return { clearInput: false, toastShown: true };
  } finally {
    setSendingState(false);
  }
}

// ============================================================================
// Plan Command Handlers
// ============================================================================

export async function handlePlanShowCommand(
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const { api, workspaceId, setInput, setToast } = context;

  setInput("");

  const result = await api.workspace.getPlanContent({ workspaceId });
  if (!result.success) {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "No plan found for this workspace",
    });
    return { clearInput: true, toastShown: true };
  }

  // Keep the ephemeral preview a singleton so repeated /plan show calls replace it instead of
  // accumulating permanent-looking cards at the transcript bottom.
  const planMessage = {
    id: "plan-display-preview",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: result.data.content }],
    metadata: {
      historySequence: Number.MAX_SAFE_INTEGER, // Appear at end of chat
      muxMetadata: { type: "plan-display" as const, path: result.data.path },
    },
  };
  addEphemeralMessage(workspaceId, planMessage);

  trackCommandUsed("plan");
  return { clearInput: true, toastShown: false };
}

export async function handlePlanOpenCommand(
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const { api, workspaceId, setInput, setToast } = context;

  setInput("");

  // First get the plan path
  const planResult = await api.workspace.getPlanContent({ workspaceId });
  if (!planResult.success) {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "No plan found for this workspace",
    });
    return { clearInput: true, toastShown: true };
  }

  const workspaceInfo = await api.workspace.getInfo({ workspaceId });
  const openResult = await openInEditor({
    api,
    workspaceId,
    targetPath: planResult.data.path,
    runtimeConfig: workspaceInfo?.runtimeConfig,
    isFile: true,
  });

  if (!openResult.success) {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: openResult.error ?? "Failed to open editor",
    });
    return { clearInput: true, toastShown: true };
  }

  trackCommandUsed("plan");
  setToast({
    id: Date.now().toString(),
    type: "success",
    message: "Opened plan in editor",
  });
  return { clearInput: true, toastShown: true };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Dispatch a custom event to switch workspaces
 */
