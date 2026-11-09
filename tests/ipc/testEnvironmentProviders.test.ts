/**
 * Provider seeding of createTestEnvironment (the key-free UI runs).
 *
 * A run without provider keys needs a configured provider for the UI, but no test may send a
 * request, or the dummy key, to a real API. Nothing else in the repo breaks when the unreachable
 * base URL is dropped, or when the seed also runs next to real keys (CI), so these tests pin both.
 */

import {
  AZURE_OPENAI_ENV_VARS,
  BEDROCK_AUTH_ENV_VARS,
  PROVIDER_ENV_VARS,
} from "../../src/node/utils/providerRequirements";
import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "./setup";
import { getProviderConfigOrDummy, shouldRunIntegrationTests } from "../testUtils";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Every environment variable that can configure a provider. */
const PROVIDER_ENV_NAMES = [
  ...new Set([
    ...Object.values(PROVIDER_ENV_VARS).flatMap((vars) => Object.values(vars).flat()),
    ...Object.values(AZURE_OPENAI_ENV_VARS),
    ...Object.values(BEDROCK_AUTH_ENV_VARS),
  ]),
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

describeIntegration("createTestEnvironment provider seeding", () => {
  let saved: Record<string, string | undefined>;
  let env: TestEnvironment | undefined;

  beforeEach(() => {
    saved = {};
    for (const name of PROVIDER_ENV_NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
      env = undefined;
    }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("without keys, Anthropic and OpenAI are configured on an unreachable loopback URL", async () => {
    env = await createTestEnvironment();
    const providers = env.services.providerService.getConfig();

    for (const name of ["anthropic", "openai"] as const) {
      expect(providers[name]?.isConfigured).toBe(true);
      expect(providers[name]?.apiKeySource).toBe("config");
      const baseUrl = providers[name]?.baseUrl;
      if (baseUrl === undefined) throw new Error(`${name} has no base URL`);
      expect(LOOPBACK_HOSTS.has(new URL(baseUrl).hostname)).toBe(true);
    }
  }, 60_000);

  test("with a key in the environment, nothing is seeded and the key stays in use", async () => {
    process.env.OPENAI_API_KEY = "env-key-for-the-seeding-test";
    env = await createTestEnvironment();
    const providers = env.services.providerService.getConfig();

    expect(providers.openai?.isConfigured).toBe(true);
    expect(providers.openai?.apiKeySource).toBe("env");
    expect(providers.openai?.apiKeySet).toBe(false);
    expect(providers.openai?.baseUrl).toBeUndefined();
    // A provider the environment leaves out stays unconfigured: tests that delete one key
    // expect an api_key_not_found error from it while another provider is configured.
    expect(providers.anthropic?.isConfigured).toBe(false);
  }, 60_000);

  test("seedDummyProviders: false leaves a keyless environment without providers", async () => {
    env = await createTestEnvironment({ seedDummyProviders: false });

    expect(
      Object.values(env.services.providerService.getConfig()).some(
        (provider) => provider?.isConfigured
      )
    ).toBe(false);
  }, 60_000);

  test("getProviderConfigOrDummy uses the environment key when set, else the loopback dummy", () => {
    process.env.ANTHROPIC_API_KEY = "env-key-for-the-helper-test";
    expect(getProviderConfigOrDummy("ANTHROPIC_API_KEY")).toEqual({
      apiKey: "env-key-for-the-helper-test",
    });

    process.env.ANTHROPIC_API_KEY = "";
    const dummy = getProviderConfigOrDummy("ANTHROPIC_API_KEY");
    expect(LOOPBACK_HOSTS.has(new URL(dummy.baseUrl ?? "http://invalid").hostname)).toBe(true);
    expect(dummy.apiKey).not.toBe("");
  });
});
