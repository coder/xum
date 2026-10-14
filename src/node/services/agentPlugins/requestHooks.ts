import * as path from "node:path";
import type { Config } from "@/node/config";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";
import { sideChatCapabilityGrants } from "@/node/services/sideChat";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { eventSpine } from "@/node/services/events/eventSpine";
import { codexPluginHookService } from "./codexHookService";
import { agentPluginHookService } from "./hookService";
import { resolveAgentPluginsMcpContext } from "./mcpConfig";

/**
 * The per-call trust gate of Codex hooks. It re-reads the workspace's projects too: `metadata` is
 * the send's snapshot, and a project added mid-turn must count from the next hook call (Codex
 * PRRT_kwDOPxxmWM6sGAw0). A workspace that is gone runs no hook.
 */
function isWorkspaceTrustedNow(config: Config, metadata: WorkspaceMetadata): boolean {
  const current = config.findWorkspace(metadata.id);
  if (current === null) return false;
  const live =
    current.projects !== undefined ? { ...metadata, projects: current.projects } : metadata;
  return isWorkspaceTrustedForSharedExecution(live, config.loadConfigOrDefault().projects);
}

/** Shared lazy hook setup for ordinary request building and rollover admission. No model/tools. */
export async function prepareWorkspaceRequestHooks(args: {
  config: Config;
  metadata: WorkspaceMetadata;
  hostCheckoutRoot: string | null;
  journal: DurableEventJournal;
  /** Codex-format hooks (hooks.json) call plugin MCP servers through it; absent: none run. */
  mcpServerManager?: Pick<MCPServerManager, "callToolForPluginHook" | "canCallToolForPluginHook">;
}): Promise<void> {
  const pluginContext = args.hostCheckoutRoot
    ? resolveAgentPluginsMcpContext(args.metadata, args.hostCheckoutRoot)
    : null;
  await agentPluginHookService.ensureWorkspaceHooksForRequest({
    workspaceId: args.metadata.id,
    sessionDir: path.join(args.config.sessionsDir, args.metadata.id),
    journal: args.journal,
    xumHome: args.config.rootDir,
    projectRoot: pluginContext?.projectRoot,
    projectKey: pluginContext?.projectKey,
    projectTrusted: isWorkspaceProjectTrusted(args.config, args.metadata),
  });
  if (args.mcpServerManager !== undefined) {
    const { config, metadata } = args;
    await codexPluginHookService.ensureWorkspaceHooks({
      workspaceId: metadata.id,
      sideChat: sideChatCapabilityGrants(metadata) != null,
      noPluginMcp: pluginContext === null,
      xumHome: config.rootDir,
      // A function, not a value: the gate re-reads trust before every hook call. Every project of
      // the workspace must be trusted: hooks run MCP tools in the runtime they all share, the
      // rule for the repo's own tool hooks too (Codex PRRT_kwDOPxxmWM6r_vUC).
      isProjectTrusted: () => isWorkspaceTrustedNow(config, metadata),
      mcp: args.mcpServerManager,
      notifyUser: (pluginName, message) =>
        eventSpine.emit("plugin.hook.notice", { workspaceId: metadata.id, pluginName, message }),
    });
  }
}
