import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Config, ProvidersConfigStore } from "@/node/config";
import { AIService } from "./aiService";
import { createEvaluationModel } from "./evaluationModelFactory";
import { HistoryService } from "./historyService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { DisposableTempDir } from "./tempDir";
import { generateWorkspaceStatus } from "./workspaceStatusGenerator";
import { generateWorkspaceIdentity } from "./workspaceTitleGenerator";

// #5604: with XUM_MOCK_AI=1 the main chat stream is mocked, but background features
// (title, status, branch summary, memory, compaction summary, refine, auto routing)
// still created real models and sent requests to the configured provider. Every
// provider here points at a loopback server that records each request it receives.

const MODEL = "anthropic:claude-haiku-4-5";
const MOCK_ENV_KEYS = ["XUM_MOCK_AI", "MUX_MOCK_AI"] as const;

interface Loopback {
  requests: string[];
  baseUrl: string;
  close: () => Promise<void>;
}

async function startLoopbackProvider(): Promise<Loopback> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
    req.resume();
    // A non-retryable 400 keeps the control case fast (no SDK retry backoff).
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "loopback" },
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function createService(root: string, baseUrl: string) {
  const config = new Config(root);
  const providersConfigStore = new ProvidersConfigStore(config.rootDir);
  providersConfigStore.saveProvidersConfig({
    anthropic: { apiKey: "test-anthropic-key", baseUrl },
    openai: { apiKey: "test-openai-key", baseUrl },
  });
  const providerService = new ProviderService(config, providersConfigStore);
  // AIService reads XUM_MOCK_AI in its constructor, like the server does at startup.
  const service = new AIService(
    config,
    new HistoryService(config),
    new InitStateManager(config),
    providerService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    providersConfigStore
  );
  return { service, providersConfigStore };
}

describe("XUM_MOCK_AI model gate", () => {
  const savedEnv = new Map<string, string | undefined>();
  let tempDir: DisposableTempDir;
  let loopback: Loopback;

  beforeEach(async () => {
    for (const key of MOCK_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    tempDir = new DisposableTempDir("mock-ai-model-gate");
    loopback = await startLoopbackProvider();
  });

  afterEach(async () => {
    await loopback.close();
    tempDir[Symbol.dispose]();
    for (const key of MOCK_ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("control: without mock mode the same callers create models and reach the provider", async () => {
    const { service, providersConfigStore } = createService(tempDir.path, loopback.baseUrl);

    const result = await generateWorkspaceIdentity(
      "Fix the login bug",
      [{ model: MODEL }],
      service
    );
    expect(result.success).toBe(false);
    expect(loopback.requests.length).toBeGreaterThan(0);

    // The entry points below succeed here, so their refusals in mock mode come from the gate.
    expect((await service.createModel(MODEL)).success).toBe(true);
    expect((await service.createModelWithPinnedMetadata(MODEL)).success).toBe(true);
    expect((await service.createModelWithPinnedOptions(MODEL)).success).toBe(true);
    expect((await service.createEvaluationModel(MODEL)).success).toBe(true);
    const routerModel = await Effect.runPromise(
      createEvaluationModel(MODEL, { providersConfigStore })
    );
    expect(routerModel.success).toBe(true);
  });

  it("with XUM_MOCK_AI=1 no background model caller reaches the provider", async () => {
    process.env.XUM_MOCK_AI = "1";
    const { service, providersConfigStore } = createService(tempDir.path, loopback.baseUrl);

    // Background generators, end to end.
    const title = await generateWorkspaceIdentity("Fix the login bug", [{ model: MODEL }], service);
    expect(title.success).toBe(false);
    const status = await generateWorkspaceStatus("user: fix the login bug", [MODEL], service);
    expect(status.success).toBe(false);
    if (!status.success) expect(status.error.reachedProvider).toBe(false);

    // Every model entry point those generators and the other background callers use
    // (branch summary, memory consolidation and harvest, continuous compaction
    // summary, refine, workflow evaluate, auto model routing).
    expect((await service.createModel(MODEL)).success).toBe(false);
    expect((await service.createModelWithPinnedMetadata(MODEL)).success).toBe(false);
    expect((await service.createModelWithPinnedOptions(MODEL)).success).toBe(false);
    expect((await service.createEvaluationModel(MODEL)).success).toBe(false);
    const routerModel = await Effect.runPromise(
      createEvaluationModel(MODEL, { providersConfigStore })
    );
    expect(routerModel.success).toBe(false);

    expect(loopback.requests).toEqual([]);
  });
});
