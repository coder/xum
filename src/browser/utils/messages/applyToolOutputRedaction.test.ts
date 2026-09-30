import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { applyToolOutputRedaction } from "./applyToolOutputRedaction";

describe("applyToolOutputRedaction", () => {
  it("strips UI-only fields from provider-bound tool output", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
            input: {},
            state: "output-available",
            output: {
              success: true,
              answer: "continue",
              ui_only: { ask_user_question: { questions: [], answers: {} } },
            },
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected dynamic tool output");
    }

    expect(part.output).toEqual({ success: true, answer: "continue" });
  });

  it("strips workflow run attachment hints from provider-bound tool parts", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-workflow",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            input: { name: "deep-research", args: {} },
            state: "input-available",
            workflowRun: {
              runId: "wfr_123",
              timestamp: 123,
            },
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool") {
      throw new Error("Expected dynamic tool part");
    }

    expect("workflowRun" in part).toBe(false);
  });

  it("scrubs legacy image tool payloads before replaying history to providers", () => {
    const imageResult = {
      success: true,
      model: "openai:gpt-image-2",
      prompt: "square",
      requestedCount: 1,
      source: {
        path: "/tmp/source.png",
        resolvedPath: "/home/user/project/source.png",
        sizeBytes: 100,
      },
      images: [
        {
          path: "/tmp/image.png",
          filename: "image.png",
          mediaType: "image/png",
          thumbnail: {
            data: "large-base64",
            mediaType: "image/webp",
            width: 512,
            height: 512,
          },
        },
      ],
    };
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "code-execution-1",
            toolName: "code_execution",
            input: {},
            state: "output-available",
            output: {
              success: true,
              toolCalls: [
                {
                  toolName: "image_generate",
                  result: imageResult,
                },
              ],
            },
            nestedCalls: [
              {
                toolCallId: "nested-image-1",
                toolName: "image_generate",
                input: { prompt: "square" },
                state: "output-available",
                output: imageResult,
              },
            ],
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected dynamic tool output");
    }

    expect(part.output).toEqual({
      success: true,
      toolCalls: [
        {
          toolName: "image_generate",
          result: {
            success: true,
            model: "openai:gpt-image-2",
            prompt: "square",
            requestedCount: 1,
            source: {
              path: "/tmp/source.png",
              sizeBytes: 100,
            },
            images: [{ path: "/tmp/image.png", filename: "image.png", mediaType: "image/png" }],
          },
        },
      ],
    });
    expect(part.nestedCalls?.[0]?.output).toEqual({
      success: true,
      model: "openai:gpt-image-2",
      prompt: "square",
      requestedCount: 1,
      source: {
        path: "/tmp/source.png",
        sizeBytes: 100,
      },
      images: [{ path: "/tmp/image.png", filename: "image.png", mediaType: "image/png" }],
    });
  });

  it("strips the embedded workflow run record from workflow_run/workflow_resume outputs", () => {
    const inlineSource = "export default function inlineSecretWorkflow() {}\n";
    const runRecord = {
      id: "wfr_demo",
      source: inlineSource,
      events: [{ sequence: 1, type: "log", at: "2026-01-01T00:00:00.000Z", message: "noisy" }],
    };
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tool-1",
            toolName: "workflow_run",
            input: { script_source: inlineSource, args: {} },
            state: "output-available",
            output: { status: "running", runId: "wfr_demo", result: null, run: runRecord },
          },
          {
            type: "dynamic-tool",
            toolCallId: "tool-2",
            toolName: "workflow_resume",
            input: { run_id: "wfr_demo" },
            state: "output-available",
            output: {
              type: "json",
              value: {
                status: "completed",
                runId: "wfr_demo",
                result: { ok: true },
                run: runRecord,
              },
            },
          },
          {
            // Only workflow tools are affected: other tools may legitimately output a `run` key.
            type: "dynamic-tool",
            toolCallId: "tool-3",
            toolName: "bash",
            input: {},
            state: "output-available",
            output: { success: true, run: "value preserved" },
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const [runPart, resumePart, bashPart] = result[0]?.parts ?? [];
    if (
      runPart?.type !== "dynamic-tool" ||
      resumePart?.type !== "dynamic-tool" ||
      bashPart?.type !== "dynamic-tool" ||
      runPart.state !== "output-available" ||
      resumePart.state !== "output-available" ||
      bashPart.state !== "output-available"
    ) {
      throw new Error("Expected dynamic tool outputs");
    }

    expect(runPart.input).toEqual({ script_source: inlineSource, args: {} });
    expect(runPart.output).toEqual({ status: "running", runId: "wfr_demo", result: null });
    expect(JSON.stringify(runPart.output)).not.toContain("inlineSecretWorkflow");
    expect(resumePart.output).toEqual({
      type: "json",
      value: { status: "completed", runId: "wfr_demo", result: { ok: true } },
    });
    expect(bashPart.output).toEqual({ success: true, run: "value preserved" });
  });

  it("sanitizes binary-like provider output strings for top-level and nested tools", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tool-1",
            toolName: "example_tool",
            input: {},
            state: "output-available",
            output: {
              success: false,
              error: "Invalid JSON response: \u001b\u0000\ufffdpayload",
            },
            nestedCalls: [
              {
                toolCallId: "nested-tool-1",
                toolName: "nested_tool",
                input: {},
                state: "output-available",
                output: {
                  success: false,
                  error: "Nested bad body \u0000",
                },
              },
            ],
          },
        ],
      },
    ];

    const result = applyToolOutputRedaction(messages);
    const part = result[0]?.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected dynamic tool output");
    }

    const output = part.output as { success?: unknown; error?: unknown };
    expect(output.success).toBe(false);
    expect(output.error).not.toBe("Invalid JSON response: \u001b\u0000\ufffdpayload");
    expect(output.error).toEqual(expect.stringContaining("nul=1"));

    const nestedOutput = part.nestedCalls?.[0]?.output as
      | { success?: unknown; error?: unknown }
      | undefined;
    expect(nestedOutput?.success).toBe(false);
    expect(nestedOutput?.error).not.toBe("Nested bad body \u0000");
    expect(nestedOutput?.error).toEqual(expect.stringContaining("nul=1"));
  });
});
