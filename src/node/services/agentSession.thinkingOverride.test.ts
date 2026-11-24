import { describe, expect, it, mock } from "bun:test";

import { Ok, Err } from "@/common/types/result";
import type { StreamMessageOptions } from "@/node/services/aiService";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";
import type { ActiveTurnThinkingOverride } from "./thinkingOverride";

const MODEL = "anthropic:claude-sonnet-4-5";

describe("AgentSession.setActiveTurnServiceTier", () => {
  it("isolates live speed picks, preserves thinking, and retires the pick with the turn", async () => {
    let activeA: StreamMessageOptions | undefined;
    const b = await createAgentSessionHarness({
      workspaceId: "speed-chat-b",
      aiServiceOverrides: {
        streamMessage: (opts: StreamMessageOptions) => {
          // A is still streaming while B starts. Changing A must not change B's
          // next-call holder or either chat's independent reasoning preference.
          expect(opts.muxProviderOptions?.openai?.serviceTier).toBe("flex");
          expect(aSession.setActiveTurnServiceTier("ultrafast")).toEqual({ accepted: true });
          expect(aSession.setActiveTurnServiceTier("default")).toEqual({ accepted: true });
          expect(activeA?.activeTurnThinkingOverride?.serviceTier).toBe("default");
          expect(activeA?.activeTurnThinkingOverride?.pending).toBe("high");
          expect(opts.activeTurnThinkingOverride?.serviceTier).toBeUndefined();
          expect(opts.activeTurnThinkingOverride?.manual).toBeUndefined();
          return Promise.resolve(Ok(createStartedTurnHandle(b.session.closingSignal)));
        },
      },
    });
    let turn = 0;
    const a = await createAgentSessionHarness({
      workspaceId: "speed-chat-a",
      aiServiceOverrides: {
        streamMessage: async (opts: StreamMessageOptions) => {
          if (turn++ === 0) {
            activeA = opts;
            expect(opts.muxProviderOptions?.openai?.serviceTier).toBe("default");
            expect(opts.activeTurnThinkingOverride?.serviceTier).toBe("priority");
            expect(opts.activeTurnThinkingOverride?.manual).toBeUndefined();
            expect(a.session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: true });
            const sent = await b.session.sendMessage("B", {
              model: "openai:gpt-6-astra",
              agentId: "exec",
              serviceTier: "flex",
            });
            expect(sent.success).toBe(true);
          } else {
            expect(opts.activeTurnThinkingOverride).not.toBe(activeA?.activeTurnThinkingOverride);
            expect(opts.activeTurnThinkingOverride?.serviceTier).toBeUndefined();
          }
          return Ok(createStartedTurnHandle(a.session.closingSignal));
        },
      },
    });
    const aSession = a.session;
    try {
      expect(a.session.setActiveTurnServiceTier("priority")).toEqual({ accepted: false });
      const sent = await a.session.sendMessage(
        "A",
        {
          model: "openai:gpt-6-astra",
          agentId: "exec",
          serviceTier: "default",
          providerOptions: { openai: { serviceTier: "priority" } },
        },
        {
          onAccepted: () => {
            expect(a.session.setActiveTurnServiceTier("priority")).toEqual({ accepted: true });
          },
        }
      );
      expect(sent.success).toBe(true);
      await Promise.all([a.session.waitForIdle(), b.session.waitForIdle()]);
      expect(a.session.setActiveTurnServiceTier("priority")).toEqual({ accepted: false });
      expect(
        (await a.session.sendMessage("again", { model: MODEL, agentId: "exec" })).success
      ).toBe(true);
      await a.session.waitForIdle();
    } finally {
      await Promise.all([a.session.dispose(), b.session.dispose()]);
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });
});

describe("AgentSession.setActiveTurnThinkingLevel", () => {
  it("reports accepted:false while idle (persisted settings cover the next turn)", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "thinking-override-idle",
    });
    try {
      expect(session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: false });
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  it("accepts writes during PREPARING and streaming, threads the holder to the stream, and expires it on turn end", async () => {
    const capturedHolders: Array<ActiveTurnThinkingOverride | undefined> = [];
    const capturedPendingAtStreamStart: Array<string | undefined> = [];
    let sessionRef: {
      setActiveTurnThinkingLevel: (level: "low" | "high" | "medium") => { accepted: boolean };
    } | null = null;

    const streamMessage = mock((opts: StreamMessageOptions) => {
      capturedHolders.push(opts.activeTurnThinkingOverride);
      capturedPendingAtStreamStart.push(opts.activeTurnThinkingOverride?.pending);
      // Simulate a slider change while the stream is active: both writes must
      // land in the SAME holder object the stream received (last write wins).
      const first = sessionRef?.setActiveTurnThinkingLevel("high");
      const second = sessionRef?.setActiveTurnThinkingLevel("low");
      expect(first).toEqual({ accepted: true });
      expect(second).toEqual({ accepted: true });
      expect(opts.activeTurnThinkingOverride?.pending).toBe("low");
      // A slider write marks the turn as user-controlled, which disables Auto's escalation.
      expect(opts.activeTurnThinkingOverride?.manual).toBe(true);
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });

    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "thinking-override-active",
      aiServiceOverrides: {
        streamMessage,
      },
    });
    sessionRef = session;

    try {
      const result = await session.sendMessage("hello", { model: MODEL, agentId: "exec" });
      expect(result.success).toBe(true);
      expect(streamMessage.mock.calls).toHaveLength(1);
      expect(capturedHolders[0]).toBeDefined();

      // The turn ended (mocked stream resolved without events -> IDLE): the
      // holder expired, so late writes fall back to persisted settings.
      await session.waitForIdle();
      expect(session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: false });

      // A follow-up turn gets a FRESH holder with no inherited pending level.
      const second = await session.sendMessage("again", { model: MODEL, agentId: "exec" });
      expect(second.success).toBe(true);
      expect(capturedHolders[1]).toBeDefined();
      expect(capturedHolders[1]).not.toBe(capturedHolders[0]);
      expect(capturedPendingAtStreamStart[1]).toBeUndefined();
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  it("delivers a change made during the PREPARING window to the turn's stream options", async () => {
    let pendingSeenByStream: string | undefined;
    const streamMessage = mock((opts: StreamMessageOptions) => {
      pendingSeenByStream = opts.activeTurnThinkingOverride?.pending;
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });

    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "thinking-override-preparing",
      aiServiceOverrides: {
        streamMessage,
      },
    });

    try {
      // onAccepted runs after the holder is created but before the stream
      // starts — exactly the PREPARING window a fast slider change can hit.
      const result = await session.sendMessage(
        "hello",
        { model: MODEL, agentId: "exec" },
        {
          onAccepted: () => {
            expect(session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: true });
          },
        }
      );
      expect(result.success).toBe(true);
      expect(streamMessage.mock.calls).toHaveLength(1);
      // The pre-stream write reaches the turn's first provider request via the
      // holder (prepareStep runs before step 1).
      expect(pendingSeenByStream).toBe("high");
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  it("clears the holder when a pre-stream failure aborts the accepted turn", async () => {
    const streamMessage = mock((_opts: StreamMessageOptions) =>
      Promise.resolve(Err({ type: "unknown" as const, raw: "startup failed" }))
    );

    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "thinking-override-prestream-failure",
      aiServiceOverrides: {
        streamMessage,
      },
    });

    try {
      const result = await session.sendMessage("hello", { model: MODEL, agentId: "exec" });
      expect(result.success).toBe(false);
      await session.waitForIdle();
      expect(session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: false });
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  it("clears the holder when an onAccepted failure aborts the turn before streaming", async () => {
    const streamMessage = mock((_options: StreamMessageOptions) =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
    );
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "thinking-override-onaccepted-failure",
      aiServiceOverrides: {
        streamMessage,
      },
    });

    try {
      const result = await session.sendMessage(
        "hello",
        { model: MODEL, agentId: "exec" },
        {
          onAccepted: () => {
            throw new Error("acceptance hook failed");
          },
        }
      );
      expect(result.success).toBe(false);
      // The stream never started; the holder must not leak into idle state.
      expect(streamMessage.mock.calls).toHaveLength(0);
      expect(session.setActiveTurnThinkingLevel("high")).toEqual({ accepted: false });
    } finally {
      await session.dispose();
      await cleanup();
    }
  });
});
