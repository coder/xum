import path from "path";
import fs from "fs/promises";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { MOCK_TOOL_FLOW_PROMPTS } from "../mockAiPrompts";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("tool and reasoning flows", () => {
  test("tool call flow - file read", async ({ ui, workspace }) => {
    await ui.projects.openFirstWorkspace();

    const readmePath = path.join(workspace.demoProject.projectPath, "README.md");
    const readmeContent = "Mock README content for tool flow test.";
    if (readmeContent.length === 0) {
      throw new Error("Test content must not be empty");
    }
    await fs.writeFile(readmePath, `${readmeContent}\n`, "utf-8");

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.FILE_READ);
    });

    const types = timeline.events.map((event) => event.type);
    const streamStartIndex = types.indexOf("stream-start");
    const toolStartIndex = types.indexOf("tool-call-start");
    const toolEndIndex = types.indexOf("tool-call-end");
    const streamEndIndex = types.lastIndexOf("stream-end");

    expect(streamStartIndex).toBeGreaterThanOrEqual(0);
    expect(toolStartIndex).toBeGreaterThan(streamStartIndex);
    expect(toolEndIndex).toBeGreaterThan(toolStartIndex);
    expect(streamEndIndex).toBeGreaterThan(toolEndIndex);

    const toolStartEvent = timeline.events[toolStartIndex];
    if (!toolStartEvent) {
      throw new Error("Timeline missing tool-call-start event for file read flow");
    }
    expect(toolStartEvent.toolName).toBe("file_read");
    expect(toolStartEvent.args).toMatchObject({ filePath: "README.md" });

    const toolEndEvent = timeline.events[toolEndIndex];
    if (!toolEndEvent) {
      throw new Error("Timeline missing tool-call-end event for file read flow");
    }
    expect(toolEndEvent.toolName).toBe("file_read");
    expect(toolEndEvent.result).toMatchObject({
      success: true,
      content: `1\t${readmeContent}`,
    });

    await ui.chat.expectTranscriptContains(readmeContent);
  });

  test("tool call flow - bash execution", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.LIST_DIRECTORY);
    });

    const types = timeline.events.map((event) => event.type);
    const toolStartIndex = types.indexOf("tool-call-start");
    const toolEndIndex = types.indexOf("tool-call-end");
    expect(toolStartIndex).toBeGreaterThanOrEqual(0);
    expect(toolEndIndex).toBeGreaterThan(toolStartIndex);

    const toolStartEvent = timeline.events[toolStartIndex];
    if (!toolStartEvent) {
      throw new Error("Timeline missing tool-call-start event for bash flow");
    }
    expect(toolStartEvent.toolName).toBe("bash");
    expect(toolStartEvent.args).toMatchObject({ script: "ls -1" });

    const toolEndEvent = timeline.events[toolEndIndex];
    if (!toolEndEvent) {
      throw new Error("Timeline missing tool-call-end event for bash flow");
    }
    expect(toolEndEvent.toolName).toBe("bash");
    expect(toolEndEvent.result).toMatchObject({
      success: true,
      output: expect.stringContaining("README.md"),
    });
    expect(toolEndEvent.result).toMatchObject({
      success: true,
      output: expect.stringContaining("package.json"),
    });

    const deltas = timeline.events
      .filter((event) => event.type === "stream-delta")
      .map((event) => event.delta ?? "");
    expect(deltas.some((delta) => delta.includes("README.md"))).toBeTruthy();
  });

  test("multi-turn conversation retains context", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();

    const firstTimeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.CREATE_TEST_FILE);
    });
    if (firstTimeline.events.length === 0) {
      throw new Error("First turn produced no events");
    }
    expect(firstTimeline.events.some((event) => event.type === "tool-call-start")).toBeTruthy();
    await ui.chat.expectTranscriptContains("Created test.txt");

    const secondTimeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.READ_TEST_FILE);
    });
    if (secondTimeline.events.length === 0) {
      throw new Error("Second turn produced no events");
    }
    expect(secondTimeline.events.some((event) => event.type === "tool-call-start")).toBeTruthy();
    await ui.chat.expectTranscriptContains("1\thello");

    const finalTimeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.RECALL_TEST_FILE);
    });
    if (finalTimeline.events.length === 0) {
      throw new Error("Recall turn produced no events");
    }
    expect(finalTimeline.events[0]?.type).toBe("stream-start");
    expect(finalTimeline.events.some((event) => event.type === "tool-call-start")).toBeFalsy();

    await ui.chat.expectTranscriptContains("contains the line 'hello'");
  });

  test("tool call flow - user notification", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.USER_NOTIFY);
    });

    const types = timeline.events.map((event) => event.type);
    const toolStartIndex = types.indexOf("tool-call-start");
    const toolEndIndex = types.indexOf("tool-call-end");
    expect(toolStartIndex).toBeGreaterThanOrEqual(0);
    expect(toolEndIndex).toBeGreaterThan(toolStartIndex);

    const toolStartEvent = timeline.events[toolStartIndex];
    if (!toolStartEvent) {
      throw new Error("Timeline missing tool-call-start event for notify flow");
    }
    expect(toolStartEvent.toolName).toBe("notify");
    expect(toolStartEvent.args).toMatchObject({
      title: "Task Complete",
      message: "Your requested task has been completed successfully.",
    });

    const toolEndEvent = timeline.events[toolEndIndex];
    if (!toolEndEvent) {
      throw new Error("Timeline missing tool-call-end event for notify flow");
    }
    expect(toolEndEvent.toolName).toBe("notify");
    expect(toolEndEvent.result).toMatchObject({
      success: true,
      title: "Task Complete",
    });

    await ui.chat.expectTranscriptContains("sent you a notification");
  });

  test("reasoning model flow emits thinking events", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_TOOL_FLOW_PROMPTS.REASONING_QUICKSORT);
    });

    const reasoningEvents = timeline.events.filter((event) => event.type === "reasoning-delta");
    expect(reasoningEvents.length).toBeGreaterThan(0);
    for (const event of reasoningEvents) {
      expect(event.delta && event.delta.length > 0).toBeTruthy();
    }

    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    const reasoningPreview = transcript
      .getByText("Assessing quicksort mechanics and choosing example array...")
      .first();
    await expect(reasoningPreview).toBeVisible();

    // Thinking blocks are quiet by default (collapsed): the summary line shows with a
    // trailing ellipsis and the multi-line body stays hidden until the user expands.
    await expect(transcript.getByTestId("reasoning-ellipsis")).toHaveCount(1);
    await expect(
      transcript.getByText("Plan: explain pivot selection, partitioning, recursion, base case.")
    ).toHaveCount(0);

    // Expanding reveals the full reasoning body (and the choice sticks for future blocks).
    await reasoningPreview.click();
    await expect(transcript.getByTestId("reasoning-ellipsis")).toHaveCount(0);
    await expect(
      transcript.getByText("Plan: explain pivot selection, partitioning, recursion, base case.")
    ).toBeVisible();
    await ui.chat.expectTranscriptContains("Quicksort works by picking a pivot");
  });
});
