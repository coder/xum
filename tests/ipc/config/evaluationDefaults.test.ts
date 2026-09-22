import { ProvidersConfigStore, type ProvidersConfig } from "@/node/config";
import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

// Credential resolution reads provider env vars; the host may export real keys.
const PROVIDER_ENV_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
] as const;

describe("config.updateEvaluationDefaults", () => {
  let env: TestEnvironment;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of PROVIDER_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("persists a trimmed evaluation model and exposes it through getConfig", async () => {
    await env.orpc.config.updateEvaluationDefaults({ model: "  anthropic:claude-haiku-4-5  " });

    expect(env.config.loadConfigOrDefault().evaluationDefaults).toEqual({
      model: "anthropic:claude-haiku-4-5",
    });
    expect((await env.orpc.config.getConfig()).evaluationDefaults).toEqual({
      model: "anthropic:claude-haiku-4-5",
    });
  });

  it("clears the default for blank or null input instead of leaving an empty block", async () => {
    await env.orpc.config.updateEvaluationDefaults({ model: "openai:gpt-5-mini" });
    await env.orpc.config.updateEvaluationDefaults({ model: "   " });

    expect(env.config.loadConfigOrDefault().evaluationDefaults).toBeUndefined();
    expect((await env.orpc.config.getConfig()).evaluationDefaults).toBeUndefined();

    await env.orpc.config.updateEvaluationDefaults({ model: "openai:gpt-5-mini" });
    await env.orpc.config.updateEvaluationDefaults({ model: null });

    expect(env.config.loadConfigOrDefault().evaluationDefaults).toBeUndefined();
  });

  // The Settings card's hint is the resolver's own verdict: the same providers.jsonc
  // that would reject a workflow step rejects it here, with no network I/O.
  it("checkEvaluationModel reports the resolver's typed verdict for the current providers config", async () => {
    const store = new ProvidersConfigStore(env.config.rootDir);
    const shadowed: ProvidersConfig = {
      openai: { providerType: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", apiKey: "x" },
    };
    store.saveProvidersConfig(shadowed);
    expect(await env.orpc.config.checkEvaluationModel({ model: "openai:gpt-5" })).toEqual({
      ok: false,
      reason: "unsupported-route",
      routeKind: "custom",
    });

    store.saveProvidersConfig({ anthropic: { apiKey: "sk-anthropic" } });
    expect(await env.orpc.config.checkEvaluationModel({ model: "openai:gpt-5" })).toEqual({
      ok: false,
      reason: "unauthorized",
      providerName: "openai",
    });
    expect(
      await env.orpc.config.checkEvaluationModel({ model: "anthropic:claude-haiku-4-5" })
    ).toEqual({ ok: true });
    expect(await env.orpc.config.checkEvaluationModel({ model: "xai:grok-4-1-fast" })).toEqual({
      ok: false,
      reason: "unsupported-provider",
      providerName: "xai",
    });
  });
});
