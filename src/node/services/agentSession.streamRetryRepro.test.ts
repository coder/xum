import { expect, spyOn, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";
import { makeTestEffectRunner } from "./di/testEffectRunner";

// Deterministic code repros of a stream auto-retry racing a manual send's preflight.
// Each repro failed at its single target assertion before its fix; each control shows the
// setup reaches the code path under test.

const options = { model: "openai:gpt-4o", agentId: "exec" };

/** A session whose startup recovery schedules an auto-retry (backoff on a virtual clock). */
async function retryPending(
  workspaceId: string,
  extra?: { hasExternalManualSendPreflight?: () => boolean }
) {
  const clock = makeTestEffectRunner();
  const streamManager = { ...createStreamLifecycleMocks(), effectRunner: clock.runner };
  const h = await createAgentSessionHarness({
    workspaceId,
    captureEvents: true,
    streamManager,
    ...extra,
  });
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
// A manual send captures the coordinator's turn id at entry (agentSession.ts sendMessage) and
// cancels the pending auto-retry only once it is accepted into history; its coordinator.prepare
// comes later still. The coordinator is idle through that preflight. Before the fix, a backoff that
// ended then admitted the retry's resumeStream, the turn id moved, and the user's send was refused
// as "retired". The fix: a user send blocks automatic admission from its entry
// (manualSendsInPreflight).

test("control: a manual send during backoff succeeds when the backoff outlasts its preflight", async () => {
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

test("an auto-retry whose backoff ends during a manual send's preflight does not refuse the send", async () => {
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
    // after the fiber's synchronous continuation, which calls onRetry. Before the fix the
    // retry was admitted and reached the provider; now resumeStream defers it.
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
});

test("recovery: a send refused in its preflight leaves the deferred retry to run", async () => {
  const h = await retryPending("stream-retry-r1-refused");
  try {
    const internal = h.session as unknown as { confirmTurnUseLease(): Promise<unknown> };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // The send's turn-lease confirmation is refused (a rename or removal holds the workspace).
    spyOn(internal, "confirmTurnUseLease").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return "Workspace is being renamed";
    });
    const sending = h.session.sendMessage("refused successor", options);
    await entered.promise;
    const deferred = Promise.withResolvers<void>();
    const unsubscribe = h.session.onChatEvent(({ message }) => {
      if (message.type === "auto-retry-scheduled") deferred.resolve();
    });
    try {
      await h.clock.adjust(calculateBackoffDelay(1));
      await deferred.promise;
    } finally {
      unsubscribe();
    }
    release.resolve();
    expect((await sending).success).toBe(false);
    // The failed turn keeps its recovery: the deferred retry is still scheduled and runs.
    expect(h.session.hasPendingAutoRetry()).toBe(true);
    const providerStarted = Promise.withResolvers<void>();
    spyOn(h.aiService, "streamMessage").mockImplementationOnce(() => {
      providerStarted.resolve();
      return Promise.resolve(Err({ type: "unknown" as const, raw: "test stream" }));
    });
    await h.clock.adjust(calculateBackoffDelay(2));
    await providerStarted.promise;
  } finally {
    await h.cleanup();
  }
});

test("service preflight: the auto-retry defers while WorkspaceService holds a user send", async () => {
  let servicePreflight = true;
  const h = await retryPending("stream-retry-r1-service", {
    hasExternalManualSendPreflight: () => servicePreflight,
  });
  try {
    const streamSpy = spyOn(h.aiService, "streamMessage");
    const deferred = Promise.withResolvers<void>();
    const unsubscribe = h.session.onChatEvent(({ message }) => {
      if (message.type === "auto-retry-scheduled") deferred.resolve();
    });
    try {
      await h.clock.adjust(calculateBackoffDelay(1));
      await deferred.promise;
    } finally {
      unsubscribe();
    }
    expect(streamSpy).not.toHaveBeenCalled();
    // The service send left without reaching the session (refused there): the retry runs.
    servicePreflight = false;
    const providerStarted = Promise.withResolvers<void>();
    streamSpy.mockImplementationOnce(() => {
      providerStarted.resolve();
      return Promise.resolve(Err({ type: "unknown" as const, raw: "test stream" }));
    });
    await h.clock.adjust(calculateBackoffDelay(2));
    await providerStarted.promise;
  } finally {
    await h.cleanup();
  }
});

test("scope: only the auto-retry defers; other automatic resumes still start", async () => {
  // A task start or terminal-attention drain resumes with origin "automatic" and must not wait
  // for a user send (its own WorkspaceService preflight ticket would otherwise veto it).
  const h = await retryPending("stream-retry-r1-scope", {
    hasExternalManualSendPreflight: () => true,
  });
  try {
    const providerStarted = Promise.withResolvers<void>();
    spyOn(h.aiService, "streamMessage").mockImplementationOnce(() => {
      providerStarted.resolve();
      return Promise.resolve(Err({ type: "unknown" as const, raw: "test stream" }));
    });
    const resuming = h.session.resumeStream(options, { acceptanceOrigin: "automatic" });
    await providerStarted.promise;
    await resuming;
  } finally {
    await h.cleanup();
  }
});
