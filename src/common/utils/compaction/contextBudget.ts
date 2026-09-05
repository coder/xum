import { WARNING_ADVANCE_PERCENT } from "./autoCompactionCheck";
import type { SendMessageError } from "@/common/types/errors";
import { isMediaPart } from "@/common/utils/attachments/toolAttachmentParts";
import { isDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import assert from "@/common/utils/assert";
import {
  IMAGE_TOKEN_ESTIMATE,
  OUTPUT_RESERVE_TOKENS,
  SYSTEM_FLOOR_TOKENS_ESTIMATE,
  WARNING_RESERVE_TOKENS,
} from "@/common/constants/contextBudget";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";
import { extractToolJsonSchema } from "@/common/utils/tools/extractToolJsonSchema";

export type ContextBudgetExceeded = Extract<SendMessageError, { type: "context_budget_exceeded" }>;

/** Carries a typed preflight refusal across thinking-rebuild callbacks that cannot return Result. */
export class ContextBudgetExceededError extends Error {
  constructor(readonly budgetError: ContextBudgetExceeded) {
    super(
      `Assembled request for ${budgetError.model} exceeds its context budget (${budgetError.estimate} > ${budgetError.hardCeiling})`
    );
    this.name = "ContextBudgetExceededError";
  }
}

/** Unknown limits are not unlimited: the caller logs that preflight could not be applied. */
export function checkAssembledRequestBudget(
  payload: Parameters<typeof estimateAssembledRequestTokens>[0],
  options: { model: string; modelContextLimit: number | null | undefined }
): ContextBudgetExceeded | undefined {
  const limit = options.modelContextLimit;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return undefined;
  const hardCeiling = limit - OUTPUT_RESERVE_TOKENS;
  const estimate = estimateAssembledRequestTokens(payload);
  return estimate > hardCeiling
    ? { type: "context_budget_exceeded", model: options.model, estimate, hardCeiling }
    : undefined;
}

export interface StepBudgetInput {
  contextTokens: number;
  outputTokens: number;
  toolResultChars: number;
  imageParts: number;
  modelContextLimit: number | null | undefined;
  threshold: number;
  warningEmitted: boolean;
}

export interface StepBudgetEvaluation {
  decision: "continue" | "warn" | "rollover";
  flushOpportunity: boolean;
  projected: number;
  /** Undefined means unknown, not unlimited. The caller should log that limitation. */
  hardCeiling: number | undefined;
}

export function evaluateStepBudget(input: StepBudgetInput): StepBudgetEvaluation {
  for (const value of [
    input.contextTokens,
    input.outputTokens,
    input.toolResultChars,
    input.imageParts,
    input.threshold,
  ]) {
    assert(
      Number.isFinite(value) && value >= 0,
      "Context budget inputs must be finite and nonnegative"
    );
  }
  const projected =
    input.contextTokens +
    input.outputTokens +
    Math.ceil(input.toolResultChars / 4) +
    IMAGE_TOKEN_ESTIMATE * input.imageParts;
  const limit = input.modelContextLimit;
  const hardCeiling =
    limit != null && Number.isFinite(limit) && limit > 0
      ? limit - OUTPUT_RESERVE_TOKENS
      : undefined;
  const result: StepBudgetEvaluation = {
    decision: "continue",
    flushOpportunity: false,
    projected,
    hardCeiling,
  };
  // The auto-compaction Off setting disables proactive rollover, not request preflight.
  if (input.threshold >= 1 || hardCeiling === undefined || limit == null) return result;
  if (
    projected >= hardCeiling ||
    projected >= limit * ((input.threshold * 100 + FORCE_COMPACTION_BUFFER_PERCENT) / 100)
  ) {
    return { ...result, decision: "rollover" };
  }
  if (
    !input.warningEmitted &&
    projected >= limit * ((input.threshold * 100 - WARNING_ADVANCE_PERCENT) / 100)
  ) {
    // Never spend the last usable context tokens telling the agent to flush notes.
    return projected + WARNING_RESERVE_TOKENS < hardCeiling
      ? { ...result, decision: "warn", flushOpportunity: true }
      : { ...result, decision: "rollover" };
  }
  return result;
}

/** Count wire text and media separately, including media nested in tool-result data. */
export function estimateToolResultSize(result: unknown): {
  toolResultChars: number;
  imageParts: number;
} {
  let toolResultChars = 0;
  let imageParts = 0;
  const ancestors = new Set<object>();
  const stack: Array<{ value: unknown; leave?: boolean }> = [{ value: result }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const value = entry.value;
    if (value == null) continue;
    if (typeof value === "string") {
      if (/^data:[^;,]+;base64,/i.test(value)) imageParts += 1;
      else toolResultChars += value.length + 2;
      continue;
    }
    if (typeof value !== "object") {
      if (typeof value === "number" || typeof value === "boolean")
        toolResultChars += String(value).length;
      continue;
    }
    if (entry.leave) {
      ancestors.delete(value);
      continue;
    }
    if (ancestors.has(value)) continue;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      imageParts += 1;
      continue;
    }
    if (value instanceof URL) {
      toolResultChars += value.href.length;
      continue;
    }
    ancestors.add(value);
    stack.push({ value, leave: true });
    toolResultChars += 2;
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child });
      toolResultChars += value.length;
      continue;
    }
    const record = value as Record<string, unknown>;
    const mediaType = record.mediaType ?? record.mimeType;
    const displayOnly = isDisplayOnlyFilePart(value);
    const isMedia =
      isMediaPart(value) ||
      ["image", "file", "image_url", "image-url", "image-data", "file-data", "file-url"].includes(
        String(record.type)
      ) ||
      (typeof mediaType === "string" && /^(image|audio|video)\//.test(mediaType));
    if (isMedia && !displayOnly) imageParts += 1;
    for (const [key, child] of Object.entries(record)) {
      // Skip only this media object's payload. An outer tool result's `data`
      // can contain both ordinary text and more media and must still be walked.
      if ((isMedia || displayOnly) && ["data", "url", "image", "image_url"].includes(key)) continue;
      toolResultChars += key.length + 4;
      stack.push({ value: child });
    }
  }
  return { toolResultChars, imageParts };
}

function estimateContentTokens(content: unknown): number {
  const size = estimateToolResultSize(content);
  return Math.ceil(size.toolResultChars / 3.5) + size.imageParts * IMAGE_TOKEN_ESTIMATE;
}

export function estimateFreshRequestTokens(input: {
  userText: string;
  attachments?: readonly unknown[];
  leadIn?: string;
  systemFloorTokens?: number;
}): number {
  const systemFloorTokens = input.systemFloorTokens ?? SYSTEM_FLOOR_TOKENS_ESTIMATE;
  assert(
    Number.isFinite(systemFloorTokens) && systemFloorTokens >= 0,
    "System token floor must be finite and nonnegative"
  );
  return (
    systemFloorTokens +
    estimateContentTokens([input.userText, input.leadIn ?? "", ...(input.attachments ?? [])])
  );
}

/** Estimate the final wire payload, not just history: system and tool schemas count too. */
export function estimateAssembledRequestTokens(payload: {
  system?: unknown;
  tools?: Record<string, unknown>;
  messages: readonly unknown[];
}): number {
  let tokens = estimateContentTokens([payload.system, ...payload.messages]);
  for (const [name, tool] of Object.entries(payload.tools ?? {})) {
    const record = tool as { description?: unknown; type?: unknown; id?: unknown; args?: unknown };
    const wireTool =
      record.type === "provider" || record.type === "provider-defined"
        ? { name, id: record.id, args: record.args }
        : { name, description: record.description, parameters: extractToolJsonSchema(tool) };
    // Schemas are text, even if they describe image/data properties.
    tokens += Math.ceil(JSON.stringify(wireTool).length / 3.5);
  }
  return tokens;
}
