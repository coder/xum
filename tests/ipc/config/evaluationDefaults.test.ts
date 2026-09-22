import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.updateEvaluationDefaults", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
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
});
