import { describe, expect, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { isStepCount, streamText, type ToolExecutionOptions } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

import { createTestComputerUseService } from "@/node/services/computerUse/computerUseTestFixtures";

import { createComputerTool } from "./computerTool";

// Calls from one model response share its input messages; each call here is its own response.
const response = (): ToolExecutionOptions<unknown> => ({
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
});

describe("computer tool", () => {
  test("returns screenshots as JPEG media and failures as tool errors", async () => {
    const { service } = createTestComputerUseService();
    await service.setEnabled("a", true);
    const computer = createComputerTool(service.grantFor("a")!);
    const run = (input: object) => computer.execute!(input, response()) as Promise<unknown>;

    const failure = (await run({ action: "left_click", x: 1, y: 1 })) as {
      success: boolean;
      error: string;
    };
    expect(failure.success).toBe(false);
    expect(failure.error).toMatch(/Take a screenshot first/);
    expect(await run({ action: "screenshot" })).toMatchObject({
      type: "content",
      value: [{ type: "text" }, { type: "media", mediaType: "image/jpeg", data: "anBlZw==" }],
    });
    const cursor = (await run({ action: "cursor_position" })) as {
      value: Array<{ type: string; text: string }>;
    };
    expect(cursor.value).toHaveLength(1);
    expect(cursor.value[0].text).toMatch(/\(678, 424\)/);
  });

  test("runs only the first action of a model response", async () => {
    const { service, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);
    const click = { action: "left_click", x: 1, y: 1 };
    // Step one plans a click alongside the screenshot it should have waited for; step two retries.
    const steps = [[{ action: "screenshot" }, click], [click], []];
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: () => {
        const calls = steps[step++] ?? [];
        const chunks: LanguageModelV3StreamPart[] = [
          ...calls.map((input, index) => ({
            type: "tool-call" as const,
            toolCallId: `call-${step}-${index}`,
            toolName: "computer",
            input: JSON.stringify(input),
          })),
          {
            type: "finish",
            finishReason: { unified: calls.length > 0 ? "tool-calls" : "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ];
        return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
      },
    });

    const result = streamText({
      model,
      prompt: "Click the button.",
      tools: { computer: createComputerTool(service.grantFor("a")!) },
      stopWhen: isStepCount(steps.length),
    });
    // Results arrive in completion order, so look them up by call.
    const outputs = new Map(
      (await result.steps).flatMap((s) => s.toolResults.map((r) => [r.toolCallId, r.output]))
    );

    expect(outputs.get("call-1-0")).toMatchObject({ type: "content" });
    expect(outputs.get("call-1-1")).toMatchObject({ success: false });
    expect(outputs.get("call-2-0")).toMatchObject({ type: "content" });
    expect(driver.calls.filter((call) => call.startsWith("click"))).toEqual(["click left"]);
  });
});
