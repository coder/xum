import { describe, expect, test, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { Err } from "@/common/types/result";

import type { MuxMessage } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";
import {
  compactSessionForTest,
  createAgentSessionHarness,
  createFailedTurnHandle,
  createStartedTurnHandle,
  sessionCompactionHandler,
} from "./agentSession.testHarness";

function contextExceededResult(messageId: string) {
  return {
    success: true as const,
    data: createFailedTurnHandle(messageId, {
      error: "Context length exceeded",
      errorType: "context_exceeded",
    }),
  };
}

const HEADER = { text: "<post-compaction context>", skillNames: [] };

function createHeaderBoundary(): MuxMessage {
  return {
    id: "compaction-summary",
    role: "assistant",
    parts: [{ type: "text", text: "Summary" }],
    metadata: {
      timestamp: 1000,
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
      postCompactionContext: HEADER,
    },
  };
}

/** The header on the boundary row of one streamMessage call's request messages. */
function requestHeader(streamMessage: ReturnType<typeof mock>, call: number): unknown {
  const { messages } = streamMessage.mock.calls[call][0] as { messages: MuxMessage[] };
  return messages.find((message) => message.id === "compaction-summary")?.metadata
    ?.postCompactionContext;
}

function createPersistedPostCompactionState(options: {
  filePath: string;
  diffs: Array<{ path: string; diff: string; truncated: boolean }>;
}): Promise<void> {
  const payload = {
    version: 1 as const,
    createdAt: Date.now(),
    // Pending state belongs to the boundary that createHeaderBoundary writes.
    boundaryMessageId: "compaction-summary",
    diffs: options.diffs,
  };

  return fsPromises.writeFile(options.filePath, JSON.stringify(payload));
}

describe("AgentSession post-compaction context retry", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  /** Real Config/HistoryService pair plus this workspace's session dir. */
  async function createSessionsFixture(workspaceId: string) {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    return { historyService, config, sessionDir };
  }

  /**
   * Resume a session whose first stream fails with context_exceeded, and wait until the retry
   * streams. `beforeResume` runs on the new session before the resume.
   */
  async function resumeIntoContextRetry(
    fixture: Awaited<ReturnType<typeof createSessionsFixture>>,
    workspaceId: string,
    beforeResume?: (session: AgentSession) => Promise<void>
  ) {
    const aiEmitter = new EventEmitter();
    let resolveRetry: (() => void) | undefined;
    const retried = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const streamMessage = mock((..._args: unknown[]) => {
      if (streamMessage.mock.calls.length === 1) {
        // Simulate a provider context limit error before any deltas.
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return Promise.resolve(contextExceededResult("assistant-ctx-exceeded"));
      }
      resolveRetry?.();
      return Promise.resolve({
        success: true as const,
        data: createStartedTurnHandle(session.closingSignal, "assistant-retry"),
      });
    });
    const { session } = await createAgentSessionHarness({
      workspaceId,
      config: fixture.config,
      historyService: fixture.historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        // No workspace metadata: the retry path must not depend on a runtime.
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });
    await beforeResume?.(session);

    // Exercise the public resume facade so retry preparation has a real admitted owner.
    await session.resumeStream({
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions);
    await Promise.race([
      retried,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry timeout")), 1000)),
    ]);
    return { session, streamMessage };
  }

  test("retries once without post-compaction injection on context_exceeded", async () => {
    const workspaceId = "ws";
    const fixture = await createSessionsFixture(workspaceId);
    const { historyService } = fixture;
    const postCompactionPath = path.join(fixture.sessionDir, "post-compaction.json");

    await createPersistedPostCompactionState({
      filePath: postCompactionPath,
      diffs: [
        {
          path: "/tmp/foo.ts",
          diff: "@@ -1 +1 @@\n-foo\n+bar\n",
          truncated: false,
        },
      ],
    });

    const history: MuxMessage[] = [
      createHeaderBoundary(),
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 1100 },
      },
    ];

    for (const msg of history) {
      await historyService.appendToHistory(workspaceId, msg);
    }
    spyOn(historyService, "deleteMessage");

    const { session, streamMessage } = await resumeIntoContextRetry(fixture, workspaceId);
    expect(streamMessage).toHaveBeenCalledTimes(2);

    // Codex fast-retry scenario: a waiter that arrives only after the retry
    // already started (and possibly finished) must still see the recorded
    // "retry-started" outcome for this attempt instead of sampling live flags.
    expect(await session.waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")).toBe(
      "retry-started"
    );

    expect(requestHeader(streamMessage, 0)).toEqual(HEADER);
    expect(requestHeader(streamMessage, 1)).toBeUndefined();

    expect((historyService.deleteMessage as ReturnType<typeof mock>).mock.calls[0][1]).toBe(
      "assistant-ctx-exceeded"
    );

    // Pending post-compaction state should be discarded.
    let exists = true;
    try {
      await fsPromises.stat(postCompactionPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    await session.dispose();
  });

  test("a retry after the window's first turn discards the acknowledged carryover", async () => {
    const workspaceId = "ws-carryover";
    const fixture = await createSessionsFixture(workspaceId);
    // Carryover needs a published boundary; a todo list gives its header content.
    await fsPromises.writeFile(
      path.join(fixture.sessionDir, "todos.json"),
      JSON.stringify([{ content: "Keep going", status: "pending" }])
    );

    const { session } = await resumeIntoContextRetry(fixture, workspaceId, async (session) => {
      await compactSessionForTest(session, fixture.historyService, workspaceId);
      await fixture.historyService.appendToHistory(workspaceId, {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: Date.now() },
      });
      // The window's first turn succeeded, so its snapshot is carryover now, not pending.
      const compaction = sessionCompactionHandler(session);
      await compaction.ackPendingStateConsumed();
      expect(await compaction.peekCarryoverState()).not.toBeNull();
    });

    expect(await sessionCompactionHandler(session).peekCarryoverState()).toBeNull();
    await session.dispose();
  });

  test("does not retry without the header when the carryover discard fails", async () => {
    const workspaceId = "ws-discard-fails";
    const fixture = await createSessionsFixture(workspaceId);
    await fsPromises.writeFile(
      path.join(fixture.sessionDir, "todos.json"),
      JSON.stringify([{ content: "Keep going", status: "pending" }])
    );

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((..._args: unknown[]) => {
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-ctx-exceeded",
        error: "Context length exceeded",
        errorType: "context_exceeded",
      });
      return Promise.resolve(contextExceededResult("assistant-ctx-exceeded"));
    });
    const { session } = await createAgentSessionHarness({
      workspaceId,
      config: fixture.config,
      historyService: fixture.historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });
    await compactSessionForTest(session, fixture.historyService, workspaceId);
    await fixture.historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: Date.now() },
    });
    const compaction = sessionCompactionHandler(session);
    await compaction.ackPendingStateConsumed();
    spyOn(compaction, "discardPendingState").mockRejectedValueOnce(new Error("disk"));

    await session.resumeStream({
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions);

    // A headerless retry would leave the carryover for the next compaction to merge again.
    expect(await session.waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")).toBe(
      "terminal"
    );
    expect(streamMessage).toHaveBeenCalledTimes(1);
    expect(await compaction.peekCarryoverState()).not.toBeNull();

    await session.dispose();
  });

  test("does not retry when the request had no post-compaction header", async () => {
    const workspaceId = "ws-no-header";
    const { historyService, config } = await createSessionsFixture(workspaceId);
    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((..._args: unknown[]) => {
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-ctx-exceeded",
        error: "Context length exceeded",
        errorType: "context_exceeded",
      });
      return Promise.resolve(contextExceededResult("assistant-ctx-exceeded"));
    });

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });

    await session.resumeStream({
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions);

    expect(await session.waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")).toBe(
      "terminal"
    );
    expect(streamMessage).toHaveBeenCalledTimes(1);

    await session.dispose();
  });

  // Waiters (task/workspace-turn stream-error settlement) treat the resolved
  // decision as "the retry outcome is known". Resolving while retry startup is
  // still in flight would let a pre-stream startup failure (no further error
  // event) leave a child task running until the parent times out.
  test("recovery decision resolves only after the context retry startup outcome is known", async () => {
    const workspaceId = "ws-decision";
    const { historyService, config, sessionDir } = await createSessionsFixture(workspaceId);
    await createPersistedPostCompactionState({
      filePath: path.join(sessionDir, "post-compaction.json"),
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });

    await historyService.appendToHistory(workspaceId, createHeaderBoundary());
    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    const aiEmitter = new EventEmitter();
    let releaseRetryStartup!: () => void;
    const retryStartupGate = new Promise<void>((resolve) => {
      releaseRetryStartup = resolve;
    });
    let retryStartupInvoked!: () => void;
    const retryStartupStarted = new Promise<void>((resolve) => {
      retryStartupInvoked = resolve;
    });

    let callCount = 0;
    const streamMessage = mock(async (..._args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-ctx-exceeded",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return contextExceededResult("assistant-ctx-exceeded");
      }
      // Retry startup in flight: hold it until the test releases, then fail
      // pre-stream (e.g. commitPartial / history read failure).
      retryStartupInvoked();
      await retryStartupGate;
      return {
        success: false as const,
        error: { type: "unknown" as const, raw: "startup failed before stream" },
      };
    });

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        // No workspace metadata: the retry path must not depend on a runtime.
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    await session.resumeStream(options);

    // The error event began a recovery decision and kicked off the retry.
    await Promise.race([
      retryStartupStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry never started")), 1000)),
    ]);

    let decidedOutcome: string | undefined;
    let decided = false;
    const decision = session
      .waitForPendingStreamErrorRecoveryDecision("assistant-ctx-exceeded")
      .then((outcome) => {
        decided = true;
        decidedOutcome = outcome;
      });

    // Retry startup still in flight: the decision must stay pending so waiters
    // cannot observe a transient PREPARING as a started recovery.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided).toBe(false);

    releaseRetryStartup();
    await Promise.race([
      decision,
      new Promise((_, reject) => setTimeout(() => reject(new Error("decision timeout")), 1000)),
    ]);

    // Startup failed pre-stream: the recorded outcome must be terminal so
    // task settlement can interrupt the child instead of waiting forever.
    expect(decided).toBe(true);
    expect(decidedOutcome).toBe("terminal");
    expect(session.isPreparingTurn()).toBe(false);
    expect(callCount).toBe(2);

    await session.dispose();
  });

  // Overlapping recovery episodes: a retry stream can emit its own error
  // before the original retry path resumes. Each error event must get its own
  // per-attempt decision — folding them into one would let the first
  // episode's "retry-started" mask the second's "terminal", leaving task
  // settlement convinced the (dead) retry is still carrying the turn.
  test("a retry that starts and then fails terminally records separate per-attempt outcomes", async () => {
    const workspaceId = "ws-overlap";
    const { historyService, config, sessionDir } = await createSessionsFixture(workspaceId);
    await createPersistedPostCompactionState({
      filePath: path.join(sessionDir, "post-compaction.json"),
      diffs: [{ path: "/tmp/foo.ts", diff: "@@ -1 +1 @@\n-foo\n+bar\n", truncated: false }],
    });

    await historyService.appendToHistory(workspaceId, createHeaderBoundary());
    await historyService.appendToHistory(workspaceId, {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
      metadata: { timestamp: 1100 },
    });

    const aiEmitter = new EventEmitter();
    let callCount = 0;
    const streamMessage = mock((..._args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        aiEmitter.emit("error", {
          workspaceId,
          messageId: "assistant-attempt-1",
          error: "Context length exceeded",
          errorType: "context_exceeded",
        });
        return Promise.resolve(contextExceededResult("assistant-attempt-1"));
      }
      // The retry's startup succeeds, but the stream dies immediately with a
      // terminal error — emitted before the original retry path resumes.
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-attempt-2",
        error: "The model refused to continue",
        errorType: "model_refusal",
      });
      return Promise.resolve({
        success: true as const,
        data: createFailedTurnHandle("assistant-attempt-2", {
          error: "The model refused to continue",
          errorType: "model_refusal",
        }),
      });
    });

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiEmitter,
      aiServiceOverrides: {
        streamMessage,
        // No workspace metadata: the retry path must not depend on a runtime.
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("nope"))),
      },
    });

    const options: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
    } as unknown as SendMessageOptions;

    await session.resumeStream(options);

    const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timeout`)), 1000)
        ),
      ]);

    // Attempt 1's recovery started a retry; attempt 2 (the retry's own death)
    // is terminal. A settlement waiter keyed to attempt 2 must see terminal.
    expect(
      await withTimeout(
        session.waitForPendingStreamErrorRecoveryDecision("assistant-attempt-1"),
        "attempt-1 decision"
      )
    ).toBe("retry-started");
    expect(
      await withTimeout(
        session.waitForPendingStreamErrorRecoveryDecision("assistant-attempt-2"),
        "attempt-2 decision"
      )
    ).toBe("terminal");
    expect(callCount).toBe(2);

    // The header stays in chat.jsonl, but later requests of this session leave it out.
    await session.resumeStream(options);
    expect(callCount).toBe(3);
    expect(requestHeader(streamMessage, 2)).toBeUndefined();

    await session.dispose();
  });
});
