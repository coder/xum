import { describe, expect, it } from "bun:test";
import type { JSONValue, ModelMessage } from "ai";
import { applyToolOutputRedaction } from "@/browser/utils/messages/applyToolOutputRedaction";
import { stripWorkflowRunRecordsFromModelMessages } from "./stripWorkflowRunRecordsFromModelMessages";

const INLINE_SOURCE = "export default function inlineSecretWorkflow() {}\n";

const runRecord = {
  id: "wfr_demo",
  source: INLINE_SOURCE,
  events: [{ sequence: 1, type: "log", at: "2026-01-01T00:00:00.000Z", message: "noisy" }],
};

describe("stripWorkflowRunRecordsFromModelMessages", () => {
  it("strips attach_file's ui_only.artifact before the model sees the result", () => {
    const toolOutput = {
      type: "content",
      value: [{ type: "text", text: "[File shown to user: report.md]" }],
      ui_only: { artifact: { id: "report-md-0123456789", version: 2, path: "report.md" } },
    };
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-attach",
            toolName: "attach_file",
            output: { type: "json", value: toolOutput },
          },
        ],
      },
    ];

    const result = stripWorkflowRunRecordsFromModelMessages(messages);
    const part = result[0]?.role === "tool" ? result[0].content[0] : undefined;
    expect(JSON.stringify(part?.type === "tool-result" ? part.output : undefined)).not.toContain(
      "artifact"
    );
  });

  it("strips run records from same-turn workflow tool results", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "workflow_run",
            output: {
              type: "json",
              value: { status: "running", runId: "wfr_demo", result: null, run: runRecord },
            },
          },
        ],
      },
    ];

    const result = stripWorkflowRunRecordsFromModelMessages(messages);

    expect(result).not.toBe(messages);
    const part = result[0]?.role === "tool" ? result[0].content[0] : undefined;
    expect(part?.type === "tool-result" ? part.output : undefined).toEqual({
      type: "json",
      value: { status: "running", runId: "wfr_demo", result: null },
    });
  });

  it("strips ui_only fields the same way replay-time redaction does", () => {
    const uiOnlyDiff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const toolOutput = {
      success: true,
      diff: "[diff omitted]",
      ui_only: { file_edit: { diff: uiOnlyDiff } },
    };
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-edit",
            toolName: "file_edit_replace_string",
            output: { type: "json", value: toolOutput },
          },
        ],
      },
    ];

    const result = stripWorkflowRunRecordsFromModelMessages(messages);
    const part = result[0]?.role === "tool" ? result[0].content[0] : undefined;
    const inStreamOutput = part?.type === "tool-result" ? part.output : undefined;

    const [replayed] = applyToolOutputRedaction([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-edit",
            toolName: "file_edit_replace_string",
            state: "output-available",
            input: {},
            output: toolOutput,
          },
        ],
      },
    ]);
    const replayedPart = replayed?.parts[0];
    const replayedOutput =
      replayedPart?.type === "dynamic-tool" && replayedPart.state === "output-available"
        ? replayedPart.output
        : undefined;

    expect(JSON.stringify(inStreamOutput)).not.toContain(uiOnlyDiff);
    expect(replayedOutput).toEqual(
      inStreamOutput?.type === "json" ? inStreamOutput.value : undefined
    );
  });

  it("sanitizes tool output strings the same way replay-time redaction does", () => {
    // Nested 7 levels below the output value: the sanitizer's depth limit must count from the
    // value in both paths, not from the SDK's { type, value } wrapper.
    let deep: unknown = { body: "deep\u0000body" };
    for (let level = 0; level < 6; level++) deep = { level: deep };
    const outputs: unknown[] = [
      { success: true, output: "PNG\u0000\u0001\ufffd body" },
      { success: true, content: "line\n".repeat(5_000) },
      { success: true, deep },
      "plain string \u0000 output",
    ];

    for (const toolOutput of outputs) {
      const wrapped =
        typeof toolOutput === "string"
          ? { type: "text" as const, value: toolOutput }
          : { type: "json" as const, value: toolOutput as JSONValue };
      const [inStream] = stripWorkflowRunRecordsFromModelMessages([
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call-1", toolName: "bash", output: wrapped },
          ],
        },
      ]);
      const part = inStream?.role === "tool" ? inStream.content[0] : undefined;
      const inStreamOutput = part?.type === "tool-result" ? part.output : undefined;

      const [replayed] = applyToolOutputRedaction([
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "call-1",
              toolName: "bash",
              state: "output-available",
              input: {},
              output: toolOutput,
            },
          ],
        },
      ]);
      const replayedPart = replayed?.parts[0];
      const replayedOutput =
        replayedPart?.type === "dynamic-tool" && replayedPart.state === "output-available"
          ? replayedPart.output
          : undefined;

      expect(inStreamOutput?.type).toBe(wrapped.type);
      // Byte parity: the wire carries the JSON text of each value.
      expect(
        JSON.stringify(
          inStreamOutput != null && "value" in inStreamOutput ? inStreamOutput.value : null
        )
      ).toBe(JSON.stringify(replayedOutput));
      expect(JSON.stringify(replayedOutput)).not.toContain("\\u0000");
    }
  });

  it("does not redact original inline workflow tool-call inputs", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-inline",
            toolName: "workflow_run",
            input: { script_source: INLINE_SOURCE, args: {} },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-inline",
            toolName: "workflow_run",
            output: {
              type: "json",
              value: { status: "running", runId: "wfr_demo", result: null, run: runRecord },
            },
          },
        ],
      },
    ];

    const result = stripWorkflowRunRecordsFromModelMessages(messages);

    expect(JSON.stringify(result[0])).toContain("inlineSecretWorkflow");
    expect(JSON.stringify(result[1])).not.toContain("inlineSecretWorkflow");
  });

  it("returns the original array when no workflow tool results carry a run record", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            // Non-workflow tools may legitimately output a `run` key; it must survive.
            output: { type: "json", value: { success: true, run: "value preserved" } },
          },
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "workflow_run",
            output: { type: "json", value: { status: "completed", runId: "wfr_demo" } },
          },
        ],
      },
    ];

    expect(stripWorkflowRunRecordsFromModelMessages(messages)).toBe(messages);
  });
});
