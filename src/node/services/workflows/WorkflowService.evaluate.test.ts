/* eslint-disable @typescript-eslint/await-thenable -- Bun's `expect(...).rejects` is not typed as thenable */
/**
 * Checkpoint retry of a run that failed on an `evaluate()` step (UAT finding
 * C2): the service must admit the retry and the runner must re-attempt the
 * step with its persisted admission instead of refusing the failed run.
 */
import { describe, expect, test } from "bun:test";
import type { EvaluationOutcome } from "@/node/services/evaluation/evaluationOutcome";
import type { EvaluationCallResult } from "@/node/services/evaluation/evaluationService";
import type { PinnedEvaluationModel } from "@/node/services/providerModelFactory";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { WorkflowEvaluationPort } from "./workflowEvaluationStep";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowService } from "./WorkflowService";
import type { ResolvedWorkflowScript } from "./workflowScriptResolver";

type Outcome = EvaluationOutcome<EvaluationCallResult<never>>;

const COMPLETED: Outcome = {
  status: "completed",
  result: {
    answers: { ok: { type: "boolean", probability: 0.9 } },
    rounding: null,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    usageProviderMetadata: null,
    responseModelId: "fixture-model",
    warningsCount: 0,
  } as unknown as EvaluationCallResult<never>,
};
const PROVIDER_FAILURE = {
  status: "failed",
  reason: "provider-failure",
  code: "api-call",
  statusCode: 503,
  defect: false,
} as unknown as Outcome;

function createFakeEvaluation(outcomes: Outcome[]) {
  const pinned: PinnedEvaluationModel = {
    model: Object.create(null) as PinnedEvaluationModel["model"],
    modelString: "openai:gpt-5",
    effectiveModelString: "openai:gpt-5",
    wireProviderName: "openai",
    metadataModel: "openai:gpt-5",
    routeKind: "direct",
    configFingerprint: "fp",
  };
  const resolutions: Array<{ persistedAttempt: number | undefined }> = [];
  let dispatches = 0;
  const adapter: WorkflowEvaluationPort = {
    resolveSelection(_spec, persisted) {
      resolutions.push({ persistedAttempt: persisted === undefined ? undefined : 1 });
      return Promise.resolve({ ok: true as const, pinned });
    },
    dispatch: (() => {
      const outcome = outcomes[dispatches] ?? COMPLETED;
      dispatches += 1;
      return Promise.resolve(outcome);
    }) as WorkflowEvaluationPort["dispatch"],
    recordUsage() {
      return Promise.resolve();
    },
  };
  return { adapter, resolutions, dispatchCount: () => dispatches };
}

function script(source: string): ResolvedWorkflowScript {
  return {
    requestedScriptPath: "./workflows/demo.js",
    canonicalScriptPath: "./workflows/demo.js",
    source,
    sourceHash: "sha256:test",
    sourceKind: "workspace-file",
    resolvedPath: "/workspace/workflows/demo.js",
  };
}

const EVALUATE_SOURCE = `export default function workflow({ evaluate }) {
  const result = evaluate("probe", {
    id: "probe",
    questions: { ok: { type: "boolean", instructions: "Is it ok?" } },
  });
  return { reportMarkdown: "evaluated", structuredOutput: result };
}
`;

function createService(sessionDir: string, evaluation: WorkflowEvaluationPort, runId: string) {
  const runStore = new WorkflowRunStore({ sessionDir });
  const service = new WorkflowService({
    runStore,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: {
      runAgent() {
        return Promise.reject(new Error("No agent steps expected"));
      },
    },
    evaluationAdapter: evaluation,
    generateRunId: () => runId,
    runnerId: "runner-a",
    clock: { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() },
  });
  return { service, runStore };
}

describe("WorkflowService checkpoint retry of failed evaluate() steps", () => {
  test("a run failed by a provider error re-attempts the step with its persisted admission", async () => {
    using tmp = new DisposableTempDir("workflow-service-evaluate-retry");
    const evaluation = createFakeEvaluation([PROVIDER_FAILURE, COMPLETED]);
    const { service, runStore } = createService(tmp.path, evaluation.adapter, "wfr_eval_retry");

    await expect(
      service.startWorkflow({
        script: script(EVALUATE_SOURCE),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: {},
      })
    ).rejects.toThrow(/evaluation failed: provider-failure\/api-call status 503/);
    const failed = await runStore.getRun("wfr_eval_retry");
    expect(failed.status).toBe("failed");
    expect(failed.steps[0]).toMatchObject({ status: "failed", evaluation: { attempt: 1 } });

    const retried = await service.retryRunFromCheckpoint({
      workspaceId: "workspace-1",
      runId: "wfr_eval_retry",
      projectTrusted: true,
    });

    expect(retried.status).toBe("completed");
    expect(evaluation.dispatchCount()).toBe(2);
    // Every resolution after the first attempt saw the persisted admission
    // (no fresh selection); the lifecycle may re-check credentials before dispatch.
    expect(evaluation.resolutions[0]).toEqual({ persistedAttempt: undefined });
    expect(evaluation.resolutions.length).toBeGreaterThanOrEqual(2);
    expect(evaluation.resolutions.slice(1).every((r) => r.persistedAttempt === 1)).toBe(true);
    const run = await runStore.getRun("wfr_eval_retry");
    expect(run.status).toBe("completed");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      status: "completed",
      evaluation: { attempt: 2, selection: { modelString: "openai:gpt-5" } },
    });
  });

  test("a run failed by the author after catching the evaluation error is still not retryable", async () => {
    using tmp = new DisposableTempDir("workflow-service-evaluate-caught");
    const evaluation = createFakeEvaluation([PROVIDER_FAILURE]);
    const { service } = createService(tmp.path, evaluation.adapter, "wfr_eval_caught");

    await expect(
      service.startWorkflow({
        script: script(`export default function workflow({ evaluate }) {
  try {
    evaluate("probe", { id: "probe", questions: { ok: { type: "boolean", instructions: "Is it ok?" } } });
  } catch (error) {
    throw new Error("author decided to stop: " + error.message);
  }
  return { reportMarkdown: "unreachable" };
}
`),
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: {},
      })
    ).rejects.toThrow(/author decided to stop/);

    await expect(
      service.retryRunFromCheckpoint({
        workspaceId: "workspace-1",
        runId: "wfr_eval_caught",
        projectTrusted: true,
      })
    ).rejects.toThrow("Workflow run cannot be retried from checkpoint");
    expect(evaluation.dispatchCount()).toBe(1);
  });
});
