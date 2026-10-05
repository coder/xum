import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";

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

  test("runs only the first action of a response", async () => {
    const { service, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);
    const computer = createComputerTool(service.grantFor("a")!);
    const run = (input: object, options: ToolExecutionOptions<unknown>) =>
      computer.execute!(input, options) as Promise<unknown>;
    const batch = response();

    await run({ action: "screenshot" }, batch);
    // The click was planned before the screenshot it would now be checked against existed.
    expect(await run({ action: "left_click", x: 1, y: 1 }, batch)).toMatchObject({
      success: false,
    });
    expect(driver.calls).toEqual([]);
    expect(await run({ action: "left_click", x: 1, y: 1 }, response())).toMatchObject({
      type: "content",
    });
    expect(driver.calls).toContain("click left");
  });
});
