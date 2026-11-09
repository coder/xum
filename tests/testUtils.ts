/**
 * Shared test utilities for integration tests
 *
 * This module handles:
 * - Loading .env configuration for tests
 * - Checking TEST_INTEGRATION flag
 * - Validating required API keys
 */

import { config } from "dotenv";
import * as path from "path";

// Load .env from project root on module import
// This runs once when the module is first imported
config({ path: path.resolve(__dirname, "../.env"), quiet: true });

/**
 * Default provider-backed integration coverage to Haiku so the suite runs faster
 * and cheaper unless a test explicitly pins a larger or provider-specific model.
 */
export const INTEGRATION_TEST_MODEL = "anthropic:claude-haiku-4-5";

/**
 * Check if integration tests should run
 * Tests are skipped if TEST_INTEGRATION env var is not set
 */
export function shouldRunIntegrationTests(): boolean {
  return process.env.TEST_INTEGRATION === "1";
}

/**
 * Validate required API keys are present
 * Throws if TEST_INTEGRATION is set but API keys are missing
 */
export function validateApiKeys(requiredKeys: string[]): void {
  if (!shouldRunIntegrationTests()) {
    return; // Skip validation if not running integration tests
  }

  const missing = requiredKeys.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Integration tests require the following environment variables: ${missing.join(", ")}\n` +
        `Please set them or unset TEST_INTEGRATION to skip these tests.`
    );
  }
}

/**
 * Get API key from environment or throw if missing (when TEST_INTEGRATION is set)
 */
export function getApiKey(keyName: string): string {
  if (!shouldRunIntegrationTests()) {
    throw new Error("getApiKey should only be called when TEST_INTEGRATION is set");
  }

  const value = process.env[keyName];
  if (!value) {
    throw new Error(`Environment variable ${keyName} is required for integration tests`);
  }

  return value;
}

/**
 * Placeholder for a provider key in tests that need a configured provider but never reach it
 * (the mock AI router, or a simulated stream).
 */
export const DUMMY_API_KEY = "test-key-for-ui-tests";

/**
 * A configured provider that cannot be reached: the dummy key plus a base URL on the loopback
 * discard port, where nothing listens. A feature that calls the provider anyway (title generation
 * on a creation send) is refused at once, and nothing leaves the host, so a run without keys never
 * sends the dummy key to a real API.
 */
export const DUMMY_PROVIDER_CONFIG = {
  apiKey: DUMMY_API_KEY,
  baseUrl: "http://127.0.0.1:9/v1",
};

/**
 * The environment's key for a provider when it has one (CI), else DUMMY_PROVIDER_CONFIG. Lets a
 * suite that only needs a configured provider run without keys, while a run with keys keeps using
 * them. A suite that calls the provider must keep `getApiKey`/`validateApiKeys`: the dummy cannot
 * answer.
 */
export function getProviderConfigOrDummy(keyName: string): { apiKey: string; baseUrl?: string } {
  const value = process.env[keyName];
  return value === undefined || value === "" ? DUMMY_PROVIDER_CONFIG : { apiKey: value };
}
