import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.updateModelFallbacks", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("persists sanitized chains through update → load → getConfig", async () => {
    await env.orpc.config.updateModelFallbacks({
      modelFallbacks: {
        // Gateway-prefixed key canonicalizes onto the bare provider model.
        "openrouter:anthropic/claude-opus-4-6": {
          models: [
            "anthropic:claude-opus-4-6", // self-fallback after canonicalization: dropped
            "openrouter:openai/gpt-5.5", // canonicalizes to openai:gpt-5.5
            "openai:gpt-5.5", // duplicate of the canonicalized entry above: dropped
            "google:gemini-3-pro",
            "openai:gpt-5.5-codex",
            "xai:grok-5", // beyond the 3-model cap: dropped
          ],
        },
      },
    });

    const expected = {
      "anthropic:claude-opus-4-6": {
        models: ["openai:gpt-5.5", "google:gemini-3-pro", "openai:gpt-5.5-codex"],
      },
    };

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.modelFallbacks).toEqual(expected);

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.modelFallbacks).toEqual(expected);
  });

  it("drops the map entirely when every chain sanitizes to empty", async () => {
    await env.orpc.config.updateModelFallbacks({
      modelFallbacks: {
        // Self-only chain sanitizes to an empty chain, which is removed.
        "anthropic:claude-opus-4-6": { models: ["anthropic:claude-opus-4-6"] },
      },
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.modelFallbacks).toBeUndefined();

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.modelFallbacks).toBeUndefined();
  });
});
