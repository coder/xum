import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getStatusStateKey } from "@/common/constants/storage";
import { createMuxMessage } from "@/common/types/message";
import { restartLocalStorage } from "../../../../tests/ui/quotaLimitedStorage";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const CREATED_AT = "2024-01-01T00:00:00.000Z";
const WORKSPACE_ID = "workspace1";
const MODEL = "test-model";
const originalLocalStorage: Storage | undefined = (globalThis as { localStorage?: Storage })
  .localStorage;
const originalWindow: unknown = (globalThis as { window?: unknown }).window;

interface StatusInput {
  emoji: string;
  message: string;
  url?: string;
}
type StatusResult = ({ success: true } & StatusInput) | { success: false; error: string };
interface StreamStartOptions {
  messageId?: string;
  historySequence?: number;
  workspaceId?: string;
}
interface StatusToolOptions {
  messageId?: string;
  toolCallId?: string;
  input: StatusInput;
  result?: StatusResult;
  workspaceId?: string;
}

const createMockLocalStorage = () => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  } satisfies Storage;
};

function createAggregator(workspaceId?: string) {
  return new StreamingMessageAggregator(CREATED_AT, workspaceId);
}

function startStream(aggregator: StreamingMessageAggregator, options: StreamStartOptions = {}) {
  aggregator.handleStreamStart({
    type: "stream-start",
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    messageId: options.messageId ?? "msg1",
    model: MODEL,
    historySequence: options.historySequence ?? 1,
    startTime: Date.now(),
  });
}

function endStream(
  aggregator: StreamingMessageAggregator,
  options: { messageId?: string; workspaceId?: string } = {}
) {
  aggregator.handleStreamEnd({
    type: "stream-end",
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    messageId: options.messageId ?? "msg1",
    metadata: { model: MODEL },
    parts: [],
  });
}

function runStatusTool(aggregator: StreamingMessageAggregator, options: StatusToolOptions) {
  const messageId = options.messageId ?? "msg1";
  const toolCallId = options.toolCallId ?? "tool1";
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;

  aggregator.handleToolCallStart({
    type: "tool-call-start",
    workspaceId,
    messageId,
    toolCallId,
    toolName: "status_set",
    args: options.input,
    tokens: 10,
    timestamp: Date.now(),
  });

  aggregator.handleToolCallEnd({
    type: "tool-call-end",
    workspaceId,
    messageId,
    toolCallId,
    toolName: "status_set",
    result: options.result ?? { success: true, ...options.input },
    timestamp: Date.now(),
  });
}

function statusMessage(
  id: string,
  toolCallId: string,
  input: StatusInput,
  options: { output?: StatusResult; historySequence?: number; timestamp?: number } = {}
) {
  const message = createMuxMessage(id, "assistant", "", {
    timestamp: options.timestamp ?? options.historySequence ?? 1,
    historySequence: options.historySequence ?? 1,
  });
  message.parts.push({
    type: "dynamic-tool",
    toolCallId,
    toolName: "status_set",
    state: "output-available",
    input,
    output: options.output ?? { success: true, ...input },
    timestamp: options.timestamp ?? options.historySequence ?? 1,
  });
  return message;
}

beforeEach(() => {
  const localStorage = createMockLocalStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  // Status persistence goes through the persisted-state helpers, which read `window.localStorage`
  // (and dispatch same-tab change events on `window`).
  const testWindow: Pick<Window, "localStorage" | "dispatchEvent"> = {
    localStorage,
    dispatchEvent: () => true,
  };
  Object.defineProperty(globalThis, "window", { value: testWindow, configurable: true });
});

afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage?.clear?.();
});

afterAll(() => {
  if (originalWindow !== undefined) {
    Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (originalLocalStorage !== undefined) {
    Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage });
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

describe("ask_user_question waiting state", () => {
  it("treats partial ask_user_question as executing (waiting) not interrupted", () => {
    const aggregator = createAggregator();
    const assistantMessage = createMuxMessage("assistant-1", "assistant", "", {
      timestamp: 1000,
      historySequence: 1,
      partial: true,
    });
    assistantMessage.parts.push({
      type: "dynamic-tool",
      toolCallId: "call-ask-1",
      toolName: "ask_user_question",
      state: "input-available",
      input: {
        questions: [
          {
            header: "Approach",
            question: "Which approach should we take?",
            options: [
              { label: "A", description: "Approach A" },
              { label: "B", description: "Approach B" },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    aggregator.loadHistoricalMessages([assistantMessage]);

    const toolMsg = aggregator
      .getDisplayedMessages()
      .find((m) => m.type === "tool" && m.toolName === "ask_user_question");
    expect(toolMsg).toBeDefined();
    if (toolMsg?.type === "tool") {
      expect(toolMsg.status).toBe("executing");
      expect(toolMsg.isPartial).toBe(true);
    }
    expect(aggregator.hasAwaitingUserQuestion()).toBe(true);
  });
});

describe("StreamingMessageAggregator - Agent Status", () => {
  it("should start with undefined agent status", () => {
    expect(createAggregator().getAgentStatus()).toBeUndefined();
  });

  it("should update agent status when status_set tool succeeds", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    runStatusTool(aggregator, { input: { emoji: "🔍", message: "Analyzing code" } });

    const status = aggregator.getAgentStatus();
    expect(status).toBeDefined();
    expect(status?.emoji).toBe("🔍");
    expect(status?.message).toBe("Analyzing code");
  });

  it("should update agent status multiple times", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    runStatusTool(aggregator, {
      toolCallId: "tool1",
      input: { emoji: "🔍", message: "Analyzing" },
    });
    expect(aggregator.getAgentStatus()?.emoji).toBe("🔍");

    runStatusTool(aggregator, {
      toolCallId: "tool2",
      input: { emoji: "📝", message: "Writing" },
    });
    expect(aggregator.getAgentStatus()?.emoji).toBe("📝");
    expect(aggregator.getAgentStatus()?.message).toBe("Writing");
  });

  it("should persist agent status after stream ends", () => {
    const aggregator = createAggregator(WORKSPACE_ID);
    startStream(aggregator);
    runStatusTool(aggregator, { input: { emoji: "🔍", message: "Working" } });
    expect(aggregator.getAgentStatus()).toBeDefined();

    endStream(aggregator);
    expect(aggregator.getAgentStatus()).toBeDefined();
    expect(aggregator.getAgentStatus()?.emoji).toBe("🔍");
  });

  it("should not update agent status if tool call fails", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    runStatusTool(aggregator, {
      input: { emoji: "🔍", message: "Analyzing" },
      result: { success: false, error: "Something went wrong" },
    });

    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should clear agent status when new user message arrives", () => {
    const aggregator = createAggregator(WORKSPACE_ID);
    startStream(aggregator);
    runStatusTool(aggregator, { input: { emoji: "🔍", message: "First task" } });
    expect(aggregator.getAgentStatus()?.message).toBe("First task");

    endStream(aggregator);
    expect(aggregator.getAgentStatus()?.message).toBe("First task");

    aggregator.handleMessage({
      type: "message",
      ...createMuxMessage("msg2", "user", "What's next?", {
        timestamp: Date.now(),
        historySequence: 2,
      }),
    });
    expect(aggregator.getAgentStatus()).toBeUndefined();
    // The persisted copy is cleared too, so a reload does not resurrect the stale status.
    expect(createAggregator(WORKSPACE_ID).getAgentStatus()).toBeUndefined();
  });

  const toolStatusScenarios = [
    {
      name: "should show 'failed' status in UI when status_set validation fails",
      input: { emoji: "not-an-emoji", message: "test" },
      result: { success: false, error: "emoji must be a single emoji character" } as const,
      expectedToolStatus: "failed",
      expectedAgentStatus: undefined,
    },
    {
      name: "should show 'completed' status in UI when status_set validation succeeds",
      input: { emoji: "🔍", message: "Analyzing code" },
      result: { success: true, emoji: "🔍", message: "Analyzing code" } as const,
      expectedToolStatus: "completed",
      expectedAgentStatus: { emoji: "🔍", message: "Analyzing code" },
    },
  ] as const;

  for (const scenario of toolStatusScenarios) {
    it(scenario.name, () => {
      const aggregator = createAggregator(WORKSPACE_ID);
      startStream(aggregator);
      runStatusTool(aggregator, { input: scenario.input, result: scenario.result });
      endStream(aggregator);

      const toolMessage = aggregator.getDisplayedMessages().find((m) => m.type === "tool");
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.type).toBe("tool");
      if (toolMessage?.type === "tool") {
        expect(toolMessage.status).toBe(scenario.expectedToolStatus);
        expect(toolMessage.toolName).toBe("status_set");
      }
      expect(aggregator.getAgentStatus()).toEqual(scenario.expectedAgentStatus);
    });
  }

  it("should reconstruct agentStatus when loading historical messages", () => {
    const aggregator = createAggregator();
    aggregator.loadHistoricalMessages([
      createMuxMessage("msg1", "user", "Hello", { timestamp: Date.now(), historySequence: 1 }),
      (() => {
        const message = statusMessage(
          "msg2",
          "tool1",
          { emoji: "🔍", message: "Analyzing code" },
          { historySequence: 2, timestamp: Date.now() }
        );
        message.parts.unshift({ type: "text", text: "Working on it..." });
        return message;
      })(),
    ]);

    const status = aggregator.getAgentStatus();
    expect(status).toBeDefined();
    expect(status?.emoji).toBe("🔍");
    expect(status?.message).toBe("Analyzing code");
  });

  it("should use most recent status_set when loading multiple historical messages", () => {
    const aggregator = createAggregator();
    aggregator.loadHistoricalMessages([
      statusMessage(
        "msg1",
        "tool1",
        { emoji: "🔍", message: "First status" },
        { historySequence: 1 }
      ),
      statusMessage(
        "msg2",
        "tool2",
        { emoji: "📝", message: "Second status" },
        { historySequence: 2 }
      ),
    ]);

    const status = aggregator.getAgentStatus();
    expect(status?.emoji).toBe("📝");
    expect(status?.message).toBe("Second status");
  });

  it("should not reconstruct status from failed status_set in historical messages", () => {
    const aggregator = createAggregator();
    aggregator.loadHistoricalMessages([
      statusMessage(
        "msg1",
        "tool1",
        { emoji: "not-emoji", message: "test" },
        { output: { success: false, error: "emoji must be a single emoji character" } }
      ),
    ]);

    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should retain last status_set even if later assistant messages omit it", () => {
    const aggregator = createAggregator();
    aggregator.loadHistoricalMessages([
      statusMessage(
        "assistant1",
        "tool1",
        { emoji: "🧪", message: "Running tests" },
        { timestamp: 1000 }
      ),
      createMuxMessage("assistant2", "assistant", "[compaction summary]", {
        timestamp: 2000,
        historySequence: 2,
      }),
    ]);

    const status = aggregator.getAgentStatus();
    expect(status?.emoji).toBe("🧪");
    expect(status?.message).toBe("Running tests");
  });

  it("should restore persisted status when history is compacted away", () => {
    const persistedStatus = {
      emoji: "🔗",
      message: "PR open",
      url: "https://example.com/pr/123",
    } as const;
    localStorage.setItem(getStatusStateKey(WORKSPACE_ID), JSON.stringify(persistedStatus));

    const aggregator = createAggregator(WORKSPACE_ID);
    aggregator.loadHistoricalMessages([
      createMuxMessage("assistant2", "assistant", "[compacted history]", {
        timestamp: 3000,
        historySequence: 1,
      }),
    ]);

    expect(aggregator.getAgentStatus()).toEqual(persistedStatus);
  });

  // An over-budget status lived only in memory, so after a restart it was lost once compacted.
  it("should restore a status with an overlong message and URL after a restart, bounded", () => {
    // A dynamic (MCP) status_set output is not length-limited.
    const longMessage = `PR open ${"m".repeat(600)}`;
    const aggregator = createAggregator(WORKSPACE_ID);
    startStream(aggregator);
    runStatusTool(aggregator, {
      input: { emoji: "🔗", message: longMessage, url: `https://example.com/${"x".repeat(600)}` },
    });
    endStream(aggregator);

    restartLocalStorage();
    const restarted = createAggregator(WORKSPACE_ID);
    restarted.loadHistoricalMessages([
      createMuxMessage("assistant2", "assistant", "[compacted history]", {
        timestamp: 3000,
        historySequence: 1,
      }),
    ]);

    const restored = restarted.getAgentStatus();
    expect(restored?.emoji).toBe("🔗");
    expect(restored?.url).toBeUndefined();
    expect(restored?.message.startsWith("PR open m")).toBe(true);
    expect(longMessage.startsWith(restored?.message ?? "")).toBe(true);
  });

  it("should use truncated message from output, not original input", () => {
    const aggregator = createAggregator();
    const longMessage = "a".repeat(100);
    const truncatedMessage = "a".repeat(59) + "…";

    startStream(aggregator);
    runStatusTool(aggregator, {
      input: { emoji: "✅", message: longMessage },
      result: { success: true, emoji: "✅", message: truncatedMessage },
    });

    const status = aggregator.getAgentStatus();
    expect(status).toEqual({ emoji: "✅", message: truncatedMessage });
    expect(status?.message.length).toBe(60);
  });

  it("should store URL when provided in status_set", () => {
    const aggregator = createAggregator();
    const testUrl = "https://github.com/owner/repo/pull/123";

    startStream(aggregator);
    runStatusTool(aggregator, {
      input: { emoji: "🔗", message: "PR submitted", url: testUrl },
    });

    const status = aggregator.getAgentStatus();
    expect(status).toBeDefined();
    expect(status?.emoji).toBe("🔗");
    expect(status?.message).toBe("PR submitted");
    expect(status?.url).toBe(testUrl);
  });

  it("should persist URL across status updates until explicitly replaced", () => {
    const aggregator = createAggregator();
    const testUrl = "https://github.com/owner/repo/pull/123";
    const newUrl = "https://github.com/owner/repo/pull/456";

    startStream(aggregator);
    runStatusTool(aggregator, {
      toolCallId: "tool1",
      input: { emoji: "🔗", message: "PR submitted", url: testUrl },
    });
    expect(aggregator.getAgentStatus()?.url).toBe(testUrl);

    runStatusTool(aggregator, {
      toolCallId: "tool2",
      input: { emoji: "✅", message: "Done" },
    });
    const statusAfterUpdate = aggregator.getAgentStatus();
    expect(statusAfterUpdate?.emoji).toBe("✅");
    expect(statusAfterUpdate?.message).toBe("Done");
    expect(statusAfterUpdate?.url).toBe(testUrl);

    runStatusTool(aggregator, {
      toolCallId: "tool3",
      input: { emoji: "🔄", message: "New PR", url: newUrl },
    });
    const finalStatus = aggregator.getAgentStatus();
    expect(finalStatus?.emoji).toBe("🔄");
    expect(finalStatus?.message).toBe("New PR");
    expect(finalStatus?.url).toBe(newUrl);
  });

  it("should persist URL even after status is cleared by new stream start", () => {
    const aggregator = createAggregator();
    const testUrl = "https://github.com/owner/repo/pull/123";

    startStream(aggregator, { messageId: "msg1" });
    runStatusTool(aggregator, {
      messageId: "msg1",
      toolCallId: "tool1",
      input: { emoji: "🔗", message: "PR submitted", url: testUrl },
    });
    expect(aggregator.getAgentStatus()?.url).toBe(testUrl);

    aggregator.handleMessage({
      type: "message",
      ...createMuxMessage("user1", "user", "Continue", {
        timestamp: Date.now(),
        historySequence: 2,
      }),
    });
    expect(aggregator.getAgentStatus()).toBeUndefined();

    startStream(aggregator, { messageId: "msg2", historySequence: 2 });
    runStatusTool(aggregator, {
      messageId: "msg2",
      toolCallId: "tool2",
      input: { emoji: "✅", message: "Tests passed" },
    });

    const finalStatus = aggregator.getAgentStatus();
    expect(finalStatus?.emoji).toBe("✅");
    expect(finalStatus?.message).toBe("Tests passed");
    expect(finalStatus?.url).toBe(testUrl);
  });

  it("should persist URL across multiple assistant messages when loading from history", () => {
    const aggregator = createAggregator();
    const testUrl = "https://github.com/owner/repo/pull/123";

    aggregator.loadHistoricalMessages([
      createMuxMessage("user1", "user", "Make a PR", { timestamp: 1000, historySequence: 1 }),
      statusMessage(
        "assistant1",
        "tool1",
        { emoji: "🔗", message: "PR submitted", url: testUrl },
        { timestamp: 1001, historySequence: 2 }
      ),
      createMuxMessage("user2", "user", "Continue", { timestamp: 2000, historySequence: 3 }),
      statusMessage(
        "assistant2",
        "tool2",
        { emoji: "✅", message: "Tests passed" },
        { timestamp: 2001, historySequence: 4 }
      ),
    ]);

    const status = aggregator.getAgentStatus();
    expect(status?.emoji).toBe("✅");
    expect(status?.message).toBe("Tests passed");
    expect(status?.url).toBe(testUrl);
  });

  // Note: URL persistence through compaction is handled via localStorage,
  // which is tested in integration tests. The aggregator saves lastStatusUrl
  // to localStorage when it changes, and loads it on construction.
});
