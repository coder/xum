import { describe, expect, test } from "bun:test";
import {
  InvalidToolInputError,
  TypeValidationError,
  type ModelMessage,
  type TextStreamPart,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import { z } from "zod";
import {
  blankInvalidToolCallInputs,
  describeInvalidToolInput,
  summarizeInvalidToolInputErrors,
} from "./summarizeInvalidToolInputErrors";

async function runTransform(
  parts: Array<TextStreamPart<ToolSet>>
): Promise<Array<TextStreamPart<ToolSet>>> {
  const transform = summarizeInvalidToolInputErrors<ToolSet>()({
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

describe("blankInvalidToolCallInputs", () => {
  const rejectedInput = { command: "view", path: "/memories/global" };
  const schemaRejection = (() => {
    const validation = z.object({ script: z.string() }).safeParse(rejectedInput);
    if (validation.success) throw new Error("Expected the schema to reject the input");
    return describeInvalidToolInput(
      "bash",
      rejectedInput,
      new InvalidToolInputError({
        toolName: "bash",
        toolInput: JSON.stringify(rejectedInput),
        cause: TypeValidationError.wrap({ value: rejectedInput, cause: validation.error }),
      })
    );
  })();
  // The SDK's own message, used when the cause chain carries no zod issues.
  const unparsable = new InvalidToolInputError({
    toolName: "bash",
    toolInput: "{not json",
    cause: new Error("JSON parsing failed"),
  }).message;

  function conversation(
    results: Array<{ id: string; output: ToolResultPart["output"] }>
  ): ModelMessage[] {
    return [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: results.map((result) => ({
          type: "tool-call" as const,
          toolCallId: result.id,
          toolName: "bash",
          input: rejectedInput,
        })),
      },
      {
        role: "tool",
        content: results.map((result) => ({
          type: "tool-result" as const,
          toolCallId: result.id,
          toolName: "bash",
          output: result.output,
        })),
      },
    ];
  }

  function toolCallInputs(messages: ModelMessage[]): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const message of messages) {
      if (message.role !== "assistant" || typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type === "tool-call") inputs[part.toolCallId] = part.input;
      }
    }
    return inputs;
  }

  test("blanks rejected calls in every replay shape and leaves calls that ran alone", () => {
    const messages = conversation([
      { id: "same-turn-text", output: { type: "error-text", value: schemaRejection } },
      { id: "same-turn-json", output: { type: "error-json", value: unparsable } },
      {
        id: "history",
        output: { type: "json", value: { success: false, error: schemaRejection } },
      },
      {
        id: "ran-and-failed",
        output: { type: "json", value: { success: false, error: "exit code 1", exitCode: 1 } },
      },
      {
        id: "other-tool-error",
        output: { type: "error-text", value: schemaRejection.replace("bash", "file_read") },
      },
    ]);

    const blanked = blankInvalidToolCallInputs(messages);

    expect(toolCallInputs(blanked)).toEqual({
      "same-turn-text": {},
      "same-turn-json": {},
      history: {},
      "ran-and-failed": rejectedInput,
      "other-tool-error": rejectedInput,
    });
    expect(blanked[0]).toBe(messages[0]);
    expect(blanked[2]).toBe(messages[2]);
    // Idempotent: a second pass over its own output changes nothing.
    expect(blankInvalidToolCallInputs(blanked)).toBe(blanked);
  });

  test("blanks only the rejected call when a provider reuses its ID in another turn", () => {
    const ran = conversation([
      { id: "call_0", output: { type: "json", value: { success: true, output: "ok" } } },
    ]);
    const rejected = conversation([
      { id: "call_0", output: { type: "error-text", value: schemaRejection } },
    ]);
    const callInputs = (messages: ModelMessage[]) =>
      blankInvalidToolCallInputs(messages).flatMap((message) =>
        message.role === "assistant" && typeof message.content !== "string"
          ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.input] : []))
          : []
      );

    expect(callInputs([...ran, ...rejected])).toEqual([rejectedInput, {}]);
    expect(callInputs([...rejected, ...ran])).toEqual([{}, rejectedInput]);
  });

  test("returns the same array when no call was rejected", () => {
    const messages = conversation([
      { id: "ran", output: { type: "json", value: { success: true, output: "ok" } } },
    ]);

    expect(blankInvalidToolCallInputs(messages)).toBe(messages);
  });
});
