import * as path from "node:path";
import type { Config } from "@/node/config";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { sideChatCapabilityGrants } from "@/node/services/sideChat";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { log } from "@/node/services/log";
import { codexPluginHookService } from "./codexHookService";
import { agentPluginHookService } from "./hookService";
import { resolveAgentPluginsMcpContext } from "./mcpConfig";

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
    projectTrusted: isWorkspaceProjectTrusted(args.config, args.metadata),
  });
  if (args.mcpServerManager !== undefined) {
    const { config, metadata } = args;
    await codexPluginHookService.ensureWorkspaceHooks({
      workspaceId: metadata.id,
      sideChat: sideChatCapabilityGrants(metadata) != null,
      xumHome: config.rootDir,
      // A function, not a value: the gate re-reads trust before every hook call.
      isProjectTrusted: () => isWorkspaceProjectTrusted(config, metadata),
      mcp: args.mcpServerManager,
      notifyUser: (pluginName, message) =>
        log.info("Plugin hook message", { workspaceId: metadata.id, pluginName, message }),
    });
  }
}
