import { os, ORPCError } from "@orpc/server";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import * as schemas from "@/common/orpc/schemas";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ORPCContext } from "./context";
import {
  getWorkspaceMcpOverrides,
  getWorkspacePluginComposition,
  listWorkspaceMcpPrompts,
  listWorkspacePluginSlashCommands,
  setWorkspaceMcpOverrides,
} from "@/node/services/agentPlugins/workspacePluginOperations";
import {
  assertMemoryEnabled,
  consolidateMemory,
  deleteMemory,
  getMemoryConsolidationStatus,
  listMemory,
  readMemory,
  saveMemory,
  setMemoryPinned,
} from "@/node/services/memoryOperations";
import {
  controlBrowser,
  getBrowserBootstrap,
  listBrowserSessions,
  selectBrowserTab,
} from "@/node/services/browser/browserOperations";
import { getDesktopBootstrap } from "@/node/services/desktop/desktopOperations";
import {
  getApiServerStatus,
  setApiServerSettings,
  setServerSshHost,
} from "@/node/services/serverService";
import { executeRawQueryForApi } from "@/node/services/analytics/analyticsService";
import {
  addUpcomingWorkspaceGoal,
  archiveWorkspaceGoal,
  clearWorkspaceGoal,
  getBackgroundBashOutput,
  getWorkspaceGoal,
  getWorkspaceGoalBoard,
  getWorkspacePlanContent,
  promoteUpcomingWorkspaceGoal,
  reorderUpcomingWorkspaceGoals,
  reviveArchivedWorkspaceGoal,
  setWorkspaceGoal,
  updateUpcomingWorkspaceGoal,
} from "@/node/services/workspaceOperations";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults } from "@/constants/goals";
import { Err, Ok } from "@/common/types/result";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

import { generateWorkspaceIdentity } from "@/node/services/workspaceTitleGenerator";

import type { WorkspaceMetadata } from "@/common/types/workspace";
import {
  createAuthMiddleware,
  extractClientIpAddress,
  extractCookieValues,
  getFirstHeaderValue,
} from "./authMiddleware";
import { resolveWorkspaceCreationScope } from "@/common/utils/subProjects";
import { clearLogFiles, getLogFilePath } from "@/node/services/log";
import { clearLogEntries } from "@/node/services/logBuffer";

import { asyncIterableFromSubscription } from "@/common/utils/asyncEventIterator";
import {
  attachTerminal,
  createTickIterable,
  subscribeConfigChanges,
  subscribeDevTools,
  subscribeLogs,
  subscribeBackgroundBashes,
  subscribeMemoryChanges,
  subscribeMetadata,
  subscribeOpenSettings,
  subscribePolicyChanges,
  subscribeProviderConfig,
  subscribeSshPrompts,
  subscribeTerminalActivity,
  subscribeTerminalExit,
  subscribeTerminalOutput,
  subscribeTimeline,
  subscribeUpdateStatus,
  subscribeWorkspaceActivity,
  subscribeWorkspaceChat,
  subscribeWorkspaceStats,
} from "./routerSubscriptions";

import { createRuntime, checkRuntimeAvailability } from "@/node/runtime/runtimeFactory";
import {
  appendSubProjectRelativePath,
  createRuntimeForWorkspace,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  isLayoutPresetsConfigEmpty,
  normalizeLayoutPresetsConfig,
} from "@/common/types/uiLayouts";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { normalizeRuntimeEnablement } from "@/common/types/runtime";

import {
  discoverAgentSkills,
  discoverAgentSkillsDiagnostics,
  readAgentSkill,
} from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import type { SkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
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

import type { WorkflowRunStreamEvent } from "@/common/types/workflow";
import { SERVER_AUTH_SESSION_COOKIE_NAME } from "@/node/services/serverAuthService";
import { getErrorMessage } from "@/common/utils/errors";

import {
  getWorkflowRunStatusesForOwners,
  listActiveWorkflowRunsForOwners,
} from "@/node/services/workflows/WorkflowRunStore";
import { workflowRunStreamHub } from "@/node/services/workflows/workflowRunStreamHub";

import {
  listWorkflowScripts,
  resolveWorkflowContext,
  resumeWorkflowRun,
  retryWorkflowRunFromCheckpoint,
  startWorkflowRun,
} from "@/node/services/workflows/WorkflowService";
import { throwWorkflowOrpcError } from "./formatOrpcError";

function handleWorkflowRequest<T>(request: () => Promise<T>): Promise<T> {
  return request().catch(throwWorkflowOrpcError);
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

async function resolveAgentSkillDiscoveryContext(
  context: ORPCContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean },
  options: { includeClaudeSkills: boolean; includeAgentPlugins: boolean }
): Promise<SkillStorageContext> {
  const resolved = await resolveAgentDiscoveryContext(context, input);
  if (resolved.metadata == null) {
    const projectPath = input.projectPath ?? resolved.discoveryPath;
    const creationScope = resolveWorkspaceCreationScope(
      projectPath,
      context.config.loadConfigOrDefault().projects
    );
    return resolveSkillStorageContext({
      runtime: resolved.runtime,
      workspacePath: resolved.discoveryPath,
      xumScope: {
        type: "project",
        xumHome: context.config.rootDir,
        projectRoot: resolved.discoveryPath,
        projectStorageAuthority: "host-local",
        checkoutRoot: creationScope.projectPath,
      },
      ...options,
    });
  }

  const workspacePath =
    input.disableWorkspaceAgents === true
      ? resolved.discoveryPath
      : appendSubProjectRelativePath(
          resolved.metadata,
          resolved.runtime,
          resolveWorkspaceRootPath(resolved.metadata, resolved.runtime)
        );
  const xumScope = context.aiService.resolveXumToolScopeForWorkspace(
    resolved.metadata,
    resolved.runtime,
    workspacePath
  );
  return resolveSkillStorageContext({
    runtime: resolved.runtime,
    workspacePath,
    xumScope:
      input.disableWorkspaceAgents === true && xumScope.type === "project"
        ? { ...xumScope, checkoutRoot: workspacePath }
        : xumScope,
    ...options,
  });
}

/**
 * Agent Plugins MCP context for an optional workspaceId input (agent-plugins
 * experiment). Returns undefined (project-level default: scan under
 * projectPath) when no workspace is given or its metadata cannot be resolved;
 * otherwise the workspace's own context — worktree-scanning for host
 * workspaces, null for off-host workspaces so plugin servers match what the
 * engine actually offers there.
 *
 * SECURITY: the workspace must belong to the request's project. The caller's
 * `trusted` flag is derived from `projectPath`, so honoring a workspaceId from
 * a DIFFERENT (untrusted) project would scan that project's checkout under
 * another project's trust and let mcp.test execute its repo-local stdio
 * plugins. Mismatches fall back to the projectPath-scoped default, whose
 * trust and scan root describe the same project.
 */
function assertDynamicWorkflowsEnabled(context: ORPCContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS)) {
    throw new ORPCError("BAD_REQUEST", { message: "Dynamic workflows are disabled" });
  }
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

function subscribeWorkflowRuns(
  context: ORPCContext,
  workspaceId: string,
  signal?: AbortSignal
): AsyncGenerator<WorkflowRunStreamEvent> {
  return asyncIterableFromSubscription<WorkflowRunStreamEvent>({
    signal,
    validate: () => assertDynamicWorkflowsEnabled(context),
    subscribe: (push) =>
      workflowRunStreamHub.subscribe(workspaceId, (run) => {
        if (run.parentWorkflow == null) push({ type: "run-changed", run });
      }),
    initial: async () => {
      const { service, projectTrusted } = await resolveWorkflowContext(context, workspaceId);
      await service.resumeCrashedRuns({ workspaceId, projectTrusted });
      return { type: "snapshot" as const, runs: await service.listRuns({ workspaceId }) };
    },
  });
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
        .handler(({ context, input }) => setServerSshHost(context, input.sshHost)),
      getApiServerStatus: t
        .input(schemas.server.getApiServerStatus.input)
        .output(schemas.server.getApiServerStatus.output)
        .handler(({ context }) => getApiServerStatus(context)),
      setApiServerSettings: t
        .input(schemas.server.setApiServerSettings.input)
        .output(schemas.server.setApiServerSettings.output)
        .handler(({ context, input }) => setApiServerSettings(context, input)),
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
            // Xum Governor enrollment status (safe fields only - token never exposed)
            muxGovernorUrl,
            muxGovernorEnrolled,
            chatTranscriptFullWidth: config.chatTranscriptFullWidth === true,
            llmDebugLogs: config.llmDebugLogs === true,
            heartbeatDefaultPrompt: config.heartbeatDefaultPrompt ?? undefined,
            heartbeatDefaultIntervalMs: config.heartbeatDefaultIntervalMs ?? undefined,
            goalDefaults: normalizeGoalDefaults(config.goalDefaults ?? DEFAULT_GOAL_DEFAULTS),
          };
        }),
      onConfigChanged: t
        .input(schemas.config.onConfigChanged.input)
        .output(schemas.config.onConfigChanged.output)
        .handler(({ context, signal }) => subscribeConfigChanges(context, signal)),
      updateAgentAiDefaults: t
        .input(schemas.config.updateAgentAiDefaults.input)
        .output(schemas.config.updateAgentAiDefaults.output)
        .handler(({ context, input }) =>
          context.config.updateAgentAiDefaults(input.agentAiDefaults)
        ),

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
        .handler(({ context, input }) =>
          context.config.updateRoutePreferences({
            ...input,
            validateRouteOverrides: (overrides) =>
              context.providerService.validateRouteOverrides(overrides),
          })
        ),

      updateMinThinkingLevels: t
        .input(schemas.config.updateMinThinkingLevels.input)
        .output(schemas.config.updateMinThinkingLevels.output)
        .handler(({ context, input }) =>
          context.config.updateMinThinkingLevels(input.minThinkingLevelByModel)
        ),

      updateModelFallbacks: t
        .input(schemas.config.updateModelFallbacks.input)
        .output(schemas.config.updateModelFallbacks.output)
        .handler(({ context, input }) => context.config.updateModelFallbacks(input.modelFallbacks)),

      updateModelPreferences: t
        .input(schemas.config.updateModelPreferences.input)
        .output(schemas.config.updateModelPreferences.output)
        .handler(({ context, input }) => context.config.updateModelPreferences(input)),

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
      updateRuntimeEnablement: t
        .input(schemas.config.updateRuntimeEnablement.input)
        .output(schemas.config.updateRuntimeEnablement.output)
        .handler(({ context, input }) => context.config.updateRuntimeEnablement(input)),

      saveConfig: t
        .input(schemas.config.saveConfig.input)
        .output(schemas.config.saveConfig.output)
        .handler(async ({ context, input }) => {
          await context.config.saveUserConfig(input);
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
        .handler(({ context, input, signal }) =>
          subscribeDevTools(context, input.workspaceId, signal)
        ),
    },
    browser: {
      listSessions: t
        .input(schemas.browser.listSessions.input)
        .output(schemas.browser.listSessions.output)
        .handler(({ context, input }) => listBrowserSessions(context, input.workspaceId)),
      listTabs: t
        .input(schemas.browser.listTabs.input)
        .output(schemas.browser.listTabs.output)
        .handler(({ context, input }) => context.browserControlService.listTabs(input)),
      getBootstrap: t
        .input(schemas.browser.getBootstrap.input)
        .output(schemas.browser.getBootstrap.output)
        .handler(({ context, input }) => getBrowserBootstrap(context, input)),
      control: t
        .input(schemas.browser.control.input)
        .output(schemas.browser.control.output)
        .handler(({ context, input }) => controlBrowser(context, input)),
      selectTab: t
        .input(schemas.browser.selectTab.input)
        .output(schemas.browser.selectTab.output)
        .handler(({ context, input }) => selectBrowserTab(context, input)),
      getUrl: t
        .input(schemas.browser.getUrl.input)
        .output(schemas.browser.getUrl.output)
        .handler(({ context, input }) =>
          context.browserControlService.getUrl(input.workspaceId, input.sessionName, {
            allowOtherWorkspaceSession: input.allowOtherWorkspaceSession === true,
          })
        ),
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

          const includeAgentPlugins = context.experimentsService.isExperimentEnabled(
            EXPERIMENT_IDS.AGENT_PLUGINS
          );
          const descriptors = await discoverAgentDefinitions(runtime, discoveryPath, {
            includeAgentPlugins,
          });

          const cfg = context.config.loadConfigOrDefault();

          const resolved = await Promise.all(
            descriptors.map(async (descriptor) => {
              try {
                const resolvedFrontmatter = await resolveAgentFrontmatter(
                  runtime,
                  discoveryPath,
                  descriptor.id,
                  {
                    includeAgentPlugins,
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
          return readAgentDefinition(runtime, discoveryPath, input.agentId, {
            includeAgentPlugins: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.AGENT_PLUGINS
            ),
          });
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
          const skillCtx = await resolveAgentSkillDiscoveryContext(context, input, {
            includeClaudeSkills: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
            ),
            includeAgentPlugins: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.AGENT_PLUGINS
            ),
          });
          return discoverAgentSkills(skillCtx.runtime, skillCtx.workspacePath, {
            roots: skillCtx.roots,
            containment: skillCtx.containment,
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
          const skillCtx = await resolveAgentSkillDiscoveryContext(context, input, {
            includeClaudeSkills: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
            ),
            includeAgentPlugins: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.AGENT_PLUGINS
            ),
          });
          const diagnostics = await discoverAgentSkillsDiagnostics(
            skillCtx.runtime,
            skillCtx.workspacePath,
            {
              roots: skillCtx.roots,
              containment: skillCtx.containment,
            }
          );
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
          const skillCtx = await resolveAgentSkillDiscoveryContext(context, input, {
            includeClaudeSkills: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
            ),
            includeAgentPlugins: context.experimentsService.isExperimentEnabled(
              EXPERIMENT_IDS.AGENT_PLUGINS
            ),
          });
          const result = await readAgentSkill(
            skillCtx.runtime,
            skillCtx.workspacePath,
            input.skillName,
            {
              roots: skillCtx.roots,
              containment: skillCtx.containment,
            }
          );
          return result.package;
        }),
    },
    workflows: {
      listRuns: t
        .input(schemas.workflows.listRuns.input)
        .output(schemas.workflows.listRuns.output)
        .handler(({ context, input }) =>
          handleWorkflowRequest(async () => {
            const { service, projectTrusted } = await resolveWorkflowContext(
              context,
              input.workspaceId
            );
            await service.resumeCrashedRuns({ workspaceId: input.workspaceId, projectTrusted });
            return service.listRuns({ workspaceId: input.workspaceId });
          })
        ),
      getRun: t
        .input(schemas.workflows.getRun.input)
        .output(schemas.workflows.getRun.output)
        .handler(({ context, input }) =>
          handleWorkflowRequest(async () => {
            const { service } = await resolveWorkflowContext(context, input.workspaceId);
            return service.getRun(input);
          })
        ),
      getRunStatuses: t
        .input(schemas.workflows.getRunStatuses.input)
        .output(schemas.workflows.getRunStatuses.output)
        .handler(async ({ context, input }) => {
          // Read owner stores without waiting for workspace initialization so one stuck
          // workspace cannot stall the batch. Transient failures are omitted; missing runs
          // retain a null status so callers can distinguish them from retryable reads.
          if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS)) {
            return [];
          }
          return getWorkflowRunStatusesForOwners(context.config, input.runs);
        }),
      listActiveRuns: t
        .input(schemas.workflows.listActiveRuns.input)
        .output(schemas.workflows.listActiveRuns.output)
        .handler(async ({ context, input }) => {
          // Keep discovery strict per owner: missing session dirs are empty, while transient
          // store failures reject the call so the tray retries instead of caching no runs.
          if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS)) {
            return [];
          }
          return listActiveWorkflowRunsForOwners(context.config, input.workspaceIds);
        }),
      interrupt: t
        .input(schemas.workflows.interrupt.input)
        .output(schemas.workflows.interrupt.output)
        .handler(({ context, input }) =>
          handleWorkflowRequest(async () => {
            const { service } = await resolveWorkflowContext(context, input.workspaceId);
            return service.interruptRun(input);
          })
        ),
      resume: t
        .input(schemas.workflows.resume.input)
        .output(schemas.workflows.resume.output)
        .handler(({ context, input }) =>
          handleWorkflowRequest(() => resumeWorkflowRun(context, input))
        ),
      retryFromCheckpoint: t
        .input(schemas.workflows.retryFromCheckpoint.input)
        .output(schemas.workflows.retryFromCheckpoint.output)
        .handler(({ context, input }) =>
          handleWorkflowRequest(() => retryWorkflowRunFromCheckpoint(context, input))
        ),
      start: t
        .input(schemas.workflows.start.input)
        .output(schemas.workflows.start.output)
        .handler(({ context, input, signal }) =>
          handleWorkflowRequest(() => startWorkflowRun(context, input, signal))
        ),
      // Live run stream for the Workflows tab. Mirrors devtools.subscribe (queue +
      // resolve-next async generator). The event source is the module-level
      // workflowRunStreamHub, fed by WorkflowRunStore on every durable write, so
      // updates surface regardless of which flow is executing the run.
      subscribe: t
        .input(schemas.workflows.subscribe.input)
        .output(schemas.workflows.subscribe.output)
        .handler(({ context, input, signal }) =>
          subscribeWorkflowRuns(context, input.workspaceId, signal)
        ),
      listScripts: t
        .input(schemas.workflows.listScripts.input)
        .output(schemas.workflows.listScripts.output)
        .handler(({ context, input }) =>
          handleWorkflowRequest(() => listWorkflowScripts(context, input.workspaceId))
        ),
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
      addCustomProvider: t
        .input(schemas.providers.addCustomProvider.input)
        .output(schemas.providers.addCustomProvider.output)
        .handler(({ context, input }) => context.providerService.addCustomProvider(input)),
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
        .handler(({ context, signal }) => subscribeProviderConfig(context, signal)),
    },
    policy: {
      get: t
        .input(schemas.policy.get.input)
        .output(schemas.policy.get.output)
        .handler(({ context }) => context.policyService.getPolicyGetResponse()),
      onChanged: t
        .input(schemas.policy.onChanged.input)
        .output(schemas.policy.onChanged.output)
        .handler(({ context, signal }) => subscribePolicyChanges(context, signal)),
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
        .handler(({ context }) => context.muxGatewayOauthService.getAccountStatus()),
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
    coderOauth: {
      startDesktopFlow: t
        .input(schemas.coderOauth.startDesktopFlow.input)
        .output(schemas.coderOauth.startDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.coderOauthService.startDesktopFlow({
            deploymentUrl: input.deploymentUrl,
            flowId: input.flowId,
          });
        }),
      waitForDesktopFlow: t
        .input(schemas.coderOauth.waitForDesktopFlow.input)
        .output(schemas.coderOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.coderOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.coderOauth.cancelDesktopFlow.input)
        .output(schemas.coderOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.coderOauthService.cancelDesktopFlow(input.flowId);
        }),
      disconnect: t
        .input(schemas.coderOauth.disconnect.input)
        .output(schemas.coderOauth.disconnect.output)
        .handler(({ context }) => {
          return context.coderOauthService.disconnect();
        }),
      refreshModels: t
        .input(schemas.coderOauth.refreshModels.input)
        .output(schemas.coderOauth.refreshModels.output)
        .handler(({ context }) => {
          return context.coderOauthService.refreshModels();
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
        .handler(({ input }) => createTickIterable(input.count, input.intervalMs)),
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
        .handler(({ input, signal }) => subscribeLogs(input.level ?? "info", signal)),
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
          // Custom editors spawn detached and untrackable; record the open (refusing while
          // the workspace is archiving) before launching. See recordExternalEditorOpen.
          const recorded = await context.workspaceService.recordExternalEditorOpenForLaunch(
            input.workspaceId
          );
          if (!recorded.success) {
            return recorded;
          }
          const result = await context.editorService.openInEditor(
            input.workspaceId,
            input.targetPath,
            input.editorConfig
          );
          if (!result.success) {
            // EditorService errors occur only before its detached spawn (missing/invalid
            // command, unsupported runtime), so no editor launched — roll back a marker this
            // call created, or it would stick and permanently refuse future model-driven
            // snapshot/Coder-stop archives of the workspace.
            await recorded.data.rollbackAfterFailedLaunch();
          }
          return result;
        }),
      recordEditorOpen: t
        .input(schemas.general.recordEditorOpen.input)
        .output(schemas.general.recordEditorOpen.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.recordExternalEditorOpen(
            input.workspaceId,
            input.launchToken
          );
        }),
      rollbackEditorOpen: t
        .input(schemas.general.rollbackEditorOpen.input)
        .output(schemas.general.rollbackEditorOpen.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.rollbackRecordedEditorOpen(
            input.workspaceId,
            input.launchToken
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
        .handler(({ context, input }) => context.mcpConfigService.listForApi(input)),

      add: t
        .input(schemas.mcp.add.input)
        .output(schemas.mcp.add.output)
        .handler(({ context, input }) => context.mcpConfigService.addForApi(input)),

      remove: t
        .input(schemas.mcp.remove.input)
        .output(schemas.mcp.remove.output)
        .handler(({ context, input }) => context.mcpConfigService.removeForApi(input.name)),

      test: t
        .input(schemas.mcp.test.input)
        .output(schemas.mcp.test.output)
        .handler(({ context, input }) => context.mcpServerManager.testForApi(input)),

      setEnabled: t
        .input(schemas.mcp.setEnabled.input)
        .output(schemas.mcp.setEnabled.output)
        .handler(({ context, input }) =>
          context.mcpConfigService.setEnabledForApi(input.name, input.enabled)
        ),

      setToolAllowlist: t
        .input(schemas.mcp.setToolAllowlist.input)
        .output(schemas.mcp.setToolAllowlist.output)
        .handler(({ context, input }) =>
          context.mcpConfigService.setToolAllowlistForApi(input.name, input.toolAllowlist)
        ),
    },
    // Managed Agent Plugin installs (agent-plugins experiment). The service
    // gates every method on the experiment flag and throws user-facing
    // errors; handlers translate them into Result values.
    agentPlugins: {
      preview: t
        .input(schemas.agentPlugins.preview.input)
        .output(schemas.agentPlugins.preview.output)
        .handler(async ({ context, input }) => {
          try {
            const data = await context.agentPluginInstallService.preview({
              input: input.input,
              ref: input.ref ?? undefined,
              subpath: input.subpath ?? undefined,
            });
            return { success: true, data };
          } catch (error) {
            return { success: false, error: getErrorMessage(error) };
          }
        }),
      install: t
        .input(schemas.agentPlugins.install.input)
        .output(schemas.agentPlugins.install.output)
        .handler(async ({ context, input }) => {
          try {
            const data = await context.agentPluginInstallService.install(input);
            return { success: true, data };
          } catch (error) {
            return { success: false, error: getErrorMessage(error) };
          }
        }),
      list: t
        .input(schemas.agentPlugins.list.input)
        .output(schemas.agentPlugins.list.output)
        .handler(async ({ context }) => {
          try {
            const data = await context.agentPluginInstallService.list();
            return { success: true, data };
          } catch (error) {
            return { success: false, error: getErrorMessage(error) };
          }
        }),
      containerLocation: t
        .input(schemas.agentPlugins.containerLocation.input)
        .output(schemas.agentPlugins.containerLocation.output)
        .handler(({ context }) => context.agentPluginInstallService.containerLocation()),
      uninstall: t
        .input(schemas.agentPlugins.uninstall.input)
        .output(schemas.agentPlugins.uninstall.output)
        .handler(async ({ context, input }) => {
          try {
            await context.agentPluginInstallService.uninstall(input);
            return { success: true, data: undefined };
          } catch (error) {
            return { success: false, error: getErrorMessage(error) };
          }
        }),
      checkUpdates: t
        .input(schemas.agentPlugins.checkUpdates.input)
        .output(schemas.agentPlugins.checkUpdates.output)
        .handler(async ({ context }) => {
          try {
            const data = await context.agentPluginInstallService.checkUpdates();
            return { success: true, data };
          } catch (error) {
            return { success: false, error: getErrorMessage(error) };
          }
        }),
      update: t
        .input(schemas.agentPlugins.update.input)
        .output(schemas.agentPlugins.update.output)
        .handler(async ({ context, input }) => {
          try {
            const data = await context.agentPluginInstallService.update(input);
            return { success: true, data };
          } catch (error) {
            return { success: false, error: getErrorMessage(error) };
          }
        }),
    },
    mcpOauth: {
      startDesktopFlow: t
        .input(schemas.mcpOauth.startDesktopFlow.input)
        .output(schemas.mcpOauth.startDesktopFlow.output)
        .handler(({ context, input }) => context.mcpOauthService.startDesktopFlowForApi(input)),
      waitForDesktopFlow: t
        .input(schemas.mcpOauth.waitForDesktopFlow.input)
        .output(schemas.mcpOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) =>
          context.mcpOauthService.waitForDesktopFlow(input.flowId, { timeoutMs: input.timeoutMs })
        ),
      cancelDesktopFlow: t
        .input(schemas.mcpOauth.cancelDesktopFlow.input)
        .output(schemas.mcpOauth.cancelDesktopFlow.output)
        .handler(({ context, input }) => context.mcpOauthService.cancelDesktopFlow(input.flowId)),
      startServerFlow: t
        .input(schemas.mcpOauth.startServerFlow.input)
        .output(schemas.mcpOauth.startServerFlow.output)
        .handler(({ context, input }) =>
          context.mcpOauthService.startServerFlowForApi(input, context.headers)
        ),
      waitForServerFlow: t
        .input(schemas.mcpOauth.waitForServerFlow.input)
        .output(schemas.mcpOauth.waitForServerFlow.output)
        .handler(({ context, input }) =>
          context.mcpOauthService.waitForServerFlow(input.flowId, { timeoutMs: input.timeoutMs })
        ),
      cancelServerFlow: t
        .input(schemas.mcpOauth.cancelServerFlow.input)
        .output(schemas.mcpOauth.cancelServerFlow.output)
        .handler(({ context, input }) => context.mcpOauthService.cancelServerFlow(input.flowId)),
      getAuthStatus: t
        .input(schemas.mcpOauth.getAuthStatus.input)
        .output(schemas.mcpOauth.getAuthStatus.output)
        .handler(({ context, input }) => context.mcpOauthService.getAuthStatus(input)),
      logout: t
        .input(schemas.mcpOauth.logout.input)
        .output(schemas.mcpOauth.logout.output)
        .handler(({ context, input }) => context.mcpOauthService.logout(input)),
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
          return context.projectService.create(input.projectPath, { initGit: input.initGit });
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
        .handler(({ context, input, signal }) =>
          context.projectService.cloneWithProgress(input, signal)
        ),
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
        .handler(({ context, input }) =>
          context.projectService.setTrust(input.projectPath, input.trusted)
        ),

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
      setCustomInstructions: t
        .input(schemas.projects.setCustomInstructions.input)
        .output(schemas.projects.setCustomInstructions.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalizedPath = stripTrailingSlashes(input.projectPath);
            const project = config.projects.get(normalizedPath);
            if (!project) {
              throw new Error(`Project not found: ${normalizedPath}`);
            }
            // Store undefined for blank input to keep config.json minimal.
            const customInstructions = input.customInstructions ?? undefined;
            project.customInstructions = customInstructions?.trim()
              ? customInstructions
              : undefined;
            return config;
          });
        }),
      setCodeWorkspaceSyncPath: t
        .input(schemas.projects.setCodeWorkspaceSyncPath.input)
        .output(schemas.projects.setCodeWorkspaceSyncPath.output)
        .handler(({ context, input }) =>
          context.projectService.setCodeWorkspaceSyncPath(
            input.projectPath,
            input.codeWorkspaceSyncPath
          )
        ),

      remove: t
        .input(schemas.projects.remove.input)
        .output(schemas.projects.remove.output)
        .handler(async ({ context, input }) => {
          const result = await context.projectService.remove(
            input.projectPath,
            input.force ?? false
          );
          if (!result.success) return result;
          // Removal cascades to child projects, whose retained trust must also
          // be forgotten or a re-registered path would inherit the old grant.
          for (const removedPath of result.data.removedProjectPaths) {
            context.mcpServerManager.forgetProjectTrust(removedPath);
          }
          return Ok(undefined);
        }),
      getRemovalBlockers: t
        .input(schemas.projects.getRemovalBlockers.input)
        .output(schemas.projects.getRemovalBlockers.output)
        .handler(({ context, input }) => {
          return context.projectService.getRemovalBlockers(input.projectPath);
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
          .handler(({ context, input }) => context.mcpConfigService.listForApi(input)),
        add: t
          .input(schemas.projects.mcp.add.input)
          .output(schemas.projects.mcp.add.output)
          .handler(({ context, input }) => context.mcpConfigService.addForApi(input)),
        remove: t
          .input(schemas.projects.mcp.remove.input)
          .output(schemas.projects.mcp.remove.output)
          .handler(({ context, input }) => context.mcpConfigService.removeForApi(input.name)),
        test: t
          .input(schemas.projects.mcp.test.input)
          .output(schemas.projects.mcp.test.output)
          .handler(({ context, input }) =>
            context.mcpServerManager.testForApi(input, { includeAgentPlugins: false })
          ),
        setEnabled: t
          .input(schemas.projects.mcp.setEnabled.input)
          .output(schemas.projects.mcp.setEnabled.output)
          .handler(({ context, input }) =>
            context.mcpConfigService.setEnabledForApi(input.name, input.enabled)
          ),
        setToolAllowlist: t
          .input(schemas.projects.mcp.setToolAllowlist.input)
          .output(schemas.projects.mcp.setToolAllowlist.output)
          .handler(({ context, input }) =>
            context.mcpConfigService.setToolAllowlistForApi(input.name, input.toolAllowlist)
          ),
      },

      mcpOauth: {
        startDesktopFlow: t
          .input(schemas.projects.mcpOauth.startDesktopFlow.input)
          .output(schemas.projects.mcpOauth.startDesktopFlow.output)
          .handler(({ context, input }) => context.mcpOauthService.startDesktopFlowForApi(input)),
        waitForDesktopFlow: t
          .input(schemas.projects.mcpOauth.waitForDesktopFlow.input)
          .output(schemas.projects.mcpOauth.waitForDesktopFlow.output)
          .handler(({ context, input }) =>
            context.mcpOauthService.waitForDesktopFlow(input.flowId, { timeoutMs: input.timeoutMs })
          ),
        cancelDesktopFlow: t
          .input(schemas.projects.mcpOauth.cancelDesktopFlow.input)
          .output(schemas.projects.mcpOauth.cancelDesktopFlow.output)
          .handler(({ context, input }) => context.mcpOauthService.cancelDesktopFlow(input.flowId)),
        startServerFlow: t
          .input(schemas.projects.mcpOauth.startServerFlow.input)
          .output(schemas.projects.mcpOauth.startServerFlow.output)
          .handler(({ context, input }) =>
            context.mcpOauthService.startServerFlowForApi(input, context.headers)
          ),
        waitForServerFlow: t
          .input(schemas.projects.mcpOauth.waitForServerFlow.input)
          .output(schemas.projects.mcpOauth.waitForServerFlow.output)
          .handler(({ context, input }) =>
            context.mcpOauthService.waitForServerFlow(input.flowId, { timeoutMs: input.timeoutMs })
          ),
        cancelServerFlow: t
          .input(schemas.projects.mcpOauth.cancelServerFlow.input)
          .output(schemas.projects.mcpOauth.cancelServerFlow.output)
          .handler(({ context, input }) => context.mcpOauthService.cancelServerFlow(input.flowId)),
        getAuthStatus: t
          .input(schemas.projects.mcpOauth.getAuthStatus.input)
          .output(schemas.projects.mcpOauth.getAuthStatus.output)
          .handler(({ context, input }) => context.mcpOauthService.getProjectAuthStatus(input)),
        logout: t
          .input(schemas.projects.mcpOauth.logout.input)
          .output(schemas.projects.mcpOauth.logout.output)
          .handler(({ context, input }) => context.mcpOauthService.logoutProjectServer(input)),
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
          .handler(({ context, input }) =>
            context.projectService.assignWorkspaceToSubProjectAndSync(
              input.projectPath,
              input.workspaceId,
              input.subProjectPath
            )
          ),
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
        .handler(({ context, input }) => listMemory(context, input)),
      read: t
        .input(schemas.memory.read.input)
        .output(schemas.memory.read.output)
        .handler(({ context, input }) => readMemory(context, input)),
      save: t
        .input(schemas.memory.save.input)
        .output(schemas.memory.save.output)
        .handler(({ context, input }) => saveMemory(context, input)),
      delete: t
        .input(schemas.memory.delete.input)
        .output(schemas.memory.delete.output)
        .handler(({ context, input }) => deleteMemory(context, input)),
      setPinned: t
        .input(schemas.memory.setPinned.input)
        .output(schemas.memory.setPinned.output)
        .handler(({ context, input }) => setMemoryPinned(context, input)),
      consolidationStatus: t
        .input(schemas.memory.consolidationStatus.input)
        .output(schemas.memory.consolidationStatus.output)
        .handler(({ context, input }) => getMemoryConsolidationStatus(context, input)),
      consolidate: t
        .input(schemas.memory.consolidate.input)
        .output(schemas.memory.consolidate.output)
        .handler(({ context, input }) => consolidateMemory(context, input)),
      onChange: t
        .input(schemas.memory.onChange.input)
        .output(schemas.memory.onChange.output)

        .handler(({ context, input, signal }) =>
          subscribeMemoryChanges(context, input.workspaceId ?? null, signal, () =>
            assertMemoryEnabled(context)
          )
        ),
    },
    refinements: {
      // /refine trajectory distillation (RLM r11). Gating lives in the
      // service: it refuses when the rlm-mode machine overrides are off.
      run: t
        .input(schemas.refinements.run.input)
        .output(schemas.refinements.run.output)
        .handler(async ({ context, input }) => {
          const result = await context.refineService.run(input.workspaceId, input.experiments);
          return result.success
            ? { success: true as const, data: result.data }
            : { success: false as const, error: result.error };
        }),
      // Explicit approval step: applies the staged edits from the last run
      // through the same journaled tool paths (rollback keeps working).
      apply: t
        .input(schemas.refinements.apply.input)
        .output(schemas.refinements.apply.output)
        .handler(async ({ context, input }) => {
          const result = await context.refineService.apply(
            input.workspaceId,
            input.approvedProposalHash,
            input.experiments
          );
          return result.success
            ? { success: true as const, data: result.data }
            : { success: false as const, error: result.error };
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
          .handler(({ context, input, signal }) =>
            subscribeTimeline(context, input.workspaceId, signal)
          ),
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
      setQueuedMessageDispatchMode: t
        .input(schemas.workspace.setQueuedMessageDispatchMode.input)
        .output(schemas.workspace.setQueuedMessageDispatchMode.output)
        .handler(({ context, input }) =>
          context.workspaceService.setQueuedMessageDispatchMode(
            input.workspaceId,
            input.queueDispatchMode
          )
        ),
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
          let workspaceId = input.workspaceId?.trim() ?? null;
          if (workspaceId === "") workspaceId = null;
          return context.historyService.getSubagentTranscript(
            { taskId, requestingWorkspaceId: workspaceId },
            { taskService: context.taskService, aiService: context.aiService }
          );
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
        .handler(({ context, input, signal }) => subscribeWorkspaceChat(context, input, signal)),
      onMetadata: t
        .input(schemas.workspace.onMetadata.input)
        .output(schemas.workspace.onMetadata.output)
        .handler(({ context, signal }) => subscribeMetadata(context, signal)),
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
          .handler(({ context, signal }) => subscribeWorkspaceActivity(context, signal)),
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
        .handler(({ context, input }) => getWorkspacePlanContent(context, input.workspaceId)),
      backgroundBashes: {
        subscribe: t
          .input(schemas.workspace.backgroundBashes.subscribe.input)
          .output(schemas.workspace.backgroundBashes.subscribe.output)

          .handler(({ context, input, signal }) =>
            subscribeBackgroundBashes(context, input.workspaceId, signal)
          ),

        terminate: t
          .input(schemas.workspace.backgroundBashes.terminate.input)
          .output(schemas.workspace.backgroundBashes.terminate.output)
          .handler(async ({ context, input }) => {
            const result = await context.workspaceService.terminateBackgroundProcess(
              input.workspaceId,
              input.processId
            );
            return result.success
              ? { success: true, data: undefined }
              : { success: false, error: result.error };
          }),
        sendToBackground: t
          .input(schemas.workspace.backgroundBashes.sendToBackground.input)
          .output(schemas.workspace.backgroundBashes.sendToBackground.output)
          .handler(({ context, input }) => {
            const result = context.workspaceService.sendToBackground(input.toolCallId);
            return result.success
              ? { success: true, data: undefined }
              : { success: false, error: result.error };
          }),
        getOutput: t
          .input(schemas.workspace.backgroundBashes.getOutput.input)
          .output(schemas.workspace.backgroundBashes.getOutput.output)
          .handler(({ context, input }) => getBackgroundBashOutput(context, input)),
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
        .handler(({ context, input }) => getWorkspaceGoal(context, input.workspaceId)),
      setGoal: t
        .input(schemas.workspace.setGoal.input)
        .output(schemas.workspace.setGoal.output)
        .handler(({ context, input }) => setWorkspaceGoal(context, input)),
      clearGoal: t
        .input(schemas.workspace.clearGoal.input)
        .output(schemas.workspace.clearGoal.output)
        .handler(({ context, input }) => clearWorkspaceGoal(context, input.workspaceId)),
      getGoalBoard: t
        .input(schemas.workspace.getGoalBoard.input)
        .output(schemas.workspace.getGoalBoard.output)
        .handler(({ context, input }) => getWorkspaceGoalBoard(context, input.workspaceId)),
      addUpcomingGoal: t
        .input(schemas.workspace.addUpcomingGoal.input)
        .output(schemas.workspace.addUpcomingGoal.output)
        .handler(({ context, input }) => addUpcomingWorkspaceGoal(context, input)),
      archiveGoal: t
        .input(schemas.workspace.archiveGoal.input)
        .output(schemas.workspace.archiveGoal.output)
        .handler(({ context, input }) =>
          archiveWorkspaceGoal(context, input.workspaceId, input.goalId)
        ),
      reviveArchivedGoal: t
        .input(schemas.workspace.reviveArchivedGoal.input)
        .output(schemas.workspace.reviveArchivedGoal.output)
        .handler(({ context, input }) =>
          reviveArchivedWorkspaceGoal(context, input.workspaceId, input.goalId)
        ),
      reorderUpcomingGoals: t
        .input(schemas.workspace.reorderUpcomingGoals.input)
        .output(schemas.workspace.reorderUpcomingGoals.output)
        .handler(({ context, input }) =>
          reorderUpcomingWorkspaceGoals(context, input.workspaceId, input.upcomingIds)
        ),
      promoteUpcomingGoal: t
        .input(schemas.workspace.promoteUpcomingGoal.input)
        .output(schemas.workspace.promoteUpcomingGoal.output)
        .handler(({ context, input }) =>
          promoteUpcomingWorkspaceGoal(context, input.workspaceId, input.goalId)
        ),
      updateUpcomingGoal: t
        .input(schemas.workspace.updateUpcomingGoal.input)
        .output(schemas.workspace.updateUpcomingGoal.output)
        .handler(({ context, input }) => updateUpcomingWorkspaceGoal(context, input)),
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
          .handler(({ context, input, signal }) =>
            subscribeWorkspaceStats(context, input.workspaceId, signal)
          ),
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
          .handler(({ context, input }) => getWorkspaceMcpOverrides(context, input.workspaceId)),
        prompts: {
          list: t
            .input(schemas.workspace.mcp.prompts.list.input)
            .output(schemas.workspace.mcp.prompts.list.output)
            .handler(({ context, input, signal }) =>
              listWorkspaceMcpPrompts(context, input.workspaceId, signal)
            ),
        },
        set: t
          .input(schemas.workspace.mcp.set.input)
          .output(schemas.workspace.mcp.set.output)
          .handler(({ context, input }) => setWorkspaceMcpOverrides(context, input)),
      },
      plugins: {
        slashCommands: {
          list: t
            .input(schemas.workspace.plugins.slashCommands.list.input)
            .output(schemas.workspace.plugins.slashCommands.list.output)
            .handler(({ context, input, signal }) =>
              listWorkspacePluginSlashCommands(context, input.workspaceId, signal)
            ),
        },
        composition: {
          get: t
            .input(schemas.workspace.plugins.composition.get.input)
            .output(schemas.workspace.plugins.composition.get.output)
            .handler(({ context, input, signal }) =>
              getWorkspacePluginComposition(context, input.workspaceId, signal)
            ),
        },
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

        .handler(({ context, input, signal }) =>
          subscribeTerminalOutput(context, input.sessionId, signal)
        ),
      attach: t
        .input(schemas.terminal.attach.input)
        .output(schemas.terminal.attach.output)
        .handler(({ context, input, signal }) => attachTerminal(context, input.sessionId, signal)),
      onExit: t
        .input(schemas.terminal.onExit.input)
        .output(schemas.terminal.onExit.output)
        .handler(({ context, input, signal }) =>
          subscribeTerminalExit(context, input.sessionId, signal)
        ),

      openWindow: t
        .input(schemas.terminal.openWindow.input)
        .output(schemas.terminal.openWindow.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.openWindow(
            input.workspaceId,
            input.sessionId,
            input.initialTitle
          );
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

          .handler(({ context, signal }) => subscribeTerminalActivity(context, signal)),
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
        .handler(({ context, input }) => getDesktopBootstrap(context, input.workspaceId)),
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
        .handler(({ context, signal }) => subscribeUpdateStatus(context, signal)),
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
        .handler(({ context, signal }) => subscribeOpenSettings(context, signal)),
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
      getOverrides: t
        .input(schemas.experiments.getOverrides.input)
        .output(schemas.experiments.getOverrides.output)
        .handler(async ({ context }) => {
          return await context.experimentsService.getOverrides();
        }),
      setOverride: t
        .input(schemas.experiments.setOverride.input)
        .output(schemas.experiments.setOverride.output)
        .handler(async ({ context, input }) => {
          await context.experimentsService.setOverride(input.experimentId, input.enabled);
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
        .handler(({ context, input }) =>
          executeRawQueryForApi(context.analyticsService, input.sql)
        ),

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
    backup: {
      getSettings: t
        .output(schemas.backup.getSettings.output)
        .handler(({ context }) => context.backupService.getSettings()),
      saveSettings: t
        .input(schemas.backup.saveSettings.input)
        .output(schemas.backup.saveSettings.output)
        .handler(({ context, input }) => context.backupService.saveSettings(input)),
      validate: t
        .input(schemas.backup.validate.input)
        .output(schemas.backup.validate.output)
        .handler(({ context, input }) => context.backupService.validate(input)),
      preview: t
        .input(schemas.backup.preview.input)
        .output(schemas.backup.preview.output)
        .handler(({ context, input }) => context.backupService.preview(input)),
      push: t
        .input(schemas.backup.push.input)
        .output(schemas.backup.push.output)
        .handler(({ context, input }) => {
          const { approvedSecretDigest, ...settings } = input;
          return context.backupService.push(settings, {
            approvedSecretDigest: approvedSecretDigest ?? undefined,
          });
        }),
      restore: t
        .input(schemas.backup.restore.input)
        .output(schemas.backup.restore.output)
        .handler(({ context, input }) => {
          const { approvedCommandTokens, ...settings } = input;
          return context.backupService.restore(settings, {
            approvedCommandTokens: approvedCommandTokens ?? undefined,
          });
        }),
    },
    ssh: {
      prompt: {
        subscribe: t
          .input(schemas.ssh.prompt.subscribe.input)
          .output(schemas.ssh.prompt.subscribe.output)
          .handler(({ context, signal }) => subscribeSshPrompts(context, signal)),
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
