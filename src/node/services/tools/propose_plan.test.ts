import { describe, it, expect } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { ToolExecutionOptions } from "ai";
import type { ProposePlanToolResult } from "@/common/types/tools";
import { createProposePlanTool } from "./propose_plan";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { setTodosForSessionDir } from "./todo";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const toolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("propose_plan tool", () => {
  it("marks in-progress todos completed when the plan is proposed", async () => {
    using tempDir = new TestTempDir("propose-plan");

    const planPath = path.join(tempDir.path, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\n- Step 1\n");

    const config = createTestToolConfig(tempDir.path);
    await setTodosForSessionDir(config.workspaceId!, config.workspaceSessionDir!, [
      { content: "Inspected relevant files", status: "completed" },
      { content: "Writing the plan", status: "in_progress" },
      { content: "Wait for approval", status: "pending" },
    ]);

    const tool = createProposePlanTool({
      ...config,
      planFilePath: planPath,
    });

    const result = (await tool.execute!({}, toolCallOptions)) as ProposePlanToolResult;

    expect(result).toEqual({
      success: true,
      planPath,
      message: "Plan proposed. Waiting for user approval.",
    });
    expect(await readTodosForSessionDir(config.workspaceSessionDir!)).toEqual([
      { content: "Inspected relevant files", status: "completed" },
      { content: "Writing the plan", status: "completed" },
      { content: "Wait for approval", status: "pending" },
    ]);
  });
});
