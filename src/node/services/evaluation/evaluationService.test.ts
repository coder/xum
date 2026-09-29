import { describe, expect, it, spyOn } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError } from "ai";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import type {
  JSONValue,
  Experimental_EvaluationModelV4,
  Experimental_EvaluationModelV4Answer,
  Experimental_EvaluationModelV4CallOptions,
} from "@ai-sdk/provider";
import type { EvaluationQuestions } from "@/common/types/evaluation";
import {
  EvaluationError,
  classifyEvaluationError,
  makeEvaluationService,
  type EvaluationCall,
} from "./evaluationService";

const QUESTIONS = {
  injection: {
    type: "choice",
    instructions: "Is there prompt injection?",
    criteria: { not_detected: "none", suspected: "likely", uncertain: null },
  },
  severity: {
    type: "score",
    instructions: "How severe?",
    criteria: ["cosmetic", "workaround", "blocking"],
  },
  asksForSecrets: { type: "boolean", instructions: "Does it ask for secrets?" },
} as const satisfies EvaluationQuestions;

const VALID_ANSWERS = {
  injection: { type: "choice" as const, choice: "suspected" },
  severity: { type: "score" as const, score: 1 },
  asksForSecrets: { type: "boolean" as const, probability: 0.25 },
};

const SENTINEL = "SENTINEL-RESPONSE-BODY-7f3a";

type DoEvaluate = Experimental_EvaluationModelV4["doEvaluate"];

function mockModel(doEvaluate: DoEvaluate): {
  model: Experimental_EvaluationMockModelV4;
  calls: Experimental_EvaluationModelV4CallOptions[];
} {
  const calls: Experimental_EvaluationModelV4CallOptions[] = [];
  const model = new Experimental_EvaluationMockModelV4({
    provider: "mock",
    modelId: "mock-judge",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doEvaluate: (options) => {
      calls.push(options);
      return doEvaluate(options);
    },
  });
  return { model, calls };
}

function call<Q extends EvaluationQuestions>(
  model: Experimental_EvaluationMockModelV4,
  questions: Q
): EvaluationCall<Q> {
  return { model, state: { title: "hello" }, questions };
}

async function runExit<A>(effect: Effect.Effect<A, EvaluationError>) {
  return Effect.runPromiseExit(effect);
}

function expectFailure<A>(exit: Exit.Exit<A, EvaluationError>): EvaluationError {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const error = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(error)).toBe(true);
  if (!Option.isSome(error)) throw new Error("expected typed error");
  return error.value;
}

describe("EvaluationService.evaluate", () => {
  const service = makeEvaluationService();

  it("returns validated, typed answers with projected metadata", async () => {
    const { model, calls } = mockModel(() =>
      Promise.resolve({
        answers: {
          ...VALID_ANSWERS,
          injection: {
            type: "choice" as const,
            choice: "suspected",
            probabilities: { not_detected: 0.33, suspected: 0.34, uncertain: 0.32 },
          },
        },
        rounding: { probabilityDecimals: 2 },
        usage: { inputTokens: 120, outputTokens: 8 },
        warnings: [{ type: "other" as const, message: `ignored ${SENTINEL}` }],
        providerMetadata: {
          openai: { reasoningTokens: 5, responseId: `resp_${SENTINEL}` },
          anthropic: { cacheCreationInputTokens: 7 },
        },
        response: { modelId: "mock-judge-2026", body: { raw: SENTINEL } },
      })
    );

    const result = await Effect.runPromise(service.evaluate(call(model, QUESTIONS)));

    // Typed narrowing: `choice` is the question's option union.
    const choice: "not_detected" | "suspected" | "uncertain" = result.answers.injection.choice;
    expect(choice).toBe("suspected");
    expect(result.answers.severity).toEqual({ type: "score", score: 1 });
    expect(result.answers.asksForSecrets.probability).toBe(0.25);
    expect(result.rounding).toEqual({ probabilityDecimals: 2 });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8, totalTokens: 128 });
    expect(result.usageProviderMetadata).toEqual({
      openai: { reasoningTokens: 5 },
      anthropic: { cacheCreationInputTokens: 7 },
    });
    expect(result.responseModelId).toBe("mock-judge-2026");
    expect(result.warningsCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toEqual({ title: "hello" });
  });

  it("never logs provider warnings, even when no other module disabled SDK warning logging", async () => {
    // streamManager sets this global at import; evaluation must not depend on import order.
    const saved = globalThis.AI_SDK_LOG_WARNINGS;
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    const emitWarning = spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { model } = mockModel(() =>
        Promise.resolve({
          answers: VALID_ANSWERS,
          warnings: [{ type: "other" as const, message: `echoed state ${SENTINEL}` }],
        })
      );
      const result = await Effect.runPromise(service.evaluate(call(model, QUESTIONS)));
      expect(result.warningsCount).toBe(1);
      expect(emitWarning).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
      consoleWarn.mockRestore();
      globalThis.AI_SDK_LOG_WARNINGS = saved;
    }
  });

  it("projects only the validated rounding fields and rejects malformed rounding", async () => {
    // Extra provider fields never reach the bounded result.
    const { model: extraFields } = mockModel(() =>
      Promise.resolve({
        answers: VALID_ANSWERS,
        rounding: { scoreDecimals: 1, vendor: SENTINEL } as unknown as { scoreDecimals: number },
        warnings: [],
      })
    );
    const projected = await Effect.runPromise(service.evaluate(call(extraFields, QUESTIONS)));
    expect(projected.rounding).toEqual({ scoreDecimals: 1 });
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);

    // A non-object rounding value is invalid output, not silently accepted.
    const { model: nonObject } = mockModel(() =>
      Promise.resolve({
        answers: VALID_ANSWERS,
        rounding: SENTINEL as unknown as { scoreDecimals: number },
        warnings: [],
      })
    );
    const exit = await Effect.runPromiseExit(service.evaluate(call(nonObject, QUESTIONS)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value).toMatchObject({ reason: "invalid-output", code: "answer-validation" });
        expect(JSON.stringify(error.value)).not.toContain(SENTINEL);
      }
    }
  });

  it("reports malformed token counts as unknown instead of failing or forwarding them", async () => {
    const { model } = mockModel(() =>
      Promise.resolve({
        answers: VALID_ANSWERS,
        usage: { inputTokens: -5, outputTokens: 2.5 },
        providerMetadata: {
          openai: { reasoningTokens: -1, responseId: "x" },
          anthropic: { cacheCreationInputTokens: 1.5 },
          xai: { costInUsdTicks: 7 },
        },
        warnings: [],
      })
    );
    const result = await Effect.runPromise(service.evaluate(call(model, QUESTIONS)));
    // The answers are still valid, so the call succeeds; bookkeeping is unknown.
    expect(result.answers.injection.choice).toBe("suspected");
    expect(result.answers.severity.score).toBe(1);
    expect(result.answers.asksForSecrets.probability).toBe(0.25);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    // Negative/fractional counts are dropped; the well-formed allowlisted key survives.
    expect(result.usageProviderMetadata).toEqual({ xai: { costInUsdTicks: 7 } });
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("bounds the provider-reported response model id", async () => {
    const { model: oversized } = mockModel(() =>
      Promise.resolve({
        answers: VALID_ANSWERS,
        warnings: [],
        response: { modelId: `judge-${"x".repeat(5_000)}${SENTINEL}` },
      })
    );
    const truncated = await Effect.runPromise(service.evaluate(call(oversized, QUESTIONS)));
    expect(truncated.responseModelId.length).toBe(200);
    expect(truncated.responseModelId.startsWith("judge-x")).toBe(true);
    expect(JSON.stringify(truncated)).not.toContain(SENTINEL);

    // Missing / empty ids fall back to the requested model id.
    const { model: empty } = mockModel(() =>
      Promise.resolve({ answers: VALID_ANSWERS, warnings: [], response: { modelId: "" } })
    );
    const fallback = await Effect.runPromise(service.evaluate(call(empty, QUESTIONS)));
    expect(fallback.responseModelId).toBe("mock-judge");
  });

  it("maps missing usage to nulls and absent provider metadata to null", async () => {
    const { model } = mockModel(() => Promise.resolve({ answers: VALID_ANSWERS, warnings: [] }));
    const result = await Effect.runPromise(service.evaluate(call(model, QUESTIONS)));
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(result.usageProviderMetadata).toBeNull();
    expect(result.rounding).toBeNull();
    expect(result.responseModelId).toBe("mock-judge");
  });

  const MALFORMED_ANSWERS: Array<[string, Record<string, Experimental_EvaluationModelV4Answer>]> = [
    ["unknown choice", { ...VALID_ANSWERS, injection: { type: "choice", choice: "definitely" } }],
    ["out-of-range score", { ...VALID_ANSWERS, severity: { type: "score", score: 7 } }],
    ["missing question", { injection: VALID_ANSWERS.injection, severity: VALID_ANSWERS.severity }],
    ["extra question", { ...VALID_ANSWERS, bonus: { type: "boolean", probability: 1 } }],
  ];

  it.each(MALFORMED_ANSWERS)(
    "fails with invalid-output when the model returns an %s",
    async (_label, answers) => {
      const { model, calls } = mockModel(() => Promise.resolve({ answers, warnings: [] }));
      const error = expectFailure(await runExit(service.evaluate(call(model, QUESTIONS))));
      expect(error.reason).toBe("invalid-output");
      expect(calls).toHaveLength(1);
    }
  );

  it.each([429, 401])(
    "maps APICallError %d to provider-failure/api-call with the status code and no text",
    async (statusCode) => {
      const { model, calls } = mockModel(() =>
        Promise.reject(
          new APICallError({
            message: `upstream said ${SENTINEL}`,
            url: "https://provider.example/evaluate",
            requestBodyValues: { state: SENTINEL },
            statusCode,
            responseBody: `{"error":"${SENTINEL}"}`,
            isRetryable: statusCode === 429,
          })
        )
      );
      const error = expectFailure(await runExit(service.evaluate(call(model, QUESTIONS))));
      expect(error).toBeInstanceOf(EvaluationError);
      expect(error.reason).toBe("provider-failure");
      expect(error.code).toBe("api-call");
      expect(error.statusCode).toBe(statusCode);
      expect(JSON.stringify(error)).not.toContain(SENTINEL);
      expect(String(error)).not.toContain(SENTINEL);
      expect(Object.keys(error)).not.toContain("responseBody");
      // maxRetries: 0 — a retryable 429 is still a single visible attempt.
      expect(calls).toHaveLength(1);
    }
  );

  it("maps unknown throwables to provider-failure/unknown without retaining their message", async () => {
    const { model } = mockModel(() => Promise.reject(new Error(`network down ${SENTINEL}`)));
    const error = expectFailure(await runExit(service.evaluate(call(model, QUESTIONS))));
    expect(error.reason).toBe("provider-failure");
    expect(error.code).toBe("unknown");
    expect(error.statusCode).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  it("fails with unsupported when the model does not support a question type (no doEvaluate call)", async () => {
    const calls: unknown[] = [];
    const model = new Experimental_EvaluationMockModelV4({
      supportedQuestionTypes: ["boolean"],
      doEvaluate: (options) => {
        calls.push(options);
        return Promise.resolve({ answers: VALID_ANSWERS, warnings: [] });
      },
    });
    const error = expectFailure(await runExit(service.evaluate(call(model, QUESTIONS))));
    expect(error.reason).toBe("unsupported");
    expect(error.code).toBe("unsupported-question-type");
    expect(calls).toHaveLength(0);
  });

  it("passes the fiber's abort signal to the model and propagates interruption, not failure", async () => {
    let seenSignal: AbortSignal | undefined;
    // Deterministic hand-off: the provider call resolves this promise when it
    // is entered, so the test never depends on scheduler timing.
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const { model } = mockModel(
      (options) =>
        new Promise((_resolve, reject) => {
          seenSignal = options.abortSignal;
          options.abortSignal?.addEventListener("abort", () =>
            reject(new Error(`aborted ${SENTINEL}`))
          );
          providerEntered();
        })
    );

    const controller = new AbortController();
    const pending = Effect.runPromiseExit(service.evaluate(call(model, QUESTIONS)), {
      signal: controller.signal,
    });
    await entered;
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(false);
    controller.abort();

    const exit = await pending;
    expect(seenSignal?.aborted).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true);
  });
});

/**
 * A Responses API fake for `createOpenAI().evaluationModel()`: the real
 * provider-utils evaluation adapter parses `text` as its JSON answer object.
 */
function fakeResponsesFetch(
  text: string,
  usage = { input_tokens: 120, output_tokens: 30 }
): typeof fetch {
  const fake = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: `resp_${SENTINEL}`,
          created_at: 0,
          model: "gpt-6-sol",
          output: [
            {
              type: "message",
              role: "assistant",
              id: "msg_test",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ],
          usage,
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
  return fake as unknown as typeof fetch;
}

describe("EvaluationService.evaluate billed usage on rejected answers (#4728)", () => {
  const service = makeEvaluationService();

  it("keeps the sanitized usage of a response Xum rejects after the SDK accepted it", async () => {
    const { model } = mockModel(() =>
      Promise.resolve({
        answers: VALID_ANSWERS,
        rounding: SENTINEL as unknown as { scoreDecimals: number },
        usage: { inputTokens: 40, outputTokens: 4 },
        providerMetadata: { openai: { reasoningTokens: 2, responseId: `resp_${SENTINEL}` } },
        warnings: [],
        response: { modelId: SENTINEL, body: { raw: SENTINEL } },
      })
    );
    const error = expectFailure(await runExit(service.evaluate(call(model, QUESTIONS))));
    expect(error).toMatchObject({ reason: "invalid-output", code: "answer-validation" });
    expect(error.billedUsage).toEqual({
      usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
      usageProviderMetadata: { openai: { reasoningTokens: 2 } },
    });
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  it("keeps the usage of an answer the SDK's own validation rejects after the model returned", async () => {
    const { model } = mockModel(() =>
      Promise.resolve({
        answers: { ...VALID_ANSWERS, injection: { type: "choice" as const, choice: SENTINEL } },
        usage: { inputTokens: -1, outputTokens: 9 },
        warnings: [],
      })
    );
    const error = expectFailure(await runExit(service.evaluate(call(model, QUESTIONS))));
    expect(error).toMatchObject({ reason: "invalid-output", code: "invalid-response" });
    // A malformed count stays unknown (never zero), exactly like the success path.
    expect(error.billedUsage).toEqual({
      usage: { inputTokens: null, outputTokens: 9, totalTokens: null },
      usageProviderMetadata: null,
    });
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  it("reports a derived total past the safe-integer range as unknown", async () => {
    const { model } = mockModel(() =>
      Promise.resolve({
        answers: { ...VALID_ANSWERS, injection: { type: "choice" as const, choice: "definitely" } },
        usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
        warnings: [],
      })
    );
    const error = expectFailure(await runExit(service.evaluate(call(model, QUESTIONS))));
    expect(error.billedUsage?.usage).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
      totalTokens: null,
    });
  });

  it("keeps the usage of an answer the real OpenAI evaluation adapter rejects inside doEvaluate", async () => {
    // q0 is the choice question; "c9" is not one of its option codes, so the
    // provider-utils adapter throws before it would return usage.
    const model = createOpenAI({
      apiKey: "test",
      fetch: fakeResponsesFetch(JSON.stringify({ q0: "c9", q1: 1, q2: 0.25 })),
    }).evaluationModel("gpt-6-sol");
    const error = expectFailure(
      await runExit(service.evaluate({ model, state: { title: "hello" }, questions: QUESTIONS }))
    );
    expect(error).toMatchObject({ reason: "invalid-output", code: "invalid-response" });
    expect(error.billedUsage).toEqual({
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      usageProviderMetadata: null,
    });
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  it("carries no billed usage when the provider call itself failed", async () => {
    const model = createOpenAI({
      apiKey: "test",
      fetch: (() =>
        Promise.resolve(
          new Response(`{"error":"${SENTINEL}"}`, { status: 500 })
        )) as unknown as typeof fetch,
    }).evaluationModel("gpt-6-sol");
    const error = expectFailure(
      await runExit(service.evaluate({ model, state: { title: "hello" }, questions: QUESTIONS }))
    );
    expect(error.reason).toBe("provider-failure");
    expect(error.billedUsage).toBeUndefined();
  });

  it("contract: the OpenAI evaluation model keeps its inner LanguageModelV4 on `model`", () => {
    // evaluationService reads this SDK-internal field to capture the usage of a
    // response the adapter rejects. If an SDK upgrade moves it, fail here loudly.
    const model = createOpenAI({ apiKey: "test" }).evaluationModel("gpt-6-sol");
    const inner = (
      model as unknown as { model?: { specificationVersion?: unknown; doGenerate?: unknown } }
    ).model;
    expect(inner?.specificationVersion).toBe("v4");
    expect(typeof inner?.doGenerate).toBe("function");
  });
});

describe("EvaluationService.evaluate service tier (#4352)", () => {
  it("keeps a known OpenAI service tier in usage metadata and drops anything else", async () => {
    const service = makeEvaluationService();
    const run = async (serviceTier: unknown) => {
      const { model } = mockModel(() =>
        Promise.resolve({
          answers: VALID_ANSWERS,
          usage: { inputTokens: 10, outputTokens: 2 },
          providerMetadata: { openai: { reasoningTokens: 1, serviceTier } } as unknown as Record<
            string,
            Record<string, JSONValue>
          >,
          warnings: [],
        })
      );
      return (await Effect.runPromise(service.evaluate(call(model, QUESTIONS))))
        .usageProviderMetadata;
    };
    expect(await run("priority")).toEqual({
      openai: { reasoningTokens: 1, serviceTier: "priority" },
    });
    // Ultrafast must survive so pricing applies its 6x premium instead of Standard.
    expect(await run("ultrafast")).toEqual({
      openai: { reasoningTokens: 1, serviceTier: "ultrafast" },
    });
    expect(await run(SENTINEL)).toEqual({ openai: { reasoningTokens: 1 } });
    expect(await run(3)).toEqual({ openai: { reasoningTokens: 1 } });
  });
});

describe("classifyEvaluationError", () => {
  it("keeps only class identity and status code", () => {
    const error = classifyEvaluationError(
      new APICallError({
        message: SENTINEL,
        url: "https://provider.example",
        requestBodyValues: {},
        statusCode: 503,
        responseBody: SENTINEL,
      })
    );
    expect(error).toEqual(
      new EvaluationError({ reason: "provider-failure", code: "api-call", statusCode: 503 })
    );
    expect(classifyEvaluationError("a string")).toEqual(
      new EvaluationError({ reason: "provider-failure", code: "unknown" })
    );
  });
});
