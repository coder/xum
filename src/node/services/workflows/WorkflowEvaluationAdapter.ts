import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { Effect } from "effect";
import type {
  EvaluationAdmission,
  EvaluationQuestions,
  EvaluationState,
  EvaluationStepFailureCode,
  EvaluationStepFailureReason,
  WorkflowEvaluateSpec,
} from "@/common/types/evaluation";
import { EVALUATION_ANALYTICS_SOURCE } from "@/common/utils/ai/evaluationModels";
import assert from "@/common/utils/assert";
import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import {
  runEvaluationToOutcome,
  type EvaluationOutcome,
} from "@/node/services/evaluation/evaluationOutcome";
import type {
  EvaluationCallResult,
  EvaluationService,
} from "@/node/services/evaluation/evaluationService";
import { log } from "@/node/services/log";
import type {
  EvaluationResolveError,
  PinnedEvaluationModel,
} from "@/node/services/providerModelFactory";
import type { SessionUsageService } from "@/node/services/sessionUsageService";

/**
 * Promise-facing seam between `WorkflowRunner`'s `evaluate()` step and the
 * Effect `EvaluationService`. It owns the three decisions the runner must not
 * make itself:
 *
 * 1. **Selection** — which model string an attempt uses. On a first attempt
 *    the precedence is per-call `model` > CLI `--evaluation-model` > Settings
 *    `evaluationDefaults.model`; every later attempt (resume, checkpoint retry)
 *    uses the *persisted* admission and refuses a changed endpoint fingerprint,
 *    so Settings edits never silently redirect an admitted step.
 * 2. **Dispatch** — one billable call bounded by the attempt deadline and the
 *    runtime abort signal, classified via `runEvaluationToOutcome`.
 * 3. **Accounting** — the headless usage row, written after the runner has
 *    committed the completed record (see `runEvaluationStep`); it never throws.
 *
 * The adapter has no journal access and never sees credentials: `aiService`
 * returns an instance plus a non-secret fingerprint only.
 */
export interface WorkflowEvaluationAdapterOptions {
  readonly evaluationService: EvaluationService;
  readonly aiService: Pick<AIService, "createEvaluationModel">;
  readonly sessionUsageService: Pick<SessionUsageService, "recordHeadlessUsage">;
  readonly config: Pick<Config, "loadConfigOrDefault">;
  readonly workspaceId: string;
  /** CLI `--evaluation-model`: beats the Settings default, loses to a per-call `model`. */
  readonly evaluationModelOverride?: string;
}

export interface EvaluationSelectionFailure {
  readonly ok: false;
  readonly reason: EvaluationStepFailureReason;
  readonly code: EvaluationStepFailureCode;
}

export type EvaluationSelection =
  | { readonly ok: true; readonly pinned: PinnedEvaluationModel }
  | EvaluationSelectionFailure;

export interface EvaluationDispatchOptions {
  readonly runtimeAbortSignal: AbortSignal;
  /** Absolute attempt deadline (epoch ms); preparation time already counted against it. */
  readonly attemptDeadlineAt: number;
}

export interface EvaluationDispatchCall<Q extends EvaluationQuestions> {
  readonly state: EvaluationState;
  readonly questions: Q;
  readonly providerOptions?: SharedV4ProviderOptions;
}

/** Identifiers the ledger-failure log line may carry (digest/number fields only). */
export interface EvaluationUsageContext {
  readonly runId: string;
  readonly stepDigest: string;
  readonly attempt: number;
}

export const EVALUATION_LEDGER_FAILED_CODE = "evaluation-ledger-failed";

/**
 * `createEvaluationModel` rejections → step failure identity. Exhaustive so a
 * new resolver reason cannot fall through to a misleading code.
 */
const RESOLVE_FAILURES: Record<
  EvaluationResolveError["reason"],
  Pick<EvaluationSelectionFailure, "reason" | "code">
> = {
  "unsupported-provider": { reason: "unsupported", code: "unsupported-provider" },
  "unsupported-route": { reason: "unsupported", code: "unsupported-route" },
  "unknown-model": { reason: "unsupported", code: "unknown-model" },
  unauthorized: { reason: "unauthorized", code: "unauthorized" },
};

export class WorkflowEvaluationAdapter {
  constructor(private readonly options: WorkflowEvaluationAdapterOptions) {
    assert(options.workspaceId.length > 0, "WorkflowEvaluationAdapter requires a workspaceId");
    assert(
      options.evaluationModelOverride === undefined ||
        options.evaluationModelOverride.trim().length > 0,
      "evaluationModelOverride must be a non-blank model string when provided"
    );
  }

  /**
   * Resolve the model for one attempt.
   *
   * `persisted` is the admitted selection of an earlier attempt of the same
   * step. When present it is authoritative: the current Settings default and
   * CLI override are ignored, and a resolution whose `configFingerprint`
   * differs from the admitted one is `admission-mismatch` (endpoint changed
   * underneath a partially executed step). Every call re-reads credentials, so
   * a revoked key surfaces as `unauthorized` even on resume.
   */
  async resolveSelection(
    spec: Pick<WorkflowEvaluateSpec, "model">,
    persisted?: EvaluationAdmission["selection"]
  ): Promise<EvaluationSelection> {
    const modelString = persisted
      ? persisted.modelString
      : (spec.model ??
        this.options.evaluationModelOverride ??
        this.options.config.loadConfigOrDefault().evaluationDefaults?.model);
    if (modelString === undefined) {
      return { ok: false, reason: "invalid-input", code: "no-model" };
    }

    const resolved = await this.options.aiService.createEvaluationModel(modelString);
    if (!resolved.success) {
      return { ok: false, ...RESOLVE_FAILURES[resolved.error.reason] };
    }
    if (persisted && resolved.data.configFingerprint !== persisted.configFingerprint) {
      return { ok: false, reason: "admission-mismatch", code: "admission-mismatch" };
    }
    return { ok: true, pinned: resolved.data };
  }

  /**
   * One billable attempt; interruption and deadline are outcomes, never throws
   * for those. `Effect.suspend` defers even building the service call until the
   * bridge has passed its already-aborted / already-expired pre-checks, so an
   * attempt that cannot run touches nothing.
   */
  dispatch<const Q extends EvaluationQuestions>(
    pinned: PinnedEvaluationModel,
    call: EvaluationDispatchCall<Q>,
    options: EvaluationDispatchOptions
  ): Promise<EvaluationOutcome<EvaluationCallResult<Q>>> {
    return runEvaluationToOutcome(
      Effect.suspend(() =>
        this.options.evaluationService.evaluate({
          model: pinned.model,
          state: call.state,
          questions: call.questions,
          ...(call.providerOptions !== undefined ? { providerOptions: call.providerOptions } : {}),
        })
      ),
      { runtimeAbortSignal: options.runtimeAbortSignal, deadlineAt: options.attemptDeadlineAt }
    );
  }

  /**
   * Write the headless usage row for a completed attempt. Called only after the
   * completed step record is durable, so a failure here must never turn a
   * committed step into a failed one: it is logged with a fixed code and
   * swallowed. There is no idempotency key — a crash between the journal
   * commit and this write under-counts that attempt (documented contract).
   */
  async recordUsage(
    pinned: Pick<PinnedEvaluationModel, "modelString" | "metadataModel">,
    result: Pick<EvaluationCallResult<EvaluationQuestions>, "usage" | "usageProviderMetadata">,
    context: EvaluationUsageContext
  ): Promise<void> {
    try {
      await this.options.sessionUsageService.recordHeadlessUsage(
        this.options.workspaceId,
        pinned.modelString,
        toAiSdkUsage(result.usage),
        toProviderMetadataRecord(result.usageProviderMetadata),
        { analyticsSource: EVALUATION_ANALYTICS_SOURCE, metadataModel: pinned.metadataModel }
      );
    } catch (error) {
      // Deliberately no `error` text: it may echo provider payloads.
      log.warn("Workflow evaluation usage ledger write failed", {
        code: EVALUATION_LEDGER_FAILED_CODE,
        workspaceId: this.options.workspaceId,
        runId: context.runId,
        stepDigest: context.stepDigest,
        attempt: context.attempt,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

/** Unknown counts are `null` in the step result but absent for the ledger. */
function toAiSdkUsage(usage: EvaluationCallResult<EvaluationQuestions>["usage"]): AiSdkUsageLike {
  return {
    ...(usage.inputTokens !== null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== null ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== null ? { totalTokens: usage.totalTokens } : {}),
  };
}

function toProviderMetadataRecord(
  metadata: EvaluationCallResult<EvaluationQuestions>["usageProviderMetadata"]
): Record<string, unknown> | undefined {
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata }
    : undefined;
}
