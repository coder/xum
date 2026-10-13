/**
 * The first UserPromptSubmit after a restart: AIService.runMessageSendHooks starts the workspace's
 * MCP servers (the turn's own startup) before the Codex prompt hooks run, so a hook whose plugin
 * server is not running yet still sees the prompt. Real plugin files, registry, trust store and
 * local runtime; the MCP manager is a fake that records the order.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { ProvidersConfigStore } from "@/node/config";
import { AIService } from "./aiService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import type { MCPServerManager } from "./mcpServerManager";
import { createTestHistoryService } from "./testHistoryService";
import { codexPluginHookService } from "./agentPlugins/codexHookService";
import { loadPluginCodexHooks } from "./agentPlugins/codexHooks";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./agentPlugins/manifest";
import { computePluginInstanceId } from "./agentPlugins/mcpConfig";
import { setPluginHookTrust } from "./agentPlugins/pluginHookTrust";
import { PLUGIN_REGISTRY_FILE_NAME } from "./agentPlugins/registry";
import { createTestPluginInstallEntry } from "./agentPlugins/testFixtures";

const workspaceId = "prompt-hook-startup";
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await codexPluginHookService.disposeWorkspace(workspaceId);
  await cleanup?.();
  cleanup = undefined;
});

async function setup(hooksDocument: unknown, metadataOverrides: Partial<WorkspaceMetadata> = {}) {
  const fixture = await createTestHistoryService();
  cleanup = fixture.cleanup;
  const { config, historyService } = fixture;
  const root = config.rootDir;
  const projectPath = path.join(fixture.tempDir, "project");
  await fs.mkdir(projectPath, { recursive: true });
  // AIService creates the sessions dir in the background; create it first so teardown is quiet.
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  await config.editConfig((cfg) => {
    cfg.projects.set(projectPath, {
      trusted: true,
      workspaces: [{ path: projectPath, id: workspaceId }],
    });
    return cfg;
  });
  const pluginRoot = path.join(root, "plugins", "guard");
  await fs.mkdir(path.join(pluginRoot, "hooks"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "guard" })
  );
  await fs.writeFile(path.join(pluginRoot, "hooks", "hooks.json"), JSON.stringify(hooksDocument));
  await fs.writeFile(
    path.join(root, PLUGIN_REGISTRY_FILE_NAME),
    JSON.stringify({ plugins: [createTestPluginInstallEntry("guard")] })
  );
  // No com.openai extension: the default hooks/hooks.json.
  const { hooks } = await loadPluginCodexHooks({ rootPath: await fs.realpath(pluginRoot) });
  for (const hook of hooks) {
    await setPluginHookTrust(root, computePluginInstanceId(pluginRoot), {
      key: hook.key,
      hash: hook.hash,
      state: "trusted",
    });
  }

  const providersConfigStore = new ProvidersConfigStore(config.rootDir);
  const service = new AIService(
    config,
    historyService,
    new InitStateManager(config),
    new ProviderService(config, providersConfigStore),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    providersConfigStore
  );
  const metadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "workspace",
    projectName: "project",
    projectPath,
    runtimeConfig: { type: "local" },
    ...metadataOverrides,
  };
  spyOn(service, "getWorkspaceMetadata").mockResolvedValue({ success: true, data: metadata });

  const order: string[] = [];
  let running = false;
  const getToolsForWorkspace = mock((options: { workspaceId: string; trusted?: boolean }) => {
    order.push(`startup:${options.workspaceId}:${String(options.trusted)}`);
    running = true;
    return Promise.resolve({ tools: {}, toolServerNames: {}, promptDescriptors: [], stats: {} });
  });
  const callToolForPluginHook = mock(() => {
    order.push("hook");
    // Like the real manager: a server that has not started is refused.
    return running
      ? Promise.resolve({ structuredContent: { decision: "block", reason: "No secrets." } })
      : Promise.reject(new Error("MCP server is not running"));
  });
  service.turnRequestBuilderBindings.mcpServerManager = {
    getToolsForWorkspace,
    callToolForPluginHook,
  } as unknown as MCPServerManager;
  return { service, order, getToolsForWorkspace };
}

const promptHook = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "mcp_tool", server: "scanner", tool: "check" }] }],
  },
};

describe("UserPromptSubmit hooks on the first prompt", () => {
  test("the workspace's MCP startup runs before the hooks, so the first prompt is checked", async () => {
    const { service, order } = await setup(promptHook);

    const outcome = await service.runMessageSendHooks(workspaceId, {
      text: "key=abc",
      origin: "user",
      canBlock: true,
    });

    expect(outcome).toEqual({ kind: "blocked", pluginName: "guard", reason: "No secrets." });
    expect(order).toEqual([`startup:${workspaceId}:true`, "hook"]);
  });

  test("a side chat starts no MCP server before its hooks (its local-read-only ceiling)", async () => {
    const { service, getToolsForWorkspace } = await setup(promptHook, {
      sideChatParentWorkspaceId: "main-workspace",
    });

    const outcome = await service.runMessageSendHooks(workspaceId, {
      text: "key=abc",
      origin: "user",
      canBlock: true,
    });

    expect(getToolsForWorkspace).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "none" });
  });

  test("a workspace without UserPromptSubmit hooks starts nothing before the send", async () => {
    const { service, getToolsForWorkspace } = await setup({
      hooks: { PreToolUse: [{ hooks: [{ type: "mcp_tool", server: "scanner", tool: "check" }] }] },
    });

    await service.runMessageSendHooks(workspaceId, {
      text: "hello",
      origin: "user",
      canBlock: true,
    });

    expect(getToolsForWorkspace).not.toHaveBeenCalled();
  });
});
