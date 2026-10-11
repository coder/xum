/**
 * Codex plugin hooks in a workspace, with real plugin files, a real registry and a real trust
 * store. The MCP manager is a fake that records the server key of each call. Covers the per-call
 * gate (#6042's P1-a and P1-b) and the same-plugin server rule.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventSpine, type ToolExecuteContext } from "@/node/services/events/eventSpine";
import { runMessageSendHooks } from "./promptHooks";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { CodexPluginHookService, type EnsureCodexHooksArgs } from "./codexHookService";
import { loadPluginCodexHooks } from "./codexHooks";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { buildPluginServerKey, computePluginInstanceId } from "./mcpConfig";
import { getPluginHookTrustPath, setPluginHookTrust } from "./pluginHookTrust";
import { PLUGIN_REGISTRY_FILE_NAME } from "./registry";
import { createTestPluginInstallEntry } from "./testFixtures";

const workspaceId = "ws-hooks";
const deny = {
  structuredContent: {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "no",
    },
  },
};

describe("CodexPluginHookService", () => {
  let tmp: DisposableTempDir;
  let xumHome: string;
  let spine: EventSpine;
  let service: CodexPluginHookService;
  let projectTrusted: boolean;
  let calledKeys: string[];
  let mcpFails: boolean;

  const pluginRoot = (name: string) => path.join(xumHome, "plugins", name);
  const instanceId = (name: string) => computePluginInstanceId(pluginRoot(name));

  async function writePlugin(
    name: string,
    server: string,
    managed = true,
    document: unknown = {
      hooks: { PreToolUse: [{ hooks: [{ type: "mcp_tool", server, tool: "check" }] }] },
    }
  ) {
    await fs.mkdir(path.join(pluginRoot(name), "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot(name), "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name })
    );
    await fs.writeFile(
      path.join(pluginRoot(name), "hooks", "hooks.json"),
      JSON.stringify(document)
    );
    if (!managed) return;
    const registryPath = path.join(xumHome, PLUGIN_REGISTRY_FILE_NAME);
    const existing = await fs.readFile(registryPath, "utf8").then(
      (raw) => (JSON.parse(raw) as { plugins: unknown[] }).plugins,
      () => []
    );
    await fs.writeFile(
      registryPath,
      JSON.stringify({ plugins: [...existing, createTestPluginInstallEntry(name)] })
    );
  }

  async function trustAll(name: string) {
    const { hooks } = await loadPluginCodexHooks({
      rootPath: await fs.realpath(pluginRoot(name)),
      manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name },
    });
    for (const hook of hooks) {
      await setPluginHookTrust(xumHome, instanceId(name), {
        key: hook.key,
        hash: hook.hash,
        state: "trusted",
      });
    }
    return hooks;
  }

  const args = (): EnsureCodexHooksArgs => ({
    workspaceId,
    xumHome,
    isProjectTrusted: () => projectTrusted,
    mcp: {
      callToolForPluginHook: (_workspaceId, serverKey) => {
        calledKeys.push(serverKey);
        return mcpFails
          ? Promise.reject(new Error(`MCP server '${serverKey}' is not enabled in this workspace`))
          : Promise.resolve(deny);
      },
    },
    notifyUser: () => undefined,
    sideChat: false,
  });

  async function runBash(): Promise<ToolExecuteContext> {
    const ctx: ToolExecuteContext = {
      toolName: "bash",
      args: {},
      host: {
        runtime: new LocalRuntime(xumHome),
        runtimeTempDir: xumHome,
        cwd: xumHome,
        workspaceId,
      },
      executed: false,
    };
    await spine.run("tool.execute", ctx, (c) => {
      c.result = { ok: true };
      c.executed = true;
    });
    return ctx;
  }

  beforeEach(() => {
    tmp = new DisposableTempDir("codex-hook-service");
    xumHome = tmp.path;
    spine = new EventSpine();
    service = new CodexPluginHookService(spine);
    projectTrusted = true;
    calledKeys = [];
    mcpFails = false;
  });

  afterEach(async () => {
    await service.disposeWorkspace(workspaceId);
    tmp[Symbol.dispose]();
  });

  test("an untrusted hook never runs; a trusted one calls its own plugin's server", async () => {
    await writePlugin("guard", "scanner");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(true);
    expect(calledKeys).toEqual([]);

    await trustAll("guard");
    expect((await runBash()).executed).toBe(false);
    expect(calledKeys).toEqual([buildPluginServerKey(instanceId("guard"), "scanner")]);
  });

  test("a hook turned off mid-turn does not run on the next call", async () => {
    await writePlugin("guard", "scanner");
    const [hook] = await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(false);

    // No re-registration in between: the gate reads the store at the call.
    await setPluginHookTrust(xumHome, instanceId("guard"), {
      key: hook.key,
      hash: hook.hash,
      state: "disabled",
    });
    expect((await runBash()).executed).toBe(true);
    expect(calledKeys).toHaveLength(1);
  });

  test("revoking project trust mid-stream stops the next call", async () => {
    await writePlugin("guard", "scanner");
    await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(false);

    projectTrusted = false;
    expect((await runBash()).executed).toBe(true);
    expect(calledKeys).toHaveLength(1);
  });

  test("uninstalling or editing the plugin mid-stream stops the next call", async () => {
    await writePlugin("guard", "scanner");
    await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(false);

    // The definition changed on disk: the trusted hash no longer matches what is declared.
    await fs.writeFile(
      path.join(pluginRoot("guard"), "hooks", "hooks.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "mcp_tool", server: "x", tool: "y" }] }] },
      })
    );
    expect((await runBash()).executed).toBe(true);
    await fs.rm(pluginRoot("guard"), { recursive: true });
    expect((await runBash()).executed).toBe(true);
    expect(calledKeys).toHaveLength(1);
  });

  test("a trusted hook that moves to another position runs again after re-registration", async () => {
    await writePlugin("guard", "scanner");
    await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(false);

    // Same runnable hook (same hash), new trust key: a command group now precedes it.
    await fs.writeFile(
      path.join(pluginRoot("guard"), "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "true" }] },
            { hooks: [{ type: "mcp_tool", server: "scanner", tool: "check" }] },
          ],
        },
      })
    );
    await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(false);
    expect(calledKeys).toHaveLength(2);
  });

  test("a manifest edit that stops declaring the hooks file stops the next call", async () => {
    await writePlugin("guard", "scanner");
    await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(false);

    // plugin.json now points at another hooks file; the old file stays on disk unchanged.
    await fs.writeFile(
      path.join(pluginRoot("guard"), "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "guard",
        extensions: { "com.openai": { hooks: "hooks/other.json" } },
      })
    );
    expect((await runBash()).executed).toBe(true);
    expect(calledKeys).toHaveLength(1);
  });

  test("a side chat runs no hook, even a trusted one whose server is running", async () => {
    await writePlugin("guard", "scanner");
    await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    expect((await runBash()).executed).toBe(false);

    await service.ensureWorkspaceHooks({ ...args(), sideChat: true });
    expect((await runBash()).executed).toBe(true);
    expect(calledKeys).toHaveLength(1);
  });

  test("a disabled plugin server fails open: the tool runs", async () => {
    await writePlugin("guard", "scanner");
    await trustAll("guard");
    await service.ensureWorkspaceHooks(args());
    mcpFails = true;
    expect((await runBash()).executed).toBe(true);
  });

  test("a hook cannot reach another plugin's server", async () => {
    await writePlugin("victim", "db");
    const victimKey = buildPluginServerKey(instanceId("victim"), "db");
    await writePlugin("attacker", victimKey);
    await trustAll("attacker");
    await service.ensureWorkspaceHooks(args());

    await runBash();

    expect(calledKeys).toEqual([buildPluginServerKey(instanceId("attacker"), victimKey)]);
    expect(calledKeys).not.toContain(victimKey);
  });

  test("an unmanaged plugin's hooks never run, even with a trust record", async () => {
    await writePlugin("loose", "scanner", false);
    // setPluginHookTrust refuses a plugin without a registry entry, so write the record directly.
    const { hooks } = await loadPluginCodexHooks({
      rootPath: await fs.realpath(pluginRoot("loose")),
      manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "loose" },
    });
    const trustFile = getPluginHookTrustPath(xumHome, instanceId("loose"));
    await fs.mkdir(path.dirname(trustFile), { recursive: true });
    await fs.writeFile(
      trustFile,
      JSON.stringify({
        version: 1,
        installedAt: new Date(0).toISOString(),
        hooks: Object.fromEntries(
          hooks.map((hook) => [hook.key, { hash: hook.hash, state: "trusted" }])
        ),
      })
    );
    await service.ensureWorkspaceHooks(args());

    expect((await runBash()).executed).toBe(true);
    expect(calledKeys).toEqual([]);
  });

  describe("UserPromptSubmit after a restart", () => {
    const promptPlugin = (timeout?: number) =>
      writePlugin("guard", "scanner", true, {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "mcp_tool",
                  server: "scanner",
                  tool: "check",
                  ...(timeout !== undefined ? { timeout } : {}),
                },
              ],
            },
          ],
        },
      });
    let serverRunning: boolean;
    const promptArgs = (): EnsureCodexHooksArgs => ({
      ...args(),
      mcp: {
        // Like MCPServerManager.callToolForPluginHook: a server that is not running is refused.
        callToolForPluginHook: (_workspaceId, serverKey) => {
          calledKeys.push(serverKey);
          return serverRunning
            ? Promise.resolve({ structuredContent: { decision: "block", reason: "No secrets." } })
            : Promise.reject(new Error(`MCP server '${serverKey}' is not running`));
        },
      },
    });
    const send = () =>
      runMessageSendHooks(spine, workspaceId, { text: "key=abc", origin: "user", canBlock: true });

    beforeEach(() => {
      serverRunning = false;
    });

    test("the hooks wait for the turn's MCP startup, so the first prompt is checked", async () => {
      await promptPlugin();
      await trustAll("guard");
      await service.ensureWorkspaceHooks(promptArgs());
      const startServers = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        serverRunning = true;
        return true;
      };

      await service.prepareForPromptHooks(workspaceId, startServers);

      expect(await send()).toMatchObject({ kind: "blocked", reason: "No secrets." });
    });

    test("without the wait the hook would miss the first prompt (fails open)", async () => {
      await promptPlugin();
      await trustAll("guard");
      await service.ensureWorkspaceHooks(promptArgs());

      expect(await send()).toEqual({ kind: "none" });
      expect(calledKeys).toHaveLength(1);
    });

    test("a slow startup is bounded by the hook timeout, then the hook fails open", async () => {
      await promptPlugin(0.05);
      await trustAll("guard");
      await service.ensureWorkspaceHooks(promptArgs());
      let aborted = false;
      const startServers = (signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(false);
          });
        });

      const started = performance.now();
      await service.prepareForPromptHooks(workspaceId, startServers);

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(aborted).toBe(true);
      expect(await send()).toEqual({ kind: "none" });
    });

    test("a canceled send ends the startup wait at once", async () => {
      await promptPlugin();
      await trustAll("guard");
      await service.ensureWorkspaceHooks(promptArgs());
      let aborted = false;
      const startServers = (signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(false);
          });
        });
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 10);

      const started = performance.now();
      await service.prepareForPromptHooks(workspaceId, startServers, cancel.signal);

      // The default hook timeout is far longer: only the cancellation ends the wait this soon.
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(aborted).toBe(true);
    });

    test("a failed startup is logged and the hooks still run", async () => {
      await promptPlugin();
      await trustAll("guard");
      await service.ensureWorkspaceHooks(promptArgs());

      await service.prepareForPromptHooks(workspaceId, () =>
        Promise.reject(new Error("runtime not ready"))
      );

      expect(await send()).toEqual({ kind: "none" });
      expect(calledKeys).toHaveLength(1);
    });

    test("no UserPromptSubmit hook: nothing is started", async () => {
      await writePlugin("guard", "scanner");
      await trustAll("guard");
      await service.ensureWorkspaceHooks(args());
      let starts = 0;

      await service.prepareForPromptHooks(workspaceId, () => {
        starts++;
        return Promise.resolve(true);
      });

      expect(starts).toBe(0);
    });
  });
});
