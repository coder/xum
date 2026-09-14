import * as aiSdk from "ai";
import { APICallError, NoOutputGeneratedError, RetryError, type LanguageModel } from "ai";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  buildWorkspaceIdentityPrompt,
  generateWorkspaceIdentity,
  mapModelCreationError,
  mapNameGenerationError,
} from "./workspaceTitleGenerator";
import { Err, Ok } from "@/common/types/result";
import type { AIService } from "./aiService";
import type { SendMessageError } from "@/common/types/errors";
import { NAME_GEN_MAX_OUTPUT_TOKENS } from "@/common/constants/nameGeneration";
import type { ThinkingLevel } from "@/common/types/thinking";
import { attachLanguageModelCleanup } from "./languageModelCleanup";

afterEach(() => {
  mock.restore();
});

describe("buildWorkspaceIdentityPrompt", () => {
  test("includes overall-scope guidance, conversation turns, and latest-user context without precedence", () => {
    const prompt = buildWorkspaceIdentityPrompt(
      "Refactor workspace title generation",
      "Turn 1 (User):\nOutline the plan\n\nTurn 2 (Assistant):\nImplement incrementally",
      "Please prioritize reliability work"
    );

    expect(prompt).toContain('Primary user objective: "Refactor workspace title generation"');
    expect(prompt).toContain("Conversation turns");
    expect(prompt).toContain("Outline the plan");
    expect(prompt).toContain("Please prioritize reliability work");
    // Recent message is included as context but not given priority
    expect(prompt).toContain("Most recent user message");
    expect(prompt).toContain("do not prefer it over earlier turns");
    // Scope guidance: weigh all turns equally
    expect(prompt).toContain("Weigh all turns equally");
    // No temporal recency bias in requirements
    expect(prompt).not.toContain("highest priority");
    expect(prompt).not.toContain("precedence");
  });

  test("omits conversation-specific sections when no conversation block is provided", () => {
    const prompt = buildWorkspaceIdentityPrompt(
      "Fix flaky tests",
      undefined,
      "Most recent instruction that should be ignored without context"
    );

    expect(prompt).toContain('Primary user objective: "Fix flaky tests"');
    expect(prompt).not.toContain("Conversation turns");
    expect(prompt).not.toContain("Most recent instruction that should be ignored without context");
  });
});

const createApiCallError = (
  statusCode: number,
  message = `HTTP ${statusCode}`,
  overrides?: {
    data?: unknown;
    responseBody?: string;
  }
): APICallError =>
  new APICallError({
    message,
    statusCode,
    url: "https://api.example.com/v1/responses",
    requestBodyValues: {},
    data: overrides?.data,
    responseBody: overrides?.responseBody,
  });

function createTitleModel(modelId = "title-model"): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("doGenerate is unused in cleanup tests")),
    doStream: () => Promise.reject(new Error("doStream is unused in cleanup tests")),
  };
}

/** Pinned-options receipt for a direct (non-gateway) route, as ProviderModelFactory returns it. */
function pinnedOptionsFor(
  modelString: string,
  model: LanguageModel,
  _opts?: { thinkingLevel?: ThinkingLevel; agentInitiated?: boolean }
) {
  return Ok({
    model,
    effectiveModelString: modelString,
    wireProviderName: modelString.split(":")[0],
    metadataModel: modelString,
    optionsModelString: modelString,
    optionsProvidersConfig: {},
    optionsMuxProviderOptions: {},
  });
}

type PinnedCreate = (
  modelString: string,
  opts?: { thinkingLevel?: ThinkingLevel; agentInitiated?: boolean }
) => Promise<ReturnType<typeof pinnedOptionsFor> | ReturnType<typeof Err<SendMessageError>>>;

/** AIService surface the generator uses: pinned creation + the policy-filtered providers view. */
function titleAIService(createModelWithPinnedOptions: PinnedCreate): AIService {
  return { createModelWithPinnedOptions, getProvidersConfig: () => null } as unknown as AIService;
}

function createTitleAIService(model: LanguageModel): AIService {
  return titleAIService((modelString) => Promise.resolve(pinnedOptionsFor(modelString, model)));
}

const proposeNameStream = {
  toolResults: Promise.resolve([
    {
      dynamic: false,
      toolName: "propose_name",
      output: { name: "settings", title: "Add setting" },
    },
  ]),
} as unknown as ReturnType<typeof aiSdk.streamText>;

describe("generateWorkspaceIdentity candidate settings", () => {
  test("uses the configured candidate's thinking level and stops after it succeeds", async () => {
    const createModelWithPinnedOptions = mock(
      (modelString: string, opts?: { thinkingLevel?: ThinkingLevel; agentInitiated?: boolean }) =>
        Promise.resolve(pinnedOptionsFor(modelString, createTitleModel(modelString), opts))
    );
    const aiService = titleAIService(createModelWithPinnedOptions);
    const streamTextSpy = spyOn(aiSdk, "streamText").mockReturnValue(proposeNameStream);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [
        { model: "google:gemini-3.8-flash", thinkingLevel: "medium" },
        { model: "anthropic:claude-haiku-4-5" },
      ],
      aiService
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelUsed).toBe("google:gemini-3.8-flash");
    }
    // Configured model is created with its thinking level (xAI variant mapping etc.)
    // and the hardcoded fallback is never touched once it succeeds.
    expect(createModelWithPinnedOptions).toHaveBeenCalledTimes(1);
    expect(createModelWithPinnedOptions.mock.calls[0]?.[0]).toBe("google:gemini-3.8-flash");
    expect(createModelWithPinnedOptions.mock.calls[0]?.[1]).toMatchObject({
      thinkingLevel: "medium",
      agentInitiated: true,
    });
    // The request itself carries the configured thinking level.
    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    expect(streamTextSpy.mock.calls[0]?.[0].providerOptions).toMatchObject({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
  });

  test("clamps the configured thinking level to the model's policy", async () => {
    const aiService = createTitleAIService(createTitleModel());
    const streamTextSpy = spyOn(aiSdk, "streamText").mockReturnValue(proposeNameStream);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      // Gemini 3.8 Flash has no true "off"; policy floors it to "low" instead of
      // sending a value the provider rejects.
      [{ model: "google:gemini-3.8-flash", thinkingLevel: "off" }],
      aiService
    );

    expect(result.success).toBe(true);
    expect(streamTextSpy.mock.calls[0]?.[0].providerOptions).toMatchObject({
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
  });

  test("falls through to the next candidate when the configured model fails", async () => {
    const createModelWithPinnedOptions = mock(
      (modelString: string, opts?: { thinkingLevel?: ThinkingLevel; agentInitiated?: boolean }) =>
        Promise.resolve(pinnedOptionsFor(modelString, createTitleModel(modelString), opts))
    );
    const aiService = titleAIService(createModelWithPinnedOptions);
    let streamTextCalls = 0;
    const streamTextSpy = spyOn(aiSdk, "streamText").mockImplementation((() => {
      streamTextCalls += 1;
      if (streamTextCalls === 1) {
        throw createApiCallError(500, "configured model unavailable");
      }
      return proposeNameStream;
    }) as unknown as typeof aiSdk.streamText);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [
        { model: "google:gemini-3.8-flash", thinkingLevel: "medium" },
        { model: "openai:gpt-5.6-luna" },
      ],
      aiService
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelUsed).toBe("openai:gpt-5.6-luna");
    }
    expect(createModelWithPinnedOptions).toHaveBeenCalledTimes(2);
    // Fallbacks carry no configured thinking: they are CREATED with an explicit
    // "off" (xAI picks its non-reasoning variant at creation) and run off.
    expect(createModelWithPinnedOptions.mock.calls[1]?.[1]).toEqual({
      thinkingLevel: "off",
      agentInitiated: true,
    });
    expect(streamTextSpy.mock.calls[1]?.[0].providerOptions).toMatchObject({
      openai: { reasoningEffort: "none" },
    });
  });

  test.each([true, false])(
    "keeps the selected chat model reachable within a bounded chain (succeeds=%s)",
    async (selectedModelSucceeds) => {
      const selectedModel = "openai:gpt-5.4";
      const createModelWithPinnedOptions = mock((modelString: string) =>
        Promise.resolve(pinnedOptionsFor(modelString, createTitleModel(modelString)))
      );
      const aiService = titleAIService(createModelWithPinnedOptions);
      let attempts = 0;
      spyOn(aiSdk, "streamText").mockImplementation((() => {
        attempts += 1;
        if (attempts === 4 && selectedModelSucceeds) {
          return proposeNameStream;
        }
        throw createApiCallError(500, "candidate unavailable");
      }) as unknown as typeof aiSdk.streamText);

      const result = await generateWorkspaceIdentity(
        "Add setting",
        [
          { model: "google:gemini-3.8-flash", thinkingLevel: "medium" },
          { model: "anthropic:claude-haiku-4-5" },
          { model: "openai:gpt-5.6-luna" },
          { model: selectedModel },
          { model: "openai:gpt-5.6" },
        ],
        aiService
      );

      expect(result.success).toBe(selectedModelSucceeds);
      if (result.success) {
        expect(result.data.modelUsed).toBe(selectedModel);
      }
      // A configured naming model must not displace the previously reachable
      // chat-model fallback, but extra candidates must not extend the retry bound.
      expect(createModelWithPinnedOptions).toHaveBeenCalledTimes(4);
      expect(createModelWithPinnedOptions.mock.calls[3]?.[0]).toBe(selectedModel);
      expect(attempts).toBe(4);
    }
  );

  test.each([
    // A per-model floor from config.minThinkingLevelByModel applies to fallbacks too,
    // and must be in place BEFORE creation (xAI picks its variant from that level).
    { model: "openai:gpt-5.6-luna", expected: { openai: { reasoningEffort: "high" } } },
    { model: "xai:grok-4-1-fast", expected: { xai: {} } },
  ])(
    "applies the per-model thinking floor before creation and in the request ($model)",
    async ({ model, expected }) => {
      const createModelWithPinnedOptions = mock(
        (modelString: string, opts?: { thinkingLevel?: ThinkingLevel }) =>
          Promise.resolve(pinnedOptionsFor(modelString, createTitleModel(modelString), opts))
      );
      const aiService = titleAIService(createModelWithPinnedOptions);
      const streamTextSpy = spyOn(aiSdk, "streamText").mockReturnValue(proposeNameStream);

      const result = await generateWorkspaceIdentity(
        "Add setting",
        [{ model, minThinkingLevel: "high" }],
        aiService
      );

      expect(result.success).toBe(true);
      expect(createModelWithPinnedOptions.mock.calls[0]?.[1]).toMatchObject({
        thinkingLevel: "high",
      });
      expect(streamTextSpy.mock.calls[0]?.[0].providerOptions).toMatchObject(expected);
    }
  );

  test("fails a candidate whose pinned route resolves a different thinking level, then continues", async () => {
    let cleanupCalls = 0;
    const createModelWithPinnedOptions = mock(
      (modelString: string, opts?: { thinkingLevel?: ThinkingLevel }) => {
        const model = createTitleModel(modelString);
        attachLanguageModelCleanup(model, () => {
          cleanupCalls += 1;
        });
        const pinned = pinnedOptionsFor(modelString, model, opts);
        if (modelString === "openai:gpt-5.6-luna" && pinned.success) {
          // The route/config receipt re-maps the request to a model whose policy has no
          // "off" (Gemini 3.8 Flash floors to "low"): the level the model was created for
          // can no longer be honored, so this candidate must be abandoned, not re-clamped.
          pinned.data.optionsModelString = "google:gemini-3.8-flash";
        }
        return Promise.resolve(pinned);
      }
    );
    const aiService = titleAIService(createModelWithPinnedOptions);
    const streamTextSpy = spyOn(aiSdk, "streamText").mockReturnValue(proposeNameStream);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [{ model: "openai:gpt-5.6-luna" }, { model: "anthropic:claude-haiku-4-5" }],
      aiService
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelUsed).toBe("anthropic:claude-haiku-4-5");
    }
    // No request is sent with options that differ from the creation-time level.
    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    expect(streamTextSpy.mock.calls[0]?.[0].model).toMatchObject({
      modelId: "anthropic:claude-haiku-4-5",
    });
    expect(createModelWithPinnedOptions).toHaveBeenCalledTimes(2);
    expect(cleanupCalls).toBe(2);
  });

  test.each([
    { thinkingLevel: "medium" as const, budget: 10_000 },
    { thinkingLevel: "high" as const, budget: 20_000 },
  ])(
    "reserves output headroom above the serialized Anthropic thinking budget ($thinkingLevel)",
    async ({ thinkingLevel, budget }) => {
      const aiService = createTitleAIService(createTitleModel());
      const streamTextSpy = spyOn(aiSdk, "streamText").mockReturnValue(proposeNameStream);

      const result = await generateWorkspaceIdentity(
        "Add setting",
        [{ model: "anthropic:claude-haiku-4-5", thinkingLevel }],
        aiService
      );

      expect(result.success).toBe(true);
      const request = streamTextSpy.mock.calls[0]?.[0];
      // Anthropic rejects max_tokens <= thinking.budget_tokens; the headroom follows
      // the budget that was actually serialized for this request.
      expect(request?.providerOptions).toMatchObject({
        anthropic: { thinking: { type: "enabled", budgetTokens: budget } },
      });
      expect(request?.maxOutputTokens).toBe(budget + NAME_GEN_MAX_OUTPUT_TOKENS);
      expect(request?.maxOutputTokens).toBeGreaterThan(budget);
    }
  );

  test.each([
    { model: "anthropic:claude-haiku-4-5", thinkingLevel: undefined },
    { model: "openai:gpt-5.6-luna", thinkingLevel: "medium" as const },
  ])(
    "leaves maxOutputTokens unset without an Anthropic thinking budget ($model)",
    async ({ model, thinkingLevel }) => {
      const aiService = createTitleAIService(createTitleModel());
      const streamTextSpy = spyOn(aiSdk, "streamText").mockReturnValue(proposeNameStream);

      const result = await generateWorkspaceIdentity(
        "Add setting",
        [{ model, thinkingLevel }],
        aiService
      );

      expect(result.success).toBe(true);
      expect(streamTextSpy.mock.calls[0]?.[0].maxOutputTokens).toBeUndefined();
    }
  );

  test("skips a candidate whose model cannot be created and reports the last failure", async () => {
    const createModelWithPinnedOptions = mock((modelString: string) =>
      Promise.resolve(
        modelString.startsWith("google:")
          ? Err({ type: "api_key_not_found" as const, provider: "google" })
          : pinnedOptionsFor(modelString, createTitleModel(modelString))
      )
    );
    const aiService = titleAIService(createModelWithPinnedOptions);
    spyOn(aiSdk, "streamText").mockReturnValue({
      toolResults: Promise.resolve([]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [
        { model: "google:gemini-3.8-flash", thinkingLevel: "medium" },
        { model: "openai:gpt-5.6-luna" },
      ],
      aiService
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual({
        type: "unknown",
        raw: "Model did not call propose_name tool",
      });
    }
    expect(createModelWithPinnedOptions).toHaveBeenCalledTimes(2);
  });
});

describe("generateWorkspaceIdentity cleanup", () => {
  test("cleans up the model after a successful title stream", async () => {
    let cleanupCalls = 0;
    const model = createTitleModel();
    attachLanguageModelCleanup(model, () => {
      cleanupCalls += 1;
    });
    const titleAiService = createTitleAIService(model);

    spyOn(aiSdk, "streamText").mockReturnValue({
      toolResults: Promise.resolve([
        {
          dynamic: false,
          toolName: "propose_name",
          output: { name: "settings", title: "Add setting" },
        },
      ]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [{ model: "openai:gpt-4.1-mini" }],
      titleAiService
    );

    expect(result.success).toBe(true);
    expect(cleanupCalls).toBe(1);
  });

  test("cleans up when title stream throws before trying the next candidate", async () => {
    let cleanupCalls = 0;
    const failingModel = createTitleModel("title-failing-model");
    attachLanguageModelCleanup(failingModel, () => {
      cleanupCalls += 1;
    });
    const aiService = createTitleAIService(failingModel);

    spyOn(aiSdk, "streamText").mockImplementation(() => {
      throw new Error("title stream failed");
    });

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [{ model: "openai:gpt-4.1-mini" }],
      aiService
    );

    expect(result.success).toBe(false);
    expect(cleanupCalls).toBe(1);
  });

  test("cleans up each candidate when title generation retries", async () => {
    let firstCleanupCalls = 0;
    let secondCleanupCalls = 0;
    const firstModel = createTitleModel("title-first-model");
    const secondModel = createTitleModel("title-second-model");
    attachLanguageModelCleanup(firstModel, () => {
      firstCleanupCalls += 1;
    });
    attachLanguageModelCleanup(secondModel, () => {
      secondCleanupCalls += 1;
    });
    const aiService = titleAIService((modelString) =>
      Promise.resolve(
        pinnedOptionsFor(modelString, modelString.includes("first") ? firstModel : secondModel)
      )
    );
    let streamTextCalls = 0;
    spyOn(aiSdk, "streamText").mockImplementation((() => {
      streamTextCalls += 1;
      if (streamTextCalls === 1) {
        throw new Error("first candidate failed");
      }
      return {
        toolResults: Promise.resolve([
          {
            dynamic: false,
            toolName: "propose_name",
            output: { name: "settings", title: "Add setting" },
          },
        ]),
      } as unknown as ReturnType<typeof aiSdk.streamText>;
    }) as unknown as typeof aiSdk.streamText);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [{ model: "openai:first" }, { model: "openai:second" }],
      aiService
    );

    expect(result.success).toBe(true);
    expect(firstCleanupCalls).toBe(1);
    expect(secondCleanupCalls).toBe(1);
  });

  test("cleans up when title stream returns no propose_name result", async () => {
    let cleanupCalls = 0;
    const model = createTitleModel("title-no-tool-model");
    attachLanguageModelCleanup(model, () => {
      cleanupCalls += 1;
    });
    const aiService = createTitleAIService(model);

    spyOn(aiSdk, "streamText").mockReturnValue({
      toolResults: Promise.resolve([]),
    } as unknown as ReturnType<typeof aiSdk.streamText>);

    const result = await generateWorkspaceIdentity(
      "Add setting",
      [{ model: "openai:gpt-4.1-mini" }],
      aiService
    );

    expect(result.success).toBe(false);
    expect(cleanupCalls).toBe(1);
  });
});

describe("workspaceTitleGenerator error mappers", () => {
  describe("mapNameGenerationError", () => {
    test("preserves provider context for auth and permission API failures", () => {
      const modelString = "openai:gpt-4.1-mini";

      const auth = mapNameGenerationError(createApiCallError(401, "Unauthorized"), modelString);
      expect(auth).toEqual({
        type: "authentication",
        authKind: "invalid_credentials",
        provider: "openai",
        raw: "Unauthorized",
      });

      const permission = mapNameGenerationError(createApiCallError(403, "Forbidden"), modelString);
      expect(permission).toEqual({
        type: "permission_denied",
        provider: "openai",
        raw: "Forbidden",
      });
    });

    test("treats explicit billing failures as quota", () => {
      const paymentRequired = mapNameGenerationError(
        createApiCallError(402, "Payment Required"),
        "openai:gpt-4.1-mini"
      );
      expect(paymentRequired).toEqual({ type: "quota", raw: "Payment Required" });

      const capacityWithBillingSignal = mapNameGenerationError(
        createApiCallError(429, "Request failed", {
          data: { error: { code: "insufficient_quota", message: "Please add credits" } },
          responseBody: '{"error":{"code":"insufficient_quota","message":"Please add credits"}}',
        }),
        "openai:gpt-4.1-mini"
      );
      expect(capacityWithBillingSignal).toEqual({ type: "quota", raw: "Request failed" });
    });

    test("classifies throttling as rate_limit when no billing markers are present", () => {
      const burstRateLimit = mapNameGenerationError(
        createApiCallError(429, "Too Many Requests"),
        "openai:gpt-4.1-mini"
      );
      expect(burstRateLimit).toEqual({ type: "rate_limit", raw: "Too Many Requests" });

      const quotaWordingOnly = mapNameGenerationError(
        createApiCallError(429, "Per-minute quota limit reached. Retry in 10s."),
        "openai:gpt-4.1-mini"
      );
      expect(quotaWordingOnly).toEqual({
        type: "rate_limit",
        raw: "Per-minute quota limit reached. Retry in 10s.",
      });
    });

    test("maps any 5xx API failure to service_unavailable", () => {
      for (const statusCode of [500, 503]) {
        const message = `HTTP ${statusCode}`;
        const mapped = mapNameGenerationError(
          createApiCallError(statusCode, message),
          "openai:gpt-4.1-mini"
        );
        expect(mapped).toEqual({ type: "service_unavailable", raw: message });
      }
    });

    test("unwraps RetryError and applies inner error classification", () => {
      const retryError = new RetryError({
        message: "Retry failed",
        reason: "maxRetriesExceeded",
        errors: [createApiCallError(401, "Unauthorized")],
      });

      expect(mapNameGenerationError(retryError, "openai:gpt-4.1-mini")).toMatchObject({
        type: "authentication",
        authKind: "invalid_credentials",
      });
    });

    test("maps NoOutputGeneratedError to a user-friendly message", () => {
      const noOutput = new NoOutputGeneratedError({
        message: "No output generated. Check the stream for errors.",
      });

      expect(mapNameGenerationError(noOutput, "openai:gpt-4.1-mini")).toEqual({
        type: "unknown",
        raw: "No output generated from the AI provider.",
      });
    });

    test("only treats fetch TypeError as network; all other failures fall back to unknown", () => {
      expect(mapNameGenerationError(new TypeError("fetch failed"), "openai:gpt-4.1-mini")).toEqual({
        type: "network",
        raw: "fetch failed",
      });
      expect(mapNameGenerationError(new Error("boom"), "openai:gpt-4.1-mini")).toEqual({
        type: "unknown",
        raw: "boom",
      });
      expect(mapNameGenerationError("boom", "openai:gpt-4.1-mini")).toEqual({
        type: "unknown",
        raw: "boom",
      });
    });
  });

  describe("mapModelCreationError", () => {
    test("maps auth setup failures to authentication and keeps provider from the error", () => {
      const apiKeyMissing = mapModelCreationError(
        { type: "api_key_not_found", provider: "anthropic" },
        "openai:gpt-4.1-mini"
      );
      const oauthMissing = mapModelCreationError(
        { type: "oauth_not_connected", provider: "openai" },
        "anthropic:claude-3-5-haiku"
      );

      expect(apiKeyMissing).toEqual({
        type: "authentication",
        authKind: "api_key_missing",
        provider: "anthropic",
      });
      expect(oauthMissing).toEqual({
        type: "authentication",
        authKind: "oauth_not_connected",
        provider: "openai",
      });
    });

    test("groups provider availability issues under configuration", () => {
      const providerDisabled = mapModelCreationError(
        { type: "provider_disabled", provider: "google" },
        "google:gemini-2.0-flash"
      );
      const providerNotSupported = mapModelCreationError(
        { type: "provider_not_supported", provider: "custom" },
        "custom:model"
      );

      expect(providerDisabled).toEqual({ type: "configuration", raw: "Provider disabled" });
      expect(providerNotSupported).toEqual({
        type: "configuration",
        raw: "Provider not supported",
      });
    });

    test("derives provider from model string for policy_denied errors", () => {
      const mapped = mapModelCreationError(
        { type: "policy_denied", message: "Provider blocked" },
        "openai:gpt-4.1-mini"
      );
      expect(mapped).toEqual({
        type: "policy",
        provider: "openai",
        raw: "Provider blocked",
      });
    });

    test("preserves unknown raw messages and uses message fallback for unmapped variants", () => {
      const unknownWithRaw = mapModelCreationError(
        { type: "unknown", raw: "Some detailed error" },
        "openai:gpt-4o"
      );
      expect(unknownWithRaw).toEqual({ type: "unknown", raw: "Some detailed error" });

      const fallbackFromMessage = mapModelCreationError(
        { type: "runtime_not_ready", message: "Container booting" },
        "openai:gpt-4o"
      );
      expect(fallbackFromMessage).toEqual({ type: "unknown", raw: "Container booting" });
    });
  });
});
