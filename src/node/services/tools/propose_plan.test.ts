import { describe, it, expect, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { ToolExecutionOptions } from "ai";
import type { ProposePlanToolResult } from "@/common/types/tools";
import { createProposePlanTool } from "./propose_plan";
import { RuntimeError } from "@/node/runtime/Runtime";
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

  // #4826: "No plan file found … write your plan" would invite the agent to
  // overwrite a plan it simply could not reach.
  it("reports an unreachable runtime instead of a missing plan", async () => {
    using tempDir = new TestTempDir("propose-plan-transport");

    const planPath = path.join(tempDir.path, "plan.md");
    await fs.writeFile(planPath, "# Plan\n");

    const config = createTestToolConfig(tempDir.path);
    spyOn(config.runtime, "readFile").mockImplementation(() => {
      throw new RuntimeError("ssh: connect to host dev port 22: Connection refused", "network");
    });
    const tool = createProposePlanTool({ ...config, planFilePath: planPath });

    const result = (await tool.execute!({}, toolCallOptions)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).not.toContain("No plan file found");
    expect(result.error).toContain("Connection refused");
  });
});
