import { describe, expect, test } from "bun:test";

import {
  isAllowedOrpcPath,
  redactWebviewOrpcResult,
  sanitizeWebviewOrpcInput,
} from "./orpcAllowlist";

describe("isAllowedOrpcPath", () => {
  test("allows known procedures", () => {
    expect(isAllowedOrpcPath(["general", "ping"]))
      .toBe(true);
    expect(isAllowedOrpcPath(["workspace", "sendMessage"]))
      .toBe(true);
    expect(isAllowedOrpcPath(["providers", "getConfig"]))
      .toBe(true);
  });

  test("rejects unknown roots and procedures", () => {
    expect(isAllowedOrpcPath(["server", "getApiServerStatus"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "create"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["providers", "setProviderConfig"]))
      .toBe(false);
  });

  test("rejects nested routers", () => {
    expect(isAllowedOrpcPath(["workspace", "backgroundBashes", "subscribe"]))
      .toBe(false);
  });

  test("rejects invalid segments", () => {
    expect(isAllowedOrpcPath([])).toBe(false);
    expect(isAllowedOrpcPath(["workspace", "__proto__"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "send-message"]))
      .toBe(false);
  });
});

describe("agents.list (#4751)", () => {
  test("allows listing agent descriptors but not reading agent packages", () => {
    expect(isAllowedOrpcPath(["agents", "list"])).toBe(true);
    // agents.get returns full prompt bodies; it stays blocked.
    expect(isAllowedOrpcPath(["agents", "get"])).toBe(false);
  });

  const known = new Set(["ws-1"]);

  test("forwards only a known workspaceId and the disable flag", () => {
    expect(
      sanitizeWebviewOrpcInput(
        ["agents", "list"],
        {
          workspaceId: "ws-1",
          disableWorkspaceAgents: true,
          projectPath: "/etc",
          includeDisabled: true,
        },
        known
      )
    ).toEqual({ ok: true, input: { workspaceId: "ws-1", disableWorkspaceAgents: true } });
  });

  test("rejects unknown workspaces, free-form project paths and malformed input", () => {
    for (const input of [
      { workspaceId: "ws-other" },
      { projectPath: "/home/alice/secret-project" },
      {},
      null,
      "ws-1",
    ]) {
      expect(sanitizeWebviewOrpcInput(["agents", "list"], input, known).ok).toBe(false);
    }
  });

  test("leaves other procedures' input unchanged", () => {
    const input = { workspaceId: "anything", message: "hi" };
    expect(sanitizeWebviewOrpcInput(["workspace", "sendMessage"], input, known)).toEqual({
      ok: true,
      input,
    });
  });
});

describe("plan implement setting (#4942)", () => {
  test("projects only the plan-implement replace flag out of taskSettings", () => {
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        routePriority: ["direct"],
        taskSettings: {
          proposePlanImplementReplacesChatHistory: true,
          maxParallelAgentTasks: 4,
          bashOutputHint: "secret-ish",
        },
      })
    ).toEqual({
      routePriority: ["direct"],
      taskSettings: { proposePlanImplementReplacesChatHistory: true },
    });
  });

  test("omits taskSettings when the flag is not a boolean", () => {
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        taskSettings: { proposePlanImplementReplacesChatHistory: "yes", maxParallelAgentTasks: 4 },
      })
    ).toEqual({});
  });
});

describe("webview preferences (#4972, #4962)", () => {
  test("forwards a valid bash collapsed-summary mode and nothing else from userPreferences", () => {
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        userPreferences: {
          appearance: {
            theme: "light",
            bashCollapsedSummaryMode: "intent",
            vimEnabled: true,
            transcriptDensity: "hyper",
          },
          editorConfig: { editor: "custom", customCommand: "/opt/editor --wait" },
          ai: { projectDefaults: { "/home/alice/secret-project": { model: "openai:gpt-5" } } },
          workspaceCreation: {
            byProject: { "/home/alice/secret-project": { lastRuntimeConfig: { type: "ssh" } } },
          },
          notifications: { sound: true },
        },
      })
    ).toEqual({ userPreferences: { appearance: { bashCollapsedSummaryMode: "intent" } } });
  });

  test("omits userPreferences when the bash mode is invalid", () => {
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        userPreferences: { appearance: { bashCollapsedSummaryMode: "everything", theme: "dark" } },
      })
    ).toEqual({});
  });

  test("forwards agentAiDefaults rebuilt from named fields, without invalid agents", () => {
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        agentAiDefaults: {
          exec: {
            modelString: "openai:gpt-5.6-terra",
            thinkingLevel: "high",
            futureSecret: "must stay in the host",
          },
          "Not An Agent!": { modelString: "openai:gpt-5.6-terra" },
        },
      })
    ).toEqual({
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.6-terra", thinkingLevel: "high" } },
    });
    expect(redactWebviewOrpcResult(["config", "getConfig"], { agentAiDefaults: "exec" })).toEqual(
      {}
    );
  });
});

describe("held inputs (#4771)", () => {
  const known = new Set(["ws-1"]);

  test("allows sending and discarding a held input of a known workspace, with only its IDs", () => {
    for (const procedure of ["sendHeldInput", "discardHeldInput"]) {
      expect(isAllowedOrpcPath(["workspace", procedure])).toBe(true);
      expect(
        sanitizeWebviewOrpcInput(
          ["workspace", procedure],
          { workspaceId: "ws-1", heldInputId: "held-1", extra: true },
          known
        )
      ).toEqual({ ok: true, input: { workspaceId: "ws-1", heldInputId: "held-1" } });
    }
  });

  test("rejects unknown workspaces and malformed input", () => {
    for (const procedure of ["sendHeldInput", "discardHeldInput"]) {
      for (const input of [
        { workspaceId: "ws-2", heldInputId: "held-1" },
        { workspaceId: "ws-1" },
        { workspaceId: "ws-1", heldInputId: 7 },
        null,
      ]) {
        expect(sanitizeWebviewOrpcInput(["workspace", procedure], input, known).ok).toBe(false);
      }
    }
  });
});

describe("policy (#4739)", () => {
  test("allows reading the effective policy and its change signal only", () => {
    expect(isAllowedOrpcPath(["policy", "get"])).toBe(true);
    expect(isAllowedOrpcPath(["policy", "onChanged"])).toBe(true);
    expect(isAllowedOrpcPath(["policy", "refresh"])).toBe(false);
  });

  test("strips provider forcedBaseUrl from policy.get and keeps everything else", () => {
    const response = {
      source: "governor",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [
          {
            id: "openai",
            forcedBaseUrl: "https://user:token@gateway.corp.example/v1",
            allowedModels: ["gpt-5.6-terra"],
          },
          { id: "anthropic", allowedModels: null },
        ],
        mcp: { allowUserDefined: { stdio: false, remote: true } },
        runtimes: ["worktree"],
      },
    };
    expect(redactWebviewOrpcResult(["policy", "get"], response)).toEqual({
      ...response,
      policy: {
        ...response.policy,
        providerAccess: [
          { id: "openai", allowedModels: ["gpt-5.6-terra"] },
          { id: "anthropic", allowedModels: null },
        ],
      },
    });
    // The input object is not mutated.
    expect(response.policy.providerAccess[0].forcedBaseUrl).toBeDefined();
  });

  test("passes other results and policy-less responses through unchanged", () => {
    const noPolicy = { source: "none", status: { state: "disabled" }, policy: null };
    expect(redactWebviewOrpcResult(["policy", "get"], noPolicy)).toEqual(noPolicy);
    const other = { forcedBaseUrl: "kept" };
    expect(redactWebviewOrpcResult(["workspace", "getPlanContent"], other)).toBe(other);
  });
});

describe("app and providers config (#4766)", () => {
  test("allows reading the app config and its change signal only", () => {
    expect(isAllowedOrpcPath(["config", "getConfig"])).toBe(true);
    expect(isAllowedOrpcPath(["config", "onConfigChanged"])).toBe(true);
    expect(isAllowedOrpcPath(["config", "saveConfig"])).toBe(false);
    expect(isAllowedOrpcPath(["config", "updateRoutePreferences"])).toBe(false);
  });

  test("projects config.getConfig to the model-routing and thinking-floor fields", () => {
    const config = {
      routePriority: ["mux-gateway", "direct"],
      routeOverrides: { "openai:gpt-5.6-terra": "direct" },
      minThinkingLevelByModel: { "anthropic:claude-opus-5-5": "high" },
      muxGovernorUrl: "https://governor.corp.example",
      heartbeatDefaultPrompt: "private prompt",
      userPreferences: { name: "alice" },
      taskSettings: { maxParallelAgentTasks: 3 },
    };
    expect(redactWebviewOrpcResult(["config", "getConfig"], config)).toEqual({
      routePriority: ["mux-gateway", "direct"],
      routeOverrides: { "openai:gpt-5.6-terra": "direct" },
      minThinkingLevelByModel: { "anthropic:claude-opus-5-5": "high" },
    });
  });

  test("strips URL and key-file fields from providers.getConfig and keeps everything else", () => {
    const providers = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        baseUrl: "https://user:token@proxy.corp.example/v1",
        baseUrlResolved: "https://proxy.corp.example/v1?key=secret",
        apiKeyFile: "/home/alice/.secrets/openai",
        models: ["gpt-5.6-terra"],
      },
      coder: {
        apiKeySet: false,
        isConfigured: true,
        deploymentUrl: "https://coder.corp.example",
        discoveredModels: ["openai/gpt-5.6-sol"],
      },
    };
    expect(redactWebviewOrpcResult(["providers", "getConfig"], providers)).toEqual({
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true, models: ["gpt-5.6-terra"] },
      coder: { apiKeySet: false, isConfigured: true, discoveredModels: ["openai/gpt-5.6-sol"] },
    });
    // The input object is not mutated.
    expect(providers.openai.baseUrl).toBeDefined();
  });
});
