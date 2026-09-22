import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AvailableModel } from "@/common/types/tools";
import { listAvailableModels } from "@/common/utils/ai/selectableModels";
import { ModelsListToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { log } from "@/node/services/log";

import {
  createModelsListTool,
  MODELS_LIST_FAILED_ERROR,
  MODELS_LIST_UNAVAILABLE_ERROR,
} from "./models_list";
import { parseTaskAiOverrides } from "./task";
import { createTestToolConfig, mockToolCallOptions, TestTempDir } from "./testHelpers";

// Strings that must never reach the model: everything credential- or endpoint-shaped
// that a ProvidersConfigMap can carry.
const SECRET_BASE_URL = "https://fixture.invalid/v1/SECRET-BASE-URL";
const SECRET_KEY_FILE = "/secrets/SECRET-KEY-FILE";
const SECRET_DISPLAY_NAME = "SECRET-DISPLAY-NAME";
const SECRET_DEPLOYMENT_URL = "https://coder.invalid/SECRET-DEPLOYMENT";
const FIXTURE_SECRETS = [
  SECRET_BASE_URL,
  SECRET_KEY_FILE,
  SECRET_DISPLAY_NAME,
  SECRET_DEPLOYMENT_URL,
];

const fixtureProvidersConfig: ProvidersConfigMap = {
  anthropic: {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    apiKeyFile: SECRET_KEY_FILE,
    baseUrl: SECRET_BASE_URL,
    baseUrlResolved: SECRET_BASE_URL,
  },
  fixture: {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    isCustom: true,
    providerType: "openai-compatible",
    displayName: SECRET_DISPLAY_NAME,
    baseUrl: SECRET_BASE_URL,
    models: ["fixture-echo"],
  },
  coder: {
    apiKeySet: false,
    isEnabled: true,
    isConfigured: true,
    deploymentUrl: SECRET_DEPLOYMENT_URL,
    models: ["openai/gpt-6-astra"],
  },
};

function fixtureCatalog(): AvailableModel[] {
  return listAvailableModels({
    providersConfig: fixtureProvidersConfig,
    hiddenModels: [KNOWN_MODELS.HAIKU.id],
    effectivePolicy: null,
    routePriority: ["direct"],
    routeOverrides: {},
  });
}

async function run(listAvailableModelsClosure?: () => AvailableModel[]): Promise<unknown> {
  using tempDir = new TestTempDir("test-models-list-tool");
  const tool = createModelsListTool({
    ...createTestToolConfig(tempDir.path),
    ...(listAvailableModelsClosure ? { listAvailableModels: listAvailableModelsClosure } : {}),
  });
  return await Promise.resolve(tool.execute!({}, mockToolCallOptions));
}

describe("models_list tool", () => {
  afterEach(() => mock.restore());

  it("reports unavailability when no catalog closure is configured", async () => {
    expect(await run()).toEqual({ success: false, error: MODELS_LIST_UNAVAILABLE_ERROR });
  });

  it("returns the closure result as a schema-valid success", async () => {
    const catalog = fixtureCatalog();
    expect(catalog.length).toBeGreaterThan(0);

    const result = await run(() => catalog);

    expect(result).toEqual({ success: true, models: catalog });
    expect(ModelsListToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("returns success with an empty list when nothing is selectable", async () => {
    expect(await run(() => [])).toEqual({ success: true, models: [] });
  });

  it("replaces a throwing closure's message with the fixed failure text and logs it", async () => {
    const logError = spyOn(log, "error").mockImplementation(() => undefined);
    const secret = "SECRET-EXCEPTION-TEXT";

    const result = await run(() => {
      throw new Error(`catalog exploded: ${secret} ${SECRET_BASE_URL}`);
    });

    expect(result).toEqual({ success: false, error: MODELS_LIST_FAILED_ERROR });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("advertises only inputs the task tool accepts unchanged", () => {
    const catalog = fixtureCatalog();
    // The fixture must exercise built-ins with aliases, a custom model and an explicit gateway ID.
    const catalogIds = catalog.map((entry) => entry.model);
    for (const id of [KNOWN_MODELS.SONNET.id, "fixture:fixture-echo", "coder:openai/gpt-6-astra"]) {
      expect(catalogIds).toContain(id);
    }

    for (const entry of catalog) {
      for (const thinking of entry.thinkingLevels) {
        expect(parseTaskAiOverrides({ model: entry.model, thinking })).toEqual({
          modelString: entry.model,
          thinkingLevel: thinking,
        });
      }
      for (const alias of entry.aliases) {
        expect(parseTaskAiOverrides({ model: alias }).modelString).toBe(entry.model);
      }
    }
  });

  it("never serializes credentials or provider configuration", async () => {
    const serialized = JSON.stringify(await run(fixtureCatalog));

    for (const secret of FIXTURE_SECRETS) {
      expect(serialized).not.toContain(secret);
    }
  });
});
