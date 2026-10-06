import { afterAll, describe, expect, test } from "bun:test";
import { AiModeError, resolveAiMode } from "./aiMode";

// A loopback upstream: the path names the status the probe receives. Like a Responses-only
// OpenAI gateway, it has no chat completions endpoint.
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    const status = Number(pathname.split("/")[1]);
    return new Response("{}", { status });
  },
});
afterAll(() => upstream.stop(true));

const at = (status: number) => `http://127.0.0.1:${upstream.port}/${status}`;
async function expectAiModeError(result: Promise<unknown>): Promise<void> {
  const error = await result.then(
    () => null,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(AiModeError);
}

// Port 9 (discard) refuses connections on loopback.
const offline = "http://127.0.0.1:9/v1";

describe("resolveAiMode", () => {
  test("auto: real when the probe succeeds, mock without a key or with an unavailable upstream", async () => {
    const real = await resolveAiMode({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: at(200) });
    expect(real).toMatchObject({ mode: "real", provider: "anthropic", baseUrl: at(200) });

    expect((await resolveAiMode({})).mode).toBe("mock");
    for (const baseUrl of [at(503), at(429), offline]) {
      const mode = await resolveAiMode({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: baseUrl });
      expect(mode.mode).toBe("mock");
    }
  });

  test("auto never hides a rejected key or bad model behind the mock", async () => {
    for (const status of [401, 403, 404, 400]) {
      const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: at(status) };
      await expectAiModeError(resolveAiMode(env));
    }
  });

  test("real fails instead of falling back; mock never probes", async () => {
    await expectAiModeError(resolveAiMode({ BUGBASH_AI: "real" }));
    const env = { BUGBASH_AI: "real", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: offline };
    await expectAiModeError(resolveAiMode(env));
    // An unreachable upstream with a key: mock mode must not even try it.
    const mock = await resolveAiMode({
      BUGBASH_AI: "mock",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: offline,
    });
    expect(mock.mode).toBe("mock");
  });

  test("a resolved mode is reused without a second probe", async () => {
    const env = {
      BUGBASH_AI_RESOLVED: "real",
      BUGBASH_AI_REASON: "probed by run.ts",
      ANTHROPIC_API_KEY: "k",
      // Would fail a probe: proves none runs.
      ANTHROPIC_BASE_URL: offline,
    };
    expect(await resolveAiMode(env)).toMatchObject({ mode: "real", reason: "probed by run.ts" });
    await expectAiModeError(resolveAiMode({ BUGBASH_AI_RESOLVED: "real" }));
  });

  // OpenAI app models probe the Responses API, the endpoint the app itself calls.
  test("the app model picks the provider and its key", async () => {
    const env = {
      BUGBASH_APP_MODEL: "openai:gpt-test",
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: at(200),
    };
    expect(await resolveAiMode(env)).toMatchObject({
      mode: "real",
      provider: "openai",
      model: "openai:gpt-test",
    });
    // An Anthropic key does not serve an OpenAI app model.
    expect(
      (await resolveAiMode({ BUGBASH_APP_MODEL: "openai:gpt-test", ANTHROPIC_API_KEY: "k" })).mode
    ).toBe("mock");
    await expectAiModeError(resolveAiMode({ BUGBASH_APP_MODEL: "gemini:x" }));
  });
});
