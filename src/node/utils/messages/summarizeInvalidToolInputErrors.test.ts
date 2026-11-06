import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { InvalidToolInputError, TypeValidationError, type TextStreamPart, type ToolSet } from "ai";
import { z } from "zod";
import { log } from "@/node/services/log";
import {
  type RejectedToolCallLogContext,
  summarizeInvalidToolInputErrors,
} from "./summarizeInvalidToolInputErrors";

let warn: Mock<typeof log.warn>;
beforeEach(() => {
  warn = spyOn(log, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

async function runTransform(
  parts: Array<TextStreamPart<ToolSet>>,
  context?: RejectedToolCallLogContext
): Promise<Array<TextStreamPart<ToolSet>>> {
  const transform = summarizeInvalidToolInputErrors<ToolSet>(context)({
    tools: {},
    stopStream: () => undefined,
  });
  const output: Array<TextStreamPart<ToolSet>> = [];
  await new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  })
    .pipeThrough(transform)
    .pipeTo(
      new WritableStream({
        write(part) {
          output.push(part);
        },
      })
    );
  return output;
}

function rejectedCall(toolCallId: string, input: unknown, cause: unknown) {
  const error = new InvalidToolInputError({
    toolName: "note",
    toolInput: JSON.stringify(input),
    cause,
  });
  return {
    call: {
      type: "tool-call" as const,
      toolCallId,
      toolName: "note",
      input,
      dynamic: true as const,
      invalid: true,
      error,
    },
    toolError: {
      type: "tool-error" as const,
      toolCallId,
      toolName: "note",
      input,
      error: error.message,
      dynamic: true as const,
    },
  };
}

describe("summarizeInvalidToolInputErrors", () => {
  test("rewrites only the rejected call's tool-error and leaves other errors alone", async () => {
    const schema = z.object({ text: z.string().max(5) });
    const input = { text: "toolong" };
    const validation = schema.safeParse(input);
    if (validation.success) throw new Error("Expected the schema to reject the input");
    const rejected = rejectedCall(
      "rejected",
      input,
      TypeValidationError.wrap({ value: input, cause: validation.error })
    );
    const executionFailure = {
      type: "tool-error" as const,
      toolCallId: "executed",
      toolName: "note",
      input: { text: "ok" },
      error: new Error("disk full"),
    };

    const output = await runTransform([rejected.call, rejected.toolError, executionFailure]);

    expect(output).toHaveLength(3);
    expect(output[0]).toBe(rejected.call);
    expect(output[1]).toMatchObject({
      type: "tool-error",
      toolCallId: "rejected",
      error:
        "Invalid input for tool note: text: Too big: expected string to have <=5 characters (received 7 characters)",
    });
    expect(output[2]).toBe(executionFailure);
  });

  test("falls back to the error message when the cause chain has no issues", async () => {
    const rejected = rejectedCall("unparsable", "{not json", new Error("JSON parsing failed"));

    const output = await runTransform([rejected.call, rejected.toolError]);

    expect(output[1]).toMatchObject({ type: "tool-error", error: rejected.toolError.error });
  });
});

describe("summarizeInvalidToolInputErrors logging", () => {
  test("logs the argument text exactly as received, with its byte length and context", async () => {
    const error = new InvalidToolInputError({
      toolName: "bash",
      toolInput: '{"command": "cd é"}',
      cause: new Error("invalid"),
    });
    const rejected = rejectedCall("cut", { command: "cd é" }, undefined);

    await runTransform([{ ...rejected.call, toolName: "bash", error }, rejected.toolError], {
      model: "local:qwen",
      workspaceId: "ws-1",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "Rejected a tool call with invalid input",
      {
        toolName: "bash",
        model: "local:qwen",
        workspaceId: "ws-1",
        argumentsBytes: 20,
        arguments: '{"command": "cd é"}',
      },
    ]);
  });

  test("caps the logged arguments but reports the full byte length", async () => {
    const input = { text: "x".repeat(5000) };
    const rejected = rejectedCall("big", input, new Error("invalid"));

    await runTransform([rejected.call, rejected.toolError]);

    const fields = warn.mock.calls[0]?.[1] as { arguments: string; argumentsBytes: number };
    expect(fields.argumentsBytes).toBe(5011);
    expect(fields.arguments).toHaveLength(513);
    expect(fields.arguments).toStartWith('{"text":"xxx');
    expect(fields.arguments).toEndWith("x…");
  });

  test("keeps arguments at the cap whole", async () => {
    const toolInput = "y".repeat(512);
    const error = new InvalidToolInputError({ toolName: "note", toolInput, cause: undefined });
    const rejected = rejectedCall("edge", {}, error);

    await runTransform([{ ...rejected.call, error }, rejected.toolError]);

    expect(warn.mock.calls[0]?.[1]).toMatchObject({ arguments: toolInput });
  });

  test("falls back to the input when the error carries no argument text", async () => {
    const withoutArgumentText = (toolCallId: string, input: unknown) => ({
      ...rejectedCall(toolCallId, input, undefined).call,
      error: new Error("No such tool"),
    });

    await runTransform([
      withoutArgumentText("raw", "{not json"),
      withoutArgumentText("parsed", { a: 1 }),
      withoutArgumentText("missing", undefined),
    ]);

    expect(warn.mock.calls.map((call) => (call[1] as { arguments: string }).arguments)).toEqual([
      "{not json",
      '{"a":1}',
      "",
    ]);
  });

  test("does not log calls that passed validation", async () => {
    const executionFailure = {
      type: "tool-error" as const,
      toolCallId: "executed",
      toolName: "note",
      input: { text: "ok" },
      error: new Error("disk full"),
    };

    const validCall = (toolCallId: string, dynamic: boolean) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName: "note",
      input: { text: "ok" },
      dynamic,
      invalid: false,
      error: new Error("not a rejection"),
    });

    await runTransform([
      validCall("static", false),
      validCall("dynamic", true),
      executionFailure,
    ] as Array<TextStreamPart<ToolSet>>);

    expect(warn).not.toHaveBeenCalled();
  });
});
