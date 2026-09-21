import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { EvaluationError } from "./evaluationService";
import { classifyEvaluationExit, runEvaluationToOutcome } from "./evaluationOutcome";

const STATE_SENTINEL = "STATE-SENTINEL-91c2";

/** An effect that only settles when its fiber is interrupted (records the SDK-facing signal). */
function hangUntilInterrupted(onSignal?: (signal: AbortSignal) => void) {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<never>((_resolve, reject) => {
        onSignal?.(signal);
        signal.addEventListener("abort", () => reject(new Error(`aborted ${STATE_SENTINEL}`)));
      }),
    catch: () => new EvaluationError({ reason: "provider-failure", code: "unknown" }),
  });
}

describe("runEvaluationToOutcome", () => {
  it("completes with the effect's value", async () => {
    const outcome = await runEvaluationToOutcome(Effect.succeed({ answers: 1 }), {
      runtimeAbortSignal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    expect(outcome).toEqual({ status: "completed", result: { answers: 1 } });
  });

  it("reports a typed EvaluationError as a non-defect failure with its status code", async () => {
    const outcome = await runEvaluationToOutcome(
      Effect.fail(
        new EvaluationError({ reason: "provider-failure", code: "api-call", statusCode: 429 })
      ),
      { runtimeAbortSignal: new AbortController().signal, timeoutMs: 1_000 }
    );
    expect(outcome).toEqual({
      status: "failed",
      reason: "provider-failure",
      code: "api-call",
      statusCode: 429,
      defect: false,
    });
  });

  it("omits statusCode when the error has none", async () => {
    const outcome = await runEvaluationToOutcome(
      Effect.fail(new EvaluationError({ reason: "invalid-output", code: "answer-validation" })),
      { runtimeAbortSignal: new AbortController().signal, timeoutMs: 1_000 }
    );
    expect(outcome).toEqual({
      status: "failed",
      reason: "invalid-output",
      code: "answer-validation",
      defect: false,
    });
  });

  it("classifies a runtime abort as interrupted and aborts the in-flight provider signal", async () => {
    const runtime = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const pending = runEvaluationToOutcome(
      hangUntilInterrupted((signal) => {
        providerSignal = signal;
      }),
      { runtimeAbortSignal: runtime.signal, timeoutMs: 60_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(providerSignal?.aborted).toBe(false);
    runtime.abort();
    expect(await pending).toEqual({ status: "interrupted" });
    expect(providerSignal?.aborted).toBe(true);
  });

  it("classifies an expired attempt budget as a deadline failure", async () => {
    const outcome = await runEvaluationToOutcome(hangUntilInterrupted(), {
      runtimeAbortSignal: new AbortController().signal,
      timeoutMs: 10,
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "deadline",
      code: "deadline",
      defect: false,
    });
  });

  it("accepts an absolute deadline and treats a past deadline as an immediate timeout", async () => {
    const outcome = await runEvaluationToOutcome(hangUntilInterrupted(), {
      runtimeAbortSignal: new AbortController().signal,
      deadlineAt: Date.now() - 1,
    });
    expect(outcome).toMatchObject({ status: "failed", reason: "deadline" });
  });

  it("lets the runtime abort win when both the timeout and the runtime signal fired", async () => {
    // Pre-aborted runtime signal + zero budget: both reasons are present at once.
    const runtime = new AbortController();
    runtime.abort();
    const outcome = await runEvaluationToOutcome(hangUntilInterrupted(), {
      runtimeAbortSignal: runtime.signal,
      timeoutMs: 0,
    });
    expect(outcome).toEqual({ status: "interrupted" });
  });

  it("reports a defect distinctly from a provider failure and never leaks its message", async () => {
    const outcome = await runEvaluationToOutcome(
      Effect.sync(() => {
        throw new Error(`exploded while holding ${STATE_SENTINEL}`);
      }),
      { runtimeAbortSignal: new AbortController().signal, timeoutMs: 1_000 }
    );
    expect(outcome).toEqual({
      status: "failed",
      reason: "provider-failure",
      code: "unknown",
      defect: true,
    });
    expect(JSON.stringify(outcome)).not.toContain(STATE_SENTINEL);

    const providerFailure = await runEvaluationToOutcome(
      Effect.fail(new EvaluationError({ reason: "provider-failure", code: "unknown" })),
      { runtimeAbortSignal: new AbortController().signal, timeoutMs: 1_000 }
    );
    expect(providerFailure).toMatchObject({ status: "failed", code: "unknown", defect: false });
    expect(providerFailure).not.toEqual(outcome);
  });

  it("requires exactly one attempt budget option", async () => {
    const runtimeAbortSignal = new AbortController().signal;
    const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
        return undefined;
      } catch (error) {
        return error;
      }
    };
    expect(
      await rejectionOf(() => runEvaluationToOutcome(Effect.succeed(1), { runtimeAbortSignal }))
    ).toBeInstanceOf(Error);
    expect(
      await rejectionOf(() =>
        runEvaluationToOutcome(Effect.succeed(1), {
          runtimeAbortSignal,
          timeoutMs: 10,
          deadlineAt: Date.now() + 10,
        })
      )
    ).toBeInstanceOf(Error);
  });
});

describe("classifyEvaluationExit", () => {
  it("classifies a success exit without consulting the runtime signal", () => {
    const runtime = new AbortController();
    runtime.abort();
    expect(classifyEvaluationExit(Exit.succeed("ok"), runtime.signal)).toEqual({
      status: "completed",
      result: "ok",
    });
  });
});
