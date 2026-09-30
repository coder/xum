import { describe, expect, it } from "bun:test";

import type { Config, Workspace } from "@/node/config";

import {
  applyAgentTaskTurnAiSnapshot,
  buildReawakenContextKey,
  computeReawakenInputsKey,
  planReawakenAi,
  type PreparedReawakenAi,
} from "./agentTaskReawakenAi";

type LoadedConfig = ReturnType<Config["loadConfigOrDefault"]>;

// Unrecognized providers avoid capability clamping (see resolveAgentAiSettings.test.ts).
const MODEL_A = "custom:model-a";
const MODEL_B = "custom:model-b";
const MODEL_C = "custom:model-c";
const PROJECT = "/repo";

function makeConfig(overrides?: {
  child?: Partial<Workspace>;
  parent?: Partial<Workspace>;
  agentAiDefaults?: LoadedConfig["agentAiDefaults"];
}): LoadedConfig {
  const parent: Workspace = {
    id: "parent",
    name: "main",
    path: "/repo/main",
    // A Plan parent has no Exec selection, so only its fallbacks participate.
    agentId: "plan",
    aiSettings: { model: MODEL_C, thinkingLevel: "low" },
    ...overrides?.parent,
  };
  const child: Workspace = {
    id: "child",
    name: "child-branch",
    path: "/repo/child",
    runtimeConfig: { type: "local" },
    parentWorkspaceId: "parent",
    agentId: "exec",
    taskStatus: "reported",
    taskModelString: MODEL_A,
    taskThinkingLevel: "medium",
    aiSettings: { model: MODEL_A, thinkingLevel: "medium" },
    aiSettingsByAgent: { exec: { model: MODEL_A, thinkingLevel: "medium" } },
    taskAiPins: {},
    ...overrides?.child,
  };
  return {
    projects: new Map([[PROJECT, { workspaces: [parent, child] }]]),
    ...(overrides?.agentAiDefaults != null ? { agentAiDefaults: overrides.agentAiDefaults } : {}),
  } as unknown as LoadedConfig;
}

function contextKeyFor(config: LoadedConfig): string {
  const child = config.projects.get(PROJECT)?.workspaces.find((w) => w.id === "child");
  if (child == null) throw new Error("child missing");
  return buildReawakenContextKey({ projectPath: PROJECT, workspace: child }, false);
}

function plan(config: LoadedConfig, prepared?: PreparedReawakenAi) {
  return planReawakenAi({
    config,
    taskId: "child",
    prepared,
    freshContextKey: contextKeyFor(config),
    providersConfig: null,
  });
}

describe("computeReawakenInputsKey", () => {
  const key = (config: LoadedConfig, contextKey = "ctx") =>
    computeReawakenInputsKey(config, "child", contextKey);

  it("is stable for equal inputs and null for a missing child", () => {
    expect(key(makeConfig())).toBe(key(makeConfig()));
    expect(computeReawakenInputsKey(makeConfig(), "missing", "ctx")).toBeNull();
  });

  it("changes when any planned input changes", () => {
    const base = key(makeConfig());
    const variants: LoadedConfig[] = [
      makeConfig({ child: { taskAiPins: { model: MODEL_B } } }),
      makeConfig({
        child: { aiSettingsByAgent: { exec: { model: MODEL_B, thinkingLevel: "low" } } },
      }),
      makeConfig({ child: { taskModelString: MODEL_B } }),
      makeConfig({
        parent: { aiSettingsByAgent: { exec: { model: MODEL_B, thinkingLevel: "low" } } },
      }),
      makeConfig({ agentAiDefaults: { exec: { subagent: { modelString: MODEL_B } } } }),
    ];
    for (const variant of variants) {
      expect(key(variant)).not.toBe(base);
    }
    expect(key(makeConfig(), "other-context")).not.toBe(base);
  });
});

describe("planReawakenAi", () => {
  it("keeps legacy children (no taskAiPins) on the existing path", () => {
    expect(plan(makeConfig({ child: { taskAiPins: undefined } }))).toEqual({ kind: "legacy" });
  });

  it("refuses stale prepared layers (agent or checkout context changed)", () => {
    const config = makeConfig();
    const fresh = contextKeyFor(config);
    const layers = { ancestors: [] };
    expect(plan(config, { taskId: "child", agentId: "plan", contextKey: fresh, layers })).toEqual({
      kind: "stale",
    });
    expect(plan(config, { taskId: "child", agentId: "exec", contextKey: "moved", layers })).toEqual(
      { kind: "stale" }
    );
  });

  it("follows the delegated override over the child's current model", () => {
    const result = plan(
      makeConfig({ agentAiDefaults: { exec: { subagent: { modelString: MODEL_B } } } })
    );
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.snapshot.taskModelString).toBe(MODEL_B);
    // Unconfigured thinking keeps the child's current value (reactivation fallback).
    expect(result.snapshot.thinkingLevel).toBe("medium");
    expect(result.usedDefinitionLayers).toBe(false);
  });

  it("prefers the direct parent's Exec selection over the child's current values", () => {
    const result = plan(
      makeConfig({
        parent: { aiSettingsByAgent: { exec: { model: MODEL_C, thinkingLevel: "low" } } },
      })
    );
    if (result.kind !== "resolved") throw new Error(`unexpected ${result.kind}`);
    expect(result.snapshot.taskModelString).toBe(MODEL_C);
    expect(result.snapshot.thinkingLevel).toBe("low");
  });

  it("keeps the persisted reasoning mode when the task has no active-agent bucket yet", () => {
    const result = plan(
      makeConfig({
        child: {
          aiSettingsByAgent: undefined,
          aiSettings: { model: MODEL_A, thinkingLevel: "medium", reasoningMode: "pro" },
        },
      })
    );
    if (result.kind !== "resolved") throw new Error(`unexpected ${result.kind}`);
    expect(result.snapshot.reasoningMode).toBe("pro");
  });

  it("keeps pinned fields over configured defaults", () => {
    const result = plan(
      makeConfig({
        child: { taskAiPins: { model: MODEL_A } },
        agentAiDefaults: { exec: { subagent: { modelString: MODEL_B, thinkingLevel: "high" } } },
      })
    );
    if (result.kind !== "resolved") throw new Error(`unexpected ${result.kind}`);
    expect(result.snapshot.taskModelString).toBe(MODEL_A);
    expect(result.snapshot.thinkingLevel).toBe("high");
  });

  it("applies prepared definition layers when their context still matches", () => {
    const config = makeConfig({ child: { agentId: "worker" } });
    const result = plan(config, {
      taskId: "child",
      agentId: "worker",
      contextKey: contextKeyFor(config),
      layers: { targetDefinitionAiDefaults: { model: MODEL_C }, ancestors: [] },
    });
    if (result.kind !== "resolved") throw new Error(`unexpected ${result.kind}`);
    expect(result.snapshot.taskModelString).toBe(MODEL_C);
    expect(result.usedDefinitionLayers).toBe(true);
  });

  it("resolves without layers when the definition read was unavailable", () => {
    const config = makeConfig({
      child: { agentId: "worker" },
      agentAiDefaults: { worker: { modelString: MODEL_B } },
    });
    const result = plan(config, {
      taskId: "child",
      agentId: "worker",
      contextKey: contextKeyFor(config),
      layers: null,
    });
    if (result.kind !== "resolved") throw new Error(`unexpected ${result.kind}`);
    expect(result.snapshot.taskModelString).toBe(MODEL_B);
    expect(result.usedDefinitionLayers).toBe(false);
  });
});

describe("applyAgentTaskTurnAiSnapshot", () => {
  it("writes aiSettings, the active bucket, and the task fields", () => {
    const workspace: Workspace = {
      id: "child",
      name: "child",
      path: "/repo/child",
      aiSettingsByAgent: { plan: { model: MODEL_C, thinkingLevel: "low" } },
    };
    applyAgentTaskTurnAiSnapshot(workspace, {
      agentId: "exec",
      taskModelString: MODEL_B,
      canonicalModel: MODEL_B,
      thinkingLevel: "high",
      reasoningMode: "standard",
    });
    expect(workspace.aiSettings).toEqual({
      model: MODEL_B,
      thinkingLevel: "high",
      reasoningMode: "standard",
    });
    expect(workspace.aiSettingsByAgent).toEqual({
      plan: { model: MODEL_C, thinkingLevel: "low" },
      exec: { model: MODEL_B, thinkingLevel: "high", reasoningMode: "standard" },
    });
    expect(workspace.taskModelString).toBe(MODEL_B);
    expect(workspace.taskThinkingLevel).toBe("high");
  });
});
