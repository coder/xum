import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { ChatStats } from "@/common/types/chatStats";
import { createMuxMessage } from "@/common/types/message";
import { WorkspaceConsumerManager } from "./WorkspaceConsumerManager";

const STATS: ChatStats = {
  consumers: [{ name: "User", tokens: 5, percentage: 100 }],
  totalTokens: 5,
  model: "gpt-4",
  tokenizerName: "cl100k",
  usageHistory: [],
};

function createAggregator(messageCount: number): StreamingMessageAggregator {
  const messages = Array.from({ length: messageCount }, (_, i) =>
    createMuxMessage(`msg-${i}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(2_000), {
      historySequence: i + 1,
    })
  );
  return {
    getAllMessages: () => messages,
    getCurrentModel: () => "gpt-4",
  } as unknown as StreamingMessageAggregator;
}

function waitForCalculation(manager: WorkspaceConsumerManager, workspaceId: string) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = () => {
      if (manager.getCachedState(workspaceId)) return resolve();
      if (Date.now() > deadline) return reject(new Error("calculation did not complete"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("WorkspaceConsumerManager", () => {
  let cleanupDom: (() => void) | null = null;
  let calculateStats: ReturnType<typeof mock<(input: unknown) => Promise<ChatStats>>>;
  let manager: WorkspaceConsumerManager;

  beforeEach(() => {
    cleanupDom = installDom();
    calculateStats = mock((_input: unknown) => Promise.resolve(STATS));
    window.__ORPC_CLIENT__ = {
      tokenizer: { calculateStats },
    } as unknown as APIClient;
    manager = new WorkspaceConsumerManager(
      () => undefined,
      () => 1
    );
  });

  afterEach(() => {
    manager.dispose();
    delete window.__ORPC_CLIENT__;
    cleanupDom?.();
    cleanupDom = null;
  });

  test("asks the backend for stats by workspaceId instead of uploading the message history", async () => {
    const aggregator = createAggregator(200);

    // Simulate a burst of tool-call-end events during one stream; only the
    // debounced trailing request should reach the backend.
    manager.scheduleCalculation("ws-1", aggregator);
    manager.scheduleCalculation("ws-1", aggregator);
    manager.scheduleCalculation("ws-1", aggregator);
    await waitForCalculation(manager, "ws-1");

    expect(calculateStats).toHaveBeenCalledTimes(1);
    const payload = calculateStats.mock.calls[0][0];
    expect(payload).toEqual({ workspaceId: "ws-1", model: "gpt-4" });
    // Regression guard for the ~36 KB/s upstream leak: the request must stay a few bytes
    // regardless of how large the renderer's copy of the transcript is.
    expect(JSON.stringify(payload).length).toBeLessThan(100);

    expect(manager.getCachedState("ws-1")).toEqual({
      consumers: STATS.consumers,
      tokenizerName: STATS.tokenizerName,
      totalTokens: STATS.totalTokens,
      isCalculating: false,
      topFilePaths: undefined,
    });
  });
});
