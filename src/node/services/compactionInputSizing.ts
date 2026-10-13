/**
 * Node-side sizing for the compaction input trim (trimCompactionInput).
 *
 * The trim sizes what the provider receives: the history after applyToolOutputRedaction
 * removes ui_only data and workflow-run records, which can be most of a tool result's bytes.
 * It also measures each row with the model's tokenizer (contextBudgetCounting): chars/4
 * undercounts dense text, about 5x for CJK and 8x for emoji. Measured on histories of about
 * 1M model tokens (480 to 800 rows, unique text), sizing takes 0.45 s (Claude) and 0.3 s
 * (GPT, 1.1 s with the first tokenizer load): small next to the compaction request itself.
 */
import { applyToolOutputRedaction } from "@/browser/utils/messages/applyToolOutputRedaction";
import type { MuxMessage } from "@/common/types/message";
import { getErrorMessage } from "@/common/utils/errors";
import {
  estimateCompactionInputTokens,
  estimateCompactionRowTokens,
  type CompactionTokenFactors,
} from "@/common/utils/messages/trimCompactionInput";
import { estimateToolResultTokensForModel } from "./contextBudgetCounting";
import { log } from "./log";

export interface SizedCompactionInput {
  /** The provider-visible projection the trim sizes and edits. */
  sized: MuxMessage[];
  factors: CompactionTokenFactors;
}

/**
 * Per-row factors of the model's count over the chars/4 estimate (at least 1). A tokenizer
 * failure keeps the chars/4 estimate (no factors) instead of failing the compaction request.
 */
async function measureTokenFactors(
  rows: MuxMessage[],
  modelString: string
): Promise<CompactionTokenFactors> {
  try {
    const entries = await Promise.all(
      rows.map(async (row): Promise<[string, number]> => {
        const counted = await estimateToolResultTokensForModel(row.parts, { model: modelString });
        const estimated = Math.max(1, estimateCompactionRowTokens(row));
        return [row.id, Math.max(1, counted / estimated)];
      })
    );
    return new Map(entries);
  } catch (error) {
    log.warn("Compaction input sizing fell back to chars/4", {
      model: modelString,
      error: getErrorMessage(error),
    });
    return new Map();
  }
}

export async function sizeCompactionInput(
  messages: MuxMessage[],
  modelString: string
): Promise<SizedCompactionInput> {
  const sized = applyToolOutputRedaction(messages);
  return { sized, factors: await measureTokenFactors(sized, modelString) };
}

/** The model-aware size of a history's provider-visible projection, in tokens. */
export async function measureCompactionInputTokens(
  messages: MuxMessage[],
  modelString: string
): Promise<number> {
  const { sized, factors } = await sizeCompactionInput(messages, modelString);
  return estimateCompactionInputTokens(sized, factors);
}
