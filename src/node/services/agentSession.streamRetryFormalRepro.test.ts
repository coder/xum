import { expect, spyOn, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import { expectReproFailure } from "@/node/utils/formalRepro.testHarness";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";
import { makeTestEffectRunner } from "./di/testEffectRunner";

// Deterministic code repros for the TLA+ model in formal/stream-retry/ (see its check.sh).
// Each repro passes only while its finding still fails at its single target assertion
// (expectReproFailure); each control shows the setup reaches the code path under test.

const options = { model: "openai:gpt-4o", agentId: "exec" };

/** A session whose startup recovery schedules an auto-retry (backoff on a virtual clock). */
async function retryPending(workspaceId: string) {
  const clock = makeTestEffectRunner();
  const streamManager = { ...createStreamLifecycleMocks(), effectRunner: clock.runner };
  const h = await createAgentSessionHarness({ workspaceId, captureEvents: true, streamManager });
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("user", "user", "first", { retrySendOptions: options })
  );
  await h.session.runStartupRecovery();
  // assert, not expect: a setup failure must not match the repro target's matcher text.
  assert(h.session.hasPendingAutoRetry(), "startup recovery schedules an auto-retry");
  return {
    ...h,
    clock,
    async cleanup() {
      await h.session.dispose();
      await h.cleanup();
      await clock.dispose();
    },
  };
}

/**
 * Starts a manual send and holds it in prepareMessage's preflight (its turn-lease confirmation,
 * one of the awaits before the send is accepted into history and before coordinator.prepare).
 * Returns the pending send and a release for the hold.
 */
async function sendHeldInPreflight(h: Awaited<ReturnType<typeof retryPending>>) {
  const internal = h.session as unknown as { confirmTurnUseLease(): Promise<unknown> };
  const confirm = internal.confirmTurnUseLease.bind(h.session);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  spyOn(internal, "confirmTurnUseLease").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return confirm();
  });
  const sending = h.session.sendMessage("manual successor", options);
  await entered.promise;
  return { sending, release: () => release.resolve() };
}

// ---------------------------------------------------------------------------------------------
// R1 (StreamRetry.tla, MC_faithful, NoStaleRetry): a manual send captures the coordinator's turn
// id at entry (agentSession.ts sendMessage) and cancels the pending auto-retry only once it is
// accepted into history; its coordinator.prepare comes later still. While its preflight awaits
// run, the coordinator is idle, so a backoff that ends then admits the retry's resumeStream: the
// turn id moves, and the user's send is refused as "retired". Fixed: MC_fixed (the manual send
// blocks automatic admission from its entry).

test("R1 control: a manual send during backoff succeeds when the backoff outlasts its preflight", async () => {
  const h = await retryPending("stream-retry-r1-control");
  try {
    const held = await sendHeldInPreflight(h);
    held.release();
    expect((await held.sending).success).toBe(true);
    expect(h.session.hasPendingAutoRetry()).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("R1: an auto-retry whose backoff ends during a manual send's preflight does not refuse the send", async () => {
  await expectReproFailure(
    async () => {
      const h = await retryPending("stream-retry-r1");
      let held: Awaited<ReturnType<typeof sendHeldInPreflight>> | undefined;
      try {
        held = await sendHeldInPreflight(h);
        // streamMessage is a harness mock and spyOn returns that same mock: wrap its
        // implementation, not the mock itself (calling it from the wrapper would recurse).
        const streamSpy = spyOn(h.aiService, "streamMessage");
        const streamMessage = streamSpy.getMockImplementation();
        assert(streamMessage, "harness streamMessage has an implementation");
        const retryReachedProvider = Promise.withResolvers<void>();
        streamSpy.mockImplementation((...args) => {
          retryReachedProvider.resolve();
          return streamMessage(...args);
        });
        // The retry fiber's onRetry (agentSession retryActiveStream). A fix may refuse the
        // retry here (resumeStream returns without reaching the provider) or cancel it before
        // the backoff ends (never called); either way the held send is still released below.
        const internal = h.session as unknown as {
          retryActiveStream(...args: unknown[]): Promise<void>;
        };
        const retryActiveStream = internal.retryActiveStream.bind(h.session);
        let retryStarted = false;
        const retrySettled = Promise.withResolvers<void>();
        spyOn(internal, "retryActiveStream").mockImplementation(async (...args) => {
          retryStarted = true;
          try {
            await retryActiveStream(...args);
          } finally {
            retrySettled.resolve();
          }
        });
        // The backoff ends while the user's send is still in its preflight. adjust resolves
        // after the fiber's synchronous continuation, which calls onRetry. At a186481add the
        // retry is admitted and reaches the provider.
        await h.clock.adjust(calculateBackoffDelay(1));
        if (retryStarted) await Promise.race([retryReachedProvider.promise, retrySettled.promise]);
        held.release();
        const result = await held.sending;
        // Target assertion: the user's message is sent.
        expect(result.success).toBe(true);
      } finally {
        // Disposal drains the send's execution, so a send still held would hang cleanup.
        held?.release();
        await h.cleanup();
      }
    },
    { matcher: "toBe", expected: "true", received: "false" }
  );
});
