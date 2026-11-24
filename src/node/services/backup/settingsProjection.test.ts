import { describe, expect, it } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import { getDefaultAutoModelRoutingConfig } from "@/common/types/autoModelRouting";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import {
  mergeBackupSettings,
  projectBackupSettings,
  readBackupSettings,
} from "./settingsProjection";

/** What a config with none of the portable settings set exports: every key, spelled unset. */
const UNSET_EXPORT = {
  agentAiDefaults: {},
  defaultModel: null,
  hiddenModels: null,
  minThinkingLevelByModel: null,
  modelFallbacks: null,
  autoModelRouting: null,
  evaluationDefaults: null,
  heartbeatDefaultIntervalMs: null,
  chatTranscriptFullWidth: false,
  runtimeEnablement: null,
  defaultIsolation: null,
};

describe("settingsProjection", () => {
  it("projects every portable setting and leaves machine-local keys behind", () => {
    const portable = {
      agentAiDefaults: {
        exec: {
          modelString: "anthropic:claude-exec",
          thinkingLevel: "high",
          subagent: { modelString: "openai:gpt-sub", thinkingLevel: "low" },
        },
        plan: { modelString: "openai:gpt-plan", reasoningMode: "pro" },
        review: { enabled: false },
      },
      defaultModel: "anthropic:claude-exec",
      hiddenModels: ["openai:gpt-old"],
      minThinkingLevelByModel: { "openai:gpt-plan": "medium" },
      modelFallbacks: { "anthropic:claude-exec": { models: ["openai:gpt-plan"] } },
      autoModelRouting: {
        ...getDefaultAutoModelRoutingConfig(),
        tiers: getDefaultAutoModelRoutingConfig().tiers.map((tier) => ({
          ...tier,
          model: "anthropic:claude-exec",
        })),
      },
      evaluationDefaults: { model: "openai:gpt-plan" },
      heartbeatDefaultIntervalMs: 15 * 60 * 1000,
      chatTranscriptFullWidth: true,
      runtimeEnablement: { docker: false },
      defaultIsolation: { project: "local", workspace: "worktree" },
    } satisfies Partial<ProjectsConfig>;
    const config: ProjectsConfig = {
      projects: new Map([["/repo", { workspaces: [] }]]),
      ...portable,
      apiServerPort: 4321,
      apiServerBindHost: "0.0.0.0",
      worktreeArchiveBehavior: "delete",
      coderWorkspaceArchiveBehavior: "delete",
      terminalDefaultShell: "/bin/fish",
      updateChannel: "nightly",
      keepScreenAwake: true,
      heartbeatDefaultPrompt: "Check in",
      // Limits a restore must not raise behind the user's back.
      taskSettings: { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 4 },
      goalDefaults: {
        defaultBudgetCents: 500,
        defaultTurnCap: 20,
        alwaysRequireExplicitBudget: true,
      },
      llmDebugLogs: true,
      routePriority: ["anthropic"],
      routeOverrides: { "anthropic:claude-exec": "direct" },
      viewedSplashScreens: ["welcome"],
      migrations: { hiddenModelsInitialized: true },
      settingsBackup: { repoUrl: "https://example.com/backup.git", branch: "main", path: "xum" },
    };

    const projected = projectBackupSettings(config);

    expect(projected).toEqual(portable);
    // A copy, not a view: editing the projection must not reach the live config.
    expect(projected.agentAiDefaults).not.toBe(config.agentAiDefaults);
  });

  it("exports resets as explicit unset values, the same for a fresh and a saved config", () => {
    // A fresh install holds none of these keys; a loaded config holds their normalized forms.
    // Both must export identically or the first push after a save would look like a change.
    expect(projectBackupSettings({ projects: new Map() })).toEqual(UNSET_EXPORT);
    expect(
      projectBackupSettings({
        projects: new Map(),
        agentAiDefaults: {},
        hiddenModels: undefined,
        chatTranscriptFullWidth: undefined,
      })
    ).toEqual(UNSET_EXPORT);
    // An emptied hidden list is a choice, not an unset value.
    expect(projectBackupSettings({ projects: new Map(), hiddenModels: [] }).hiddenModels).toEqual(
      []
    );
  });

  it("restoring a reset source clears the target's overrides", () => {
    const target: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" } },
      modelFallbacks: { "openai:gpt-local": { models: ["anthropic:claude-exec"] } },
      chatTranscriptFullWidth: true,
      defaultIsolation: { project: "local", workspace: "docker" },
      defaultRuntime: "docker",
      apiServerPort: 4321,
    };

    const merged = mergeBackupSettings(
      target,
      readBackupSettings({ settings: projectBackupSettings({ projects: new Map() }) }).settings!
    );

    expect(merged.agentAiDefaults).toEqual({});
    expect(merged.modelFallbacks).toBeUndefined();
    expect(merged.chatTranscriptFullWidth).toBe(false);
    expect(merged.defaultIsolation).toBeUndefined();
    // The legacy mirror goes with it, or load would resolve the default from it again.
    expect(merged.defaultRuntime).toBeUndefined();
    expect(merged.apiServerPort).toBe(4321);
    // The round trip closes: the restored target exports what the source exported.
    expect(projectBackupSettings(merged)).toEqual(UNSET_EXPORT);
  });

  it("restores the default isolation together with the legacy runtime older builds read", () => {
    const merged = mergeBackupSettings(
      {
        projects: new Map(),
        defaultIsolation: { project: "local", workspace: "docker" },
        defaultRuntime: "docker",
      },
      { defaultIsolation: { project: "local", workspace: "worktree" } }
    );
    expect(merged.defaultIsolation).toEqual({ project: "local", workspace: "worktree" });
    expect(merged.defaultRuntime).toBe("worktree");
  });

  it("replaces the keys a sparse block carries and keeps the rest of the local config", () => {
    const current: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" }, review: { enabled: false } },
      defaultModel: "openai:gpt-local",
      hiddenModels: ["openai:gpt-hidden-locally"],
      apiServerPort: 4321,
      terminalDefaultShell: "/bin/fish",
      migrations: { daybreakModelsHidden: true },
    };

    // A block an older build wrote, with only some of the keys.
    const sparse = readBackupSettings({
      settings: {
        agentAiDefaults: { plan: { modelString: "anthropic:claude-plan" } },
        hiddenModels: [],
        evaluationDefaults: { model: "openai:gpt-eval" },
      },
    }).settings!;
    const merged = mergeBackupSettings(current, sparse);

    expect(merged.agentAiDefaults).toEqual({ plan: { modelString: "anthropic:claude-plan" } });
    expect(merged.hiddenModels).toEqual([]);
    expect(merged.defaultModel).toBe("openai:gpt-local");
    expect(merged.apiServerPort).toBe(4321);
    expect(merged.terminalDefaultShell).toBe("/bin/fish");
    expect(merged.evaluationDefaults).toEqual({ model: "openai:gpt-eval" });
    expect(merged.migrations).toEqual({
      daybreakModelsHidden: true,
      hiddenModelsInitialized: true,
    });
    expect(current.agentAiDefaults?.exec).toBeDefined();
  });

  it("does not touch the hidden-model migration when the backup carries no list", () => {
    const merged = mergeBackupSettings(
      { projects: new Map(), migrations: { daybreakModelsHidden: true } },
      { defaultModel: "anthropic:claude-plan", hiddenModels: null }
    );
    expect(merged.migrations).toEqual({ daybreakModelsHidden: true });
    expect(merged.hiddenModels).toBeUndefined();
  });

  it("canonicalizes accepted values the way config.json persists them", () => {
    // A schema-valid document can still hold spellings the save path would rewrite; reading
    // them canonically is what makes the post-write comparison hold.
    const { settings } = readBackupSettings({
      settings: {
        defaultModel: " anthropic:claude-exec ",
        hiddenModels: ["openai:gpt-a", "openai:gpt-a", " "],
        modelFallbacks: {
          "anthropic:claude-exec": { models: ["anthropic:claude-exec", "openai:gpt-plan"] },
        },
        agentAiDefaults: { exec: { modelString: " openai:gpt-exec " } },
      },
    });

    expect(settings).toMatchObject({
      defaultModel: "anthropic:claude-exec",
      hiddenModels: ["openai:gpt-a"],
      modelFallbacks: { "anthropic:claude-exec": { models: ["openai:gpt-plan"] } },
      agentAiDefaults: { exec: { modelString: "openai:gpt-exec" } },
    });
  });

  it("never carries the heartbeat prompt, which agents execute unattended", () => {
    const local: ProjectsConfig = { projects: new Map(), heartbeatDefaultPrompt: "Local prompt" };
    expect(projectBackupSettings(local)).not.toHaveProperty("heartbeatDefaultPrompt");

    // A backup written while the prompt was still portable is read like any block with a key
    // this build does not project: silently, so the local prompt stays.
    const read = readBackupSettings({
      settings: {
        heartbeatDefaultPrompt: "Run the release script",
        heartbeatDefaultIntervalMs: 600_000,
      },
    });
    expect(read).toEqual({ settings: { heartbeatDefaultIntervalMs: 600_000 }, unsupported: [] });
    const merged = mergeBackupSettings(local, read.settings!);
    expect(merged.heartbeatDefaultPrompt).toBe("Local prompt");
    expect(merged.heartbeatDefaultIntervalMs).toBe(600_000);
  });

  it("reads only the portable settings block", () => {
    const none = { settings: undefined, unsupported: [] };
    expect(readBackupSettings({ appearance: { theme: "dark" } })).toEqual(none);
    expect(readBackupSettings(undefined)).toEqual(none);

    expect(
      readBackupSettings({
        settings: {
          defaultModel: "anthropic:claude-plan",
          apiServerPort: 4321,
          muxGovernorToken: "smuggled",
          unknownKey: true,
          // Limits and diagnostics stay local even when a block carries them.
          taskSettings: { maxParallelAgentTasks: 256 },
          goalDefaults: { alwaysRequireExplicitBudget: false, defaultTurnCap: null },
          llmDebugLogs: true,
        },
      })
    ).toEqual({ settings: { defaultModel: "anthropic:claude-plan" }, unsupported: [] });
  });

  it("keeps the local value for fields this build does not understand and names them", () => {
    // A newer build's export (or a damaged document): the other fields still apply, and the
    // restore reports the skipped ones instead of refusing the whole backup on a downgrade.
    const read = readBackupSettings({
      settings: {
        agentAiDefaults: { exec: { thinkingLevel: "bogus" } },
        heartbeatDefaultIntervalMs: 1,
        defaultModel: "anthropic:claude-plan",
      },
    });
    expect(read.unsupported).toEqual(["agentAiDefaults", "heartbeatDefaultIntervalMs"]);
    expect(read.settings).toEqual({ defaultModel: "anthropic:claude-plan" });

    const current: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" } },
      heartbeatDefaultIntervalMs: 900_000,
    };
    const merged = mergeBackupSettings(current, read.settings!);
    expect(merged.agentAiDefaults).toEqual(current.agentAiDefaults);
    expect(merged.heartbeatDefaultIntervalMs).toBe(900_000);
    expect(merged.defaultModel).toBe("anthropic:claude-plan");

    expect(readBackupSettings({ settings: null })).toEqual({
      settings: undefined,
      unsupported: ["settings (not an object)"],
    });
  });

  it("reports values the on-disk schema accepts but normalization rejects instead of resetting", () => {
    // Each of these passes the loose on-disk shape and normalizes to unset; a restore must keep the
    // local value and name the key, not delete the target's setting.
    const rejected = {
      defaultModel: "garbage",
      hiddenModels: ["anthropic:claude-plan", "garbage"],
      modelFallbacks: { "openai:gpt-a": { models: ["openai:gpt-a"] } },
      // Load would heal a tier list it cannot parse to the default tiers.
      autoModelRouting: { tiers: [{ id: "tier-from-a-newer-build" }] },
      runtimeEnablement: { "runtime-from-a-newer-build": false },
    };
    const read = readBackupSettings({ settings: rejected });
    expect(read.unsupported).toEqual(Object.keys(rejected));
    expect(read.settings).toEqual({});

    const current: ProjectsConfig = {
      projects: new Map(),
      defaultModel: "anthropic:claude-local",
      hiddenModels: ["openai:gpt-hidden"],
      runtimeEnablement: { ssh: false },
    };
    expect(mergeBackupSettings(current, read.settings!)).toEqual(current);

    // Empty spellings are still resets.
    expect(
      readBackupSettings({
        settings: {
          defaultModel: " ",
          hiddenModels: [],
          modelFallbacks: {},
          runtimeEnablement: {},
        },
      })
    ).toEqual({
      settings: {
        defaultModel: null,
        hiddenModels: [],
        modelFallbacks: null,
        runtimeEnablement: null,
      },
      unsupported: [],
    });
  });

  it("keeps the local agent defaults when a nested model string does not canonicalize", () => {
    // The per-agent shape accepts any string as a model, and the normalizer drops what it cannot
    // canonicalize, so without the tightened schema a bad nested model would restore as a
    // whole-field reset over the target's valid agent defaults.
    const current: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-local", thinkingLevel: "high" },
        plan: { subagent: { modelString: "anthropic:claude-local" } },
      },
    };
    for (const agentAiDefaults of [
      { exec: { modelString: "garbage" } },
      { exec: { modelString: "openai:gpt-exec", subagent: { modelString: "garbage" } } },
    ]) {
      const read = readBackupSettings({
        settings: { agentAiDefaults, defaultModel: "anthropic:claude-plan" },
      });
      expect(read).toEqual({
        settings: { defaultModel: "anthropic:claude-plan" },
        unsupported: ["agentAiDefaults"],
      });
      expect(mergeBackupSettings(current, read.settings!).agentAiDefaults).toEqual(
        current.agentAiDefaults
      );
    }

    // Valid nested models still apply, canonicalized, and empty spellings still mean unset.
    const valid = readBackupSettings({
      settings: {
        agentAiDefaults: {
          exec: {
            modelString: " openai:gpt-exec ",
            subagent: { modelString: "anthropic:claude-sub" },
          },
          plan: { modelString: "", subagent: { modelString: " " } },
        },
      },
    });
    expect(valid.unsupported).toEqual([]);
    expect(mergeBackupSettings(current, valid.settings!).agentAiDefaults).toEqual({
      exec: { modelString: "openai:gpt-exec", subagent: { modelString: "anthropic:claude-sub" } },
    });
    expect(readBackupSettings({ settings: { agentAiDefaults: {} } })).toEqual({
      settings: { agentAiDefaults: {} },
      unsupported: [],
    });
  });
});
