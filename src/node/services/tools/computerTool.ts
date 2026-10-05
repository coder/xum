import { type Tool, tool } from "ai";

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
  return tool({
    description: TOOL_DEFINITIONS.computer.description,
    inputSchema: TOOL_DEFINITIONS.computer.schema,
    execute: async (input, { abortSignal }): Promise<ComputerToolResult> => {
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
