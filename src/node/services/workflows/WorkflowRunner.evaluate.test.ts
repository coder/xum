/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import { describe, expect, spyOn, test } from "bun:test";
import type {
  EvaluationAdmission,
  EvaluationQuestions,
  EvaluationStepResult,
} from "@/common/types/evaluation";
import { canRetryWorkflowFromCheckpoint } from "@/common/utils/workflowRetryEligibility";
import {
  EVALUATION_DEFAULT_TIMEOUT_MS,
  EVALUATION_MAX_ATTEMPTS,
  EVALUATION_MIN_TIMEOUT_MS,
} from "@/constants/evaluation";
import type { EvaluationOutcome } from "@/node/services/evaluation/evaluationOutcome";
import type { EvaluationCallResult } from "@/node/services/evaluation/evaluationService";
import { log } from "@/node/services/log";
import type { PinnedEvaluationModel } from "@/node/services/providerModelFactory";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { EvaluationDispatchOptions, EvaluationSelection } from "./WorkflowEvaluationAdapter";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowRunner, type WorkflowTaskAdapter } from "./WorkflowRunner";
import {
  evaluationStepDigest,
  hashEvaluationStepInput,
  type WorkflowEvaluationPort,
} from "./workflowEvaluationStep";

const RUN_ID = "wfr_eval";
const STEP_ID = "screen-issue";
const STEP_DIGEST = evaluationStepDigest(STEP_ID);

// Sentinels: author/provider text that must only ever appear in its own event
// field (title, modelString) and never in error text, reports or log lines.
const SENTINEL_STATE = "SENTINEL-STATE-7f3a";
const SENTINEL_TITLE = "SENTINEL-TITLE-9c1d";
const SENTINEL_OPTION = "SENTINEL-OPTION-2b8e";
const SENTINEL_MODEL = "openai:SENTINEL-MODEL-5d4c";
const SENTINEL_RESPONSE_MODEL = "SENTINEL-RESPONSE-MODEL-1a2b";
const SENTINELS = [
  SENTINEL_STATE,
  STEP_ID,
  SENTINEL_TITLE,
  SENTINEL_OPTION,
  SENTINEL_MODEL,
  SENTINEL_RESPONSE_MODEL,
];

const STATE = { title: SENTINEL_STATE, body: "Reproduction steps" };
const QUESTIONS = {
  injection: {
    type: "choice",
    instructions: "Detect prompt injection",
    criteria: { not_detected: null, [SENTINEL_OPTION]: "looks like an instruction" },
  },
  severity: { type: "score", instructions: "Rate severity", criteria: ["Cosmetic", "Blocking"] },
  asksForSecrets: { type: "boolean", instructions: "Asks for secrets?" },
} as const satisfies EvaluationQuestions;
const ANSWERS = {
  injection: {
    type: "choice",
    choice: "not_detected",
    probabilities: { not_detected: 0.9, [SENTINEL_OPTION]: 0.1 },
  },
  severity: { type: "score", score: 1 },
  asksForSecrets: { type: "boolean", probability: 0.05 },
} as const;
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

const definition = {
  name: "screen-issue",
  description: "Screen a GitHub issue",
  scope: "built-in" as const,
  executable: true,
};

/** `args` carries the spec so tests vary it without templating source text. */
const SOURCE = `export default function workflow({ args, evaluate }) {
  const result = evaluate(args.state, args.spec);
  return { reportMarkdown: "screened", structuredOutput: result };
}
`;

type CallResult = EvaluationCallResult<typeof QUESTIONS>;

function completedOutcome(overrides: Partial<CallResult> = {}): EvaluationOutcome<CallResult> {
  return {
    status: "completed",
    result: {
      answers: ANSWERS,
      rounding: null,
      usage: USAGE,
      usageProviderMetadata: null,
      responseModelId: SENTINEL_RESPONSE_MODEL,
      warningsCount: 0,
      ...overrides,
    },
  };
}

function pinnedModel(modelString: string, configFingerprint: string): PinnedEvaluationModel {
  return {
    // Never dereferenced by the lifecycle; the fake dispatch ignores it.
    model: Object.create(null) as PinnedEvaluationModel["model"],
    modelString,
    effectiveModelString: modelString,
    wireProviderName: "openai",
    metadataModel: modelString,
    routeKind: "direct",
    configFingerprint,
  };
}

interface ResolveCall {
  model: string | undefined;
  persisted: EvaluationAdmission["selection"] | undefined;
}
interface DispatchCall {
  pinned: PinnedEvaluationModel;
  call: { state: unknown; questions: unknown; providerOptions?: unknown };
  options: EvaluationDispatchOptions;
}

interface FakeAdapterOptions {
  /** Settings/CLI default the fake applies when neither a per-call model nor a persisted selection exists. */
  defaultModel?: string | (() => string | undefined);
  fingerprint?: (resolveIndex: number) => string;
  /** Override for one resolution; `undefined` keeps the default behaviour. */
  selection?: (input: ResolveCall & { index: number }) => EvaluationSelection | undefined;
  outcome?: (
    input: DispatchCall & { index: number }
  ) => EvaluationOutcome<CallResult> | Promise<EvaluationOutcome<CallResult>>;
  recordUsage?: () => Promise<void>;
}

function createFakeAdapter(options: FakeAdapterOptions = {}) {
  const resolveCalls: ResolveCall[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const usageCalls: Array<{
    modelString: string;
    runId: string;
    stepDigest: string;
    attempt: number;
  }> = [];
  const pinnedByResolve: PinnedEvaluationModel[] = [];
  const adapter: WorkflowEvaluationPort = {
    async resolveSelection(spec, persisted) {
      const index = resolveCalls.length;
      resolveCalls.push({ model: spec.model, persisted });
      const override = options.selection?.({ model: spec.model, persisted, index });
      if (override !== undefined) {
        return override;
      }
      const fallback =
        typeof options.defaultModel === "function" ? options.defaultModel() : options.defaultModel;
      const modelString = persisted?.modelString ?? spec.model ?? fallback;
      if (modelString === undefined) {
        return { ok: false, reason: "invalid-input", code: "no-model" };
      }
      const pinned = pinnedModel(modelString, options.fingerprint?.(index) ?? "fp-1");
      pinnedByResolve.push(pinned);
      if (persisted !== undefined && persisted.configFingerprint !== pinned.configFingerprint) {
        return { ok: false, reason: "admission-mismatch", code: "admission-mismatch" };
      }
      return { ok: true, pinned };
    },
    dispatch: (async (pinned, call, dispatchOptions) => {
      const index = dispatchCalls.length;
      const record: DispatchCall = { pinned, call, options: dispatchOptions };
      dispatchCalls.push(record);
      return options.outcome === undefined
        ? completedOutcome()
        : await options.outcome({ ...record, index });
    }) as WorkflowEvaluationPort["dispatch"],
    async recordUsage(pinned, _result, context) {
      usageCalls.push({ modelString: pinned.modelString, ...context });
      await options.recordUsage?.();
    },
  };
  return { adapter, resolveCalls, dispatchCalls, usageCalls, pinnedByResolve };
}

interface RunFixtureOptions {
  spec?: Record<string, unknown>;
  state?: unknown;
  source?: string;
}

async function createStore(sessionDir: string, options: RunFixtureOptions = {}) {
  const store = new WorkflowRunStore({ sessionDir, staleLeaseMs: 100 });
  await store.createRun({
    id: RUN_ID,
    workspaceId: "workspace-1",
    workflow: definition,
    source: options.source ?? SOURCE,
    args: {
      state: options.state ?? STATE,
      spec: { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS, ...options.spec },
    },
    now: "2026-05-29T00:00:00.000Z",
  });
  return store;
}

const noAgentSteps: WorkflowTaskAdapter = {
  async runAgent() {
    throw new Error("No agent steps expected");
  },
};

function createClock(startMs = 1_000) {
  let nowMs = startMs;
  return {
    nowIso: () => new Date(nowMs).toISOString(),
    nowMs: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function createRunner(
  store: WorkflowRunStore,
  evaluationAdapter: WorkflowEvaluationPort | undefined,
  options: { clock?: ReturnType<typeof createClock>; taskAdapter?: WorkflowTaskAdapter } = {}
) {
  return new WorkflowRunner({
    runStore: store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: options.taskAdapter ?? noAgentSteps,
    evaluationAdapter,
    runnerId: "runner-a",
    clock: options.clock ?? createClock(),
  });
}

const EXPECTED_RESULT_SHAPE = {
  answers: ANSWERS,
  rounding: null,
  usage: USAGE,
  model: { modelString: SENTINEL_MODEL, responseModelId: SENTINEL_RESPONSE_MODEL },
};

async function readStep(store: WorkflowRunStore) {
  const run = await store.getRun(RUN_ID);
  return run.steps.find((step) => step.stepId === STEP_ID);
}

function evaluationEvents(run: Awaited<ReturnType<WorkflowRunStore["getRun"]>>) {
  return run.events.filter((event) => event.type === "evaluation");
}

function errorMessages(run: Awaited<ReturnType<WorkflowRunStore["getRun"]>>): string[] {
  return run.events.flatMap((event) => (event.type === "error" ? [event.message] : []));
}

function expectNoSentinels(text: string | undefined, allowed: string[] = []) {
  for (const sentinel of SENTINELS) {
    if (allowed.includes(sentinel)) continue;
    expect(text ?? "").not.toContain(sentinel);
  }
}

/** Seed a completed evaluate step as an older run would have left it. */
async function seedCompletedStep(
  store: WorkflowRunStore,
  input: { result: EvaluationStepResult; admission?: EvaluationAdmission }
) {
  const spec = { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS };
  const inputHash = hashEvaluationStepInput(spec, STATE);
  await store.recordStepStarted(RUN_ID, {
    stepId: STEP_ID,
    inputHash,
    startedAt: "2026-05-29T00:00:00.500Z",
    ...(input.admission !== undefined ? { evaluation: input.admission } : {}),
  });
  await store.recordStepCompleted(RUN_ID, {
    stepId: STEP_ID,
    inputHash,
    result: {
      reportMarkdown: "Evaluation step completed (3 answers)",
      structuredOutput: input.result,
    },
    startedAt: "2026-05-29T00:00:00.500Z",
    completedAt: "2026-05-29T00:00:00.900Z",
    ...(input.admission !== undefined ? { evaluation: input.admission } : {}),
  });
  return inputHash;
}

function admissionFor(input: {
  attempt: number;
  modelString?: string;
  fingerprint?: string;
}): EvaluationAdmission {
  return {
    attempt: input.attempt,
    selection: {
      modelString: input.modelString ?? SENTINEL_MODEL,
      effectiveModelString: input.modelString ?? SENTINEL_MODEL,
      wireProviderName: "openai",
      routeKind: "direct",
      configFingerprint: input.fingerprint ?? "fp-1",
    },
    timeoutMs: EVALUATION_DEFAULT_TIMEOUT_MS,
    attemptDeadlineAt: "2026-05-29T00:01:00.000Z",
    stateSha256: "seeded",
    stateBytes: 1,
    questionsSha256: "seeded",
    questionCount: 3,
  };
}

const storedResult: EvaluationStepResult = {
  ...EXPECTED_RESULT_SHAPE,
  state: { sha256: "seeded", bytes: 1 },
};

describe("hashEvaluationStepInput", () => {
  const base = { id: STEP_ID, questions: QUESTIONS };

  test("request-shaping inputs change the replay key; execution config does not", () => {
    const key = hashEvaluationStepInput(base, STATE);
    expect(hashEvaluationStepInput({ ...base, title: "other", timeoutMs: 9_000 }, STATE)).toBe(key);
    expect(hashEvaluationStepInput({ ...base, model: SENTINEL_MODEL }, STATE)).not.toBe(key);
    expect(
      hashEvaluationStepInput(
        { ...base, providerOptions: { openai: { reasoningEffort: "low" } } },
        STATE
      )
    ).not.toBe(key);
    expect(
      hashEvaluationStepInput(
        { ...base, providerOptions: { openai: { reasoningEffort: "low" } } },
        STATE
      )
    ).not.toBe(
      hashEvaluationStepInput(
        { ...base, providerOptions: { openai: { reasoningEffort: "high" } } },
        STATE
      )
    );
    expect(hashEvaluationStepInput(base, { ...STATE, body: "changed" })).not.toBe(key);
  });
});

describe("WorkflowRunner evaluate()", () => {
  test("happy path: admits once, dispatches once, commits then accounts", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const fake = createFakeAdapter();
    const runner = createRunner(store, fake.adapter);

    const result = await runner.run(RUN_ID);

    expect(result.reportMarkdown).toBe("screened");
    expect(result.structuredOutput).toMatchObject(EXPECTED_RESULT_SHAPE);
    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("completed");
    const step = await readStep(store);
    expect(step).toMatchObject({ status: "completed", evaluation: { attempt: 1 } });
    expect(step?.taskId).toBeUndefined();
    expect(step?.evaluation).toMatchObject({
      selection: { modelString: SENTINEL_MODEL, configFingerprint: "fp-1" },
      timeoutMs: EVALUATION_DEFAULT_TIMEOUT_MS,
      questionCount: 3,
    });
    expect(step?.result?.structuredOutput).toEqual(result.structuredOutput);
    // Resolution runs twice (selection + pre-dispatch recheck) but bills once.
    expect(fake.resolveCalls).toHaveLength(2);
    expect(fake.resolveCalls[1]?.persisted).toMatchObject({ modelString: SENTINEL_MODEL });
    expect(fake.dispatchCalls).toHaveLength(1);
    expect(fake.dispatchCalls[0]?.call).toEqual({ state: STATE, questions: QUESTIONS });
    expect(fake.usageCalls).toEqual([
      { modelString: SENTINEL_MODEL, runId: RUN_ID, stepDigest: STEP_DIGEST, attempt: 1 },
    ]);
    expect(evaluationEvents(run).map((event) => event.status)).toEqual(["started", "completed"]);
    expect(evaluationEvents(run)[1]).toMatchObject({
      title: SENTINEL_TITLE,
      modelString: SENTINEL_MODEL,
      responseModelId: SENTINEL_RESPONSE_MODEL,
      usage: USAGE,
      attempt: 1,
    });
  });

  test("dispatches the re-resolved instance and clamps the requested timeout", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL, timeoutMs: 1 } });
    const clock = createClock(5_000);
    const fake = createFakeAdapter();
    const runner = createRunner(store, fake.adapter, { clock });

    await runner.run(RUN_ID);

    expect(fake.pinnedByResolve).toHaveLength(2);
    expect(fake.dispatchCalls[0]?.pinned).toBe(fake.pinnedByResolve[1]);
    expect(fake.dispatchCalls[0]?.options.attemptDeadlineAt).toBe(
      5_000 + EVALUATION_MIN_TIMEOUT_MS
    );
    expect((await readStep(store))?.evaluation?.timeoutMs).toBe(EVALUATION_MIN_TIMEOUT_MS);
  });

  test("replays a completed step across a checkpoint retry without dispatching", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, {
      spec: { model: SENTINEL_MODEL },
      source: `export default function workflow({ args, evaluate, agent }) {
  const result = evaluate(args.state, args.spec);
  const summary = agent("Summarize", { id: "summarize" });
  return { reportMarkdown: summary, structuredOutput: result };
}
`,
    });
    const fake = createFakeAdapter();
    let agentCalls = 0;
    const taskAdapter: WorkflowTaskAdapter = {
      async runAgent() {
        agentCalls += 1;
        if (agentCalls === 1) {
          throw new Error("agent exploded");
        }
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
    };

    await expect(runner(store, fake, taskAdapter).run(RUN_ID)).rejects.toThrow(/agent exploded/);
    await expect(store.getRun(RUN_ID)).resolves.toMatchObject({ status: "failed" });
    const firstResult = (await readStep(store))?.result?.structuredOutput;

    const retried = await runner(store, fake, taskAdapter).run(RUN_ID, {
      allowRetryFromFailedCheckpoint: true,
    });

    expect(retried.structuredOutput).toEqual(firstResult);
    expect(fake.dispatchCalls).toHaveLength(1);
    expect(fake.resolveCalls).toHaveLength(2);
    expect(fake.usageCalls).toHaveLength(1);
    const run = await store.getRun(RUN_ID);
    expect(evaluationEvents(run).map((event) => event.status)).toEqual([
      "started",
      "completed",
      "cached",
    ]);
    expect(evaluationEvents(run)[2]).toMatchObject({ attempt: 1, modelString: SENTINEL_MODEL });

    function runner(s: WorkflowRunStore, f: typeof fake, t: WorkflowTaskAdapter) {
      return createRunner(s, f.adapter, { taskAdapter: t });
    }
  });

  test("a malformed cached result fails the run without touching the record or dispatching", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    const corrupt: EvaluationStepResult = {
      ...storedResult,
      answers: { ...ANSWERS, injection: { type: "choice", choice: "never-an-option" } },
    };
    await seedCompletedStep(store, { result: corrupt, admission: admissionFor({ attempt: 1 }) });
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:01.000Z");
    const fake = createFakeAdapter();

    await expect(
      createRunner(store, fake.adapter).run(RUN_ID, { allowResumeFromInterrupted: true })
    ).rejects.toThrow(`evaluation replay failed: cached result invalid (step ${STEP_DIGEST})`);

    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(fake.resolveCalls).toHaveLength(0);
    expect(fake.dispatchCalls).toHaveLength(0);
    const step = await readStep(store);
    expect(step?.status).toBe("completed");
    expect(step?.result?.structuredOutput).toEqual(corrupt);
    expect(evaluationEvents(run)).toHaveLength(0);
    for (const message of errorMessages(run)) expectNoSentinels(message);
  });

  test("a provider failure records one failed attempt with its admission and no retry", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const fake = createFakeAdapter({
      outcome: () => ({
        status: "failed",
        reason: "provider-failure",
        code: "api-call",
        statusCode: 500,
        defect: false,
      }),
    });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      `evaluation failed: provider-failure/api-call status 500 (step ${STEP_DIGEST}, attempt 1)`
    );

    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(fake.dispatchCalls).toHaveLength(1);
    expect(fake.usageCalls).toHaveLength(0);
    const step = await readStep(store);
    expect(step).toMatchObject({
      status: "failed",
      error: `evaluation failed: provider-failure/api-call status 500 (step ${STEP_DIGEST}, attempt 1)`,
      evaluation: { attempt: 1, selection: { modelString: SENTINEL_MODEL } },
    });
    expect(evaluationEvents(run).at(-1)).toMatchObject({
      status: "failed",
      attempt: 1,
      reason: "provider-failure",
      code: "api-call",
      statusCode: 500,
      modelString: SENTINEL_MODEL,
    });
    expectNoSentinels(step?.error);
    for (const message of errorMessages(run)) expectNoSentinels(message);
  });

  test("checkpoint retry of a failed attempt pins the persisted selection, not the new default", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    let defaultModel = SENTINEL_MODEL;
    let fail = true;
    const fake = createFakeAdapter({
      defaultModel: () => defaultModel,
      outcome: () =>
        fail
          ? { status: "failed", reason: "provider-failure", code: "api-call", defect: false }
          : completedOutcome(),
    });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(/attempt 1\)/);
    defaultModel = "openai:changed-default";
    fail = false;

    const result = await createRunner(store, fake.adapter).run(RUN_ID, {
      allowRetryFromFailedCheckpoint: true,
    });

    expect(result.structuredOutput).toMatchObject({
      model: { modelString: SENTINEL_MODEL },
    });
    expect(
      fake.resolveCalls.slice(2).every((call) => call.persisted?.modelString === SENTINEL_MODEL)
    ).toBe(true);
    const step = await readStep(store);
    expect(step).toMatchObject({
      status: "completed",
      evaluation: { attempt: 2, selection: { modelString: SENTINEL_MODEL } },
    });
    expect(fake.dispatchCalls).toHaveLength(2);
    expect(fake.dispatchCalls[1]?.pinned.modelString).toBe(SENTINEL_MODEL);
    const run = await store.getRun(RUN_ID);
    expect(evaluationEvents(run).map((event) => [event.status, event.attempt])).toEqual([
      ["started", 1],
      ["failed", 1],
      ["started", 2],
      ["completed", 2],
    ]);
  });

  test("resuming a started attempt reuses its admission as attempt 2", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    const spec = { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS };
    await store.recordStepStarted(RUN_ID, {
      stepId: STEP_ID,
      inputHash: hashEvaluationStepInput(spec, STATE),
      startedAt: "2026-05-29T00:00:00.500Z",
      evaluation: admissionFor({ attempt: 1 }),
    });
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:01.000Z");
    const fake = createFakeAdapter({ defaultModel: "openai:changed-default" });

    await createRunner(store, fake.adapter).run(RUN_ID, { allowResumeFromInterrupted: true });

    expect(fake.resolveCalls[0]?.persisted?.modelString).toBe(SENTINEL_MODEL);
    expect(fake.dispatchCalls[0]?.pinned.modelString).toBe(SENTINEL_MODEL);
    expect(await readStep(store)).toMatchObject({
      status: "completed",
      startedAt: "2026-05-29T00:00:00.500Z",
      evaluation: { attempt: 2, selection: { modelString: SENTINEL_MODEL } },
    });
  });

  test("resume with a changed endpoint fingerprint fails admission-mismatch without dispatching", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    const spec = { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS };
    await store.recordStepStarted(RUN_ID, {
      stepId: STEP_ID,
      inputHash: hashEvaluationStepInput(spec, STATE),
      startedAt: "2026-05-29T00:00:00.500Z",
      evaluation: admissionFor({ attempt: 1, fingerprint: "fp-old" }),
    });
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:01.000Z");
    const fake = createFakeAdapter();

    await expect(
      createRunner(store, fake.adapter).run(RUN_ID, { allowResumeFromInterrupted: true })
    ).rejects.toThrow(
      `evaluation failed: admission-mismatch/admission-mismatch (step ${STEP_DIGEST}, attempt 2)`
    );

    expect(fake.dispatchCalls).toHaveLength(0);
    expect(await readStep(store)).toMatchObject({
      status: "failed",
      evaluation: { attempt: 1, selection: { configFingerprint: "fp-old" } },
    });
  });

  test("a started record without an admission fails closed as admission-missing", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    const spec = { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS };
    await store.recordStepStarted(RUN_ID, {
      stepId: STEP_ID,
      inputHash: hashEvaluationStepInput(spec, STATE),
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:01.000Z");
    const fake = createFakeAdapter({ defaultModel: SENTINEL_MODEL });

    await expect(
      createRunner(store, fake.adapter).run(RUN_ID, { allowResumeFromInterrupted: true })
    ).rejects.toThrow(
      `evaluation failed: admission-missing/admission-missing (step ${STEP_DIGEST}, attempt 1)`
    );

    expect(fake.resolveCalls).toHaveLength(0);
    expect(fake.dispatchCalls).toHaveLength(0);
    const step = await readStep(store);
    expect(step?.status).toBe("failed");
    expect(step?.evaluation).toBeUndefined();
  });

  test("a failed record whose admission is malformed fails closed as admission-missing", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    const spec = { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS };
    const inputHash = hashEvaluationStepInput(spec, STATE);
    await store.recordStepStarted(RUN_ID, {
      stepId: STEP_ID,
      inputHash,
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await store.recordStepFailed(RUN_ID, {
      stepId: STEP_ID,
      inputHash,
      error: "evaluation failed: provider-failure/api-call (step x, attempt 1)",
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.900Z",
    });
    await store.appendStatus(RUN_ID, "failed", "2026-05-29T00:00:01.000Z");
    const fake = createFakeAdapter({ defaultModel: SENTINEL_MODEL });

    await expect(
      createRunner(store, fake.adapter).run(RUN_ID, { allowRetryFromFailedCheckpoint: true })
    ).rejects.toThrow(/admission-missing/);
    expect(fake.dispatchCalls).toHaveLength(0);
  });

  test("the attempt budget is enforced before any resolution", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    const spec = { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS };
    const inputHash = hashEvaluationStepInput(spec, STATE);
    const admission = admissionFor({ attempt: EVALUATION_MAX_ATTEMPTS });
    await store.recordStepStarted(RUN_ID, {
      stepId: STEP_ID,
      inputHash,
      startedAt: "2026-05-29T00:00:00.500Z",
      evaluation: admission,
    });
    await store.recordStepFailed(RUN_ID, {
      stepId: STEP_ID,
      inputHash,
      error: "evaluation failed: provider-failure/api-call (step x, attempt 3)",
      startedAt: "2026-05-29T00:00:00.500Z",
      completedAt: "2026-05-29T00:00:00.900Z",
      evaluation: admission,
    });
    await store.appendStatus(RUN_ID, "failed", "2026-05-29T00:00:01.000Z");
    const fake = createFakeAdapter();

    await expect(
      createRunner(store, fake.adapter).run(RUN_ID, { allowRetryFromFailedCheckpoint: true })
    ).rejects.toThrow(
      `evaluation failed: attempts-exhausted/attempts-exhausted (step ${STEP_DIGEST}, attempt ${EVALUATION_MAX_ATTEMPTS + 1})`
    );

    expect(fake.resolveCalls).toHaveLength(0);
    expect(fake.dispatchCalls).toHaveLength(0);
    expect(await readStep(store)).toMatchObject({
      status: "failed",
      evaluation: { attempt: EVALUATION_MAX_ATTEMPTS },
    });
  });

  test("a deadline elapsed during first-attempt preparation writes no step record", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const clock = createClock();
    const fake = createFakeAdapter({
      selection: ({ index }) => {
        if (index === 0) clock.advance(EVALUATION_DEFAULT_TIMEOUT_MS);
        return undefined;
      },
    });

    await expect(createRunner(store, fake.adapter, { clock }).run(RUN_ID)).rejects.toThrow(
      `evaluation failed: deadline/deadline (step ${STEP_DIGEST}, attempt 1)`
    );

    expect(fake.dispatchCalls).toHaveLength(0);
    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(run.steps).toHaveLength(0);
    expect(evaluationEvents(run)).toHaveLength(0);
  });

  test("a deadline elapsed after admission records a failed attempt without dispatching", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const clock = createClock();
    const fake = createFakeAdapter({
      selection: ({ index }) => {
        if (index === 1) clock.advance(EVALUATION_DEFAULT_TIMEOUT_MS);
        return undefined;
      },
    });

    await expect(createRunner(store, fake.adapter, { clock }).run(RUN_ID)).rejects.toThrow(
      /deadline\/deadline/
    );

    expect(fake.dispatchCalls).toHaveLength(0);
    expect(await readStep(store)).toMatchObject({
      status: "failed",
      evaluation: { attempt: 1 },
    });
  });

  test("a deadline during dispatch is a failed attempt", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const fake = createFakeAdapter({
      outcome: () => ({ status: "failed", reason: "deadline", code: "deadline", defect: false }),
    });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      `evaluation failed: deadline/deadline (step ${STEP_DIGEST}, attempt 1)`
    );
    expect((await readStep(store))?.status).toBe("failed");
  });

  test("a runtime abort during dispatch leaves the started record and writes no terminal step", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const controller = new AbortController();
    const fake = createFakeAdapter({
      outcome: async ({ options }) => {
        controller.abort();
        await new Promise<void>((resolve) =>
          options.runtimeAbortSignal.aborted
            ? resolve()
            : options.runtimeAbortSignal.addEventListener("abort", () => resolve(), { once: true })
        );
        return { status: "interrupted" };
      },
    });

    await expect(
      createRunner(store, fake.adapter).run(RUN_ID, { abortSignal: controller.signal })
    ).rejects.toThrow();

    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("running");
    expect(await readStep(store)).toMatchObject({ status: "started", evaluation: { attempt: 1 } });
    expect(evaluationEvents(run).map((event) => event.status)).toEqual(["started"]);
    expect(fake.usageCalls).toHaveLength(0);
  });

  test("a completion committed before Stop is preserved and replays on resume", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, {
      spec: { model: SENTINEL_MODEL },
      source: `export default function workflow({ args, evaluate, agent }) {
  const result = evaluate(args.state, args.spec);
  agent("Summarize", { id: "summarize" });
  return { reportMarkdown: "done", structuredOutput: result };
}
`,
    });
    const controller = new AbortController();
    const fake = createFakeAdapter();
    let agentCalls = 0;
    const taskAdapter: WorkflowTaskAdapter = {
      async runAgent(_spec, _lifecycle, waitOptions) {
        agentCalls += 1;
        if (agentCalls === 1) {
          const signal = waitOptions?.abortSignal;
          if (signal == null) throw new Error("missing abort signal");
          controller.abort();
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
          }
          throw new Error("Task interrupted");
        }
        return { taskId: "task_1", reportMarkdown: "summary", structuredOutput: {} };
      },
    };

    await expect(
      createRunner(store, fake.adapter, { taskAdapter }).run(RUN_ID, {
        abortSignal: controller.signal,
      })
    ).rejects.toThrow();
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:02.000Z");

    const resumed = await createRunner(store, fake.adapter, { taskAdapter }).run(RUN_ID, {
      allowResumeFromInterrupted: true,
    });

    expect(resumed.structuredOutput).toMatchObject(EXPECTED_RESULT_SHAPE);
    expect(fake.dispatchCalls).toHaveLength(1);
    expect(fake.usageCalls).toHaveLength(1);
  });

  test("lease loss between selection and dispatch prevents the dispatch", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    let renewCalls = 0;
    let resolveLeaseLost!: () => void;
    const leaseLost = new Promise<void>((resolve) => {
      resolveLeaseLost = resolve;
    });
    let allowLoss = false;
    store.renewLease = async () => {
      renewCalls += 1;
      if (!allowLoss) return true;
      resolveLeaseLost();
      return false;
    };
    const fake = createFakeAdapter();
    const originalResolve = fake.adapter.resolveSelection;
    let resolveIndex = 0;
    fake.adapter.resolveSelection = async (spec, persisted) => {
      const selection = await originalResolve(spec, persisted);
      if (resolveIndex++ === 1) {
        allowLoss = true;
        await leaseLost;
        // Let the runner's renewal continuation mark the lease lost.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return selection;
    };

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(/lease lost/);

    expect(renewCalls).toBeGreaterThan(0);
    expect(fake.dispatchCalls).toHaveLength(0);
    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("running");
  });

  test("credential revocation on the pre-dispatch recheck fails the admitted attempt without dispatching", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const fake = createFakeAdapter({
      selection: ({ index }) =>
        index === 1 ? { ok: false, reason: "unauthorized", code: "unauthorized" } : undefined,
    });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      `evaluation failed: unauthorized/unauthorized (step ${STEP_DIGEST}, attempt 1)`
    );

    expect(fake.dispatchCalls).toHaveLength(0);
    expect(await readStep(store)).toMatchObject({
      status: "failed",
      evaluation: { attempt: 1, selection: { modelString: SENTINEL_MODEL } },
    });
  });

  test("an endpoint change on the pre-dispatch recheck fails admission-mismatch without dispatching", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const fake = createFakeAdapter({ fingerprint: (index) => (index === 0 ? "fp-1" : "fp-2") });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      /admission-mismatch\/admission-mismatch .* attempt 1\)/
    );

    expect(fake.dispatchCalls).toHaveLength(0);
    expect((await readStep(store))?.evaluation?.selection.configFingerprint).toBe("fp-1");
  });

  test("unauthorized on resume is written onto the persisted record so the run stays retryable", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    const spec = { id: STEP_ID, title: SENTINEL_TITLE, questions: QUESTIONS };
    await store.recordStepStarted(RUN_ID, {
      stepId: STEP_ID,
      inputHash: hashEvaluationStepInput(spec, STATE),
      startedAt: "2026-05-29T00:00:00.500Z",
      evaluation: admissionFor({ attempt: 1 }),
    });
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:01.000Z");
    let keyRevoked = true;
    const fake = createFakeAdapter({
      selection: () =>
        keyRevoked ? { ok: false, reason: "unauthorized", code: "unauthorized" } : undefined,
    });

    await expect(
      createRunner(store, fake.adapter).run(RUN_ID, { allowResumeFromInterrupted: true })
    ).rejects.toThrow(/unauthorized\/unauthorized .* attempt 2\)/);
    expect(fake.dispatchCalls).toHaveLength(0);

    // The `started` record is not left dangling: the failure lands on it with
    // the admission untouched (no billable attempt was admitted), which is what
    // makes the run's error traceable to this step for checkpoint retry.
    let run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(await readStep(store)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/unauthorized\/unauthorized .* attempt 2\)/) as unknown,
      evaluation: { attempt: 1 },
    });
    expect(canRetryWorkflowFromCheckpoint(run)).toBe(true);

    keyRevoked = false;
    const result = await createRunner(store, fake.adapter).run(RUN_ID, {
      allowRetryFromFailedCheckpoint: true,
    });

    expect(result.structuredOutput).toMatchObject(EXPECTED_RESULT_SHAPE);
    run = await store.getRun(RUN_ID);
    expect(run.status).toBe("completed");
    expect(await readStep(store)).toMatchObject({
      status: "completed",
      evaluation: { attempt: 2, selection: { modelString: SENTINEL_MODEL } },
    });
    expect(fake.dispatchCalls).toHaveLength(1);
  });

  test("pre-admission failures write no step record and a later retry starts at attempt 1", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    let defaultModel: string | undefined = undefined;
    const fake = createFakeAdapter({ defaultModel: () => defaultModel });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      `evaluation failed: invalid-input/no-model (step ${STEP_DIGEST}, attempt 1)`
    );
    let run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(run.steps).toHaveLength(0);
    expect(evaluationEvents(run)).toHaveLength(0);

    defaultModel = SENTINEL_MODEL;
    const result = await createRunner(store, fake.adapter).run(RUN_ID, {
      allowRetryFromFailedCheckpoint: true,
    });

    expect(result.structuredOutput).toMatchObject(EXPECTED_RESULT_SHAPE);
    run = await store.getRun(RUN_ID);
    expect(run.status).toBe("completed");
    expect(await readStep(store)).toMatchObject({
      status: "completed",
      evaluation: { attempt: 1 },
    });
    expect(fake.dispatchCalls).toHaveLength(1);
  });

  test("an unauthorized first resolution writes no step record", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const fake = createFakeAdapter({
      selection: () => ({ ok: false, reason: "unauthorized", code: "unauthorized" }),
    });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      /unauthorized\/unauthorized/
    );
    expect((await store.getRun(RUN_ID)).steps).toHaveLength(0);
  });

  test("a throwing usage ledger cannot fail a committed step", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const fake = createFakeAdapter({
        recordUsage: async () => {
          throw new Error(`ledger down ${SENTINEL_STATE}`);
        },
      });

      const result = await createRunner(store, fake.adapter).run(RUN_ID);

      expect(result.structuredOutput).toMatchObject(EXPECTED_RESULT_SHAPE);
      expect((await readStep(store))?.status).toBe("completed");
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, fields] = warn.mock.calls[0];
      expect(fields).toMatchObject({ code: "evaluation-post-commit-usage-failed", attempt: 1 });
      expectNoSentinels(JSON.stringify([message, fields]));

      const again = await createRunner(store, fake.adapter).run(RUN_ID, {
        allowResumeFromInterrupted: true,
      });
      expect(again.structuredOutput).toEqual(result.structuredOutput);
      expect(fake.dispatchCalls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a rejected completed-event append after commit keeps the step completed", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    const originalAppend = store.appendNextEvent.bind(store);
    const appendSpy = spyOn(store, "appendNextEvent").mockImplementation(
      async (runId, event, options) => {
        if (event.type === "evaluation" && event.status === "completed") {
          throw new Error("disk full");
        }
        return await originalAppend(runId, event, options);
      }
    );
    try {
      const fake = createFakeAdapter();

      const result = await createRunner(store, fake.adapter).run(RUN_ID);

      expect(result.structuredOutput).toMatchObject(EXPECTED_RESULT_SHAPE);
      const run = await store.getRun(RUN_ID);
      expect(run.status).toBe("completed");
      expect((await readStep(store))?.status).toBe("completed");
      expect(evaluationEvents(run).map((event) => event.status)).toEqual(["started"]);
      expect(fake.usageCalls).toHaveLength(1);
      expect(warn.mock.calls.map(([, fields]) => (fields as { code?: string }).code)).toContain(
        "evaluation-post-commit-event-failed"
      );
    } finally {
      appendSpy.mockRestore();
      warn.mockRestore();
    }
  });

  test("a rejected cached-event append on replay still returns the stored result", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path);
    await seedCompletedStep(store, {
      result: storedResult,
      admission: admissionFor({ attempt: 1 }),
    });
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:01.000Z");
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    const originalAppend = store.appendNextEvent.bind(store);
    const appendSpy = spyOn(store, "appendNextEvent").mockImplementation(
      async (runId, event, options) => {
        if (event.type === "evaluation" && event.status === "cached") {
          throw new Error("disk full");
        }
        return await originalAppend(runId, event, options);
      }
    );
    try {
      const fake = createFakeAdapter();

      const result = await createRunner(store, fake.adapter).run(RUN_ID, {
        allowResumeFromInterrupted: true,
      });

      expect(result.structuredOutput).toEqual(storedResult);
      expect(fake.dispatchCalls).toHaveLength(0);
      expect((await store.getRun(RUN_ID)).status).toBe("completed");
    } finally {
      appendSpy.mockRestore();
      warn.mockRestore();
    }
  });

  test("evaluate() inside parallel() is rejected before any host work", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, {
      spec: { model: SENTINEL_MODEL },
      source: `export default function workflow({ args, evaluate, parallel }) {
  const [result] = parallel([() => evaluate(args.state, args.spec)]);
  return { reportMarkdown: "unreachable", structuredOutput: result };
}
`,
    });
    const fake = createFakeAdapter();

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      "evaluate() cannot run inside parallel()/pipeline() yet; call it sequentially"
    );
    expect(fake.resolveCalls).toHaveLength(0);
    expect((await store.getRun(RUN_ID)).steps).toHaveLength(0);
  });

  test("evaluate() without an options object is rejected in the sandbox", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, {
      source: `export default function workflow({ args, evaluate }) {
  return { reportMarkdown: String(evaluate(args.state)) };
}
`,
    });
    const fake = createFakeAdapter();

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      "evaluate requires an options object"
    );
    expect(fake.resolveCalls).toHaveLength(0);
  });

  test("invalid spec and state fail before selection and carry no author text", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { questions: null } });
    const fake = createFakeAdapter({ defaultModel: SENTINEL_MODEL });

    await expect(createRunner(store, fake.adapter).run(RUN_ID)).rejects.toThrow(
      "evaluation failed: invalid-input/invalid-spec (step unknown, attempt 1)"
    );
    expect(fake.resolveCalls).toHaveLength(0);

    using tmp2 = new DisposableTempDir("workflow-eval");
    const store2 = await createStore(tmp2.path, { state: 42, spec: { model: SENTINEL_MODEL } });
    await expect(createRunner(store2, fake.adapter).run(RUN_ID)).rejects.toThrow(
      `evaluation failed: invalid-input/invalid-state (step ${STEP_DIGEST}, attempt 1)`
    );
    expect(fake.resolveCalls).toHaveLength(0);
    for (const message of errorMessages(await store2.getRun(RUN_ID))) expectNoSentinels(message);
  });

  test("a runtime without an evaluation adapter fails closed as runtime-unavailable", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });

    await expect(createRunner(store, undefined).run(RUN_ID)).rejects.toThrow(
      `evaluation failed: unsupported/runtime-unavailable (step ${STEP_DIGEST}, attempt 1)`
    );
    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(run.steps).toHaveLength(0);
  });

  test("sentinels appear only in their own display fields", async () => {
    using tmp = new DisposableTempDir("workflow-eval");
    const store = await createStore(tmp.path, { spec: { model: SENTINEL_MODEL } });
    const fake = createFakeAdapter();

    await createRunner(store, fake.adapter).run(RUN_ID);

    const run = await store.getRun(RUN_ID);
    const step = await readStep(store);
    expectNoSentinels(step?.result?.reportMarkdown);
    expectNoSentinels(step?.error);
    for (const message of errorMessages(run)) expectNoSentinels(message);
    for (const event of evaluationEvents(run)) {
      const { stepId, title, modelString, responseModelId, ...rest } = event;
      expect(stepId).toBe(STEP_ID);
      expect(title).toBe(SENTINEL_TITLE);
      expect(modelString).toBe(SENTINEL_MODEL);
      if (event.status === "completed") expect(responseModelId).toBe(SENTINEL_RESPONSE_MODEL);
      expectNoSentinels(JSON.stringify(rest));
    }
  });
});
