import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { DevToolsStep } from "@/common/types/devtools";
import { Config } from "@/node/config";
import {
  DEVTOOLS_RUN_METADATA_ID_HEADER,
  DEVTOOLS_STEP_ID_HEADER,
  captureAndStripDevToolsHeader,
  consumeRedactedRequestBody,
} from "@/node/services/devToolsHeaderCapture";
import { createDevToolsMiddleware, extractUsage } from "@/node/services/devToolsMiddleware";
import { DevToolsService } from "@/node/services/devToolsService";
import * as promptPrefixFingerprint from "@/node/services/promptPrefixFingerprint";

function createTestConfig(opts: { sessionsDir: string; enabled?: boolean }): Config {
  const config = new Config(path.dirname(opts.sessionsDir));
  spyOn(config, "getLlmDebugLogsEnabled").mockImplementation(() => opts.enabled ?? true);
  return config;
}

function createMockModel(overrides: Partial<LanguageModelV4> = {}): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: () =>
      Promise.reject(new Error("createMockModel.doGenerate should not be called in tests")),
    doStream: () =>
      Promise.reject(new Error("createMockModel.doStream should not be called in tests")),
    ...overrides,
  };
}

function createMockParams(): LanguageModelV4CallOptions {
  return {
    prompt: [
      {
        role: "system",
        content: "Be concise",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hello middleware" }],
      },
    ],
    maxOutputTokens: 128,
    temperature: 0.7,
    toolChoice: { type: "auto" },
    providerOptions: {
      test: {
        debug: true,
      },
    },
  };
}

function createUsage(inputTokens: number, outputTokens: number): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: 0,
    },
  };
}

function createGenerateResult(
  overrides: Partial<LanguageModelV4GenerateResult> = {}
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text: "Hello" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: createUsage(10, 5),
    warnings: [],
    request: { body: "test-req" },
    response: { body: "test-resp" },
    ...overrides,
  };
}

function getWrapGenerate(middleware: LanguageModelV4Middleware) {
  if (!middleware.wrapGenerate) {
    throw new Error("Expected wrapGenerate to be defined");
  }

  return middleware.wrapGenerate;
}

function getWrapStream(middleware: LanguageModelV4Middleware) {
  if (!middleware.wrapStream) {
    throw new Error("Expected wrapStream to be defined");
  }

  return middleware.wrapStream;
}

async function collectStream(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const reader = stream.getReader();
  const chunks: LanguageModelV4StreamPart[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
  }

  return chunks;
}

const SECRET_API_KEY = "sk-live-body-secret-123";
const SECRET_ENCRYPTED_REASONING = "gAAAAABencrypted-reasoning-blob-xyz";
const SECRET_SIGNATURE = "EqQBCkYIBRgCKkAthinking-signature";

// Provider-shaped body as the SDK serializes it, with a credential and encrypted reasoning.
const FAILED_REQUEST_BODY = JSON.stringify({
  model: "gpt-test",
  api_key: SECRET_API_KEY,
  max_output_tokens: 128,
  input: [
    { type: "reasoning", id: "rs_1", encrypted_content: SECRET_ENCRYPTED_REASONING, summary: [] },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "plan", signature: SECRET_SIGNATURE }],
    },
    { role: "user", content: [{ type: "input_text", text: "Hello middleware" }] },
  ],
});

/** Mimics Xum's fetch wrapper: the request goes out, then the provider rejects it (e.g. HTTP 400). */
function rejectAfterFetch(params: LanguageModelV4CallOptions, failure: Error): Promise<never> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    if (typeof value === "string") headers.set(key, value);
  }
  captureAndStripDevToolsHeader(headers, FAILED_REQUEST_BODY);
  return Promise.reject(failure);
}

async function expectRedactedFailedRequest(service: DevToolsService): Promise<void> {
  const runs = await service.getRuns("ws-1");
  const step = (await service.getRunWithSteps("ws-1", runs[0].id))?.steps[0];
  expect(step?.error).toBe("400 invalid_encrypted_content");
  expect(step?.rawRequest).toMatchObject({
    model: "gpt-test",
    api_key: "[REDACTED]",
    max_output_tokens: 128,
    input: [
      {
        type: "reasoning",
        encrypted_content: `[REDACTED ${SECRET_ENCRYPTED_REASONING.length} chars]`,
      },
      { content: [{ thinking: "plan", signature: `[REDACTED ${SECRET_SIGNATURE.length} chars]` }] },
      { content: [{ text: "Hello middleware" }] },
    ],
  });
  const persisted = JSON.stringify(step);
  for (const secret of [SECRET_API_KEY, SECRET_ENCRYPTED_REASONING, SECRET_SIGNATURE]) {
    expect(persisted).not.toContain(secret);
  }
}

describe("extractUsage", () => {
  it("preserves object-style token breakdowns", () => {
    const usage = extractUsage({
      inputTokens: {
        total: 8844,
        noCache: 8844,
        cacheRead: 0,
      },
      outputTokens: {
        total: 294,
        text: 26,
        reasoning: 268,
      },
    });

    expect(usage).toEqual({
      inputTokens: {
        total: 8844,
        noCache: 8844,
        cacheRead: 0,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: 294,
        text: 26,
        reasoning: 268,
      },
      totalTokens: 9138,
    });
  });

  it("preserves raw provider usage", () => {
    const raw = {
      thoughtsTokenCount: 268,
      promptTokenCount: 8844,
      candidatesTokenCount: 26,
      totalTokenCount: 9138,
    };

    const usage = extractUsage({ raw });

    expect(usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      raw,
    });
  });

  it("supports legacy numeric token fields", () => {
    expect(
      extractUsage({
        inputTokens: 120,
        outputTokens: 34,
      })
    ).toEqual({
      inputTokens: 120,
      outputTokens: 34,
      totalTokens: 154,
    });

    expect(
      extractUsage({
        promptTokens: 77,
        completionTokens: 9,
      })
    ).toEqual({
      inputTokens: 77,
      outputTokens: 9,
      totalTokens: 86,
    });
  });
});

describe("createDevToolsMiddleware", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devtools-middleware-test-"));
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not finalize existing in-progress steps when middleware is created", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

    await service.createRun("ws-1", {
      id: "run-1",
      workspaceId: "ws-1",
      startedAt: "2025-06-01T00:00:00Z",
    });
    await service.createStep("ws-1", {
      id: "step-1",
      runId: "run-1",
      stepNumber: 1,
      type: "generate",
      modelId: "test-model",
      provider: "test-provider",
      startedAt: "2025-06-01T00:00:00Z",
      durationMs: null,
      input: null,
      output: null,
      usage: null,
      error: null,
      rawRequest: null,
      requestHeaders: null,
      responseHeaders: null,
      rawResponse: null,
      rawChunks: null,
    });

    createDevToolsMiddleware("ws-1", service, "test:model");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
    expect(runWithSteps).not.toBeNull();

    const step = runWithSteps?.steps[0];
    expect(step?.durationMs).toBeNull();
    expect(step?.error).toBeNull();
  });

  describe("wrapGenerate", () => {
    it("records a run + step for successful generate calls", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapGenerate = getWrapGenerate(middleware);
      const model = createMockModel();
      const params = createMockParams();
      const expectedResult = createGenerateResult({
        response: {
          body: "test-resp",
          headers: {
            "content-type": "application/json",
            "x-request-id": "abc",
          },
        },
      });

      const result = await wrapGenerate({
        doGenerate: () => Promise.resolve(expectedResult),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params,
        model,
      });

      expect(result).toBe(expectedResult);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        workspaceId: "ws-1",
        stepCount: 1,
      });

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step).toBeDefined();
      expect(step?.type).toBe("generate");
      expect(step?.modelId).toBe("test-model");
      expect(step?.provider).toBe("test-provider");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.durationMs).toBeGreaterThanOrEqual(0);
      expect(step?.input).toMatchObject({
        maxOutputTokens: 128,
        temperature: 0.7,
        toolChoice: { type: "auto" },
      });
      expect(step?.output).toEqual({
        content: expectedResult.content,
        finishReason: "stop",
        toolCalls: undefined,
      });
      expect(step?.usage).toEqual({
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 5,
          text: 5,
          reasoning: 0,
        },
        totalTokens: 15,
      });
      expect(step?.rawRequest).toEqual(expectedResult.request?.body);
      expect(step?.requestHeaders).toBeNull();
      expect(step?.responseHeaders).toEqual(expectedResult.response?.headers);
      expect(step?.rawResponse).toEqual(expectedResult.response?.body);
      expect(step?.rawChunks).toBeNull();
      expect(step?.error).toBeNull();
    });

    it("records error when doGenerate throws and rethrows", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapGenerate = getWrapGenerate(middleware);
      const failure = new Error("generate failed");

      let thrownError: unknown;
      try {
        await wrapGenerate({
          doGenerate: () => Promise.reject(failure),
          doStream: () => Promise.reject(new Error("doStream should not be called")),
          params: createMockParams(),
          model: createMockModel(),
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(failure);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("generate failed");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records the redacted request body when the provider rejects before responding", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapGenerate = getWrapGenerate(middleware);
      const params = createMockParams();
      const failure = new Error("400 invalid_encrypted_content");

      let thrownError: unknown;
      try {
        await wrapGenerate({
          doGenerate: () => rejectAfterFetch(params, failure),
          doStream: () => Promise.reject(new Error("doStream should not be called")),
          params,
          model: createMockModel(),
        });
      } catch (error) {
        thrownError = error;
      }
      expect(thrownError).toBe(failure);

      await expectRedactedFailedRequest(service);
    });

    it("passes through result unmodified", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapGenerate = getWrapGenerate(middleware);
      const expectedResult = createGenerateResult();

      const result = await wrapGenerate({
        doGenerate: () => Promise.resolve(expectedResult),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      expect(result).toBe(expectedResult);
    });

    it("is a no-op when service is disabled", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: false }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapGenerate = getWrapGenerate(middleware);
      const expectedResult = createGenerateResult();
      let callCount = 0;

      const result = await wrapGenerate({
        doGenerate: () => {
          callCount += 1;
          return Promise.resolve(expectedResult);
        },
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      expect(callCount).toBe(1);
      expect(result).toBe(expectedResult);
      expect(await service.getRuns("ws-1")).toEqual([]);
    });
  });

  describe("wrapStream", () => {
    it("records streamed output plus raw provider chunks on flush", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);

      const rawChunkValue = {
        event: "response.output_text.delta",
        data: "world",
      };
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello " },
        { type: "raw", rawValue: rawChunkValue },
        { type: "text-delta", id: "t1", delta: "world" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: createUsage(5, 2),
        },
      ];
      const expectedForwardedChunks = chunks.filter((chunk) => chunk.type !== "raw");

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () =>
          Promise.resolve({
            stream,
            request: { body: "stream-req" },
            response: { headers: { "content-type": "text/event-stream" } },
          }),
        params: createMockParams(),
        model: createMockModel(),
      });

      const observedChunks = await collectStream(result.stream);
      expect(observedChunks).toEqual(expectedForwardedChunks);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);

      const step = runWithSteps?.steps[0];
      expect(step?.type).toBe("stream");
      expect(step?.output).toEqual({
        textParts: [{ id: "t1", text: "Hello world" }],
        reasoningParts: [],
        toolCalls: [],
        finishReason: "stop",
      });
      expect(step?.usage).toEqual({
        inputTokens: {
          total: 5,
          noCache: 5,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 2,
          text: 2,
          reasoning: 0,
        },
        totalTokens: 7,
      });
      expect(step?.rawRequest).toEqual("stream-req");
      expect(step?.requestHeaders).toBeNull();
      expect(step?.responseHeaders).toEqual({ "content-type": "text/event-stream" });
      expect(step?.rawResponse).toEqual(expectedForwardedChunks);
      expect(step?.rawChunks).toEqual([rawChunkValue]);
      expect(step?.error).toBeNull();
    });

    it("does not forward raw chunks when includeRawChunks was not requested", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);

      const rawValue = { event: "response.output_text.delta", data: "hidden" };
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "raw", rawValue },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: createUsage(1, 1),
        },
      ];

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const params = createMockParams();
      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params,
        model: createMockModel(),
      });

      const observedChunks = await collectStream(result.stream);
      expect(observedChunks).toEqual([chunks[1]]);

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]?.rawChunks).toEqual([rawValue]);
    });

    it("forwards raw chunks when includeRawChunks was explicitly requested", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);

      const rawValue = { event: "response.output_text.delta", data: "visible" };
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "raw", rawValue },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: createUsage(1, 1),
        },
      ];

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const params = {
        ...createMockParams(),
        includeRawChunks: true,
      };

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params,
        model: createMockModel(),
      });

      const observedChunks = await collectStream(result.stream);
      expect(observedChunks).toEqual(chunks);

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]?.rawChunks).toEqual([rawValue]);
    });

    it("records tool calls from stream chunks", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);

      const chunks: LanguageModelV4StreamPart[] = [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "weather",
          input: '{"city":"SF"}',
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: createUsage(8, 3),
        },
      ];

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params: createMockParams(),
        model: createMockModel(),
      });

      await collectStream(result.stream);

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.output).toMatchObject({
        toolCalls: [
          {
            toolCallId: "call-1",
            toolName: "weather",
            args: '{"city":"SF"}',
          },
        ],
        finishReason: "tool-calls",
      });
    });

    it("records the redacted request body when the stream is rejected before it starts", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);
      const params = createMockParams();
      const failure = new Error("400 invalid_encrypted_content");

      let thrownError: unknown;
      try {
        await wrapStream({
          doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
          doStream: () => rejectAfterFetch(params, failure),
          params,
          model: createMockModel(),
        });
      } catch (error) {
        thrownError = error;
      }
      expect(thrownError).toBe(failure);

      await expectRedactedFailedRequest(service);
    });

    it("drops the captured body on abort even when the fetch never settles", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);
      const controller = new AbortController();
      const params = { ...createMockParams(), abortSignal: controller.signal };
      let captured!: () => void;
      const fetched = new Promise<void>((resolve) => {
        captured = resolve;
      });

      void wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(params.headers ?? {})) {
            if (typeof value === "string") headers.set(key, value);
          }
          captureAndStripDevToolsHeader(headers, FAILED_REQUEST_BODY);
          captured();
          // A custom fetch that ignores the abort signal and never settles.
          return new Promise<never>(() => undefined);
        },
        params,
        model: createMockModel(),
      });
      await fetched;
      const stepId = params.headers?.[DEVTOOLS_STEP_ID_HEADER];
      if (typeof stepId !== "string") throw new Error("Expected an injected step id");

      controller.abort();

      expect(consumeRedactedRequestBody(stepId)).toBeNull();
    });

    it("keeps no body when the provider reaches fetch only after the abort", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);
      const controller = new AbortController();
      controller.abort();
      const params = { ...createMockParams(), abortSignal: controller.signal };
      let captured!: () => void;
      const fetched = new Promise<void>((resolve) => {
        captured = resolve;
      });

      void wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: async () => {
          // An asynchronous provider that only reaches its (abort-ignoring) fetch now.
          await Promise.resolve();
          const headers = new Headers();
          for (const [key, value] of Object.entries(params.headers ?? {})) {
            if (typeof value === "string") headers.set(key, value);
          }
          captureAndStripDevToolsHeader(headers, FAILED_REQUEST_BODY);
          captured();
          return new Promise<never>(() => undefined);
        },
        params,
        model: createMockModel(),
      });
      await fetched;
      const stepId = params.headers?.[DEVTOOLS_STEP_ID_HEADER];
      if (typeof stepId !== "string") throw new Error("Expected an injected step id");

      expect(consumeRedactedRequestBody(stepId)).toBeNull();
    });

    it("records 'Request aborted' on stream cancel", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);

      const neverEndingStream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream: neverEndingStream }),
        params: createMockParams(),
        model: createMockModel(),
      });

      const reader = result.stream.getReader();
      await reader.read();
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("Request aborted");
      expect(step?.durationMs).not.toBeNull();
      expect(step?.output).toEqual({
        textParts: [{ id: "t1", text: "" }],
        reasoningParts: [],
        toolCalls: [],
        finishReason: undefined,
      });
    });

    it("finalizes step as aborted when AbortSignal fires during stream", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);
      const abortController = new AbortController();

      const neverEndingStream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream: neverEndingStream }),
        params: {
          ...createMockParams(),
          abortSignal: abortController.signal,
        },
        model: createMockModel(),
      });

      const reader = result.stream.getReader();
      await reader.read();

      abortController.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBe("Request aborted");
      expect(step?.durationMs).not.toBeNull();

      await reader.cancel();
    });

    it("leaves no closed-step mark behind when a started stream is aborted", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);
      const abortController = new AbortController();
      const params = { ...createMockParams(), abortSignal: abortController.signal };

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () =>
          Promise.resolve({ stream: new ReadableStream<LanguageModelV4StreamPart>() }),
        params,
        model: createMockModel(),
      });
      const stepId = params.headers?.[DEVTOOLS_STEP_ID_HEADER];
      if (typeof stepId !== "string") throw new Error("Expected an injected step id");

      abortController.abort();

      // The fetch already settled, so the abort must not mark the id closed for good: a
      // capture under that id is accepted again (a leaked mark would drop it).
      captureAndStripDevToolsHeader(new Headers({ [DEVTOOLS_STEP_ID_HEADER]: stepId }), "{}");
      expect(consumeRedactedRequestBody(stepId)).toEqual({});
      await result.stream.cancel();
    });

    it("does not double-finalize when abort fires after normal completion", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapStream = getWrapStream(middleware);
      const abortController = new AbortController();

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: createUsage(1, 1),
          });
          controller.close();
        },
      });

      const result = await wrapStream({
        doGenerate: () => Promise.reject(new Error("doGenerate should not be called")),
        doStream: () => Promise.resolve({ stream }),
        params: {
          ...createMockParams(),
          abortSignal: abortController.signal,
        },
        model: createMockModel(),
      });

      await collectStream(result.stream);
      abortController.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await service.getRuns("ws-1");
      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();

      const step = runWithSteps?.steps[0];
      expect(step?.error).toBeNull();
    });

    it("multiple steps in one middleware instance share the same runId", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const middleware = createDevToolsMiddleware("ws-1", service, "test:model");
      const wrapGenerate = getWrapGenerate(middleware);

      await wrapGenerate({
        doGenerate: () => Promise.resolve(createGenerateResult({ response: { body: "first" } })),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      await wrapGenerate({
        doGenerate: () => Promise.resolve(createGenerateResult({ response: { body: "second" } })),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params: createMockParams(),
        model: createMockModel(),
      });

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.stepCount).toBe(2);

      const runWithSteps = await service.getRunWithSteps("ws-1", runs[0].id);
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(2);

      const [firstStep, secondStep] = runWithSteps?.steps ?? [];
      expect(firstStep?.runId).toBe(secondStep?.runId);
      expect(firstStep?.stepNumber).toBe(1);
      expect(secondStep?.stepNumber).toBe(2);
    });
  });
});

describe("prompt-prefix fingerprints (#5254)", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devtools-prefix-test-"));
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const cached = { anthropic: { cacheControl: { type: "ephemeral" as const } } };
  function prefixParams(options: {
    readDescription?: string;
    tail?: string;
    metadataId: string;
  }): LanguageModelV4CallOptions {
    return {
      prompt: [
        { role: "system", content: "Stable system", providerOptions: cached },
        ...(options.tail != null ? [{ role: "system" as const, content: options.tail }] : []),
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      tools: [
        {
          type: "function",
          name: "file_read",
          description: options.readDescription ?? "Read a file",
          inputSchema: { type: "object" },
        },
        {
          type: "function",
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object" },
          providerOptions: cached,
        },
      ],
      headers: { [DEVTOOLS_RUN_METADATA_ID_HEADER]: options.metadataId },
    };
  }

  function metadataIdOf(params: LanguageModelV4CallOptions): string {
    const metadataId = params.headers?.[DEVTOOLS_RUN_METADATA_ID_HEADER];
    if (typeof metadataId !== "string") throw new Error("expected a run metadata id");
    return metadataId;
  }

  // One middleware per model attempt, like providerModelFactory: each is its own run.
  async function attempt(
    service: DevToolsService,
    params: LanguageModelV4CallOptions,
    modelString = "anthropic:model"
  ) {
    await getWrapGenerate(createDevToolsMiddleware("ws-1", service, modelString))({
      doGenerate: () => Promise.resolve(createGenerateResult()),
      doStream: () => Promise.reject(new Error("doStream should not be called")),
      params,
      // Same bare SDK model id for every route: only the model string tells them apart.
      model: createMockModel(),
    });
    const runs = await service.getRuns("ws-1");
    const newest = runs.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b));
    const run = await service.getRunWithSteps("ws-1", newest.id);
    return run?.steps[0]?.promptPrefix;
  }

  // A whole request: metadata registered up front and cleared at the end, like aiService.
  async function send(
    service: DevToolsService,
    params: LanguageModelV4CallOptions,
    context: { agentId: string; liveTurn: boolean }
  ) {
    const metadataId = metadataIdOf(params);
    service.setPendingRunMetadata("ws-1", metadataId, { promptPrefixContext: context });
    try {
      await getWrapGenerate(createDevToolsMiddleware("ws-1", service, "anthropic:model"))({
        doGenerate: () => Promise.resolve(createGenerateResult()),
        doStream: () => Promise.reject(new Error("doStream should not be called")),
        params,
        model: createMockModel(),
      });
    } finally {
      service.clearPendingRunMetadata("ws-1", metadataId);
    }
  }

  async function generate(
    service: DevToolsService,
    params: LanguageModelV4CallOptions,
    context: { agentId: string; liveTurn: boolean },
    modelString?: string
  ) {
    const metadataId = metadataIdOf(params);
    service.setPendingRunMetadata("ws-1", metadataId, { promptPrefixContext: context });
    try {
      return await attempt(service, params, modelString);
    } finally {
      service.clearPendingRunMetadata("ws-1", metadataId);
    }
  }

  it("computes nothing while API debug logs are off", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: false }));
    const fingerprint = spyOn(promptPrefixFingerprint, "fingerprintPromptPrefix");
    let called = false;
    await getWrapGenerate(createDevToolsMiddleware("ws-1", service, "test:model"))({
      doGenerate: () => {
        called = true;
        return Promise.resolve(createGenerateResult());
      },
      doStream: () => Promise.reject(new Error("doStream should not be called")),
      params: prefixParams({ metadataId: "m-off" }),
      model: createMockModel(),
    });
    expect(called).toBe(true);
    expect(fingerprint).not.toHaveBeenCalled();
    fingerprint.mockRestore();
  });

  it("names what changed between live turns and ignores compaction", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
    const live = { agentId: "exec", liveTurn: true };

    const first = await generate(service, prefixParams({ metadataId: "m1" }), live);
    expect(first?.systemTailHash).toBeNull();
    expect(first?.change).toBeUndefined();

    const reworded = await generate(
      service,
      prefixParams({ metadataId: "m2", readDescription: "Read any file" }),
      live
    );
    expect(reworded?.change).toEqual({ components: ["tool-description:file_read"] });
    expect(reworded?.toolsHash).not.toBe(first?.toolsHash);

    // A different prompt from compaction neither compares nor moves the baseline.
    const compaction = await generate(
      service,
      prefixParams({ metadataId: "m3", tail: "Summarize" }),
      { agentId: "compact", liveTurn: false }
    );
    expect(compaction?.change).toBeUndefined();

    const switched = await generate(
      service,
      prefixParams({ metadataId: "m4", readDescription: "Read any file", tail: "Warning" }),
      { agentId: "plan", liveTurn: true }
    );
    expect(switched?.change).toEqual({
      components: ["system-tail-only"],
      expected: "agent-switch",
    });
    expect(switched?.systemPrefixHash).toBe(first?.systemPrefixHash);

    // Clearing the log drops the baseline: the next request starts fresh.
    await service.clear("ws-1");
    const afterClear = await generate(service, prefixParams({ metadataId: "m5" }), live);
    expect(afterClear?.change).toBeUndefined();
  });

  it("classifies a refusal-fallback attempt by its selected model string", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
    const live = { agentId: "exec", liveTurn: true };
    await generate(service, prefixParams({ metadataId: "m1" }), live, "anthropic:model");

    // One request, two attempts under the same metadata ID: the fallback route
    // shares the bare SDK model id but is a different selected model.
    const refusedParams = prefixParams({ metadataId: "m2", readDescription: "Read any file" });
    const fallbackParams = prefixParams({
      metadataId: "m2",
      readDescription: "Read any file",
      tail: "Fallback route",
    });
    service.setPendingRunMetadata("ws-1", "m2", { promptPrefixContext: live });
    const refused = await attempt(service, refusedParams, "anthropic:model");
    const fallback = await attempt(service, fallbackParams, "coder:anthropic/model");
    service.clearPendingRunMetadata("ws-1", "m2");
    expect(refused?.change).toEqual({ components: ["tool-description:file_read"] });
    expect(fallback?.change).toEqual({
      components: ["system-tail-only"],
      expected: "model-switch",
    });

    // The baseline now sits on the fallback route.
    const next = await generate(
      service,
      prefixParams({ metadataId: "m3", readDescription: "Read any file", tail: "Fallback route" }),
      live,
      "coder:anthropic/model"
    );
    expect(next?.change).toBeUndefined();
  });

  it("starts a fresh baseline when debug logging is toggled", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
    const live = { agentId: "exec", liveTurn: true };
    await generate(service, prefixParams({ metadataId: "m1" }), live);
    service.resetPromptPrefixBaselines();
    const afterToggle = await generate(
      service,
      prefixParams({ metadataId: "m2", readDescription: "Read any file" }),
      live
    );
    expect(afterToggle?.change).toBeUndefined();
  });

  // Holds the next step append until release() so tests can interleave.
  function holdNextStepAppend() {
    const originalAppendFile = fs.appendFile;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const held = new Promise<void>((resolve) => (reached = resolve));
    let holding = true;
    const spy = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (holding && String(args[1]).includes('"type":"step"')) {
        holding = false;
        reached();
        await released;
      }
      return originalAppendFile(...args);
    });
    return { held, release, restore: () => spy.mockRestore() };
  }

  it("compares overlapping steps in log order", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
    const live = { agentId: "exec", liveTurn: true };
    await generate(service, prefixParams({ metadataId: "m1" }), live);

    // Two runs already exist, so neither step waits on a run-line append.
    const step = (id: string): DevToolsStep => ({
      id,
      runId: `run-${id}`,
      stepNumber: 1,
      type: "generate" as const,
      modelId: "test-model",
      provider: "test-provider",
      startedAt: "2025-06-01T00:00:00Z",
      durationMs: null,
      input: null,
      output: null,
      usage: null,
      error: null,
      rawRequest: null,
      requestHeaders: null,
      responseHeaders: null,
      rawResponse: null,
      rawChunks: null,
    });
    const observe = (params: LanguageModelV4CallOptions) => {
      const runMetadataId = metadataIdOf(params);
      service.setPendingRunMetadata("ws-1", runMetadataId, { promptPrefixContext: live });
      return {
        fingerprint: promptPrefixFingerprint.fingerprintPromptPrefix(params),
        modelString: "anthropic:model",
        runMetadataId,
      };
    };
    for (const id of ["s2", "s3"]) {
      await service.createRun("ws-1", { id: `run-${id}`, workspaceId: "ws-1", startedAt: "x" });
    }
    const second = step("s2");
    const third = step("s3");
    const hold = holdNextStepAppend();
    try {
      const writing = service.createStep(
        "ws-1",
        second,
        observe(prefixParams({ metadataId: "m2", readDescription: "Read any file" }))
      );
      await hold.held;
      // Queued behind the held append, so it is logged right after s2.
      const queued = service.createStep(
        "ws-1",
        third,
        observe(prefixParams({ metadataId: "m3", readDescription: "Read any file", tail: "W" }))
      );
      hold.release();
      await Promise.all([writing, queued]);
    } finally {
      hold.restore();
    }
    expect(second.promptPrefix?.change).toEqual({ components: ["tool-description:file_read"] });
    expect(third.promptPrefix?.change).toEqual({ components: ["system-tail-only"] });
  });

  it("does not bring back a baseline cleared while its step was being written", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
    const live = { agentId: "exec", liveTurn: true };
    await generate(service, prefixParams({ metadataId: "m1" }), live);

    const hold = holdNextStepAppend();
    try {
      const inFlight = send(service, prefixParams({ metadataId: "m2", tail: "One" }), live);
      await hold.held;
      const cleared = service.clear("ws-1");
      hold.release();
      await inFlight;
      await cleared;
    } finally {
      hold.restore();
    }

    const afterClear = await generate(
      service,
      prefixParams({ metadataId: "m3", readDescription: "Read any file" }),
      live
    );
    expect(afterClear?.change).toBeUndefined();
  });

  it("keeps the baseline when the step could not be persisted", async () => {
    const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
    const live = { agentId: "exec", liveTurn: true };
    await generate(service, prefixParams({ metadataId: "m1" }), live);

    const originalAppendFile = fs.appendFile;
    const appendFileSpy = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[1]).includes('"type":"step"')) {
        throw new Error("ENOSPC: no space left on device");
      }
      return originalAppendFile(...args);
    });
    try {
      await generate(service, prefixParams({ metadataId: "m2", tail: "Unlogged" }), live);
    } finally {
      appendFileSpy.mockRestore();
    }

    // Compared with m1, not with the request that never reached the log.
    const next = await generate(
      service,
      prefixParams({ metadataId: "m3", readDescription: "Read any file" }),
      live
    );
    expect(next?.change).toEqual({ components: ["tool-description:file_read"] });
  });
});
