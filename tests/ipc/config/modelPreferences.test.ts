import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.updateModelPreferences", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("persists model preferences", async () => {
    await env.orpc.config.updateModelPreferences({
      defaultModel: "openai:gpt-4o",
      hiddenModels: ["openai:gpt-4o-mini"],
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.defaultModel).toBe("openai:gpt-4o");
    expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.defaultModel).toBe("openai:gpt-4o");
    expect(cfg.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
  });

  it("preserves explicit gateway-scoped defaultModel", async () => {
    await env.orpc.config.updateModelPreferences({
      defaultModel: "openrouter:openai/gpt-5",
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.defaultModel).toBe("openrouter:openai/gpt-5");

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.defaultModel).toBe("openrouter:openai/gpt-5");
  });

  it("preserves explicit gateway-scoped hiddenModels", async () => {
    await env.orpc.config.updateModelPreferences({
      hiddenModels: ["openrouter:openai/gpt-5", "openrouter:anthropic/claude-sonnet-4-20250514"],
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.hiddenModels).toEqual([
      "openrouter:openai/gpt-5",
      "openrouter:anthropic/claude-sonnet-4-20250514",
    ]);

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.hiddenModels).toEqual([
      "openrouter:openai/gpt-5",
      "openrouter:anthropic/claude-sonnet-4-20250514",
    ]);
  });
});
