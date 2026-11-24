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
  chatTranscriptFullWidth: false,
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
      chatTranscriptFullWidth: true,
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
      heartbeatDefaultIntervalMs: 5 * 60 * 1000,
      // Isolation policy a restore must not reduce.
      defaultIsolation: { project: "local", workspace: "none" },
      runtimeEnablement: { worktree: false },
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
      apiServerPort: 4321,
    };

    const merged = mergeBackupSettings(
      target,
      readBackupSettings({ settings: projectBackupSettings({ projects: new Map() }) }).settings!
    );

    expect(merged.agentAiDefaults).toEqual({});
    expect(merged.modelFallbacks).toBeUndefined();
    expect(merged.chatTranscriptFullWidth).toBe(false);
    expect(merged.apiServerPort).toBe(4321);
    // The round trip closes: the restored target exports what the source exported.
    expect(projectBackupSettings(merged)).toEqual(UNSET_EXPORT);
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

  it("keeps the local value for spellings the save path would rewrite", () => {
    // Exports are canonical, so a padded, repeated or self-referencing value comes from a hand
    // edit or another tool; applying the rewritten copy would restore something the document
    // does not say.
    const rewritten = {
      agentAiDefaults: { exec: { modelString: " openai:gpt-exec " } },
      defaultModel: " anthropic:claude-exec ",
      hiddenModels: ["openai:gpt-a", "openai:gpt-a"],
      modelFallbacks: {
        "anthropic:claude-exec": { models: ["anthropic:claude-exec", "openai:gpt-plan"] },
      },
    };
    expect(readBackupSettings({ settings: rewritten })).toEqual({
      settings: {},
      unsupported: Object.keys(rewritten),
    });
  });

  it("never carries the heartbeat prompt or cadence, which drive unattended turns", () => {
    const local: ProjectsConfig = {
      projects: new Map(),
      heartbeatDefaultPrompt: "Local prompt",
      heartbeatDefaultIntervalMs: 900_000,
    };
    expect(projectBackupSettings(local)).not.toHaveProperty("heartbeatDefaultPrompt");
    expect(projectBackupSettings(local)).not.toHaveProperty("heartbeatDefaultIntervalMs");

    // A backup written while they were still portable is read like any block with a key this
    // build does not project: silently, so the local values stay.
    const read = readBackupSettings({
      settings: {
        heartbeatDefaultPrompt: "Run the release script",
        heartbeatDefaultIntervalMs: 300_000,
        defaultModel: "anthropic:claude-plan",
      },
    });
    expect(read).toEqual({ settings: { defaultModel: "anthropic:claude-plan" }, unsupported: [] });
    const merged = mergeBackupSettings(local, read.settings!);
    expect(merged.heartbeatDefaultPrompt).toBe("Local prompt");
    expect(merged.heartbeatDefaultIntervalMs).toBe(900_000);
  });

  it("never carries a per-agent cache TTL, which changes what every later turn costs", () => {
    const local: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-local", cacheTtl: "5m" },
        explore: { cacheTtl: "5m" },
      },
    };
    expect(projectBackupSettings(local).agentAiDefaults).toEqual({
      exec: { modelString: "openai:gpt-local" },
    });

    // A block that carries one still restores the agent defaults around it, with the local TTLs.
    const read = readBackupSettings({
      settings: {
        agentAiDefaults: {
          exec: { modelString: "anthropic:claude-exec", cacheTtl: "1h" },
          plan: { cacheTtl: "1h" },
        },
      },
    });
    expect(read).toEqual({
      settings: { agentAiDefaults: { exec: { modelString: "anthropic:claude-exec" } } },
      unsupported: [],
    });
    expect(mergeBackupSettings(local, read.settings!).agentAiDefaults).toEqual({
      exec: { modelString: "anthropic:claude-exec", cacheTtl: "5m" },
      explore: { cacheTtl: "5m" },
    });
    // A reset of the agent defaults keeps the local TTLs too.
    expect(mergeBackupSettings(local, { agentAiDefaults: null }).agentAiDefaults).toEqual({
      exec: { cacheTtl: "5m" },
      explore: { cacheTtl: "5m" },
    });
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
          // Limits, diagnostics and isolation policy stay local even when a block carries them.
          taskSettings: { maxParallelAgentTasks: 256 },
          goalDefaults: { alwaysRequireExplicitBudget: false, defaultTurnCap: null },
          llmDebugLogs: true,
          defaultIsolation: { project: "local", workspace: "none" },
          runtimeEnablement: { worktree: false },
        },
      })
    ).toEqual({
      settings: { defaultModel: "anthropic:claude-plan" },
      // Keys this build has no setting for may be a newer build's portable settings, so the
      // restore names them; known local keys stay silent.
      unsupported: ["muxGovernorToken", "unknownKey"],
    });
  });

  it("keeps the local value for fields this build does not understand and names them", () => {
    // A newer build's export (or a damaged document): the other fields still apply, and the
    // restore reports the skipped ones instead of refusing the whole backup on a downgrade.
    const read = readBackupSettings({
      settings: {
        agentAiDefaults: { exec: { thinkingLevel: "bogus" } },
        minThinkingLevelByModel: { "openai:gpt-a": "level-from-a-newer-build" },
        defaultModel: "anthropic:claude-plan",
      },
    });
    expect(read.unsupported).toEqual(["agentAiDefaults", "minThinkingLevelByModel"]);
    expect(read.settings).toEqual({ defaultModel: "anthropic:claude-plan" });

    const current: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" } },
      minThinkingLevelByModel: { "openai:gpt-a": "high" },
    };
    const merged = mergeBackupSettings(current, read.settings!);
    expect(merged.agentAiDefaults).toEqual(current.agentAiDefaults);
    expect(merged.minThinkingLevelByModel).toEqual(current.minThinkingLevelByModel);
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
      // A floor keyed by a string no model lookup can match.
      minThinkingLevelByModel: { garbage: "high" },
      modelFallbacks: { "openai:gpt-a": { models: ["openai:gpt-a"] } },
      // Load would heal a tier list it cannot parse to the default tiers.
      autoModelRouting: { tiers: [{ id: "tier-from-a-newer-build" }] },
    };
    const read = readBackupSettings({ settings: rejected });
    expect(read.unsupported).toEqual(Object.keys(rejected));
    expect(read.settings).toEqual({});

    const current: ProjectsConfig = {
      projects: new Map(),
      defaultModel: "anthropic:claude-local",
      hiddenModels: ["openai:gpt-hidden"],
    };
    expect(mergeBackupSettings(current, read.settings!)).toEqual(current);

    // Values load would quietly shorten, drop in part or strip: a chain over this build's limit,
    // a map with one valid chain beside a self-only one, repeated tier ids (fewer than the
    // minimum remain, so load falls back to the default tiers), a tier field this build does not
    // know, and an evaluation block without a usable model.
    const routing = getDefaultAutoModelRoutingConfig();
    const tier = routing.tiers[0];
    for (const [key, value] of [
      [
        "modelFallbacks",
        {
          "openai:gpt-a": {
            models: ["openai:gpt-b", "openai:gpt-c", "openai:gpt-d", "openai:gpt-e"],
          },
        },
      ],
      [
        "modelFallbacks",
        {
          "openai:gpt-a": { models: ["openai:gpt-b"] },
          "openai:gpt-c": { models: ["openai:gpt-c"] },
        },
      ],
      // Sources and targets no model selection can match.
      ["modelFallbacks", { garbage: { models: ["openai:gpt-b"] } }],
      ["modelFallbacks", { "openai:gpt-a": { models: ["garbage"] } }],
      ["autoModelRouting", { tiers: [tier, tier] }],
      [
        "autoModelRouting",
        { ...routing, tiers: [{ ...tier, fieldFromANewerBuild: true }, ...routing.tiers.slice(1)] },
      ],
      ["evaluationDefaults", {}],
      ["evaluationDefaults", { model: "garbage" }],
      // A provider this build cannot build an evaluation model for.
      ["evaluationDefaults", { model: "xai:grok-4" }],
    ] as const) {
      expect(readBackupSettings({ settings: { [key]: value } })).toEqual({
        settings: {},
        unsupported: [key],
      });
    }

    // `null` is the only spelling of unset; an empty spelling load would read as unset is
    // reported rather than applied as a reset. An empty hidden list is a real value.
    expect(
      readBackupSettings({
        settings: {
          defaultModel: " ",
          hiddenModels: [],
          modelFallbacks: {},
          minThinkingLevelByModel: {},
        },
      })
    ).toEqual({
      settings: { hiddenModels: [] },
      unsupported: ["defaultModel", "minThinkingLevelByModel", "modelFallbacks"],
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

    // Padded and empty nested model strings are rewritten or dropped by load, so they are
    // reported too; canonical nested models apply.
    for (const agentAiDefaults of [
      { exec: { modelString: " openai:gpt-exec " } },
      { plan: { modelString: "", subagent: { modelString: " " } } },
    ]) {
      expect(readBackupSettings({ settings: { agentAiDefaults } }).unsupported).toEqual([
        "agentAiDefaults",
      ]);
    }
    const restored = {
      exec: { modelString: "openai:gpt-exec", subagent: { modelString: "anthropic:claude-sub" } },
    };
    const valid = readBackupSettings({ settings: { agentAiDefaults: restored } });
    expect(valid.unsupported).toEqual([]);
    expect(mergeBackupSettings(current, valid.settings!).agentAiDefaults).toEqual(restored);
    expect(readBackupSettings({ settings: { agentAiDefaults: {} } })).toEqual({
      settings: { agentAiDefaults: {} },
      unsupported: [],
    });
  });
});
