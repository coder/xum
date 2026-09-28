import { describe, expect, test, mock, afterEach } from "bun:test";

import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { AgentSessionAIService } from "./agentSession";
import { Err } from "@/common/types/result";

describe("AgentSession.resumeStream", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("returns an error when history is empty", async () => {
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
      Promise.resolve(Err({ type: "unknown", raw: "streamMessage must not be reached" }))
    );

    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "ws",
      aiServiceOverrides: {
        streamMessage,
      },
    });
    historyCleanup = cleanup;

    const result = await session.resumeStream({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("unknown");
    if (result.error.type !== "unknown") {
      throw new Error(`Expected unknown error, got ${result.error.type}`);
    }
    expect(result.error.raw).toContain("history is empty");
    expect(streamMessage).toHaveBeenCalledTimes(0);
  });
});
