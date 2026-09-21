import { afterEach, describe, expect, it, mock } from "bun:test";
import type {
  Experimental_EvaluationModelV4,
  Experimental_EvaluationModelV4Result,
} from "@ai-sdk/provider";
import { APICallError } from "ai";
import { Effect } from "effect";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AutoModelRouter, type AutoModelRouterDeps } from "./autoModelRouter";
import {
  createEvaluationModel,
  resolveEvaluationModelTarget,
  type EvaluationModelFactoryDeps,
} from "./evaluationModelFactory";
import type { ProvidersConfig } from "@/node/config/providersConfigStore";
import { Err, Ok } from "@/common/types/result";
import { DEFAULT_AUTO_MODEL_ROUTING_TIERS } from "@/common/types/autoModelRouting";
import {
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  TYPESAFE_PROVIDER_KEY,
} from "@/constants/autoModelRouting";

const TIERS = DEFAULT_AUTO_MODEL_ROUTING_TIERS.map((tier) => ({ ...tier }));
const EVALUATION_MODEL = DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL;

type DoEvaluate = Experimental_EvaluationModelV4["doEvaluate"];

function fakeEvaluationModel(doEvaluate: DoEvaluate): Experimental_EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-judge",
    supportedQuestionTypes: ["choice"],
    doEvaluate,
  };
}

function verdict(
  choice = "hard",
  extra: Partial<Experimental_EvaluationModelV4Result> = {}
): Experimental_EvaluationModelV4Result {
  return {
    answers: {
      difficulty: {
        type: "choice",
        choice,
        probabilities: { easy: 0.1, medium: 0.2, hard: 0.6, extreme: 0.1 },
      },
    },
    warnings: [],
    providerMetadata: { [TYPESAFE_PROVIDER_KEY]: { confidence: { difficulty: 0.6 } } },
    ...extra,
  };
}

function providersStore(providers: Record<string, unknown> | null) {
  return { loadProvidersConfig: () => providers as ProvidersConfig | null };
}

/** Router over a fake evaluation model so the real experimental_evaluate runs, minus I/O. */
function createRouter(options: {
  doEvaluate?: DoEvaluate;
  policyService?: AutoModelRouterDeps["policyService"];
}) {
  const doEvaluate = mock<DoEvaluate>(options.doEvaluate ?? (() => Promise.resolve(verdict())));
  const router = new AutoModelRouter({
    providersConfigStore: providersStore({}),
    policyService: options.policyService,
    env: {},
    createEvaluationModel: () => Effect.succeed(Ok(fakeEvaluationModel(doEvaluate))),
  });
  return { router, doEvaluate };
}

const tempPaths: string[] = [];
afterEach(() => {
  for (const p of tempPaths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe("AutoModelRouter.classify", () => {
  it("asks one choice question keyed by tier id and maps the verdict", async () => {
    const { router, doEvaluate } = createRouter({});

    const result = await router.classify({
      prompt: "Rename a variable",
      recentUserMessages: ["a", "b", "c", "d"],
      tiers: TIERS,
      evaluationModel: EVALUATION_MODEL,
    });

    expect(result).toEqual({
      success: true,
      data: {
        tierId: "hard",
        confidence: 0.6,
        probabilities: { easy: 0.1, medium: 0.2, hard: 0.6, extreme: 0.1 },
        evaluationModel: EVALUATION_MODEL,
        providerMetadata: { [TYPESAFE_PROVIDER_KEY]: { confidence: { difficulty: 0.6 } } },
      },
    });
    expect(doEvaluate).toHaveBeenCalledTimes(1);
    const call = doEvaluate.mock.calls[0][0];
    const state = call.state as { prompt: string; recentUserMessages?: string[] };
    expect(state.prompt).toBe("Rename a variable");
    // Only the most recent messages ride along.
    expect(state.recentUserMessages).toEqual(["b", "c", "d"]);
    const question = call.questions.difficulty;
    expect(question.type).toBe("choice");
    if (question.type !== "choice") return;
    expect(Object.keys(question.criteria)).toEqual(TIERS.map((tier) => tier.id));
    expect(question.criteria.easy).toBe(TIERS[0].description);
  });

  it("omits confidence and probabilities when the evaluator reports none", async () => {
    const { router } = createRouter({
      doEvaluate: () =>
        Promise.resolve({
          answers: { difficulty: { type: "choice", choice: "easy" } },
          warnings: [],
        }),
    });
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS,
      evaluationModel: "openai:gpt-5-nano",
    });
    expect(result).toEqual({
      success: true,
      data: { tierId: "easy", evaluationModel: "openai:gpt-5-nano" },
    });
  });

  it("fails when the evaluator chooses outside the tiers", async () => {
    const { router } = createRouter({ doEvaluate: () => Promise.resolve(verdict("impossible")) });
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS,
      evaluationModel: EVALUATION_MODEL,
    });
    expect(result.success).toBe(false);
  });

  it("fails when the evaluator throws, without leaking the error body into the reason", async () => {
    const { router } = createRouter({
      doEvaluate: () => Promise.reject(new Error("HTTP 429 sk-secret rate limited")),
    });
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS,
      evaluationModel: EVALUATION_MODEL,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("Evaluation failed");
    expect(result.error).not.toContain("sk-secret");
  });

  it("reduces a provider HTTP failure to its status code", async () => {
    const { router } = createRouter({
      doEvaluate: () =>
        Promise.reject(
          new APICallError({
            message: 'Rate limited: {"error":"key sk-secret exhausted"}',
            url: "https://api.example.test/evaluate",
            requestBodyValues: {},
            statusCode: 429,
            responseBody: '{"error":"key sk-secret exhausted"}',
          })
        ),
    });
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS,
      evaluationModel: EVALUATION_MODEL,
    });
    expect(result).toEqual(Err("Evaluation request failed with HTTP 429"));
  });

  it("passes the evaluator's usage and provider metadata through for cost accounting", async () => {
    const { router } = createRouter({
      doEvaluate: () =>
        Promise.resolve(verdict("hard", { usage: { inputTokens: 40, outputTokens: 3 } })),
    });
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS,
      evaluationModel: EVALUATION_MODEL,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.usage).toMatchObject({ inputTokens: 40, outputTokens: 3 });
    expect(result.data.providerMetadata).toEqual({
      [TYPESAFE_PROVIDER_KEY]: { confidence: { difficulty: 0.6 } },
    });
  });

  it("fails when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { router, doEvaluate } = createRouter({});
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS,
      evaluationModel: EVALUATION_MODEL,
      signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(doEvaluate).not.toHaveBeenCalled();
  });

  it("requires at least two tiers", async () => {
    const { router, doEvaluate } = createRouter({});
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS.slice(0, 1),
      evaluationModel: EVALUATION_MODEL,
    });
    expect(result.success).toBe(false);
    expect(doEvaluate).not.toHaveBeenCalled();
  });

  it("fails without evaluating when the evaluation model cannot be built", async () => {
    const router = new AutoModelRouter({ providersConfigStore: providersStore({}), env: {} });
    const result = await router.classify({
      prompt: "x",
      tiers: TIERS,
      evaluationModel: EVALUATION_MODEL,
    });
    expect(result).toEqual({
      success: false,
      error: `No API key configured for ${TYPESAFE_PROVIDER_KEY} in providers.jsonc`,
    });
    expect(router.getEvaluationStatus(EVALUATION_MODEL)).toEqual({
      evaluationModel: EVALUATION_MODEL,
      available: false,
      reason: `No API key configured for ${TYPESAFE_PROVIDER_KEY} in providers.jsonc`,
    });
  });
});

describe("evaluation model factory", () => {
  function deps(
    providers: Record<string, unknown> | null,
    extra: Partial<EvaluationModelFactoryDeps> = {}
  ): EvaluationModelFactoryDeps {
    return { providersConfigStore: providersStore(providers), env: {}, ...extra };
  }

  it("builds a TypeSafe evaluation model from the reserved providers.jsonc entry", async () => {
    const target = resolveEvaluationModelTarget(
      EVALUATION_MODEL,
      deps({ typesafe: { apiKey: "sk-test" } })
    );
    expect(target.success).toBe(true);
    if (!target.success) return;
    expect(target.data.provider).toBe(TYPESAFE_PROVIDER_KEY);
    expect(target.data.modelId).toBe("jev-latest");
    expect(target.data.settings.apiKey).toBe("sk-test");
    expect(target.data.settings.baseURL).toBeUndefined();
    expect(Object.keys(target.data.settings.headers)).toContain("user-agent");

    // Proxy setups: both providers.jsonc base-URL spellings and configured headers reach
    // the evaluator, as they do for chat requests.
    for (const key of ["baseUrl", "baseURL"]) {
      const proxied = resolveEvaluationModelTarget(
        EVALUATION_MODEL,
        deps({
          typesafe: {
            apiKey: "sk-test",
            [key]: "https://proxy.example.test/jev",
            headers: { "X-Proxy-Token": "proxy-token" },
          },
        })
      );
      expect(proxied.success && proxied.data.settings.baseURL).toBe(
        "https://proxy.example.test/jev"
      );
      expect(proxied.success && proxied.data.settings.headers).toMatchObject({
        "x-proxy-token": "proxy-token",
      });
    }

    const model = await Effect.runPromise(
      createEvaluationModel(EVALUATION_MODEL, deps({ typesafe: { apiKey: "sk-test" } }))
    );
    expect(model.success).toBe(true);
    if (!model.success) return;
    expect(model.data.modelId).toBe("jev-latest");
    expect(model.data.supportedQuestionTypes).toContain("choice");
  });

  it("resolves language-model evaluators through the same providers.jsonc credentials", () => {
    const target = resolveEvaluationModelTarget(
      "openai:gpt-5-nano",
      deps({ openai: { apiKey: "sk-openai", baseUrl: "https://proxy.example.test/v1" } })
    );
    expect(target.success).toBe(true);
    if (!target.success) return;
    expect(target.data).toMatchObject({
      provider: "openai",
      modelId: "gpt-5-nano",
      settings: { apiKey: "sk-openai", baseURL: "https://proxy.example.test/v1" },
    });
    expect(target.data.organization).toBeUndefined();
    // Multi-org OpenAI keys evaluate against the same organization chat requests use.
    const withOrg = resolveEvaluationModelTarget(
      "openai:gpt-5-nano",
      deps({ openai: { apiKey: "sk-openai" } }, { env: { OPENAI_ORG_ID: "org-env" } })
    );
    expect(withOrg.success && withOrg.data.organization).toBe("org-env");
    expect(resolveEvaluationModelTarget("anthropic:claude-haiku-4-5", deps({}))).toMatchObject({
      success: false,
      error: { code: "missing_api_key" },
    });
  });

  it("rejects model strings outside the evaluation-capable providers", () => {
    for (const modelString of ["coder:openai/gpt-5", "typesafe", "openai:", "mux-gateway:x"]) {
      expect(
        resolveEvaluationModelTarget(modelString, deps({ openai: { apiKey: "k" } }))
      ).toMatchObject({
        success: false,
        error: { code: "invalid_model" },
      });
    }
  });

  it("honors provider enablement and enforced policy, including the forced base URL", () => {
    expect(
      resolveEvaluationModelTarget(
        "openai:gpt-5-nano",
        deps({ openai: { apiKey: "k", enabled: false } })
      )
    ).toMatchObject({ success: false, error: { code: "provider_disabled" } });

    const denyProvider = deps(
      { typesafe: { apiKey: "k" } },
      {
        policyService: {
          isEnforced: () => true,
          isProviderAllowed: (provider) => provider !== TYPESAFE_PROVIDER_KEY,
          isModelAllowed: () => true,
          getForcedBaseUrl: () => undefined,
        },
      }
    );
    expect(resolveEvaluationModelTarget(EVALUATION_MODEL, denyProvider)).toMatchObject({
      success: false,
      error: { code: "policy_denied" },
    });

    const denyModel = deps(
      { typesafe: { apiKey: "k" } },
      {
        policyService: {
          isEnforced: () => true,
          isProviderAllowed: () => true,
          isModelAllowed: (provider, modelId) =>
            !(provider === TYPESAFE_PROVIDER_KEY && modelId === "jev-latest"),
          getForcedBaseUrl: () => undefined,
        },
      }
    );
    expect(resolveEvaluationModelTarget(EVALUATION_MODEL, denyModel)).toMatchObject({
      success: false,
      error: { code: "policy_denied" },
    });

    const forced = deps(
      { typesafe: { apiKey: "k", baseUrl: "https://user.example.test/v1" } },
      {
        policyService: {
          isEnforced: () => true,
          isProviderAllowed: () => true,
          isModelAllowed: () => true,
          getForcedBaseUrl: (provider) =>
            provider === TYPESAFE_PROVIDER_KEY ? "https://proxy.example.test/typesafe/" : undefined,
        },
      }
    );
    expect(resolveEvaluationModelTarget(EVALUATION_MODEL, forced)).toMatchObject({
      success: true,
      data: { settings: { baseURL: "https://proxy.example.test/typesafe/" } },
    });
  });

  it("refuses an id shadowed by a custom chat provider instead of using env credentials", () => {
    const custom = {
      providerType: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      apiKey: "chat-provider-key",
    };
    // The custom entry's key never reaches an evaluation API, and a native env key must not
    // route the prompt around the endpoint the user pointed that id at.
    for (const [modelString, providers, env] of [
      [EVALUATION_MODEL, { typesafe: custom }, { TYPESAFE_API_KEY: "env-key" }],
      ["openai:gpt-5-nano", { openai: custom }, { OPENAI_API_KEY: "env-key" }],
    ] as const) {
      expect(resolveEvaluationModelTarget(modelString, deps(providers, { env }))).toMatchObject({
        success: false,
        error: { code: "custom_provider" },
      });
    }
  });

  it("prefers the providers.jsonc apiKey, then apiKeyFile, then the env vars in order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-model-routing-"));
    tempPaths.push(dir);
    const keyFile = path.join(dir, "typesafe.key");
    await fsp.writeFile(keyFile, "file-key\n");
    const apiKeyOf = (providers: Record<string, unknown> | null, env: Record<string, string>) => {
      const target = resolveEvaluationModelTarget(EVALUATION_MODEL, deps(providers, { env }));
      return target.success ? target.data.settings.apiKey : target.error.code;
    };

    const env = {
      TYPESAFE_API_KEY: "env-key",
      TYPESAFE_AI_API_KEY: "sdk-env-key",
      JEV_API_KEY: "jev",
    };
    expect(apiKeyOf({ typesafe: { apiKey: "config-key", apiKeyFile: keyFile } }, env)).toBe(
      "config-key"
    );
    expect(apiKeyOf({ typesafe: { apiKeyFile: keyFile } }, env)).toBe("file-key");
    expect(apiKeyOf(null, env)).toBe("env-key");
    expect(apiKeyOf({}, { TYPESAFE_AI_API_KEY: "sdk-env-key", JEV_API_KEY: "jev" })).toBe(
      "sdk-env-key"
    );
    expect(apiKeyOf({}, { JEV_API_KEY: "jev" })).toBe("jev");
    expect(apiKeyOf({}, {})).toBe("missing_api_key");
  });
});
