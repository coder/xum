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

  test("rejects nested routers other than the background processes strip's", () => {
    expect(isAllowedOrpcPath(["workspace", "backgroundBashes", "sendToBackground"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "goal", "get"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "backgroundBashes", "subscribe", "x"]))
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
  test("forwards a valid bash collapsed-summary mode and transcript density and nothing else from userPreferences", () => {
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
    ).toEqual({
      userPreferences: {
        appearance: { bashCollapsedSummaryMode: "intent", transcriptDensity: "hyper" },
      },
    });
  });

  test("omits userPreferences when the bash mode and transcript density are invalid", () => {
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        userPreferences: {
          appearance: {
            bashCollapsedSummaryMode: "everything",
            transcriptDensity: 1,
            theme: "dark",
          },
        },
      })
    ).toEqual({});
  });

  test("forwards each valid appearance preference independently of an invalid one", () => {
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        userPreferences: {
          appearance: { bashCollapsedSummaryMode: "everything", transcriptDensity: "normal" },
        },
      })
    ).toEqual({ userPreferences: { appearance: { transcriptDensity: "normal" } } });
    expect(
      redactWebviewOrpcResult(["config", "getConfig"], {
        userPreferences: {
          appearance: { bashCollapsedSummaryMode: "intent", transcriptDensity: "dense" },
        },
      })
    ).toEqual({ userPreferences: { appearance: { bashCollapsedSummaryMode: "intent" } } });
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

describe("retry barrier (#5092)", () => {
  const known = new Set(["ws-1"]);

  test("resumes a known workspace's stream with only its ID and send options", () => {
    const options = { model: "anthropic:claude-sonnet-4-5", agentId: "exec" };
    expect(isAllowedOrpcPath(["workspace", "resumeStream"])).toBe(true);
    // Retry resumes only; the webview never toggles the auto-retry preference.
    expect(isAllowedOrpcPath(["workspace", "setAutoRetryEnabled"])).toBe(false);
    expect(
      sanitizeWebviewOrpcInput(
        ["workspace", "resumeStream"],
        { workspaceId: "ws-1", options, extra: true },
        known
      )
    ).toEqual({ ok: true, input: { workspaceId: "ws-1", options } });
  });

  test("rejects unknown workspaces and malformed input", () => {
    for (const [procedure, input] of [
      ["resumeStream", { workspaceId: "ws-2", options: {} }],
      ["resumeStream", null],
    ] as const) {
      expect(sanitizeWebviewOrpcInput(["workspace", procedure], input, known).ok).toBe(false);
    }
  });
});

describe("background processes strip (#5092)", () => {
  const known = new Set(["ws-1"]);
  const path = (procedure: string) => ["workspace", "backgroundBashes", procedure];

  test("lists, terminates and reads a known workspace's processes with only the fields each needs", () => {
    for (const [procedure, input, forwarded] of [
      ["subscribe", { workspaceId: "ws-1", processId: "p1" }, { workspaceId: "ws-1" }],
      [
        "terminate",
        { workspaceId: "ws-1", processId: "p1", extra: true },
        { workspaceId: "ws-1", processId: "p1" },
      ],
      // The output dialog's reads (#5196): an offset of 0 is kept, non-numeric windows and extra
      // fields are dropped.
      [
        "getOutput",
        { workspaceId: "ws-1", processId: "p1", fromOffset: 0, extra: true },
        { workspaceId: "ws-1", processId: "p1", fromOffset: 0 },
      ],
      [
        "getOutput",
        { workspaceId: "ws-1", processId: "p1", tailBytes: 64000, fromOffset: "5" },
        { workspaceId: "ws-1", processId: "p1", tailBytes: 64000 },
      ],
    ] as const) {
      expect(isAllowedOrpcPath(path(procedure))).toBe(true);
      expect(sanitizeWebviewOrpcInput(path(procedure), input, known)).toEqual({
        ok: true,
        input: forwarded,
      });
    }
  });

  test("empties monitor match lines before the process state reaches the webview", () => {
    const monitor = {
      filter: "ERROR",
      totalMatches: 2,
      lastLines: ["ERROR token=abc"],
      stopped: false,
    };
    const state = {
      processes: [
        { id: "p1", script: "tail -f log", status: "running", monitor },
        { id: "p2", script: "sleep 5", status: "running" },
      ],
      foregroundToolCallIds: ["call-1"],
    };
    expect(redactWebviewOrpcResult(path("subscribe"), state)).toEqual({
      processes: [
        {
          id: "p1",
          script: "tail -f log",
          status: "running",
          monitor: { ...monitor, lastLines: [] },
        },
        { id: "p2", script: "sleep 5", status: "running" },
      ],
      foregroundToolCallIds: ["call-1"],
    });
    // The host's copy is not mutated.
    expect(monitor.lastLines).toEqual(["ERROR token=abc"]);
  });

  test("rejects unknown workspaces and malformed input", () => {
    for (const [procedure, input] of [
      ["subscribe", { workspaceId: "ws-2" }],
      ["subscribe", null],
      ["terminate", { workspaceId: "ws-2", processId: "p1" }],
      ["terminate", { workspaceId: "ws-1" }],
      ["getOutput", { workspaceId: "ws-2", processId: "p1" }],
      ["getOutput", { workspaceId: "ws-1", tailBytes: 64000 }],
    ] as const) {
      expect(sanitizeWebviewOrpcInput(path(procedure), input, known).ok).toBe(false);
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
