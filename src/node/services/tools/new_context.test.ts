import { describe, expect, test } from "bun:test";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";
import { createMuxMessage } from "@/common/types/message";
import { hasUnconsumedNewContextRequest } from "@/node/services/contextWindowRollover";
import { createNewContextTool } from "./new_context";

describe("new_context tool", () => {
  test("takes no arguments and only reports a scheduled request", async () => {
    const tool = createNewContextTool(createTestToolConfig("/tmp", { workspaceId: "ws" }));
    expect(TOOL_DEFINITIONS.new_context.schema.safeParse({}).success).toBe(true);
    // Strict: a model cannot smuggle notes or a reason through this tool.
    expect(TOOL_DEFINITIONS.new_context.schema.safeParse({ notes: "x" }).success).toBe(false);
    const result = TOOL_DEFINITIONS.new_context.resultSchema.parse(
      await tool.execute!({}, mockToolCallOptions)
    );
    expect(result).toMatchObject({ success: true, status: "scheduled" });
    expect(TOOL_DEFINITIONS.new_context.ptcExcluded).toBeString();
  });

  test("refuses without a rollover receipt when automatic rollover is disabled", async () => {
    const tool = createNewContextTool({
      ...createTestToolConfig("/tmp", { workspaceId: "ws" }),
      contextBudgetRolloverAvailable: false,
    });
    const output = TOOL_DEFINITIONS.new_context.resultSchema.parse(
      await tool.execute!({}, mockToolCallOptions)
    );
    expect(output).toMatchObject({ success: false, code: "rollover_disabled" });
    // A refused call must not leave a receipt that a later send (after rollover is
    // re-enabled) would honor as a model request.
    const assistant = createMuxMessage("a1", "assistant", "");
    assistant.parts = [
      {
        type: "dynamic-tool",
        toolCallId: "call-1",
        toolName: "new_context",
        state: "output-available",
        input: {},
        output,
      },
    ];
    expect(hasUnconsumedNewContextRequest([assistant])).toBe(false);
  });
});
