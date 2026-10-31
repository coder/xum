/**
 * Node adapter for the unified agent AI-settings resolver: reads agent
 * definitions, assembles the declared base chain, gathers configured defaults,
 * and delegates all precedence to the pure resolver. Owns missing-definition
 * and cycle logging so the pure layer stays side-effect free.
 */

import type { ServiceTier } from "@/common/config/schemas/providersConfig";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type {
  AgentAiAncestorLayer,
  AgentAiDefinitionDefaults,
  AgentAiProfile,
  AgentAiSettingsLayerValues,
  ResolvedAgentAiSettings,
} from "@/common/types/agentAiSettings";
import type {
  OpenAIReasoningMode,
  ParsedThinkingInput,
  ThinkingLevel,
} from "@/common/types/thinking";
import {
  applySettingsBaseChain,
  chainSettingsBase,
  collectDefinitionLayers,
} from "@/common/utils/ai/agentAncestorLayers";
import type { AnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import {
  resolveAgentAiSettings,
  resolveAgentCacheTtl,
} from "@/common/utils/ai/resolveAgentAiSettings";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import {
  isRuntimeReadFailure,
  isRuntimeTransportError,
  type Runtime,
} from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

import { readAgentDefinition, type AgentDefinitionRequestCache } from "./agentDefinitionsService";
import {
  resolveAgentInheritanceChain,
  type AgentForInheritance,
} from "./resolveAgentInheritanceChain";
import type { RuntimeFactory } from "@/node/services/runtimeFactory/runtimeFactoryService";

/** Checkout context for reading agent definitions; omit when unavailable. */
export interface NodeAgentDefinitionContext {
  runtime: Runtime;
  workspacePath: string;
  workspaceId: string;
  /** #6426: only `true` lets project plugin agents (and bases) load. */
  projectPluginsTrusted?: boolean;
  /** Builds the host-local runtimes of the definition reads. */
  runtimeFactory: RuntimeFactory;
}

export interface ResolveNodeAgentAiSettingsParams {
  agentId: string;
  profile: AgentAiProfile;
  cfg: {
    agentAiDefaults?: AgentAiDefaults;
    minThinkingLevelByModel?: Record<string, ThinkingLevel>;
  };
  providersConfig?: ProvidersConfigMap | null;
  explicit?: {
    model?: string;
    thinkingLevel?: ParsedThinkingInput;
    reasoningMode?: OpenAIReasoningMode;
    serviceTier?: ServiceTier;
  };
  targetWorkspaceSettings?: AgentAiSettingsLayerValues;
  parentWorkspaceExecSettings?: AgentAiSettingsLayerValues;
  parentRuntime?: AgentAiSettingsLayerValues;
  fallbacks?: readonly AgentAiSettingsLayerValues[];
  defaultModel?: string;
  /**
   * When present, target/ancestor definition `ai` defaults and the declared
   * base chain are read from the checkout. When absent (e.g. recovery paths
   * without a live runtime), resolution uses the implicit fallback ancestor
   * only.
   */
  definitionContext?: NodeAgentDefinitionContext;
}

/** The agent's prompt-cache TTL over its resolved inheritance chain (see resolveAgentCacheTtl). */
export function resolveChainAgentCacheTtl(
  agentId: string,
  agentAiDefaults: AgentAiDefaults | undefined,
  chain: Parameters<typeof collectDefinitionLayers>[1]
): AnthropicCacheTtl | undefined {
  return resolveAgentCacheTtl({
    targetAgentId: agentId,
    agentAiDefaults,
    ...collectDefinitionLayers(agentId, chain),
  })?.value;
}

type SettingsBaseReadContext = NodeAgentDefinitionContext & {
  cache?: AgentDefinitionRequestCache;
  abortSignal?: AbortSignal;
};

/**
 * The settings-base agent's chain, read as the inheritance walk reads a base: null when the agent
 * is absent, and a throw when the read was aborted or failed (unreachable host, permission).
 */
async function readSettingsBaseChain(
  settingsBase: string,
  context: SettingsBaseReadContext
): Promise<AgentForInheritance[] | null> {
  const readOptions = {
    cache: context.cache,
    projectPluginsTrusted: context.projectPluginsTrusted,
    runtimeFactory: context.runtimeFactory,
    abortSignal: context.abortSignal,
  };
  try {
    const agentDefinition = await readAgentDefinition(
      context.runtime,
      context.workspacePath,
      settingsBase,
      readOptions
    );
    const chain = await resolveAgentInheritanceChain({
      runtime: context.runtime,
      workspacePath: context.workspacePath,
      agentId: agentDefinition.id,
      agentDefinition,
      workspaceId: context.workspaceId,
      ...readOptions,
    });
    // A chain that stops at a missing or cyclic base does not resolve in agents.list either, so
    // the run ignores it too instead of resolving over part of it.
    return chain.at(-1)?.base == null ? chain : null;
  } catch (error) {
    if (context.abortSignal?.aborted === true || isRuntimeReadFailure(error)) throw error;
    return null;
  }
}

/**
 * The chain an agent's AI settings resolve over (Cursor plugin RFC, D11): its inheritance chain
 * with `ai.settingsBase` applied. Tool policy keeps the inheritance chain. An ignored settings
 * base logs a warning and leaves the chain as it is (D26).
 */
export async function resolveAgentAiSettingsChain(
  agentId: string,
  chain: AgentForInheritance[],
  context: SettingsBaseReadContext
): Promise<AgentForInheritance[]> {
  const settingsBase = chainSettingsBase(chain);
  if (settingsBase == null) return chain;
  const result = applySettingsBaseChain(
    agentId,
    chain,
    await readSettingsBaseChain(settingsBase, context)
  );
  if (result.ignored != null) {
    log.warn("settingsBase ignored", { agentId, settingsBase, reason: result.ignored });
  }
  return result.chain;
}

/** Definition-derived resolver layers for one agent (target defaults + declared ancestors). */
export interface AgentDefinitionAiLayers {
  targetDefinitionAiDefaults?: AgentAiDefinitionDefaults;
  ancestors: AgentAiAncestorLayer[];
}

/**
 * Reads the target definition and its declared base chain. Returns null when the
 * chain is unavailable (missing/unreadable definition) or the read was aborted;
 * callers decide the fallback. Rethrows a transport RuntimeError (unreachable
 * host), so callers fail retryably instead of resolving without the chain. The abort signal is forwarded to the runtime
 * reads so a timeout cancels underlying (e.g. SSH) work for runtimes that honor
 * it, and settles this promise promptly even while a runtime call is still pending.
 */
export async function loadAgentDefinitionAiLayers(
  agentId: string,
  context: NodeAgentDefinitionContext,
  options?: { abortSignal?: AbortSignal }
): Promise<AgentDefinitionAiLayers | null> {
  assert(agentId.length > 0, "loadAgentDefinitionAiLayers: agentId must be non-empty");
  const abortSignal = options?.abortSignal;
  if (abortSignal?.aborted) return null;

  const load = async (): Promise<AgentDefinitionAiLayers> => {
    const agentDefinition = await readAgentDefinition(
      context.runtime,
      context.workspacePath,
      agentId,
      {
        ...(abortSignal != null ? { abortSignal } : {}),
        projectPluginsTrusted: context.projectPluginsTrusted,
        runtimeFactory: context.runtimeFactory,
      }
    );
    const chain = await resolveAgentInheritanceChain({
      runtime: context.runtime,
      workspacePath: context.workspacePath,
      agentId: agentDefinition.id,
      agentDefinition,
      workspaceId: context.workspaceId,
      ...(abortSignal != null ? { abortSignal } : {}),
      projectPluginsTrusted: context.projectPluginsTrusted,
      runtimeFactory: context.runtimeFactory,
    });
    return collectDefinitionLayers(
      agentId,
      await resolveAgentAiSettingsChain(agentId, chain, { ...context, abortSignal })
    );
  };

  let removeAbortListener: (() => void) | undefined;
  try {
    const work = load();
    if (abortSignal == null) return await work;
    // Some discovery steps (path resolution, candidate scans) take no signal; race
    // them so an abort still settles this call. The loser's rejection is observed.
    work.catch(() => undefined);
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        const reason: unknown = abortSignal.reason;
        reject(reason instanceof Error ? reason : new Error("aborted"));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([work, aborted]);
  } catch (error) {
    // An unreachable host is not a missing definition: resolving without the
    // definition layers would silently pick default AI settings (#4829). Aborts
    // are checked first because SSH2 reports an aborted exec as "network".
    if (abortSignal?.aborted !== true && isRuntimeTransportError(error)) throw error;
    log.debug("resolveNodeAgentAiSettings: definition chain unavailable", {
      agentId,
      workspaceId: context.workspaceId,
      aborted: abortSignal?.aborted === true,
      error: getErrorMessage(error),
    });
    return null;
  } finally {
    removeAbortListener?.();
  }
}

/** Synchronous resolution over already-loaded definition layers. */
export function resolveNodeAgentAiSettingsWithLayers(
  params: Omit<ResolveNodeAgentAiSettingsParams, "definitionContext">,
  layers: AgentDefinitionAiLayers
): ResolvedAgentAiSettings {
  const result = resolveAgentAiSettings({
    targetAgentId: params.agentId,
    profile: params.profile,
    explicit: params.explicit,
    targetWorkspaceSettings: params.targetWorkspaceSettings,
    agentAiDefaults: params.cfg.agentAiDefaults,
    targetDefinitionAiDefaults: layers.targetDefinitionAiDefaults,
    ancestors: layers.ancestors,
    parentWorkspaceExecSettings: params.parentWorkspaceExecSettings,
    parentRuntime: params.parentRuntime,
    fallbacks: params.fallbacks,
    defaultModel: params.defaultModel,
    providersConfig: params.providersConfig,
    minThinkingLevelByModel: params.cfg.minThinkingLevelByModel,
  });

  for (const diagnostic of result.diagnostics) {
    log.debug("resolveNodeAgentAiSettings: " + diagnostic, { agentId: params.agentId });
  }

  return result;
}

export async function resolveNodeAgentAiSettings(
  params: ResolveNodeAgentAiSettingsParams
): Promise<ResolvedAgentAiSettings> {
  // A missing or unreadable definition must not break resolution: fall back
  // to the implicit base the resolver appends on its own. An unreachable host
  // throws instead (see loadAgentDefinitionAiLayers).
  const layers =
    params.definitionContext != null
      ? await loadAgentDefinitionAiLayers(params.agentId, params.definitionContext)
      : null;
  return resolveNodeAgentAiSettingsWithLayers(params, layers ?? { ancestors: [] });
}
