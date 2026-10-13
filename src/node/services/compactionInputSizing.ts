/**
 * Node-side sizing for the compaction input trim (trimCompactionInput).
 *
 * The trim sizes what the provider receives: the history after applyToolOutputRedaction
 * removes ui_only data and workflow-run records. Each row is projected by
 * projectRowForSizing (media and base64 payloads become a fixed IMAGE_TOKEN_ESTIMATE
 * allowance) and the rest is counted with the model's tokenizer, the count the request-time
 * context check uses (contextBudgetCounting). chars/4 undercounts dense text (CJK about 5x,
 * emoji about 8x). A tokenizer error falls back to chars/4 for that row.
 *
 * Cost, on histories of about 1M model tokens (480 to 800 rows): 0.26 to 0.36 s when the
 * history fits (1.1 s with the first GPT tokenizer load), 0.27 to 0.42 s when the trim
 * replaces 217 to 371 results and recounts their rows.
 */
import { applyToolOutputRedaction } from "@/browser/utils/messages/applyToolOutputRedaction";
import { IMAGE_TOKEN_ESTIMATE } from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";
import { getErrorMessage } from "@/common/utils/errors";
import {
  estimateCompactionRowTokens,
  projectRowForSizing,
  type CountCompactionRowTokens,
} from "@/common/utils/messages/compactionRowSizing";
import { estimateCompactionInputTokens } from "@/common/utils/messages/trimCompactionInput";
import { estimateToolResultTokensForModel } from "./contextBudgetCounting";
import { log } from "./log";

/** One row's model-aware count; see the module comment. */
export function createCompactionRowCounter(modelString: string): CountCompactionRowTokens {
  let warned = false;
  return async (row) => {
    const { projected, mediaParts } = projectRowForSizing(row);
    try {
      const text = await estimateToolResultTokensForModel(projected, { model: modelString });
      return text + mediaParts * IMAGE_TOKEN_ESTIMATE;
    } catch (error) {
      if (!warned) {
        warned = true;
        log.warn("Compaction input sizing fell back to chars/4", {
          model: modelString,
          error: getErrorMessage(error),
        });
      }
      return estimateCompactionRowTokens(row);
    }
  };
}

/** The provider-bound projection the trim sizes and edits. */
export function projectCompactionInput(messages: MuxMessage[]): MuxMessage[] {
  return applyToolOutputRedaction(messages);
}

/** The model-aware size of a history's provider-bound projection, in tokens. */
export function measureCompactionInputTokens(
  messages: MuxMessage[],
  modelString: string
): Promise<number> {
  return estimateCompactionInputTokens(
    projectCompactionInput(messages),
    createCompactionRowCounter(modelString)
  );
}
