import { type ModelMessage, type Tool, tool } from "ai";

import type { ToolErrorResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ComputerUseGrant } from "@/node/services/computerUse/computerUseService";

type ComputerToolResult =
  | {
      type: "content";
      value:
        | [{ type: "text"; text: string }]
        | [
            { type: "text"; text: string },
            { type: "media"; mediaType: "image/jpeg"; data: string },
          ];
    }
  | ToolErrorResult;

export function createComputerTool(grant: ComputerUseGrant): Tool {
  // Parallel calls from one model response share its input messages. Only the first may run: the
  // rest were planned from a screenshot that its action replaced.
  let lastResponse: ModelMessage[] | undefined;
  return tool({
    description: TOOL_DEFINITIONS.computer.description,
    inputSchema: TOOL_DEFINITIONS.computer.schema,
    execute: async (input, { abortSignal, messages }): Promise<ComputerToolResult> => {
      if (messages === lastResponse) {
        return {
          success: false,
          error:
            "Only the first computer action in a response runs. Plan this action again from " +
            "the screenshot that action returned.",
        };
      }
      lastResponse = messages;
      try {
        const result = await grant.execute(input, abortSignal);
        const text = { type: "text" as const, text: result.text };
        return {
          type: "content",
          value:
            result.screenshot == null
              ? [text]
              : [
                  text,
                  { type: "media", mediaType: "image/jpeg", data: result.screenshot.jpegBase64 },
                ],
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}
