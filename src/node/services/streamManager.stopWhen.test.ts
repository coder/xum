import { describe, test, expect, mock } from "bun:test";
import type { QueuedInputStopCause, StreamStopCause } from "@/common/types/streamStopCause";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { StreamEndEventSchema } from "@/common/orpc/schemas/stream";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { StreamManager, type TurnExecutionOptions } from "./streamManager";
import { tool, type LanguageModel, type Tool } from "ai";
import { z } from "zod";
import { engineInternals, onTurnEngineEvent } from "./streamManager.testHarness";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import {
  installStreamManagerTestHistory,
  historyService,
  createTestLanguageModel,
  TEST_STREAM_MODEL_ID,
  appendPartialAssistantForTests,
  createStreamResultForTests,
  createStreamInfoForTests,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

describe("StreamManager - stopWhen configuration", () => {
  type StopWhenCondition = (options: { steps: unknown[] }) => boolean | Promise<boolean>;
  type BuildStopWhenCondition = (request: {
    stopCause?: StreamStopCause;
    getQueuedInputStopCause?: () => QueuedInputStopCause | undefined;
    hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
    toolPolicy?: ToolPolicy;
    onStepSettled?: TurnExecutionOptions["onStepSettled"];
    modelString?: string;
    tools?: Record<string, Tool>;
    contextBudgetMemoryWritable?: boolean;
  }) => StopWhenCondition[];

  function buildStopWhenForTests(streamManager = new StreamManager(historyService)) {
    return engineInternals(streamManager).createStopWhenCondition;
  }

  function requiredToolConditionForTests(toolPolicy: ToolPolicy): StopWhenCondition {
    const [, , requiredToolCondition] = buildStopWhenForTests()({
      hasQueuedMessages: () => false,
      toolPolicy,
    });
    return requiredToolCondition;
  }

  function stepsWithToolResult(toolName: string, output: unknown): { steps: unknown[] } {
    return { steps: [{ toolResults: [{ toolName, output }] }] };
  }

  test("persists the queue stop decision after the session clears the cutter", async () => {
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId: "stop-decision" });
    const manager = new StreamManager(historyService);
    const request: Parameters<BuildStopWhenCondition>[0] & {
      model: LanguageModel;
      messages: never[];
    } = {
      model: createTestLanguageModel(),
      messages: [],
      getQueuedInputStopCause: session.getQueuedInputStopCause.bind(session),
    };
    try {
      const correlation = {
        type: "workspace-turn-task" as const,
        taskHandleId: "wst_test",
        ownerWorkspaceId: "owner",
        turnId: "execution",
      };
      session.queueMessage("continue", {
        model: TEST_STREAM_MODEL_ID,
        agentId: "exec",
        muxMetadata: correlation,
      });
      const [, stop] = buildStopWhenForTests(manager)(request);
      expect(await stop({ steps: [] })).toBe(true);
      const cause = request.stopCause;
      expect(cause?.kind).toBe("queued-input");
      session.clearQueue();
      session.queueMessage("replacement");
      expect(session.getQueuedInputStopCause()?.entryId).not.toBe(
        cause?.kind === "queued-input" ? cause.entryId : undefined
      );
      expect(request.stopCause).toMatchObject({ muxMetadata: correlation });
      const messageId = "stop-decision-message";
      await appendPartialAssistantForTests("stop-decision", messageId, 1);
      const events: unknown[] = [];
      onTurnEngineEvent(manager, "stream-end", (event) => events.push(event));
      const info = createStreamInfoForTests({
        messageId,
        request,
        parts: [{ type: "text", text: "Intermediate result" }],
        streamResult: createStreamResultForTests(
          (async function* () {
            await Promise.resolve();
            yield { type: "finish", finishReason: "tool-calls" };
          })()
        ),
      });
      await engineInternals(manager).processStreamWithCleanup.call(
        manager,
        "stop-decision",
        info,
        1
      );
      expect(events).toHaveLength(1);
      expect(StreamEndEventSchema.parse(events[0]).metadata.stopCause).toEqual(cause);
      const history = await historyService.getHistoryFromLatestBoundary("stop-decision");
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(MuxMessageSchema.parse(history.data.at(-1)).metadata?.stopCause).toEqual(cause);
    } finally {
      session.clearQueue();
      await session.dispose();
      await cleanup();
    }
  });

  test.each([
    { cause: { kind: "required-tool" } as const, expected: "stop" },
    {
      cause: { kind: "queued-input", entryId: "pending-input" } as const,
      expected: "tool-calls",
    },
  ])("persists a downgrade-compatible finish for $cause.kind", async ({ cause, expected }) => {
    const manager = new StreamManager(historyService);
    const workspaceId = "finish-compatibility";
    const messageId = "finished-message";
    await appendPartialAssistantForTests(workspaceId, messageId, 1);
    const events: unknown[] = [];
    onTurnEngineEvent(manager, "stream-end", (event) => events.push(event));
    const info = createStreamInfoForTests({
      messageId,
      request: { model: createTestLanguageModel(), messages: [], stopCause: cause },
      parts: [{ type: "text", text: "Tool result" }],
      streamResult: createStreamResultForTests(
        (async function* () {
          await Promise.resolve();
          yield { type: "finish", finishReason: "tool-calls" };
        })()
      ),
    });
    await engineInternals(manager).processStreamWithCleanup.call(manager, workspaceId, info, 1);
    expect(StreamEndEventSchema.parse(events[0]).metadata.finishReason).toBe(expected);
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.at(-1)?.metadata?.finishReason).toBe(expected);
    expect(history.data.at(-1)?.metadata?.stopCause).toEqual(cause);
  });

  test("records required-tool completion instead of a queued replacement", async () => {
    const request: Parameters<BuildStopWhenCondition>[0] = {
      toolPolicy: [{ regex_match: "agent_report", action: "require" }],
      getQueuedInputStopCause: () => ({ kind: "queued-input", entryId: "replacement" }),
    };
    const [, queueStop, requiredStop] = buildStopWhenForTests()(request);
    const step = stepsWithToolResult("agent_report", { success: true });
    expect(await queueStop(step)).toBe(false);
    expect(await requiredStop(step)).toBe(true);
    expect(request.stopCause?.kind).toBe("required-tool");
  });

  test("returns step-cap and queued-message conditions with no policy", async () => {
    let queued = false;
    const stopWhen = buildStopWhenForTests()({ hasQueuedMessages: () => queued });
    expect(stopWhen).toHaveLength(3);

    const [maxStepCondition, queuedMessageCondition, requiredToolCondition] = stopWhen;
    expect(maxStepCondition({ steps: new Array(99999) })).toBe(false);
    expect(maxStepCondition({ steps: new Array(100000) })).toBe(true);

    expect(await queuedMessageCondition({ steps: [] })).toBe(false);
    queued = true;
    expect(await queuedMessageCondition({ steps: [] })).toBe(true);
    expect(requiredToolCondition(stepsWithToolResult("agent_report", { success: true }))).toBe(
      false
    );
  });

  test.each(["warn", "rollover"] as const)(
    "budget %s stops with only turn-end input queued and evaluates settled fallback usage",
    async (decision) => {
      const onStepSettled = mock<NonNullable<TurnExecutionOptions["onStepSettled"]>>(() =>
        Promise.resolve({ decision })
      );
      const sessionHistory = tool({ inputSchema: z.object({}) });
      const [, stop] = buildStopWhenForTests()({
        // The ordinary queue condition must be false; the budget decision itself stops the SDK.
        hasQueuedMessages: (mode?: "tool-end" | "turn-end") => mode === "turn-end",
        onStepSettled,
        modelString: "anthropic:claude-sonnet-4-5",
        tools: { session_history: sessionHistory },
        contextBudgetMemoryWritable: true,
      });
      const providerMetadata = { anthropic: { cacheCreationInputTokens: 20 } };
      expect(
        await stop({
          steps: [
            {
              usage: {
                inputTokens: 90,
                outputTokens: 10,
                totalTokens: 100,
                inputTokenDetails: { cacheReadTokens: 40 },
                outputTokenDetails: { reasoningTokens: 3 },
              },
              providerMetadata,
              toolResults: [
                { toolName: "bash", output: "first sibling" },
                { toolName: "file_read", output: "x".repeat(40_000) },
              ],
            },
          ],
        })
      ).toBe(true);
      expect(onStepSettled).toHaveBeenCalledTimes(1);
      const settled = onStepSettled.mock.calls[0][0];
      expect(settled).toMatchObject({
        model: "anthropic:claude-sonnet-4-5",
        usage: { inputTokens: 90, outputTokens: 10, cachedInputTokens: 40, reasoningTokens: 3 },
        providerMetadata,
        sessionHistoryAvailable: true,
        memoryWritable: true,
      });
      expect(settled.toolResultChars).toBeGreaterThan(40_000);
      expect(settled.newContextRequested).toBe(false);
    }
  );

  test.each([
    ["warn", "continue-entry"],
    ["rollover", "continue-entry"],
    ["block", undefined],
  ] as const)(
    "budget %s binds the session's designated continuation into the stop cause",
    async (decision, expectedEntryId) => {
      const request: Parameters<BuildStopWhenCondition>[0] = {
        hasQueuedMessages: () => false,
        // The session names its successor with the decision; a blocked stop hands over to none.
        onStepSettled: () => Promise.resolve({ decision, continuationEntryId: "continue-entry" }),
        modelString: "anthropic:claude-sonnet-4-5",
      };
      const [, stop] = buildStopWhenForTests()(request);
      const step = { steps: [{ usage: undefined, toolResults: [] }] };
      if (decision === "block") {
        let thrown: unknown;
        try {
          await stop(step);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
      } else {
        expect(await stop(step)).toBe(true);
      }
      expect(request.stopCause).toEqual({
        kind: "context-budget",
        decision,
        ...(expectedEntryId != null ? { continuationEntryId: expectedEntryId } : {}),
      });
    }
  );

  test("a settled successful new_context result is reported alongside its siblings", async () => {
    const onStepSettled = mock<NonNullable<TurnExecutionOptions["onStepSettled"]>>(() =>
      Promise.resolve({ decision: "rollover" })
    );
    const [, stop] = buildStopWhenForTests()({
      hasQueuedMessages: () => false,
      onStepSettled,
      modelString: "anthropic:claude-sonnet-4-5",
      tools: { session_history: tool({ inputSchema: z.object({}) }) },
    });
    const settle = (output: unknown) =>
      stop({
        steps: [
          {
            usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
            toolResults: [
              { toolName: "bash", output: "side effect done" },
              { toolName: "new_context", output },
            ],
          },
        ],
      });
    expect(await settle({ success: true, status: "scheduled", message: "ok" })).toBe(true);
    expect(onStepSettled.mock.calls[0][0].newContextRequested).toBe(true);
    // Even a policy that "requires" new_context cannot turn its success into a terminal
    // completion that would skip the settled-step callback.
    const [, stopRequired, required] = buildStopWhenForTests()({
      hasQueuedMessages: () => false,
      onStepSettled,
      modelString: "anthropic:claude-sonnet-4-5",
      tools: { session_history: tool({ inputSchema: z.object({}) }) },
      toolPolicy: [{ regex_match: "new_context", action: "require" }],
    });
    const requiredSteps = {
      steps: [
        {
          usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
          toolResults: [
            { toolName: "new_context", output: { success: true, status: "scheduled" } },
          ],
        },
      ],
    };
    expect(required(requiredSteps)).toBe(false);
    expect(await stopRequired(requiredSteps)).toBe(true);
    expect(onStepSettled.mock.calls.at(-1)?.[0].newContextRequested).toBe(true);
    // A failed or error-shaped result is not a request.
    await settle({ success: false, error: "denied" });
    expect(onStepSettled.mock.calls.at(-1)?.[0].newContextRequested).toBe(false);
  });

  test("successful required completion wins over rollover while a failed tool still evaluates budget", async () => {
    const onStepSettled = mock<NonNullable<TurnExecutionOptions["onStepSettled"]>>(() =>
      Promise.resolve({ decision: "rollover" })
    );
    const [, stop, required] = buildStopWhenForTests()({
      onStepSettled,
      modelString: TEST_STREAM_MODEL_ID,
      toolPolicy: [{ regex_match: "agent_report", action: "require" }],
    });
    const success = stepsWithToolResult("agent_report", { success: true });
    expect(await stop(success)).toBe(false);
    expect(await required(success)).toBe(true);
    expect(onStepSettled).not.toHaveBeenCalled();
    expect(await stop(stepsWithToolResult("agent_report", { success: false }))).toBe(true);
    expect(onStepSettled).toHaveBeenCalledTimes(1);
  });

  const requiredToolCases: Array<{
    name: string;
    toolPolicy: ToolPolicy;
    assertions: Array<{ toolName: string; output: unknown; expected: boolean }>;
    emptyStepsExpected?: boolean;
  }> = [
    {
      name: "stops on successful required tool result matching policy",
      toolPolicy: [{ regex_match: "agent_report", action: "require" }],
      assertions: [
        { toolName: "agent_report", output: { success: true }, expected: true },
        { toolName: "agent_report", output: { success: false }, expected: false },
        { toolName: "bash", output: { success: true }, expected: false },
      ],
      emptyStepsExpected: false,
    },
    {
      name: "stops on required tool result without success/ok markers (e.g. MCP tools)",
      toolPolicy: [{ regex_match: "chrome_take_screenshot", action: "require" }],
      assertions: [
        {
          toolName: "chrome_take_screenshot",
          output: { content: [{ type: "image", data: "..." }] },
          expected: true,
        },
      ],
    },
    {
      name: "does not stop when required tool returns error-shaped output",
      toolPolicy: [{ regex_match: "chrome_take_screenshot", action: "require" }],
      assertions: [
        {
          toolName: "chrome_take_screenshot",
          output: { error: "connection refused" },
          expected: false,
        },
        {
          toolName: "chrome_take_screenshot",
          output: { isError: true, content: [{ type: "text", text: "failed" }] },
          expected: false,
        },
      ],
    },
    {
      name: "does not stop when required tool explicitly returns success: false",
      toolPolicy: [{ regex_match: "propose_plan", action: "require" }],
      assertions: [
        {
          toolName: "propose_plan",
          output: { success: false, error: "plan file missing" },
          expected: false,
        },
      ],
    },
    {
      name: "handles pre-anchored require patterns from recovery paths",
      toolPolicy: [{ regex_match: "^agent_report$", action: "require" }],
      assertions: [{ toolName: "agent_report", output: { success: true }, expected: true }],
    },
    {
      name: "stops on successful propose_plan when required by policy",
      toolPolicy: [{ regex_match: "propose_plan", action: "require" }],
      assertions: [{ toolName: "propose_plan", output: { success: true }, expected: true }],
    },
    {
      name: "does not stop on tool results when no tools are required",
      toolPolicy: [{ regex_match: "bash", action: "enable" }],
      assertions: [{ toolName: "bash", output: { success: true }, expected: false }],
    },
  ];

  for (const requiredToolCase of requiredToolCases) {
    test(requiredToolCase.name, () => {
      const requiredToolCondition = requiredToolConditionForTests(requiredToolCase.toolPolicy);
      for (const assertion of requiredToolCase.assertions) {
        expect(
          requiredToolCondition(stepsWithToolResult(assertion.toolName, assertion.output))
        ).toBe(assertion.expected);
      }
      if (requiredToolCase.emptyStepsExpected != null) {
        expect(requiredToolCondition({ steps: [] })).toBe(requiredToolCase.emptyStepsExpected);
      }
    });
  }
});
