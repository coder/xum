import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTestComputerUseService } from "@/node/services/computerUse/computerUseTestFixtures";

import { createComputerTool } from "./computerTool";

const toolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("computer tool", () => {
  test("returns screenshots as JPEG media and failures as tool errors", async () => {
    const { service } = createTestComputerUseService();
    await service.setEnabled("a", true);
    const computer = createComputerTool("a", service);
    const run = (input: object) => computer.execute!(input, toolCallOptions) as Promise<unknown>;

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
});
