/**
 * Stream context builder: assembles plan instructions and system prompt for a stream.
 *
 * Extracted from `streamMessage()` to make these purely functional
 * preparation steps explicit and testable. Contains:
 * - Plan file reading, mode instructions, task nesting warnings
 * - Plan→exec handoff transition content
 * - Agent body resolution with inheritance + subagent prompt append
 * - Subagent discovery for tool descriptions
 * - Skill discovery for tool descriptions
 * - System message construction and token counting
 *
 * All functions are pure — no service dependencies (`this.*`).
 */

import * as path from "node:path";

import assert from "@/common/utils/assert";
import { ADVISOR_USAGE_GUIDANCE } from "@/common/constants/advisor";
import type { MuxMessage } from "@/common/types/message";
import type { DesktopCapability } from "@/common/types/desktop";
import type { ProjectsConfig } from "@/common/types/project";
import type { XumToolScope } from "@/common/types/toolScope";
import type { AgentDefinitionScope } from "@/common/types/agentDefinition";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { TaskSettings } from "@/common/types/tasks";
import type { Runtime } from "@/node/runtime/Runtime";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { getPlanFileHint, getPlanModeInstruction } from "@/common/utils/ui/modeUtils";
import { hasStartHerePlanSummary } from "@/common/utils/messages/startHerePlanSummary";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import {
  readAgentDefinition,
  resolveAgentBody,
  resolveAgentFrontmatter,
  discoverAgentDefinitions,
  getSkipScopesAboveForKnownScope,
  type AgentDefinitionsRoots,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { discoverAgentSkills } from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { buildSystemMessage } from "./systemMessage";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { log } from "./log";
import { getErrorMessage } from "@/common/utils/errors";

// ---------------------------------------------------------------------------
// Plan & Instructions Assembly
// ---------------------------------------------------------------------------

/** Options for building plan-aware additional instructions. */
export interface BuildPlanInstructionsOptions {
  runtime: Runtime;
  metadata: WorkspaceMetadata;
  workspaceId: string;
  workspacePath: string;
  effectiveMode: "plan" | "exec" | "compact";
  effectiveAgentId: string;
  agentIsPlanLike: boolean;
  /** Runtime that resolved the active agent definition. May be the parent workspace runtime for subagents. */
  agentDiscoveryRuntime: Runtime;
  agentDiscoveryPath: string;
  /** Base additional instructions from the caller (may be undefined). */
  additionalSystemInstructions: string | undefined;
  shouldDisableTaskToolsForDepth: boolean;
  taskDepth: number;
  taskSettings: TaskSettings;
  /**
   * Message history that will be sent to the provider (after request-time slicing/filtering).
   *
   * Plan-context derivation must stay aligned with the request payload to avoid pre-boundary
   * history (e.g., old Start Here summaries) suppressing required plan hints.
   */
  requestPayloadMessages: MuxMessage[];
}

/** Result of plan instructions assembly. */
export interface PlanInstructionsResult {
  /** System instructions with plan-mode/nesting directives merged in. */
  effectiveAdditionalInstructions: string | undefined;
  /** Absolute path to the plan file (always computed, even if file doesn't exist). */
  planFilePath: string;
  /** Plan file content for plan→exec handoff injection (undefined if no handoff). */
  planContentForTransition: string | undefined;
}

/**
 * Build plan-aware additional instructions and determine transition content.
 *
 * This handles:
 * 1. Reading the plan file (with legacy migration)
 * 2. Injecting plan-mode instructions when in plan mode
 * 3. Injecting plan-file hints in non-plan modes (unless Start Here already has it)
 * 4. Appending task-nesting-depth warnings
 * 5. Determining plan→exec handoff content by checking if the last assistant
 *    used a plan-like agent
 */
export async function buildPlanInstructions(
  opts: BuildPlanInstructionsOptions
): Promise<PlanInstructionsResult> {
  const {
    runtime,
    metadata,
    workspaceId,
    effectiveMode,
    effectiveAgentId,
    agentIsPlanLike,
    agentDiscoveryRuntime,
    agentDiscoveryPath,
    additionalSystemInstructions,
    shouldDisableTaskToolsForDepth,
    taskDepth,
    taskSettings,
    requestPayloadMessages,
  } = opts;

  const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });

  // Construct plan mode instruction if in plan mode
  // This is done backend-side because we have access to the plan file path
  let effectiveAdditionalInstructions = additionalSystemInstructions;
  const xumHome = runtime.getXumHome();
  const planFilePath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);

  // Read plan file (handles legacy migration transparently)
  const planResult = await readPlanFile(runtime, metadata.name, metadata.projectName, workspaceId);

  const chatHasStartHerePlanSummary = hasStartHerePlanSummary(requestPayloadMessages);

  if (effectiveMode === "plan") {
    const planModeInstruction = getPlanModeInstruction(planFilePath, planResult.exists);
    effectiveAdditionalInstructions = additionalSystemInstructions
      ? `${planModeInstruction}\n\n${additionalSystemInstructions}`
      : planModeInstruction;
  } else if (planResult.exists && planResult.content.trim()) {
    // Users often use "Replace all chat history" after plan mode. In exec (or other non-plan)
    // modes, the model can lose the plan file location because plan path injection only
    // happens in plan mode.
    //
    // Exception: the ProposePlanToolCall "Start Here" flow already stores the full plan
    // (and plan path) directly in chat history. In that case, prompting the model to
    // re-open the plan file is redundant and often results in an extra "read …KB" step.
    if (!chatHasStartHerePlanSummary) {
      const planFileHint = getPlanFileHint(planFilePath, planResult.exists);
      if (planFileHint) {
        effectiveAdditionalInstructions = effectiveAdditionalInstructions
          ? `${planFileHint}\n\n${effectiveAdditionalInstructions}`
          : planFileHint;
      }
    } else {
      workspaceLog.debug(
        "Skipping plan file hint: Start Here already includes the plan in chat history."
      );
    }
  }

  if (shouldDisableTaskToolsForDepth) {
    const nestingInstruction =
      `Task delegation is disabled in this workspace (taskDepth=${taskDepth}, ` +
      `maxTaskNestingDepth=${taskSettings.maxTaskNestingDepth}). Do not call task/task_await/task_list/task_stop/task_remove.`;
    effectiveAdditionalInstructions = effectiveAdditionalInstructions
      ? `${effectiveAdditionalInstructions}\n\n${nestingInstruction}`
      : nestingInstruction;
  }

  // Read plan content for agent transition (plan-like → exec).
  // Only read if switching to the built-in exec agent and last assistant was plan-like.
  // The `effectiveAgentId === "exec"` gate used to also include "orchestrator"
  // (extracted to an `isPlanHandoffAgent` boolean) before #3224 ripped that agent
  // out; the boolean is now redundant with a single equality check, so inline it.
  let planContentForTransition: string | undefined;
  if (effectiveAgentId === "exec") {
    if (chatHasStartHerePlanSummary) {
      workspaceLog.debug(
        "Skipping plan content injection for plan handoff transition: Start Here already includes the plan in chat history."
      );
    } else {
      const lastAssistantMessage = [...requestPayloadMessages]
        .reverse()
        .find((m) => m.role === "assistant");
      const lastAgentId = lastAssistantMessage?.metadata?.agentId;
      if (lastAgentId && planResult.content.trim()) {
        let lastAgentIsPlanLike = false;
        if (lastAgentId === effectiveAgentId) {
          lastAgentIsPlanLike = agentIsPlanLike;
        } else {
          try {
            const lastDefinition = await readAgentDefinition(
              agentDiscoveryRuntime,
              agentDiscoveryPath,
              lastAgentId
            );
            const lastChain = await resolveAgentInheritanceChain({
              runtime: agentDiscoveryRuntime,
              workspacePath: agentDiscoveryPath,
              agentId: lastAgentId,
              agentDefinition: lastDefinition,
              workspaceId,
            });
            lastAgentIsPlanLike = isPlanLikeInResolvedChain(lastChain);
          } catch (error) {
            workspaceLog.warn("Failed to resolve last agent definition for plan handoff", {
              lastAgentId,
              error: getErrorMessage(error),
            });
          }
        }

        if (lastAgentIsPlanLike) {
          planContentForTransition = planResult.content;
        }
      }
    }
  }

  return { effectiveAdditionalInstructions, planFilePath, planContentForTransition };
}

// ---------------------------------------------------------------------------
// Agent System Prompt & System Message Assembly
// ---------------------------------------------------------------------------

/** Options for building the system message context. */
export interface BuildStreamSystemContextOptions {
  runtime: Runtime;
  metadata: WorkspaceMetadata;
  workspacePath: string;
  workspaceId: string;
  /** Agent definition (may have fallen back to exec). Use `.id` for resolution. */
  agentDefinition: { id: string; scope: AgentDefinitionScope };
  /**
   * Effective mode for the stream. Custom plan-like agents run with
   * effectiveMode "plan" while keeping their own agent id, so "Mode: <mode>"
   * scoped instructions match against both this and the agent id.
   */
  effectiveMode: "plan" | "exec" | "compact";
  /** Runtime that resolved the active agent definition. May be the parent workspace runtime for subagents. */
  agentDiscoveryRuntime: Runtime;
  agentDiscoveryPath: string;
  isSubagentWorkspace: boolean;
  effectiveAdditionalInstructions: string | undefined;
  /** Active workspace plan file path used by mode instructions and tool configuration. */
  planFilePath?: string;
  modelString: string;
  cfg: ProjectsConfig;
  providersConfig?: ProvidersConfigMap | null;
  mcpServers: Parameters<typeof buildSystemMessage>[5];
  xumScope?: XumToolScope;
  loadDesktopCapability?: () => Promise<DesktopCapability>;
  /** Whether the advisor tool is available for the current agent */
  advisorToolAvailable?: boolean;
  /**
   * Whether the memory tool is in the toolset (memory experiment + policy).
   * Gates the hot-memories block: preloaded memory content must not survive
   * when the toolset has no memory tool. The memory index itself lives in the
   * memory tool description (same disclosure mechanic as skills), so it
   * disappears with the tool.
   */
  memoryToolAvailable?: boolean;
  /**
   * Pre-rendered hot-memories block (pinned + frequently used memory files;
   * memory-hot-set sub-experiment). Computed and cached by AgentSession per
   * model/session segment because selection is token-budgeted with the active
   * tokenizer, so repeated turns stay byte-identical (prompt-cache-stable).
   */
  hotMemoriesBlock?: string;
  /** claude-skills-compat experiment: read Claude skills and global instructions (read-only). */
  claudeSkillsCompatEnabled?: boolean;
  /** agent-plugins experiment: discover skills from Agent Plugins containers (read-only). */
  agentPluginsEnabled?: boolean;
}

/** Result of system context assembly. */
export interface StreamSystemContextResult {
  /**
   * Resolved agent prompt as independently-authored sections (agent body with
   * inheritance, optional subagent append_prompt, optional advisor guidance).
   * Kept per-section so scoped Model:/Mode:/Tool: extraction never lets a
   * trailing scoped heading in one section swallow the next section's text.
   */
  agentSystemPromptSections: string[];
  /** Full system message string. */
  systemMessage: string;
  /** Token count of the system message. */
  systemMessageTokens: number;
  /** Available subagent definitions for tool descriptions (undefined for subagent workspaces). */
  agentDefinitions: Awaited<ReturnType<typeof discoverAgentDefinitions>> | undefined;
  /** Available skills for tool descriptions. */
  availableSkills: Awaited<ReturnType<typeof discoverAgentSkills>> | undefined;
  /** Exact ancestor plan files surfaced in the prompt and forwarded through tool configuration. */
  ancestorPlanFilePaths: string[];
}

const MAX_ANCESTOR_PLAN_PATH_HOPS = 32;

interface WorkspaceConfigLookupEntry {
  workspaceName: string;
  projectName: string;
  parentWorkspaceId: string | undefined;
}

interface AncestorPlanPathEntry {
  workspaceName: string;
  planFilePath: string;
}

interface AncestorPlanContext {
  entries: AncestorPlanPathEntry[];
  ancestorPlanFilePaths: string[];
}

function buildWorkspaceConfigLookup(cfg: ProjectsConfig): Map<string, WorkspaceConfigLookupEntry> {
  const workspaceLookup = new Map<string, WorkspaceConfigLookupEntry>();

  for (const [projectPath, project] of cfg.projects) {
    const projectName = path.basename(projectPath) || projectPath || "unknown-project";
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      if (!workspace.name) continue;
      workspaceLookup.set(workspace.id, {
        workspaceName: workspace.name,
        projectName,
        parentWorkspaceId: workspace.parentWorkspaceId,
      });
    }
  }

  return workspaceLookup;
}

function formatAncestorPlanPathInstructions(
  entries: readonly AncestorPlanPathEntry[]
): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return [
    "Ancestor plan file paths (nearest parent first):",
    "If useful for broader context, you may read these ancestor/parent plan files:",
    ...entries.map((entry) => `- ${entry.workspaceName}: ${entry.planFilePath}`),
  ].join("\n");
}

function resolveAncestorPlanContext(args: {
  metadata: WorkspaceMetadata;
  workspaceId: string;
  workspacePath: string;
  runtime: Runtime;
  cfg: ProjectsConfig;
  isSubagentWorkspace: boolean;
  planFilePath?: string;
}): AncestorPlanContext {
  if (!args.isSubagentWorkspace) {
    return { entries: [], ancestorPlanFilePaths: [] };
  }

  const parentWorkspaceId = args.metadata.parentWorkspaceId;
  if (!parentWorkspaceId) {
    return { entries: [], ancestorPlanFilePaths: [] };
  }

  const workspaceLookup = buildWorkspaceConfigLookup(args.cfg);
  const ancestorEntries: AncestorPlanPathEntry[] = [];
  const visitedWorkspaceIds = new Set([args.workspaceId]);
  let currentWorkspaceId: string | undefined = parentWorkspaceId;

  for (let hopCount = 0; currentWorkspaceId; hopCount += 1) {
    if (hopCount >= MAX_ANCESTOR_PLAN_PATH_HOPS) {
      log.debug("Stopping ancestor plan path resolution after maximum hop count", {
        workspaceId: args.workspaceId,
        workspaceName: args.metadata.name,
        currentWorkspaceId,
        maxAncestorPlanPathHops: MAX_ANCESTOR_PLAN_PATH_HOPS,
      });
      break;
    }

    if (visitedWorkspaceIds.has(currentWorkspaceId)) {
      log.debug("Stopping ancestor plan path resolution due to parentWorkspaceId cycle", {
        workspaceId: args.workspaceId,
        workspaceName: args.metadata.name,
        currentWorkspaceId,
      });
      break;
    }
    visitedWorkspaceIds.add(currentWorkspaceId);

    const currentWorkspace = workspaceLookup.get(currentWorkspaceId);
    if (!currentWorkspace) {
      log.debug(
        "Stopping ancestor plan path resolution because parent workspace metadata is missing",
        {
          workspaceId: args.workspaceId,
          workspaceName: args.metadata.name,
          missingWorkspaceId: currentWorkspaceId,
        }
      );
      break;
    }

    ancestorEntries.push({
      workspaceName: currentWorkspace.workspaceName,
      planFilePath: getPlanFilePath(
        currentWorkspace.workspaceName,
        currentWorkspace.projectName,
        args.runtime.getXumHome()
      ),
    });

    currentWorkspaceId = currentWorkspace.parentWorkspaceId;
  }

  const excludedPlanFilePath =
    args.planFilePath == null
      ? undefined
      : args.runtime.normalizePath(args.planFilePath, args.workspacePath);
  const filteredEntries: AncestorPlanPathEntry[] = [];
  const ancestorPlanFilePaths: string[] = [];
  const seenPlanFilePaths = new Set<string>();

  // Keep the prompt text and structured ancestor-plan metadata on the same exact-file source of truth.
  for (const entry of ancestorEntries) {
    const normalizedPlanFilePath = args.runtime.normalizePath(
      entry.planFilePath,
      args.workspacePath
    );
    if (normalizedPlanFilePath === excludedPlanFilePath) {
      continue;
    }
    if (seenPlanFilePaths.has(normalizedPlanFilePath)) {
      continue;
    }
    seenPlanFilePaths.add(normalizedPlanFilePath);
    filteredEntries.push({
      workspaceName: entry.workspaceName,
      planFilePath: normalizedPlanFilePath,
    });
    ancestorPlanFilePaths.push(normalizedPlanFilePath);
  }

  return {
    entries: filteredEntries,
    ancestorPlanFilePaths,
  };
}

function mergeAdditionalInstructions(
  primaryInstructions: string | undefined,
  secondaryInstructions: string | undefined
): string | undefined {
  if (primaryInstructions && secondaryInstructions) {
    return `${primaryInstructions}\n\n${secondaryInstructions}`;
  }

  return primaryInstructions ?? secondaryInstructions;
}

function buildAdvisorGuidanceSection(): string {
  return [
    "<advisor-guidance>",
    "You have access to an advisor tool that consults a stronger model for strategic guidance.",
    ADVISOR_USAGE_GUIDANCE,
    "</advisor-guidance>",
  ].join("\n");
}

/**
 * Proactive-memory guidance (memory experiment). Modeled on Anthropic's
 * memory-tool system-prompt protocol and Claude Code's auto-memory
 * selectivity rules: memory should accumulate quietly during normal work and
 * stay high-signal — noise is the classic failure mode of agent memory.
 * Complements the static <memory> prelude section, which routes explicit
 * user "remember this" requests to AGENTS.md / code comments or the memory tool.
 */
function buildMemoryGuidanceSection(): string {
  return [
    "<memory-tool-guidance>",
    "You have a persistent memory directory (memory tool). Treat it as your own notebook and use it quietly as part of normal work — no announcements, no asking permission:",
    "- Before starting a task, skim the memory index (in the memory tool description) and `view` any files relevant to the task at hand.",
    "- Record durable lessons the moment you learn them: user corrections and confirmed judgment calls, hard-won debugging insights, environment quirks, facts not discoverable from the code.",
    "- Be selective — memory must stay high-signal. Skip one-off task details, anything obvious from the codebase or instruction files, and secrets.",
    "- Maintain as you go: update or delete memories that prove wrong or stale, prefer extending an existing file over creating near-duplicates, and give new files a one-line frontmatter `description:` so the index stays useful.",
    "- For explicit user requests to remember something, follow <memory>: use AGENTS.md/code comments for repo-visible guidance, and use the memory tool for private facts, preferences, or working notes.",
    "</memory-tool-guidance>",
  ].join("\n");
}

/**
 * Build the agent system prompt, system message, and discover available agents/skills.
 *
 * This handles:
 * 1. Resolving the agent body with inheritance (prompt.append merges with base)
 * 2. Appending subagent.append_prompt for subagent workspaces
 * 3. Discovering available subagent definitions for task tool context
 * 4. Discovering available skills for tool descriptions
 * 5. Constructing the final system message
 * 6. Counting system message tokens
 */
export async function buildStreamSystemContext(
  opts: BuildStreamSystemContextOptions
): Promise<StreamSystemContextResult> {
  const {
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
    modelString,
    cfg,
    providersConfig,
    mcpServers,
    xumScope,
    loadDesktopCapability,
    advisorToolAvailable,
  } = opts;

  const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });

  // Resolve the body with inheritance (prompt.append merges with base).
  // Use agentDefinition.id (may have fallen back to exec) instead of effectiveAgentId.
  const resolvedBody = await resolveAgentBody(
    agentDiscoveryRuntime,
    agentDiscoveryPath,
    agentDefinition.id,
    {
      includeAgentPlugins: opts.agentPluginsEnabled,
      skipScopesAbove: getSkipScopesAboveForKnownScope(agentDefinition.scope),
    }
  );

  let subagentAppendPrompt: string | undefined;
  if (isSubagentWorkspace) {
    try {
      const resolvedFrontmatter = await resolveAgentFrontmatter(
        agentDiscoveryRuntime,
        agentDiscoveryPath,
        agentDefinition.id,
        {
          includeAgentPlugins: opts.agentPluginsEnabled,
          skipScopesAbove: getSkipScopesAboveForKnownScope(agentDefinition.scope),
        }
      );
      subagentAppendPrompt = resolvedFrontmatter.subagent?.append_prompt;
    } catch (error: unknown) {
      workspaceLog.debug("Failed to resolve agent frontmatter for subagent append_prompt", {
        agentId: agentDefinition.id,
        error: getErrorMessage(error),
      });
    }
  }

  const agentSystemPromptSections = [resolvedBody];
  if (isSubagentWorkspace && subagentAppendPrompt) {
    agentSystemPromptSections.push(subagentAppendPrompt);
  }
  if (advisorToolAvailable) {
    // Keep prompt guidance in lockstep with actual tool availability for the agent.
    agentSystemPromptSections.push(buildAdvisorGuidanceSection());
  }
  if (opts.memoryToolAvailable) {
    // Same lockstep rule: the post-policy system-context rebuild strips this
    // section when tool policy removes the memory tool.
    agentSystemPromptSections.push(buildMemoryGuidanceSection());
  }

  // Discover available agent definitions for sub-agent context (only for top-level workspaces).
  //
  // NOTE: discoverAgentDefinitions returns disabled agents too, so Settings can surface them.
  // For tool descriptions (task tool), filter to agents that are effectively enabled.
  let agentDefinitions: Awaited<ReturnType<typeof discoverAgentDefinitions>> | undefined;
  if (!isSubagentWorkspace) {
    agentDefinitions = await discoverAvailableSubagentsForToolContext({
      runtime: agentDiscoveryRuntime,
      workspacePath: agentDiscoveryPath,
      cfg,
      loadDesktopCapability,
      includeAgentPlugins: opts.agentPluginsEnabled,
    });
  }

  // Discover available skills for tool description context
  const skillCtx = resolveSkillStorageContext({
    runtime,
    workspacePath,
    xumScope,
    includeClaudeSkills: opts.claudeSkillsCompatEnabled,
    includeAgentPlugins: opts.agentPluginsEnabled,
  });

  let availableSkills: Awaited<ReturnType<typeof discoverAgentSkills>> | undefined;
  try {
    availableSkills = await discoverAgentSkills(skillCtx.runtime, skillCtx.workspacePath, {
      roots: skillCtx.roots,
      containment: skillCtx.containment,
      // Used only for the project-runtime default-roots fallback (skillCtx.roots undefined).
      includeClaudeSkills: opts.claudeSkillsCompatEnabled,
      includeAgentPlugins: opts.agentPluginsEnabled,
    });
  } catch (error) {
    workspaceLog.warn("Failed to discover agent skills for tool description", { error });
  }

  const ancestorPlanContext = resolveAncestorPlanContext({
    metadata,
    workspaceId,
    workspacePath,
    runtime,
    cfg,
    isSubagentWorkspace,
    planFilePath,
  });
  const mergedAdditionalInstructions = mergeAdditionalInstructions(
    formatAncestorPlanPathInstructions(ancestorPlanContext.entries),
    effectiveAdditionalInstructions
  );

  // Build system message from workspace metadata
  let systemMessage = await buildSystemMessage(
    metadata,
    runtime,
    workspacePath,
    mergedAdditionalInstructions,
    modelString,
    mcpServers,
    // "Mode: <mode>" sections in Xum-dedicated instruction sources match the
    // effective mode (so "Mode: plan" also covers custom plan-like agents)
    // and the agent id (so per-agent sections work). The effective mode names
    // the injected <mode-...> tag; agentDefinition.id (may have fallen back
    // to exec) is the prompt actually in effect.
    {
      agentSystemPromptSections,
      modes: [effectiveMode, agentDefinition.id],
      projectConfigs: cfg.projects,
      claudeSkillsCompatEnabled: opts.claudeSkillsCompatEnabled,
    }
  );

  // Append the hot-memories block (memory-hot-set sub-experiment). Placed at
  // the end of the system message so the most recent stable prompt prefix
  // stays byte-identical for provider prompt caching. The memory index lives
  // in the memory tool description (same disclosure mechanic as skills).
  if (opts.memoryToolAvailable && opts.hotMemoriesBlock) {
    systemMessage = `${systemMessage}\n\n${opts.hotMemoriesBlock}`;
  }

  // Count system message tokens for cost tracking
  const metadataModel = resolveModelForMetadata(modelString, providersConfig ?? null);
  const tokenizer = await getTokenizerForModel(modelString, metadataModel);
  const systemMessageTokens = await tokenizer.countTokens(systemMessage);

  return {
    agentSystemPromptSections,
    systemMessage,
    systemMessageTokens,
    agentDefinitions,
    availableSkills,
    ancestorPlanFilePaths: ancestorPlanContext.ancestorPlanFilePaths,
  };
}

// ---------------------------------------------------------------------------
// Subagent Discovery Helper
// ---------------------------------------------------------------------------

/**
 * Discover agent definitions for tool description context.
 *
 * The task tool lists "Available sub-agents" by filtering on
 * AgentDefinitionDescriptor.subagentRunnable.
 *
 * NOTE: discoverAgentDefinitions() sets descriptor.subagentRunnable from the agent's *own*
 * frontmatter only, which means derived agents (e.g. `base: exec`) may incorrectly appear
 * non-runnable if they don't repeat `subagent.runnable: true`.
 *
 * Re-resolve frontmatter with inheritance (base-first) so subagent.runnable is inherited.
 */
export async function discoverAvailableSubagentsForToolContext(args: {
  runtime: Parameters<typeof discoverAgentDefinitions>[0];
  workspacePath: string;
  cfg: ProjectsConfig;
  roots?: AgentDefinitionsRoots;
  loadDesktopCapability?: () => Promise<DesktopCapability>;
  /** agent-plugins experiment: also discover agents contributed by Agent Plugins. */
  includeAgentPlugins?: boolean;
}): Promise<Awaited<ReturnType<typeof discoverAgentDefinitions>>> {
  assert(args, "discoverAvailableSubagentsForToolContext: args is required");
  assert(args.runtime, "discoverAvailableSubagentsForToolContext: runtime is required");
  assert(
    args.workspacePath && args.workspacePath.length > 0,
    "discoverAvailableSubagentsForToolContext: workspacePath is required"
  );
  assert(args.cfg, "discoverAvailableSubagentsForToolContext: cfg is required");

  const discovered = await discoverAgentDefinitions(args.runtime, args.workspacePath, {
    roots: args.roots,
    includeAgentPlugins: args.includeAgentPlugins,
  });

  let desktopAvailablePromise: Promise<boolean> | undefined;
  const isDesktopAvailable = async (): Promise<boolean> => {
    if (!args.loadDesktopCapability) {
      return false;
    }

    // Keep desktop requirement checks request-scoped: one DesktopSessionManager probe can gate
    // every desktop-only agent discovered for the same tool-context build.
    desktopAvailablePromise ??= args
      .loadDesktopCapability()
      .then((desktopCapability) => desktopCapability.available)
      .catch(() => false);
    return await desktopAvailablePromise;
  };

  const resolved = await Promise.all(
    discovered.map(async (descriptor) => {
      try {
        const resolvedFrontmatter = await resolveAgentFrontmatter(
          args.runtime,
          args.workspacePath,
          descriptor.id,
          {
            roots: args.roots,
            includeAgentPlugins: args.includeAgentPlugins,
            skipScopesAbove: getSkipScopesAboveForKnownScope(descriptor.scope),
          }
        );

        const effectivelyDisabled = isAgentEffectivelyDisabled({
          cfg: args.cfg,
          agentId: descriptor.id,
          resolvedFrontmatter,
        });

        if (effectivelyDisabled) {
          return null;
        }

        // The built-in `desktop` agent is the only definition whose subagent menu visibility
        // depends on runtime capability. Limit the gate to the built-in scope so a user
        // override at `.xum/agents/desktop.md` (or the global equivalent) replaces the built-in
        // semantics entirely and is not silently hidden when the workspace lacks a desktop
        // session.
        if (
          descriptor.id === "desktop" &&
          descriptor.scope === "built-in" &&
          !(await isDesktopAvailable())
        ) {
          return null;
        }

        return {
          ...descriptor,
          // Important: descriptor.subagentRunnable comes from the agent's own frontmatter only.
          // Re-resolve with inheritance so derived agents inherit runnable: true from their base.
          subagentRunnable: resolvedFrontmatter.subagent?.runnable ?? false,
        };
      } catch {
        // Best-effort: keep the descriptor if enablement or inheritance can't be resolved.
        return descriptor;
      }
    })
  );

  return resolved.filter((descriptor): descriptor is NonNullable<typeof descriptor> =>
    Boolean(descriptor)
  );
}
