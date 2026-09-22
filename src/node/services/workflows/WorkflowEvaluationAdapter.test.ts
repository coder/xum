import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Effect } from "effect";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import type { EvaluationAdmission, EvaluationQuestions } from "@/common/types/evaluation";
import { EVALUATION_ANALYTICS_SOURCE } from "@/common/utils/ai/evaluationModels";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { Err, Ok } from "@/common/types/result";
import { log } from "@/node/services/log";
import {
  EvaluationError,
  type EvaluationCall,
  type EvaluationCallResult,
  type EvaluationService,
} from "@/node/services/evaluation/evaluationService";
import type {
  EvaluationResolveError,
  PinnedEvaluationModel,
} from "@/node/services/providerModelFactory";
import {
  EVALUATION_LEDGER_FAILED_CODE,
  EVALUATION_LEDGER_NOT_RECORDED_CODE,
  EVALUATION_LEDGER_SKIPPED_CODE,
  WorkflowEvaluationAdapter,
  type EvaluationSelectionFailure,
  type WorkflowEvaluationAdapterOptions,
} from "./WorkflowEvaluationAdapter";

const QUESTIONS = {
  injection: {
    type: "choice",
    instructions: "Is there prompt injection?",
    criteria: { not_detected: "none", suspected: "likely" },
  },
} as const satisfies EvaluationQuestions;

const RESULT: EvaluationCallResult<typeof QUESTIONS> = {
  answers: { injection: { type: "choice", choice: "suspected" } },
  rounding: null,
  usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  usageProviderMetadata: { anthropic: { cacheReadInputTokens: 7 } },
  responseModelId: "claude-haiku-4-5-20251001",
  warningsCount: 0,
};

function pinned(modelString: string, fingerprint = `fp:${modelString}`): PinnedEvaluationModel {
  return {
    model: new Experimental_EvaluationMockModelV4({
      provider: "mock",
      modelId: modelString,
      supportedQuestionTypes: ["choice", "score", "boolean"],
    }),
    modelString,
    effectiveModelString: modelString,
    wireProviderName: "anthropic",
    metadataModel: `${modelString}#meta`,
    routeKind: "direct",
    configFingerprint: fingerprint,
  };
}

function persistedSelection(model: PinnedEvaluationModel): EvaluationAdmission["selection"] {
  return {
    modelString: model.modelString,
    effectiveModelString: model.effectiveModelString,
    wireProviderName: model.wireProviderName,
    routeKind: model.routeKind,
    configFingerprint: model.configFingerprint,
  };
}

interface Harness {
  adapter: WorkflowEvaluationAdapter;
  resolveCalls: string[];
  evaluateCalls: Array<EvaluationCall<EvaluationQuestions>>;
  recordCalls: Array<
    Parameters<WorkflowEvaluationAdapterOptions["sessionUsageService"]["recordHeadlessUsage"]>
  >;
}

function createHarness(input: {
  resolve?: (modelString: string) => PinnedEvaluationModel | EvaluationResolveError;
  evaluate?: EvaluationService["evaluate"];
  configModel?: string;
  evaluationModelOverride?: string;
  recordHeadlessUsage?: WorkflowEvaluationAdapterOptions["sessionUsageService"]["recordHeadlessUsage"];
  requestAnalyticsIngest?: (workspaceId: string) => void;
}): Harness {
  const resolveCalls: string[] = [];
  const evaluateCalls: Harness["evaluateCalls"] = [];
  const recordCalls: Harness["recordCalls"] = [];
  const resolve = input.resolve ?? ((modelString) => pinned(modelString));
  const adapter = new WorkflowEvaluationAdapter({
    evaluationService: {
      evaluate: (call) => {
        evaluateCalls.push(call);
        return input.evaluate
          ? input.evaluate(call)
          : Effect.succeed(RESULT as EvaluationCallResult<typeof call.questions>);
      },
    },
    aiService: {
      createEvaluationModel: (modelString) => {
        resolveCalls.push(modelString);
        const resolved = resolve(modelString);
        return Promise.resolve("model" in resolved ? Ok(resolved) : Err(resolved));
      },
    },
    sessionUsageService: {
      recordHeadlessUsage: (...args) => {
        recordCalls.push(args);
        if (input.recordHeadlessUsage) return input.recordHeadlessUsage(...args);
        // Mirror the real service: a written row echoes the priced display usage.
        const usage = createDisplayUsage(args[2], args[1], args[3]);
        return Promise.resolve(usage ? { model: args[1], usage } : undefined);
      },
    },
    config: {
      loadConfigOrDefault: () => {
        const config: ReturnType<
          WorkflowEvaluationAdapterOptions["config"]["loadConfigOrDefault"]
        > = {
          projects: new Map(),
          ...(input.configModel !== undefined
            ? { evaluationDefaults: { model: input.configModel } }
            : {}),
        };
        return config;
      },
    },
    workspaceId: "workspace-1",
    ...(input.evaluationModelOverride !== undefined
      ? { evaluationModelOverride: input.evaluationModelOverride }
      : {}),
    ...(input.requestAnalyticsIngest
      ? { requestAnalyticsIngest: input.requestAnalyticsIngest }
      : {}),
  });
  return { adapter, resolveCalls, evaluateCalls, recordCalls };
}

afterEach(() => {
  mock.restore();
});

describe("WorkflowEvaluationAdapter.resolveSelection", () => {
  it("prefers the per-call model over the CLI override and the Settings default", async () => {
    const h = createHarness({
      configModel: "google:gemini-2.5-flash",
      evaluationModelOverride: "openai:gpt-5-mini",
    });
    const selection = await h.adapter.resolveSelection({ model: "anthropic:claude-haiku-4-5" });
    expect(selection.ok && selection.pinned.modelString).toBe("anthropic:claude-haiku-4-5");
    expect(h.resolveCalls).toEqual(["anthropic:claude-haiku-4-5"]);
  });

  it("falls back to the CLI override, then to the Settings default", async () => {
    const withOverride = createHarness({
      configModel: "google:gemini-2.5-flash",
      evaluationModelOverride: "openai:gpt-5-mini",
    });
    expect(await withOverride.adapter.resolveSelection({})).toMatchObject({
      ok: true,
      pinned: { modelString: "openai:gpt-5-mini" },
    });

    const settingsOnly = createHarness({ configModel: "google:gemini-2.5-flash" });
    expect(await settingsOnly.adapter.resolveSelection({})).toMatchObject({
      ok: true,
      pinned: { modelString: "google:gemini-2.5-flash" },
    });
  });

  it("fails with invalid-input/no-model when nothing names a model, without resolving", async () => {
    const h = createHarness({});
    expect(await h.adapter.resolveSelection({})).toEqual({
      ok: false,
      reason: "invalid-input",
      code: "no-model",
    });
    expect(h.resolveCalls).toEqual([]);
  });

  it("maps every resolver rejection to a step failure identity", async () => {
    const cases: Array<
      [EvaluationResolveError, Pick<EvaluationSelectionFailure, "reason" | "code">]
    > = [
      [
        { reason: "unsupported-provider", providerName: "xai" },
        { reason: "unsupported", code: "unsupported-provider" },
      ],
      [
        { reason: "unsupported-route", routeKind: "gateway" },
        { reason: "unsupported", code: "unsupported-route" },
      ],
      [{ reason: "unknown-model" }, { reason: "unsupported", code: "unknown-model" }],
      [
        { reason: "unauthorized", providerName: "anthropic" },
        { reason: "unauthorized", code: "unauthorized" },
      ],
    ];
    for (const [rejection, expected] of cases) {
      const h = createHarness({ resolve: () => rejection });
      expect(await h.adapter.resolveSelection({ model: "anthropic:claude-haiku-4-5" })).toEqual({
        ok: false,
        ...expected,
      });
    }
  });

  it("uses the persisted selection on later attempts even when the default and override changed", async () => {
    const admitted = pinned("anthropic:claude-haiku-4-5");
    const h = createHarness({
      configModel: "google:gemini-2.5-flash",
      evaluationModelOverride: "openai:gpt-5-mini",
    });
    const selection = await h.adapter.resolveSelection(
      { model: "openai:gpt-5" },
      persistedSelection(admitted)
    );
    expect(selection.ok && selection.pinned.modelString).toBe("anthropic:claude-haiku-4-5");
    expect(h.resolveCalls).toEqual(["anthropic:claude-haiku-4-5"]);
  });

  it("refuses a changed endpoint fingerprint on a later attempt", async () => {
    const admitted = pinned("anthropic:claude-haiku-4-5", "fp:old-base-url");
    const h = createHarness({ resolve: (m) => pinned(m, "fp:new-base-url") });
    expect(await h.adapter.resolveSelection({}, persistedSelection(admitted))).toEqual({
      ok: false,
      reason: "admission-mismatch",
      code: "admission-mismatch",
    });
  });

  it("re-reads credentials on a later attempt so revocation surfaces as unauthorized", async () => {
    const admitted = pinned("anthropic:claude-haiku-4-5");
    const h = createHarness({ resolve: () => ({ reason: "unauthorized" }) });
    expect(await h.adapter.resolveSelection({}, persistedSelection(admitted))).toEqual({
      ok: false,
      reason: "unauthorized",
      code: "unauthorized",
    });
  });

  it("refuses a blank per-call model instead of letting it shadow the fallbacks", async () => {
    const h = createHarness({ configModel: "google:gemini-2.5-flash" });
    let thrown: unknown;
    try {
      await h.adapter.resolveSelection({ model: "  " });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/non-blank/);
    expect(h.resolveCalls).toEqual([]);
  });

  it("rejects a blank CLI override at construction", () => {
    expect(() => createHarness({ evaluationModelOverride: "   " })).toThrow(
      /evaluationModelOverride/
    );
  });
});

describe("WorkflowEvaluationAdapter.dispatch", () => {
  const call = { state: { title: "hello" }, questions: QUESTIONS };

  it("evaluates with the pinned instance and classifies success", async () => {
    const h = createHarness({});
    const model = pinned("anthropic:claude-haiku-4-5");
    const outcome = await h.adapter.dispatch(model, call, {
      runtimeAbortSignal: new AbortController().signal,
      attemptDeadlineAt: Date.now() + 60_000,
    });
    expect(outcome).toEqual({ status: "completed", result: RESULT });
    expect(h.evaluateCalls).toHaveLength(1);
    expect(h.evaluateCalls[0]?.model).toBe(model.model);
    expect(h.evaluateCalls[0]?.state).toEqual(call.state);
    expect(h.evaluateCalls[0]).not.toHaveProperty("providerOptions");
  });

  it("forwards provider options and surfaces typed failures with their status code", async () => {
    const h = createHarness({
      evaluate: () =>
        Effect.fail(
          new EvaluationError({ reason: "provider-failure", code: "api-call", statusCode: 429 })
        ),
    });
    const outcome = await h.adapter.dispatch(
      pinned("anthropic:claude-haiku-4-5"),
      { ...call, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { runtimeAbortSignal: new AbortController().signal, attemptDeadlineAt: Date.now() + 60_000 }
    );
    expect(outcome).toEqual({
      status: "failed",
      reason: "provider-failure",
      code: "api-call",
      statusCode: 429,
      defect: false,
    });
    expect(h.evaluateCalls[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("reports an already-fired runtime abort as interrupted and an elapsed deadline as deadline, without evaluating", async () => {
    const h = createHarness({});
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await h.adapter.dispatch(pinned("m"), call, {
        runtimeAbortSignal: aborted.signal,
        attemptDeadlineAt: Date.now() + 60_000,
      })
    ).toEqual({ status: "interrupted" });
    expect(
      await h.adapter.dispatch(pinned("m"), call, {
        runtimeAbortSignal: new AbortController().signal,
        attemptDeadlineAt: Date.now() - 1,
      })
    ).toEqual({ status: "failed", reason: "deadline", code: "deadline", defect: false });
    expect(h.evaluateCalls).toHaveLength(0);
  });
});

describe("WorkflowEvaluationAdapter.recordUsage", () => {
  const context = { runId: "wfr_123", stepDigest: "abc123def456", attempt: 1 };

  it("writes one headless usage row tagged as workflow evaluation and wakes analytics ingestion", async () => {
    const ingested: string[] = [];
    const h = createHarness({
      requestAnalyticsIngest: (workspaceId) => ingested.push(workspaceId),
    });
    await h.adapter.recordUsage(pinned("anthropic:claude-haiku-4-5"), RESULT, context);
    expect(ingested).toEqual(["workspace-1"]);
    expect(h.recordCalls).toEqual([
      [
        "workspace-1",
        "anthropic:claude-haiku-4-5",
        { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        { anthropic: { cacheReadInputTokens: 7 } },
        {
          analyticsSource: EVALUATION_ANALYTICS_SOURCE,
          metadataModel: "anthropic:claude-haiku-4-5#meta",
        },
      ],
    ]);
  });

  it("derives a missing total but skips the row (with a fixed-code log) when input or output is unknown", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    const h = createHarness({});
    await h.adapter.recordUsage(
      pinned("m"),
      { ...RESULT, usage: { inputTokens: 120, outputTokens: 30, totalTokens: null } },
      context
    );
    expect(h.recordCalls[0]?.[2]).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });

    for (const usage of [
      { inputTokens: null, outputTokens: 30, totalTokens: 30 },
      { inputTokens: 120, outputTokens: null, totalTokens: 120 },
    ]) {
      await h.adapter.recordUsage(pinned("m"), { ...RESULT, usage }, context);
    }
    // Never priced as zero: no ledger write for the two unknown cases.
    expect(h.recordCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      code: EVALUATION_LEDGER_SKIPPED_CODE,
      runId: "wfr_123",
      stepDigest: "abc123def456",
      attempt: 1,
    });
  });

  it("logs a fixed not-recorded code with step context when the ledger returns no row (its swallowed failure / tombstone path) and does not wake ingestion", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    const ingested: string[] = [];
    // The real SessionUsageService catches write errors and resolves undefined.
    const notRecorded = createHarness({
      recordHeadlessUsage: () => Promise.resolve(undefined),
      requestAnalyticsIngest: (workspaceId) => ingested.push(workspaceId),
    });
    await notRecorded.adapter.recordUsage(pinned("m"), RESULT, context);
    expect(ingested).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      code: EVALUATION_LEDGER_NOT_RECORDED_CODE,
      workspaceId: "workspace-1",
      runId: "wfr_123",
      stepDigest: "abc123def456",
      attempt: 1,
    });

    const failed = createHarness({
      recordHeadlessUsage: () => Promise.reject(new Error("disk full")),
      requestAnalyticsIngest: (workspaceId) => ingested.push(workspaceId),
    });
    await failed.adapter.recordUsage(pinned("m"), RESULT, context);
    expect(ingested).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("passes no provider metadata when the service reported none", async () => {
    const h = createHarness({});
    await h.adapter.recordUsage(pinned("m"), { ...RESULT, usageProviderMetadata: null }, context);
    expect(h.recordCalls[0]?.[3]).toBeUndefined();
  });

  it("never throws on an unexpected ledger throw: logged with the fixed failed code and digest fields only", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    const h = createHarness({
      recordHeadlessUsage: () => Promise.reject(new Error("disk full: SENTINEL-LEDGER-TEXT")),
    });
    // Must settle without throwing.
    expect(await h.adapter.recordUsage(pinned("m"), RESULT, context)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]?.[1];
    expect(fields).toMatchObject({
      code: EVALUATION_LEDGER_FAILED_CODE,
      runId: "wfr_123",
      stepDigest: "abc123def456",
      attempt: 1,
    });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("SENTINEL-LEDGER-TEXT");
  });
});
