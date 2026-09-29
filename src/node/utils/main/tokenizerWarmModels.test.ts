import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_MODEL, DEFAULT_WARM_MODELS } from "@/common/constants/knownModels";
import { __resetTokenizerForTests, encodingForModel } from "./tokenizer";
import { deriveWarmModels, warmConfiguredTokenizers } from "./tokenizerWarmModels";
import * as workerPool from "./workerPool";

const CLAUDE = "anthropic:claude-opus-4-6";
const OPENAI = "openai:gpt-5.5-pro";

// Loosely typed on purpose: the persisted config can hold junk the types do not admit.
function configWith(workspaces: unknown[], extra: Record<string, unknown> = {}): ProjectsConfig {
  return {
    projects: new Map([["/repo", { workspaces }]]),
    ...extra,
  } as unknown as ProjectsConfig;
}

function warmedEncodings(config: ProjectsConfig): string[] {
  const models = deriveWarmModels(config);
  const encodings = models.map((model) => encodingForModel(model));
  // One representative model per encoding.
  expect(new Set(encodings).size).toBe(models.length);
  return encodings.sort();
}

describe("deriveWarmModels", () => {
  test("a claude-only config warms only the claude encoding", () => {
    const config = configWith(
      [
        {
          id: "w1",
          aiSettings: { model: CLAUDE },
          aiSettingsByAgent: { exec: { model: "anthropic:claude-sonnet-4-5" } },
        },
      ],
      { defaultModel: CLAUDE }
    );
    expect(warmedEncodings(config)).toEqual(["claude"]);
  });

  const openaiSources: Array<[string, ProjectsConfig]> = [
    ["workspace aiSettings", configWith([{ aiSettings: { model: OPENAI } }])],
    [
      "workspace aiSettingsByAgent",
      configWith([{ aiSettingsByAgent: { plan: { model: OPENAI } } }]),
    ],
    ["workspace taskAiPins", configWith([{ taskAiPins: { model: OPENAI } }])],
    ["workspace taskModelString", configWith([{ taskModelString: OPENAI }])],
    ["agentAiDefaults", configWith([], { agentAiDefaults: { exec: { modelString: OPENAI } } })],
    [
      "agentAiDefaults subagent profile",
      configWith([], { agentAiDefaults: { exec: { subagent: { modelString: OPENAI } } } }),
    ],
    ["advisorModelString", configWith([], { advisorModelString: OPENAI })],
    [
      "a project creation default",
      configWith([], {
        userPreferences: { ai: { projectDefaults: { "/repo": { model: OPENAI } } } },
      }),
    ],
    ["a coder gateway id", configWith([{ aiSettings: { model: "coder:openai/gpt-5.5-pro" } }])],
    [
      "an auto-routing tier",
      configWith([], { autoModelRouting: { tiers: [{ id: "hard", model: OPENAI }] } }),
    ],
    [
      "a refusal fallback target",
      configWith([], { modelFallbacks: { [CLAUDE]: { models: [OPENAI] } } }),
    ],
    ["the evaluation defaults", configWith([], { evaluationDefaults: { model: OPENAI } })],
    [
      "the auto-routing classifier",
      configWith([], { autoModelRouting: { evaluationModel: OPENAI } }),
    ],
    [
      "subagentAiDefaults",
      configWith([], { subagentAiDefaults: { explore: { modelString: OPENAI } } }),
    ],
  ];
  test.each(openaiSources)("an OpenAI model in %s adds o200k_base", (_source, config) => {
    config.defaultModel = CLAUDE;
    expect(warmedEncodings(config)).toEqual(["claude", "o200k_base"]);
  });

  const defaultEncodings = () =>
    [...new Set(DEFAULT_WARM_MODELS.map((model) => encodingForModel(model)))].sort();

  test("a Coder gateway id keeps the default warm set", () => {
    // The instance's upstream type lives in providers.jsonc, which startup does not read, so
    // even a provider-named instance may be backed by another provider's model.
    const config = configWith([{ aiSettings: { model: "coder:anthropic/claude-opus-4-6" } }], {
      defaultModel: CLAUDE,
    });
    expect(warmedEncodings(config)).toEqual(defaultEncodings());
  });

  test("a known provider's unlisted model uses the provider fallback without widening the set", () => {
    const known = configWith([{ aiSettings: { model: "anthropic:claude-unreleased-9" } }], {
      defaultModel: CLAUDE,
    });
    expect(warmedEncodings(known)).toEqual(["claude"]);
  });

  test("claude stays warm for an OpenAI-only config, since history truncation counts with it", () => {
    const config = configWith([{ aiSettings: { model: OPENAI } }], { defaultModel: OPENAI });
    expect(warmedEncodings(config)).toEqual(["claude", "o200k_base"]);
  });

  test("model ids outside model keys, and non-model strings under them, do not widen the set", () => {
    const config = configWith(
      [
        {
          aiSettings: { model: CLAUDE },
          notes: OPENAI,
          runtimeConfig: { model: "https://x.test/y" },
        },
      ],
      { defaultModel: CLAUDE, hiddenModels: [OPENAI], taskModelString: [OPENAI] }
    );
    expect(warmedEncodings(config)).toEqual(["claude"]);
  });

  test("the default model's encoding is warmed even when no model uses it yet", () => {
    const config = configWith([{ aiSettings: { model: OPENAI } }]);
    expect(warmedEncodings(config)).toEqual(
      [...new Set([encodingForModel(DEFAULT_MODEL), "o200k_base"])].sort()
    );
  });

  test("a config naming no model falls back to the default warm set", () => {
    expect(deriveWarmModels({ projects: new Map() })).toEqual(Array.from(DEFAULT_WARM_MODELS));
    expect(deriveWarmModels(configWith([{ id: "w1" }]))).toEqual(Array.from(DEFAULT_WARM_MODELS));
    // A blank model string names no model, so it must not narrow the warm set to the default model.
    expect(deriveWarmModels(configWith([{ aiSettings: { model: "  " } }]))).toEqual(
      Array.from(DEFAULT_WARM_MODELS)
    );
  });

  test("malformed entries are ignored without throwing", () => {
    const config = configWith(
      [
        null,
        "junk",
        {
          aiSettings: { model: "" },
          aiSettingsByAgent: { exec: null, plan: { model: 42 } },
          taskAiPins: "junk",
          taskModelString: ["openai:gpt-5"],
        },
      ],
      { defaultModel: CLAUDE, agentAiDefaults: { exec: null, plan: { subagent: 7 } } }
    );
    expect(warmedEncodings(config)).toEqual(["claude"]);

    const badProjects = { projects: "junk", defaultModel: CLAUDE } as unknown as ProjectsConfig;
    expect(warmedEncodings(badProjects)).toEqual(["claude"]);
  });
});

describe("warmConfiguredTokenizers", () => {
  let previousForceReal: string | undefined;
  beforeEach(() => {
    // Jest runs in approximate mode, which never reaches the worker pool.
    previousForceReal = process.env.XUM_FORCE_REAL_TOKENIZER;
    process.env.XUM_FORCE_REAL_TOKENIZER = "1";
    __resetTokenizerForTests();
  });
  afterEach(() => {
    if (previousForceReal === undefined) {
      delete process.env.XUM_FORCE_REAL_TOKENIZER;
    } else {
      process.env.XUM_FORCE_REAL_TOKENIZER = previousForceReal;
    }
    jest.restoreAllMocks();
    // The stubbed "ready" answers must not stay cached for other tests.
    __resetTokenizerForTests();
  });

  // Stub the pool so no worker loads an encoding; the assertions are about which ones are asked for.
  function stubReady() {
    const runSpy = jest
      .spyOn(workerPool, "run")
      .mockImplementation((encoding) => Promise.resolve(encoding as never));
    return () =>
      runSpy.mock.calls
        .filter(([, taskName]) => taskName === "ready")
        .map(([encoding]) => encoding);
  }

  test("warms only the encodings the loaded config needs", async () => {
    const readyEncodings = stubReady();
    const config = configWith([{ aiSettings: { model: CLAUDE } }], { defaultModel: CLAUDE });
    const results = await warmConfiguredTokenizers(() => config);
    expect(results).toEqual([{ status: "fulfilled", value: "claude" }]);
    expect(readyEncodings()).toEqual(["claude"]);
  });

  test("a config load that throws warms the default encodings instead of failing", async () => {
    const readyEncodings = stubReady();
    const results = await warmConfiguredTokenizers(() => {
      throw new Error("config unreadable");
    });
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    // "ready" is sent per model, so compare the distinct encodings.
    expect(new Set(readyEncodings())).toEqual(
      new Set(DEFAULT_WARM_MODELS.map((model) => encodingForModel(model)))
    );
  });
});
