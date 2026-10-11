/**
 * Per-workspace lifecycle for Codex-format plugin hooks (hooks.json): discovers the managed
 * global plugins, registers each plugin's runnable hooks (codexHookRunner.ts) on the event spine,
 * and supplies the runner's dependencies.
 *
 * Scope: managed global plugins only (`~/.xum/plugins`, in the install registry). Project
 * plugins and unmanaged global plugins never run hooks.json hooks: their trust review is a
 * follow-up, and an unreviewed hook must not run.
 *
 * The gate before EACH hook call (the fix for #6042's P1-a and P1-b) reads, at that moment:
 * 1. the workspace's project trust (live config read);
 * 2. the trust store (pluginHookTrust.ts): this exact hash must be trusted;
 * 3. the plugin's hooks on disk: the hook must still be declared with this hash, so an edit,
 *    an update or an uninstall stops it before the next registration catches up.
 * The MCP call itself then requires the plugin's server to be enabled and running in this
 * workspace (MCPServerManager.callToolForPluginHook).
 */
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { eventSpine, type EventSpine } from "@/node/services/events/eventSpine";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { isAgentToolsDisabled } from "@/node/utils/agentToolsDisabled";
import {
  discoverAgentPlugins,
  MAX_PLUGIN_MANIFEST_BYTES,
  readPluginFileWithinRootCapped,
  type AgentPluginInfo,
} from "./discovery";
import { validatePluginManifest, type AgentPluginManifest } from "./manifest";
import { loadPluginCodexHooks, type PluginHookDefinition } from "./codexHooks";
import {
  HOOK_DEFAULT_TIMEOUT_SECONDS,
  HOOK_MAX_TIMEOUT_SECONDS,
  registerCodexPluginHooks,
  type CodexHookRunnerDeps,
} from "./codexHookRunner";
import { buildPluginServerKey, computePluginInstanceId } from "./mcpConfig";
import { isPluginHookTrusted, readPluginHookTrust } from "./pluginHookTrust";
import { PLUGIN_REGISTRY_FILE_NAME } from "./registry";

export interface EnsureCodexHooksArgs {
  workspaceId: string;
  /** Xum home (config.rootDir): the managed container and the trust store live here. */
  xumHome: string;
  /** Live project-trust read for this workspace; called before every hook call. */
  isProjectTrusted: () => boolean;
  mcp: Pick<MCPServerManager, "callToolForPluginHook" | "canCallToolForPluginHook">;
  /** Shows a hook's systemMessage to the user (never the model). */
  notifyUser: (pluginName: string, message: string) => void;
  /**
   * A `/side` chat: its local-read-only ceiling excludes MCP, so no hook runs there, even when
   * another path (prompt listing) started the plugin's server (Codex PRRT_kwDOPxxmWM6rN8JJ).
   */
  sideChat: boolean;
}

interface WorkspaceRegistration {
  fingerprint: string;
  unregister: () => void;
  /** Longest UserPromptSubmit hook timeout (ms); undefined when the workspace has none. */
  promptHookBudgetMs?: number;
}

export class CodexPluginHookService {
  private readonly registrations = new Map<string, WorkspaceRegistration>();
  private readonly locks = new Map<string, AsyncMutex>();

  constructor(private readonly spine: EventSpine = eventSpine) {}

  /** Register (or refresh) the workspace's hooks. Fail-soft: a broken plugin is skipped. */
  async ensureWorkspaceHooks(args: EnsureCodexHooksArgs): Promise<void> {
    let lock = this.locks.get(args.workspaceId);
    if (lock === undefined) {
      lock = new AsyncMutex();
      this.locks.set(args.workspaceId, lock);
    }
    await using _guard = await lock.acquire();
    // XUM_DISABLE_AGENT_TOOLS (bug-bash real mode) sends no tools: no hook may call MCP either
    // (Codex PRRT_kwDOPxxmWM6rPrkn).
    if (args.sideChat || isAgentToolsDisabled()) {
      this.registrations.get(args.workspaceId)?.unregister();
      this.registrations.delete(args.workspaceId);
      return;
    }
    const plugins = await this.discoverManagedPlugins(args.xumHome);
    const loaded = await Promise.all(
      plugins.map(async (plugin) => ({ plugin, ...(await loadPluginCodexHooks(plugin)) }))
    );
    // Only hooks trusted NOW register, so an untrusted hook's matcher (a plugin regex, possibly
    // catastrophic) never runs (Codex PRRT_kwDOPxxmWM6rPrkq). Trust can change afterwards: the
    // per-call gate still refuses a revoked hook, and this refresh runs on every send and turn,
    // so a newly trusted hook registers on the next one (the fingerprint changes).
    const projectTrusted = args.isProjectTrusted();
    const runnable = (
      await Promise.all(
        loaded.map(async (entry) => {
          if (!projectTrusted) return { ...entry, hooks: [] };
          const trust = await readPluginHookTrust(args.xumHome, instanceIdOf(entry.plugin));
          return {
            ...entry,
            hooks: entry.hooks.filter(
              (hook) => hook.status === "runnable" && isPluginHookTrusted(trust, hook)
            ),
          };
        })
      )
    ).filter((entry) => entry.hooks.length > 0);
    // Key and hash: the per-call gate matches both, so a hook that only moved (new key, same
    // hash) must re-register or its stale key is refused forever.
    const fingerprint = JSON.stringify(
      runnable.map((entry) => [
        entry.plugin.rootPath,
        entry.hooks.map((hook) => [hook.key, hook.hash]),
      ])
    );
    const existing = this.registrations.get(args.workspaceId);
    if (existing?.fingerprint === fingerprint) return;
    existing?.unregister();
    const unregisters = runnable.map((entry, order) =>
      registerCodexPluginHooks(this.spine, {
        workspaceId: args.workspaceId,
        pluginName: entry.plugin.name,
        order,
        hooks: entry.hooks,
        deps: this.depsFor(entry.plugin, args),
      })
    );
    const promptTimeouts: number[] = [];
    for (const hook of runnable.flatMap((entry) => entry.hooks)) {
      if (hook.event !== "UserPromptSubmit" || hook.handler.type !== "mcp_tool") continue;
      const seconds = hook.handler.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS;
      promptTimeouts.push(Math.min(seconds, HOOK_MAX_TIMEOUT_SECONDS));
    }
    this.registrations.set(args.workspaceId, {
      fingerprint,
      unregister: () => unregisters.forEach((unregister) => unregister()),
      ...(promptTimeouts.length > 0
        ? { promptHookBudgetMs: Math.max(...promptTimeouts) * 1000 }
        : {}),
    });
  }

  /**
   * Before the UserPromptSubmit hooks run: wait for the workspace's MCP startup, the same one the
   * turn runs right after (`startServers`), bounded by the longest of those hooks' timeouts.
   * Without this, the first prompt after a restart reaches the hooks before their plugin's server
   * runs, and they fail open. A failed or slow startup is logged and the hooks run anyway (they
   * then fail open as before). No-op when the workspace has no UserPromptSubmit hook. A canceled
   * send (`cancelSignal`) ends the wait at once.
   */
  async prepareForPromptHooks(
    workspaceId: string,
    startServers: (signal: AbortSignal) => Promise<boolean>,
    cancelSignal?: AbortSignal
  ): Promise<void> {
    const budgetMs = this.registrations.get(workspaceId)?.promptHookBudgetMs;
    if (budgetMs === undefined || cancelSignal?.aborted === true) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCancel = () => controller.abort();
    cancelSignal?.addEventListener("abort", onCancel, { once: true });
    try {
      const outcome = await Promise.race([
        startServers(controller.signal).then((ready) => (ready ? "started" : "not-ready")),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            resolve("timeout");
            controller.abort();
          }, budgetMs);
        }),
        new Promise<"canceled">((resolve) => {
          controller.signal.addEventListener("abort", () => resolve("canceled"), { once: true });
        }),
      ]);
      if (outcome !== "started" && outcome !== "canceled") {
        log.warn("Plugin hooks: MCP startup before UserPromptSubmit did not finish", {
          workspaceId,
          outcome,
        });
      }
    } catch (error) {
      log.warn("Plugin hooks: MCP startup before UserPromptSubmit failed", { workspaceId, error });
    } finally {
      clearTimeout(timer);
      cancelSignal?.removeEventListener("abort", onCancel);
    }
  }

  async disposeWorkspace(workspaceId: string): Promise<void> {
    const lock = this.locks.get(workspaceId);
    await using _guard = lock !== undefined ? await lock.acquire() : undefined;
    this.registrations.get(workspaceId)?.unregister();
    this.registrations.delete(workspaceId);
  }

  private async discoverManagedPlugins(xumHome: string): Promise<AgentPluginInfo[]> {
    const { plugins } = await discoverAgentPlugins([
      {
        path: path.join(xumHome, "plugins"),
        scope: "global",
        registryPath: path.join(xumHome, PLUGIN_REGISTRY_FILE_NAME),
      },
    ]);
    // componentPolicy marks a plugin the install registry manages.
    return plugins.filter((plugin) => plugin.componentPolicy !== undefined);
  }

  private depsFor(plugin: AgentPluginInfo, args: EnsureCodexHooksArgs): CodexHookRunnerDeps {
    const instanceId = instanceIdOf(plugin);
    return {
      isHookAllowed: async (hook: PluginHookDefinition) => {
        if (!args.isProjectTrusted()) return false;
        const trust = await readPluginHookTrust(args.xumHome, instanceId);
        if (!isPluginHookTrusted(trust, hook)) return false;
        // The CURRENT manifest decides which hooks file is declared (Codex PRRT_kwDOPxxmWM6rN77w):
        // the discovery snapshot would keep a hook that plugin.json no longer points at.
        const manifest = await readCurrentManifest(plugin.rootPath);
        if (manifest === undefined) return false;
        const current = await loadPluginCodexHooks({ rootPath: plugin.rootPath, manifest });
        const stillDeclared = current.hooks.some(
          (candidate) => candidate.key === hook.key && candidate.hash === hook.hash
        );
        if (!stillDeclared)
          log.debug("Plugin hooks: a hook changed on disk; skipping it", { key: hook.key });
        return stillDeclared;
      },
      // The key is built from THIS plugin's instance: a hook names a server, never a key.
      callPluginTool: (call) =>
        args.mcp.callToolForPluginHook(
          args.workspaceId,
          buildPluginServerKey(instanceId, call.server),
          call.tool,
          call.input,
          { signal: call.signal }
        ),
      canCallPluginTool: (call) =>
        args.mcp.canCallToolForPluginHook(
          args.workspaceId,
          buildPluginServerKey(instanceId, call.server),
          call.tool
        ),
      notifyUser: (message) => args.notifyUser(plugin.name, message),
    };
  }
}

/** Same identity as the install service and the plugin's MCP server keys. */
function instanceIdOf(plugin: AgentPluginInfo): string {
  return computePluginInstanceId(path.join(plugin.containerPath, plugin.dirName));
}

/**
 * Re-read and validate plugin.json with discovery's limits (contained in the root, size-capped).
 * undefined when it is missing, too large, unreadable or invalid: the gate then skips the hook.
 */
async function readCurrentManifest(rootPath: string): Promise<AgentPluginManifest | undefined> {
  try {
    const { content } = await readPluginFileWithinRootCapped({
      filePath: path.join(rootPath, "plugin.json"),
      pluginRoot: rootPath,
      maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
      label: "plugin.json",
    });
    const validation = validatePluginManifest(JSON.parse(content));
    return validation.ok ? validation.manifest : undefined;
  } catch (error) {
    log.debug("Plugin hooks: plugin.json cannot be re-read; skipping the hook", {
      rootPath,
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

export const codexPluginHookService = new CodexPluginHookService();
