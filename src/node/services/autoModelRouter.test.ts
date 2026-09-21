import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AutoModelRouter, type AutoModelRouterDeps } from "./autoModelRouter";
import type { ProvidersConfig } from "@/node/config/providersConfigStore";
import { DEFAULT_AUTO_MODEL_ROUTING_TIERS } from "@/common/types/autoModelRouting";
import {
  AUTO_MODEL_ROUTING_CLASSIFIER_MODEL,
  TYPESAFE_PROVIDER_KEY,
  TYPESAFE_SYSTEM_ONE_URL,
} from "@/constants/autoModelRouting";

const TIERS = DEFAULT_AUTO_MODEL_ROUTING_TIERS.map((tier) => ({ ...tier }));

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createRouter(options: {
  providers?: Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
  fetch?: NonNullable<AutoModelRouterDeps["fetch"]>;
  policyService?: AutoModelRouterDeps["policyService"];
}) {
  const fetchMock = mock<NonNullable<AutoModelRouterDeps["fetch"]>>(
    options.fetch ?? (() => Promise.resolve(jsonResponse(validBody())))
  );
  const router = new AutoModelRouter({
    providersConfigStore: {
      loadProvidersConfig: () => (options.providers ?? null) as ProvidersConfig | null,
    },
    policyService: options.policyService,
    env: options.env ?? {},
    fetch: fetchMock,
  });
  return { router, fetchMock };
}

function validBody(choice = "hard") {
  return {
    model: "jev-1.13.0",
    answers: {
      difficulty: {
        type: "choice",
        choice,
        probabilities: { easy: 0.1, medium: 0.2, hard: 0.6, extreme: 0.1 },
        confidence: 0.6,
      },
    },
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

const tempPaths: string[] = [];
afterEach(() => {
  for (const p of tempPaths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe("AutoModelRouter.classify", () => {
  it("posts a bearer-authenticated choice question keyed by tier id", async () => {
    const { router, fetchMock } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "sk-test" } },
    });

    const result = await router.classify({
      prompt: "Rename a variable",
      recentUserMessages: ["a", "b", "c", "d"],
      tiers: TIERS,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      tierId: "hard",
      confidence: 0.6,
      probabilities: { easy: 0.1, medium: 0.2, hard: 0.6, extreme: 0.1 },
      classifierModel: "jev-1.13.0",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TYPESAFE_SYSTEM_ONE_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string) as {
      model: string;
      state: { prompt: string; recentUserMessages?: string[] };
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    expect(body.model).toBe(AUTO_MODEL_ROUTING_CLASSIFIER_MODEL);
    expect(body.state.prompt).toBe("Rename a variable");
    // Only the most recent messages ride along.
    expect(body.state.recentUserMessages).toEqual(["b", "c", "d"]);
    const question = Object.values(body.questions)[0];
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(TIERS.map((tier) => tier.id));
    expect(question.criteria.easy).toBe(TIERS[0].description);
  });

  it("fails without calling the API when no key is configured", async () => {
    const { router, fetchMock } = createRouter({ providers: {} });
    const result = await router.classify({ prompt: "x", tiers: TIERS });
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on non-2xx responses without leaking the key", async () => {
    const { router } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "sk-secret" } },
      fetch: () => Promise.resolve(jsonResponse({ error: "rate limited" }, { status: 429 })),
    });
    const result = await router.classify({ prompt: "x", tiers: TIERS });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("429");
    expect(result.error).not.toContain("sk-secret");
  });

  it("fails on malformed JSON", async () => {
    const { router } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "k" } },
      fetch: () => Promise.resolve(jsonResponse("{not json")),
    });
    const result = await router.classify({ prompt: "x", tiers: TIERS });
    expect(result.success).toBe(false);
  });

  it("keeps only the configured tiers' probabilities from the response", async () => {
    const base = validBody();
    const body = {
      ...base,
      answers: {
        difficulty: {
          ...base.answers.difficulty,
          probabilities: { ...base.answers.difficulty.probabilities, bogus: 0.5, other: 0.25 },
        },
      },
    };
    const { router } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "sk-test" } },
      fetch: () => Promise.resolve(jsonResponse(body)),
    });

    const result = await router.classify({ prompt: "Refactor the scheduler", tiers: TIERS });

    expect(result.success).toBe(true);
    expect(result.success && Object.keys(result.data.probabilities).sort()).toEqual([
      "easy",
      "extreme",
      "hard",
      "medium",
    ]);
  });

  it("fails when the choice is not one of the tier ids", async () => {
    const { router } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "k" } },
      fetch: () => Promise.resolve(jsonResponse(validBody("impossible"))),
    });
    const result = await router.classify({ prompt: "x", tiers: TIERS });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("impossible");
  });

  it("fails when the caller aborts the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { router } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "k" } },
      fetch: (_url, init) =>
        init.signal?.aborted
          ? Promise.reject(new DOMException("aborted", "AbortError"))
          : Promise.resolve(jsonResponse(validBody())),
    });
    const result = await router.classify({ prompt: "x", tiers: TIERS, signal: controller.signal });
    expect(result.success).toBe(false);
  });

  it("refuses to call the API when provider policy excludes typesafe", async () => {
    const { router, fetchMock } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "sk-test" } },
      policyService: {
        isEnforced: () => true,
        isModelAllowed: (provider) => provider !== "typesafe",
        getForcedBaseUrl: () => undefined,
      },
    });

    const result = await router.classify({ prompt: "Rename a variable", tiers: TIERS });

    expect(result).toEqual({ success: false, error: "Provider policy does not allow TypeSafe" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.getClassifierStatus()).toEqual({ apiKeySource: "config" });
  });

  it("refuses to call the API when policy lists typesafe but its model_access excludes the classifier", async () => {
    const { router, fetchMock } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "sk-test" } },
      policyService: {
        isEnforced: () => true,
        isModelAllowed: (provider, modelId) =>
          provider === TYPESAFE_PROVIDER_KEY && modelId !== AUTO_MODEL_ROUTING_CLASSIFIER_MODEL,
        getForcedBaseUrl: () => undefined,
      },
    });

    const result = await router.classify({ prompt: "Rename a variable", tiers: TIERS });

    expect(result).toEqual({ success: false, error: "Provider policy does not allow TypeSafe" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the policy-forced TypeSafe base URL when policy is enforced", async () => {
    const { router, fetchMock } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "sk-test" } },
      policyService: {
        isEnforced: () => true,
        isModelAllowed: () => true,
        getForcedBaseUrl: (provider) =>
          provider === TYPESAFE_PROVIDER_KEY ? "https://proxy.example.test/typesafe/" : undefined,
      },
    });

    const result = await router.classify({ prompt: "Rename a variable", tiers: TIERS });

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example.test/typesafe/systemone");
  });

  it("ignores a legacy custom chat provider stored under the typesafe id", async () => {
    const { router, fetchMock } = createRouter({
      providers: {
        [TYPESAFE_PROVIDER_KEY]: {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
          apiKey: "chat-provider-key",
        },
      },
    });

    expect(router.getClassifierStatus()).toEqual({ apiKeySource: "none" });
    const result = await router.classify({ prompt: "Rename a variable", tiers: TIERS });
    expect(result).toEqual({ success: false, error: "No TypeSafe API key configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires at least two tiers", async () => {
    const { router, fetchMock } = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "k" } },
    });
    const result = await router.classify({ prompt: "x", tiers: TIERS.slice(0, 1) });
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AutoModelRouter credential resolution", () => {
  it("prefers providers.jsonc apiKey, then apiKeyFile, then env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-model-routing-"));
    tempPaths.push(dir);
    const keyFile = path.join(dir, "typesafe.key");
    await fsp.writeFile(keyFile, "file-key\n");
    const env = { TYPESAFE_API_KEY: "env-key" };

    const withConfig = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKey: "config-key", apiKeyFile: keyFile } },
      env,
    });
    expect(withConfig.router.getClassifierStatus()).toEqual({ apiKeySource: "config" });

    const withFile = createRouter({
      providers: { [TYPESAFE_PROVIDER_KEY]: { apiKeyFile: keyFile } },
      env,
    });
    expect(withFile.router.getClassifierStatus()).toEqual({ apiKeySource: "file" });
    await withFile.router.classify({ prompt: "x", tiers: TIERS });
    const [, init] = withFile.fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer file-key");

    const withEnv = createRouter({ providers: null, env });
    expect(withEnv.router.getClassifierStatus()).toEqual({ apiKeySource: "env" });

    const withJevEnv = createRouter({ providers: {}, env: { JEV_API_KEY: "jev" } });
    expect(withJevEnv.router.getClassifierStatus()).toEqual({ apiKeySource: "env" });

    const withNothing = createRouter({ providers: {}, env: {} });
    expect(withNothing.router.getClassifierStatus()).toEqual({ apiKeySource: "none" });
  });
});
