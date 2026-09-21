import { z } from "zod";
import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type {
  AutoModelRoutingClassifierStatus,
  AutoModelRoutingDecision,
  AutoModelRoutingTier,
} from "@/common/types/autoModelRouting";
import {
  AUTO_MODEL_ROUTING_API_KEY_ENV_VARS,
  AUTO_MODEL_ROUTING_CLASSIFIER_MODEL,
  AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS,
  AUTO_MODEL_ROUTING_MAX_PROMPT_CHARS,
  AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT,
  AUTO_MODEL_ROUTING_RECENT_MESSAGE_MAX_CHARS,
  TYPESAFE_API_BASE_URL,
  TYPESAFE_PROVIDER_KEY,
  TYPESAFE_SYSTEM_ONE_PATH,
} from "@/constants/autoModelRouting";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import type { ProvidersConfigStore } from "@/node/config/providersConfigStore";
import type { PolicyService } from "@/node/services/policyService";
import { resolveApiKeyCandidate } from "@/node/utils/providerRequirements";
import { log } from "@/node/services/log";

const QUESTION_ID = "difficulty";
const QUESTION_INSTRUCTIONS =
  "Which difficulty tier best describes the work this coding-agent prompt asks for? " +
  "Judge scope, ambiguity, how many files or systems are involved, and how much reasoning is needed.";
const ERROR_BODY_MAX_CHARS = 200;

const SystemOneResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.object({
      type: z.string().optional(),
      choice: z.string(),
      probabilities: z.record(z.string(), z.number()).optional(),
      confidence: z.number().optional(),
    })
  ),
});

export interface AutoModelRouterClassifyInput {
  prompt: string;
  /** Prior user prompts, oldest first, for conversational context. */
  recentUserMessages?: string[];
  tiers: AutoModelRoutingTier[];
  signal?: AbortSignal;
}

export interface AutoModelRouterDeps {
  providersConfigStore: Pick<ProvidersConfigStore, "loadProvidersConfig">;
  /**
   * Prompts are third-party egress, so provider policy gates the classifier like any
   * provider model: `typesafe` must be listed, its `model_access` must admit the
   * classifier, and a forced `base_url` redirects the request.
   */
  policyService?: Pick<PolicyService, "isEnforced" | "isModelAllowed" | "getForcedBaseUrl">;
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Difficulty classifier for the auto-model-routing experiment. One Jev System
 * One "choice" question whose options are the user's tier descriptions; every
 * failure is an Err so the caller falls back to the composer's model. No retries.
 */
export class AutoModelRouter {
  constructor(private readonly deps: AutoModelRouterDeps) {}

  getClassifierStatus(): AutoModelRoutingClassifierStatus {
    const resolved = this.resolveApiKey();
    return { apiKeySource: resolved.kind === "resolved" ? resolved.source : "none" };
  }

  async classify(
    input: AutoModelRouterClassifyInput
  ): Promise<Result<AutoModelRoutingDecision, string>> {
    if (input.tiers.length < 2) {
      return Err("Auto model routing needs at least two tiers");
    }
    const enforcedPolicy = this.deps.policyService?.isEnforced()
      ? this.deps.policyService
      : undefined;
    if (
      enforcedPolicy &&
      !enforcedPolicy.isModelAllowed(TYPESAFE_PROVIDER_KEY, AUTO_MODEL_ROUTING_CLASSIFIER_MODEL)
    ) {
      return Err("Provider policy does not allow TypeSafe");
    }
    const baseUrl =
      enforcedPolicy?.getForcedBaseUrl(TYPESAFE_PROVIDER_KEY) ?? TYPESAFE_API_BASE_URL;
    const url = baseUrl.replace(/\/+$/, "") + TYPESAFE_SYSTEM_ONE_PATH;
    const resolved = this.resolveApiKey();
    if (resolved.kind !== "resolved") {
      return Err("No TypeSafe API key configured");
    }

    const recentUserMessages = (input.recentUserMessages ?? [])
      .slice(-AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT)
      .map((text) => text.slice(0, AUTO_MODEL_ROUTING_RECENT_MESSAGE_MAX_CHARS));
    const body = {
      state: {
        prompt: input.prompt.slice(0, AUTO_MODEL_ROUTING_MAX_PROMPT_CHARS),
        ...(recentUserMessages.length > 0 ? { recentUserMessages } : {}),
      },
      model: AUTO_MODEL_ROUTING_CLASSIFIER_MODEL,
      questions: {
        [QUESTION_ID]: {
          type: "choice",
          instructions: QUESTION_INSTRUCTIONS,
          criteria: Object.fromEntries(input.tiers.map((tier) => [tier.id, tier.description])),
        },
      },
    };

    const timeoutSignal = AbortSignal.timeout(AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const startedAt = Date.now();
    const doFetch = this.deps.fetch ?? ((url, init) => fetch(url, init));
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resolved.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return this.fail(
        timeoutSignal.aborted
          ? `Classifier timed out after ${AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS}ms`
          : `Classifier request failed: ${getErrorMessage(error)}`
      );
    }

    if (!response.ok) {
      // The reason is persisted in message metadata, so keep upstream body text out of it.
      const text = await response.text().catch(() => "");
      log.debug("Auto model routing classifier error body", {
        status: response.status,
        body: text.slice(0, ERROR_BODY_MAX_CHARS),
      });
      return this.fail(`Classifier returned HTTP ${response.status}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      return this.fail(`Classifier returned invalid JSON: ${getErrorMessage(error)}`);
    }
    const parsed = SystemOneResponseSchema.safeParse(json);
    const answer = parsed.success ? parsed.data.answers[QUESTION_ID] : undefined;
    if (!parsed.success || !answer) {
      return this.fail("Classifier response did not contain the difficulty answer");
    }
    const tierIds = new Set(input.tiers.map((tier) => tier.id));
    if (!tierIds.has(answer.choice)) {
      return this.fail(`Classifier chose an unknown tier "${answer.choice}"`);
    }

    const decision: AutoModelRoutingDecision = {
      tierId: answer.choice,
      confidence: answer.confidence ?? 0,
      // The map is persisted on the message row and rendered per entry, so only the
      // configured tiers' probabilities are kept; anything else is noise from upstream.
      probabilities: Object.fromEntries(
        Object.entries(answer.probabilities ?? {}).filter(([tierId]) => tierIds.has(tierId))
      ),
      classifierModel: parsed.data.model ?? "",
    };
    log.debug("Auto model routing classified prompt", {
      tierId: decision.tierId,
      confidence: decision.confidence,
      latencyMs: Date.now() - startedAt,
    });
    return Ok(decision);
  }

  private fail(reason: string): Result<AutoModelRoutingDecision, string> {
    log.warn("Auto model routing classifier failed; falling back to the selected model", {
      reason,
    });
    return Err(reason);
  }

  private resolveApiKey() {
    const providersConfig = this.deps.providersConfigStore.loadProvidersConfig() ?? {};
    const entry = (providersConfig as Record<string, unknown>)[TYPESAFE_PROVIDER_KEY];
    // The id is reserved for new custom providers, but an older install may still hold a
    // custom chat provider under it; never send that provider's key to TypeSafe.
    const config =
      typeof entry === "object" && entry !== null && !isCustomProviderConfig(entry)
        ? (entry as { apiKey?: unknown; apiKeyFile?: unknown })
        : {};
    return resolveApiKeyCandidate(config, {
      envApiKeys: [...AUTO_MODEL_ROUTING_API_KEY_ENV_VARS],
      env: this.deps.env ?? process.env,
      fileErrors: "ignore",
    });
  }
}
