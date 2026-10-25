import { expect, spyOn, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";
import { makeTestEffectRunner } from "./di/testEffectRunner";

const options = { model: "openai:gpt-4o", agentId: "exec" };

// #7526: cleanup() removed only the temp folder. A session with a pending auto-retry kept
// retrying after its test file ended and took workspace use leases while later files in the
// same bun process ran (#7518).
test("cleanup() stops a pending auto-retry: no retry and no use lease after cleanup", async () => {
  const workspaceId = "harness-cleanup-retry";
  const clock = makeTestEffectRunner();
  const streamManager = { ...createStreamLifecycleMocks(), effectRunner: clock.runner };
  const h = await createAgentSessionHarness({ workspaceId, streamManager });
  try {
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user", "user", "first", { retrySendOptions: options })
    );
    await h.session.runStartupRecovery();
    // assert, not expect: a setup failure must not match the target assertion.
    assert(h.session.hasPendingAutoRetry(), "startup recovery schedules an auto-retry");

    // The retry fiber's onRetry callback calls this method when its backoff ends.
    const internal = h.session as unknown as {
      retryActiveStream(...args: unknown[]): Promise<void>;
    };
    const retryActiveStream = internal.retryActiveStream.bind(h.session);
    const retries: Array<Promise<void>> = [];
    spyOn(internal, "retryActiveStream").mockImplementation((...args) => {
      const retry = retryActiveStream(...args);
      retries.push(retry);
      return retry;
    });
    const hold = spyOn(h.historyService.locks.useLeasesFor(h.config), "hold");

    await h.cleanup();
    // adjust resolves after the fiber's synchronous continuation, which calls onRetry, so a
    // retry that survived cleanup has started by now.
    await clock.adjust(calculateBackoffDelay(1));
    await Promise.allSettled(retries);

    expect({ retries: retries.length, leaseHolds: hold.mock.calls.length }).toEqual({
      retries: 0,
      leaseHolds: 0,
    });
  } finally {
    await h.session.dispose();
    await clock.dispose();
  }
});
