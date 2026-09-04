import { tool } from "ai";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { sanitizeErrorMessageForDisplay } from "@/common/utils/providerOutputSanitization";
import type { IntuitionToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { runMemoryIntuition } from "@/node/services/memoryIntuition";
import { memoryScopeContextFromToolConfig } from "./memory";

export const createIntuitionTool: ToolFactory = (config: ToolConfiguration) => {
  const runtime = config.intuitionRuntime;
  const memoryService = config.memoryService;
  assert(runtime, "intuition tool requires intuitionRuntime");
  assert(memoryService, "intuition tool requires memoryService");
  const model = runtime.modelString.trim();
  assert(model.length > 0, "intuition model must be non-empty");
  assert(
    Number.isSafeInteger(runtime.maxUsesPerTurn) && runtime.maxUsesPerTurn > 0,
    "intuition maxUsesPerTurn must be a positive integer"
  );
  const ctx = memoryScopeContextFromToolConfig(config);
  let usesThisTurn = 0;

  return tool({
    description: TOOL_DEFINITIONS.intuition.description,
    inputSchema: TOOL_DEFINITIONS.intuition.schema,
    execute: async ({ cue }, { abortSignal, toolCallId }): Promise<IntuitionToolResult> => {
      const signal = abortSignal
        ? AbortSignal.any([abortSignal, runtime.abortSignal])
        : runtime.abortSignal;
      const cancelled = (): IntuitionToolResult => ({
        kind: "error",
        isError: true,
        message: "Intuition request cancelled.",
      });
      if (signal.aborted) return cancelled();
      if (usesThisTurn >= runtime.maxUsesPerTurn) {
        return {
          kind: "limit_reached",
          message: `Intuition limit reached for this turn (max ${runtime.maxUsesPerTurn} uses).`,
        };
      }
      // Reserve before awaiting so parallel calls cannot bypass the per-turn cap.
      usesThisTurn++;
      try {
        const result = await runMemoryIntuition({
          createModel: async () => (await runtime.createModel(model)).model,
          resolveAgentBody: () => runtime.resolveAgentBody(),
          modelString: model,
          memoryService,
          ctx,
          cue,
          abortSignal: signal,
          recordUsage: (usage, providerMetadata) =>
            Promise.resolve(
              config.reportModelUsage?.({
                source: "tool",
                toolName: "intuition",
                model,
                usage,
                providerMetadata,
                toolCallId,
                timestamp: Date.now(),
              })
            ),
        });
        // The runner also uses abort for its own timeout. Only caller cancellation
        // is an error; exhausting the bounded search is uncertainty, not a failure.
        if (signal.aborted) return cancelled();
        if (result.kind === "error") {
          return {
            kind: "error",
            isError: true,
            message: sanitizeErrorMessageForDisplay(result.message),
          };
        }
        const fields = { cue, model, stats: result.stats };
        if (result.kind === "report") {
          if (result.memories.length > 0) {
            // Scanning is not recall: only verified memories returned to the caller
            // update usage metadata, once per path even if the report repeats it.
            for (const path of new Set(result.memories.map((memory) => memory.path))) {
              await memoryService.recordRecall(ctx, path);
            }
            if (signal.aborted) return cancelled();
            return {
              kind: "recognized",
              ...fields,
              memories: result.memories,
              candidates: result.candidates,
            };
          }
          return { kind: "uncertain", ...fields, candidates: result.candidates };
        }
        return {
          kind: "uncertain",
          ...fields,
          candidates: [],
          note: result.stats.timedOut
            ? "Memory search timed out without a verified report."
            : result.stats.indexEntriesConsidered === 0
              ? "No memories are available yet."
              : "Memory search ended without a verified report.",
        };
      } catch (error) {
        return {
          kind: "error",
          isError: true,
          message: sanitizeErrorMessageForDisplay(getErrorMessage(error)),
        };
      }
    },
  });
};
