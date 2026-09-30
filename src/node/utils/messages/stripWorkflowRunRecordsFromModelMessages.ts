import type { AssistantModelMessage, ModelMessage, ToolModelMessage, ToolResultPart } from "ai";
import { getToolOutputUiOnly, stripToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { stripWorkflowRunRecordForModel } from "@/common/utils/workflowRunMessages";

type ToolResultOutput = ToolResultPart["output"];

function stripToolResultPart<P extends { type: string }>(part: P, onChange: () => void): P {
  if (part.type !== "tool-result") {
    return part;
  }
  const toolResult = part as P & ToolResultPart;
  const withoutRunRecord = stripWorkflowRunRecordForModel(toolResult.toolName, toolResult.output);
  const strippedOutput =
    getToolOutputUiOnly(withoutRunRecord) === undefined
      ? withoutRunRecord
      : stripToolOutputUiOnly(withoutRunRecord);
  if (strippedOutput === toolResult.output) {
    return part;
  }
  onChange();
  return { ...part, output: strippedOutput as ToolResultOutput };
}

/**
 * Request-only rewrite for *internal* streamText steps.
 *
 * applyToolOutputRedaction strips workflow run records and `ui_only` fields when building a
 * request from persisted history, but within a single streamText turn the SDK feeds tool results
 * straight back into the next step. Without this, the model step immediately after a
 * workflow_run/workflow_resume call still sees the full run record (script source + event log)
 * this redaction exists to keep out of context, and the next request replays a different prefix
 * than the model saw, which invalidates thinking blocks that are bound to it.
 *
 * Returns the original array when nothing changed so prepareStep can skip the rewrite.
 */
export function stripWorkflowRunRecordsFromModelMessages(messages: ModelMessage[]): ModelMessage[] {
  let didChange = false;

  const result = messages.map((message): ModelMessage => {
    let changedMessage = false;
    const onChange = () => {
      didChange = true;
      changedMessage = true;
    };

    // Tool results normally arrive in `tool` messages; assistant content can also carry
    // tool-result parts after some transforms, so handle both.
    if (message.role === "tool") {
      const newContent: ToolModelMessage["content"] = message.content.map((part) =>
        stripToolResultPart(part, onChange)
      );
      return changedMessage ? { ...message, content: newContent } : message;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const newContent: Exclude<AssistantModelMessage["content"], string> = message.content.map(
        (part) => stripToolResultPart(part, onChange)
      );
      return changedMessage ? { ...message, content: newContent } : message;
    }
    return message;
  });

  return didChange ? result : messages;
}
