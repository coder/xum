import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import {
  InvalidToolInputError,
  JSONParseError,
  TypeValidationError,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { log } from "@/node/services/log";
import {
  describeInvalidToolInput,
  redactRejectedToolCallError,
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

  test("reads issues from at most three causes down", () => {
    const issues = [{ path: ["text"], message: "Required", code: "invalid_type" }];
    const chain = (depth: number): unknown =>
      depth === 0 ? { issues } : { cause: chain(depth - 1) };
    const summarize = (depth: number) =>
      describeInvalidToolInput(
        "note",
        { text: "x" },
        new InvalidToolInputError({ toolName: "note", toolInput: "{}", cause: chain(depth) })
      );

    expect(summarize(2)).toBe("Invalid input for tool note: text: Required");
    expect(summarize(3)).not.toContain("text: Required");
  });

  test("falls back to the error message when the cause chain has no issues", async () => {
    const rejected = rejectedCall("unparsable", "{not json", new Error("JSON parsing failed"));

    const output = await runTransform([rejected.call, rejected.toolError]);

    expect(output[1]).toMatchObject({ type: "tool-error", error: rejected.toolError.error });
  });
});

describe("summarizeInvalidToolInputErrors logging", () => {
  test("logs only metadata, never the argument text", async () => {
    const error = new InvalidToolInputError({
      toolName: "bash",
      toolInput: '{"command": "cd é", "token": "sk-secret"}',
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
        toolCallId: "cut",
        model: "local:qwen",
        workspaceId: "ws-1",
        argumentsBytes: 42,
      },
    ]);
  });

  test("measures the argument text the SDK received, falling back to the input", async () => {
    const withoutArgumentText = (toolCallId: string, input: unknown) => ({
      ...rejectedCall(toolCallId, input, undefined).call,
      error: new Error("No such tool"),
    });

    await runTransform([
      withoutArgumentText("raw", "{not json"),
      withoutArgumentText("parsed", { a: 1 }),
      withoutArgumentText("missing", undefined),
    ]);

    expect(
      warn.mock.calls.map((call) => (call[1] as { argumentsBytes: number }).argumentsBytes)
    ).toEqual([9, 7, 0]);
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

describe("redactRejectedToolCallError", () => {
  const SECRET_KEY = "ghp_ABCdefSECRETxyz";
  const SECRET_VALUE = "ghp_live_zzzzzzz";

  const unparsable = `{"${SECRET_KEY}": "${SECRET_VALUE}"`;

  function rejection(input: unknown, cause: unknown): [unknown, InvalidToolInputError] {
    const toolInput = typeof input === "string" ? input : JSON.stringify(input);
    return [input, new InvalidToolInputError({ toolName: "bash", toolInput, cause })];
  }

  function zodRejection(schema: z.ZodType, input: unknown): [unknown, InvalidToolInputError] {
    const validation = schema.safeParse(input);
    if (validation.success) throw new Error("Expected the schema to reject the input");
    return rejection(input, TypeValidationError.wrap({ value: input, cause: validation.error }));
  }

  test.each([
    [
      "a missing property lists the key in the received arguments",
      zodRejection(z.object({ script: z.string() }), { [SECRET_KEY]: SECRET_VALUE }),
      "Invalid input for tool bash: script: Invalid input: expected string, received undefined. Received arguments: [redacted]",
    ],
    [
      "a strict schema lists the key as unrecognized",
      zodRejection(z.object({ x: z.number() }).strict(), { x: 1, [SECRET_KEY]: SECRET_VALUE }),
      "Invalid input for tool bash: input: unrecognized key: [redacted]",
    ],
    [
      "a record schema puts the key in the issue label",
      zodRejection(z.object({ answers: z.record(z.string(), z.string()) }), {
        answers: { [SECRET_KEY]: 5 },
      }),
      "Invalid input for tool bash: answers.[withheld]: Invalid input: expected string, received number",
    ],
    [
      "the SDK fallback echoes the validated value",
      rejection(
        { [SECRET_KEY]: SECRET_VALUE },
        new TypeValidationError({ value: { [SECRET_KEY]: SECRET_VALUE }, cause: new Error("boom") })
      ),
      "Invalid input for tool bash: AI_TypeValidationError: [withheld] [further lines withheld]",
    ],
    [
      "the SDK fallback echoes unparsable argument text",
      rejection(
        unparsable,
        new JSONParseError({ text: unparsable, cause: new SyntaxError("Unexpected end of JSON") })
      ),
      "Invalid input for tool bash: AI_JSONParseError: [withheld] [further lines withheld]",
    ],
  ])("keeps the key for the model and out of the log: %s", (_name, [input, error], logged) => {
    const summary = describeInvalidToolInput("bash", input, error);

    expect(summary).toContain(SECRET_KEY);
    expect(redactRejectedToolCallError(summary)).toBe(logged);
  });

  test.each([
    ["undefined", undefined],
    ["a number", 42],
    ["an Error with the prefix", new Error("Invalid input for tool bash: x")],
    ["an object", { message: "Invalid input for tool bash: x" }],
  ])("passes a non-string error through: %s", (_name, error) => {
    expect(redactRejectedToolCallError(error)).toBe(error);
  });

  test.each([
    "disk full",
    "Tool execution failed: Invalid input for tool bash: script: Required",
    "invalid input for tool bash: script: Required. Received arguments: token=string(3 chars)",
  ])("passes a string without the prefix through: %s", (error) => {
    expect(redactRejectedToolCallError(error)).toBe(error);
  });

  test.each([
    [
      "received arguments",
      "script: Required. Received arguments: command=string(5 chars), token=number",
      "script: Required. Received arguments: [redacted]",
    ],
    [
      "unrecognized keys",
      "input: unrecognized keys: badKey, other (1 key not shown)",
      "input: unrecognized keys: [redacted]",
    ],
    [
      "one unrecognized key",
      "input: unrecognized key: badKey",
      "input: unrecognized key: [redacted]",
    ],
    [
      "nested label",
      "answers.a.b: Invalid input: expected string, received number",
      "answers.[withheld]: Invalid input: expected string, received number",
    ],
    [
      "every clause together",
      "input: unrecognized key: badKey; answers.x: Invalid input; script: Required. Received arguments: a=number",
      "input: unrecognized key: [redacted]; answers.[withheld]: Invalid input; script: Required. Received arguments: [redacted]",
    ],
    [
      "counts and lengths that carry no names",
      "input: 2 unrecognized keys not shown; text: Too big (received 7 characters)",
      "input: 2 unrecognized keys not shown; text: Too big (received 7 characters)",
    ],
    [
      "a message that mentions a marker mid-text",
      "script: see unrecognized keys: here; and Received arguments: there",
      "script: see unrecognized keys: here; and Received arguments: there",
    ],
    [
      "an error name withholds the rest",
      "SyntaxError: Unexpected token 'g', \"ghp_x\" is not valid JSON",
      "SyntaxError: [withheld]",
    ],
    [
      "only the first line",
      'script: Required\n{"token": 1}',
      "script: Required [further lines withheld]",
    ],
    ["no body", "", ""],
  ])("redacts the log copy: %s", (_name, body, logged) => {
    expect(redactRejectedToolCallError(`Invalid input for tool bash: ${body}`)).toBe(
      `Invalid input for tool bash: ${logged}`
    );
  });

  test("keeps a prefix without a tool body as it is", () => {
    expect(redactRejectedToolCallError("Invalid input for tool bash")).toBe(
      "Invalid input for tool bash"
    );
  });

  test("caps the log copy at 500 characters", () => {
    const logged = redactRejectedToolCallError(
      `Invalid input for tool bash: script: ${"x".repeat(2000)}`
    ) as string;

    expect(logged).toStartWith("Invalid input for tool bash: script: xxx");
    expect(logged).toContain("chars omitted");
    expect(logged.length).toBeLessThan(540);
  });
});
