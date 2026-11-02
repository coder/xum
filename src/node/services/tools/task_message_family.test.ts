import { describe, expect, it, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { Ok } from "@/common/types/result";
import type { TaskService } from "@/node/services/taskService";

import { createTaskMessageParentTool } from "./task_message_parent";
import { createTaskMessageSiblingTool } from "./task_message_sibling";
import { TASK_MESSAGE_PROJECT_SKILL_CONTENT_WITHHELD_ERROR } from "./task_send_message";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const toolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "family-call",
  messages: [],
  context: undefined,
};

function familyTaskService() {
  const sendMessageToParentFromAgentTask = mock(() =>
    Promise.resolve(Ok({ parentWorkspaceId: "parent" }))
  );
  const sendMessageToSiblingAgentTask = mock(() =>
    Promise.resolve(Ok({ delivery: "accepted" as const }))
  );
  return {
    sendMessageToParentFromAgentTask,
    sendMessageToSiblingAgentTask,
    taskService: {
      sendMessageToParentFromAgentTask,
      sendMessageToSiblingAgentTask,
    } as unknown as TaskService,
  };
}

describe("family message tools project skill provenance", () => {
  it("refuse to forward from a turn whose context carries excluded project skill content", async () => {
    // The target's request is outside this turn's consent gate: a skill read
    // earlier in the stream followed by a family message would hand the
    // withheld content to the parent's or sibling's model.
    using tempDir = new TestTempDir("task-message-family-refusal");
    const { taskService, sendMessageToParentFromAgentTask, sendMessageToSiblingAgentTask } =
      familyTaskService();
    const config = {
      ...createTestToolConfig(tempDir.path, { workspaceId: "child" }),
      taskService,
      excludeProjectSkillContent: true,
      projectSkillContentInContext: () => true,
    };
    await Promise.resolve(
      expect(
        Promise.resolve(
          createTaskMessageParentTool(config).execute!(
            { message: "the skill says ..." },
            toolCallOptions
          )
        )
      ).rejects.toThrow(TASK_MESSAGE_PROJECT_SKILL_CONTENT_WITHHELD_ERROR)
    );
    await Promise.resolve(
      expect(
        Promise.resolve(
          createTaskMessageSiblingTool(config).execute!(
            { task_id: "sibling", message: "the skill says ..." },
            toolCallOptions
          )
        )
      ).rejects.toThrow(TASK_MESSAGE_PROJECT_SKILL_CONTENT_WITHHELD_ERROR)
    );
    expect(sendMessageToParentFromAgentTask).not.toHaveBeenCalled();
    expect(sendMessageToSiblingAgentTask).not.toHaveBeenCalled();
  });

  it("forward the sender context's project skill provenance under trust, and none from a clean context", async () => {
    using tempDir = new TestTempDir("task-message-family-provenance");
    const carrying = familyTaskService();
    const carryingConfig = {
      ...createTestToolConfig(tempDir.path, { workspaceId: "child" }),
      taskService: carrying.taskService,
      projectSkillContentInContext: () => true,
      projectSkillContentStillReadable: () => Promise.resolve(true),
    };
    await createTaskMessageParentTool(carryingConfig).execute!(
      { message: "the skill says ..." },
      toolCallOptions
    );
    expect(carrying.sendMessageToParentFromAgentTask).toHaveBeenCalledWith(
      "child",
      "the skill says ...",
      "tool-end",
      { carriesProjectSkillContent: true }
    );
    await createTaskMessageSiblingTool(carryingConfig).execute!(
      { task_id: "sibling", message: "the skill says ..." },
      toolCallOptions
    );
    expect(carrying.sendMessageToSiblingAgentTask).toHaveBeenCalledWith(
      "child",
      "sibling",
      "the skill says ...",
      "tool-end",
      { carriesProjectSkillContent: true }
    );

    const clean = familyTaskService();
    const cleanConfig = {
      ...createTestToolConfig(tempDir.path, { workspaceId: "child" }),
      taskService: clean.taskService,
    };
    await createTaskMessageParentTool(cleanConfig).execute!({ message: "plain" }, toolCallOptions);
    expect(clean.sendMessageToParentFromAgentTask).toHaveBeenCalledWith(
      "child",
      "plain",
      "tool-end"
    );
    await createTaskMessageSiblingTool(cleanConfig).execute!(
      { task_id: "sibling", message: "plain" },
      toolCallOptions
    );
    expect(clean.sendMessageToSiblingAgentTask).toHaveBeenCalledWith(
      "child",
      "sibling",
      "plain",
      "tool-end"
    );
  });
});
