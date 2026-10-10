/**
 * Plugin message.send.before at the session boundary: what AgentSession saves, refuses and
 * re-sends for each hook outcome. The hook chain itself (QuickJS, ordering, caps) is covered by
 * agentPlugins/hookService.test.ts; here AIService.runMessageSendBefore is a recording fake.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import assert from "node:assert";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import type { MessageSendHookOutcome, MessageSendOrigin } from "./events/eventSpine";
import type { CompactionMonitor } from "./compactionMonitor";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import type { AgentSessionAIService } from "./agentSession";

const workspaceId = "plugin-send-hooks";
const options = { model: "openai:gpt-4o", agentId: "exec" };
const harnesses: AgentSessionHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

interface HookCall {
  text: string;
  origin: MessageSendOrigin;
}

async function setup(decide: (input: HookCall) => MessageSendHookOutcome) {
  const calls: HookCall[] = [];
  const streamed: MuxMessage[][] = [];
  const h = await createAgentSessionHarness({
    workspaceId,
    captureEvents: true,
    aiServiceOverrides: {
      runMessageSendBefore: mock((_workspaceId: string, input: HookCall) => {
        calls.push(input);
        return Promise.resolve(decide(input));
      }),
    },
  });
  harnesses.push(h);
  const baseStream = h.aiService.streamMessage.bind(h.aiService);
  h.aiService.streamMessage = mock<AgentSessionAIService["streamMessage"]>((request) => {
    streamed.push(request.messages);
    return baseStream(request);
  });
  return { h, calls, streamed };
}

async function userRows(h: AgentSessionHarness): Promise<MuxMessage[]> {
  const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
  assert(history.success);
  return history.data.filter((row) => row.role === "user");
}

const textOf = (row: MuxMessage | undefined) =>
  (row?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

/** Force (or suppress) on-send compaction regardless of usage. */
function setOnSendCompaction(h: AgentSessionHarness, force: boolean): void {
  (
    h.session as unknown as { contextController: { compactionMonitor: CompactionMonitor } }
  ).contextController.compactionMonitor = {
    checkBeforeSend: mock(() => ({
      shouldShowWarning: false,
      shouldForceCompact: force,
      usagePercentage: force ? 99 : 10,
      thresholdPercentage: 85,
    })),
    checkMidStream: mock(() => false),
    resetForNewStream: mock(() => undefined),
    noteUserTurn: mock(() => undefined),
    noteAutoCompactionRequested: mock(() => undefined),
    noteAutoCompactionCompleted: mock(() => undefined),
    suppressRepeatedAutoCompaction: mock(() => false),
  } as unknown as CompactionMonitor;
}

const blockAll = (): MessageSendHookOutcome => ({
  kind: "blocked",
  pluginName: "guard",
  reason: "not today",
});

describe("message.send.before outcomes", () => {
  test("a rewrite saves the new text with its attribution and sends only the rewrite", async () => {
    const { h, calls, streamed } = await setup((input) => ({
      kind: "rewritten",
      text: input.text.toUpperCase(),
      pluginName: "shout",
    }));
    setOnSendCompaction(h, false);

    const result = await h.session.sendMessage("fix the bug", options);
    expect(result.success).toBe(true);

    expect(calls).toEqual([{ text: "fix the bug", origin: "user" }]);
    const [row] = await userRows(h);
    expect(textOf(row)).toBe("FIX THE BUG");
    expect(row?.metadata?.pluginRewrite).toEqual({ plugin: "shout", originalText: "fix the bug" });
    const requestUser = streamed[0]?.findLast((message) => message.role === "user");
    expect(textOf(requestUser)).toBe("FIX THE BUG");
  });

  test("a block returns plugin_blocked and writes no row", async () => {
    const { h, streamed } = await setup(blockAll);

    const result = await h.session.sendMessage("deploy to prod", options);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ type: "plugin_blocked", plugin: "guard", reason: "not today" });
    expect(await userRows(h)).toEqual([]);
    expect(streamed).toEqual([]);
    // A direct user send shows the reason in the composer, not as a transcript error.
    expect(h.events.some((event) => event.type === "stream-error")).toBe(false);
  });

  test("an automatic send that is blocked reports the reason in the transcript", async () => {
    const { h } = await setup(blockAll);

    const result = await h.session.sendMessage("wake up", options, {
      acceptanceOrigin: "automatic",
      synthetic: true,
    });

    expect(result.success).toBe(false);
    const errors = h.events.filter((event) => event.type === "stream-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorType: "plugin_blocked",
      error: "Plugin guard blocked this message: not today",
    });
  });

  test.each([
    ["block", blockAll],
    [
      "rewrite",
      (): MessageSendHookOutcome => ({ kind: "rewritten", text: "hijacked", pluginName: "x" }),
    ],
  ] as const)("a compaction request ignores a %s", async (_kind, decide) => {
    const { h, calls } = await setup(decide);

    const result = await h.session.sendMessage("Summarize this conversation.", {
      ...options,
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    });

    expect(result.success).toBe(true);
    expect(calls.map((call) => call.origin)).toEqual(["compaction"]);
    const [row] = await userRows(h);
    expect(textOf(row)).toBe("Summarize this conversation.");
    expect(row?.metadata?.pluginRewrite).toBeUndefined();
  });

  test("each send kind reaches the hook with its origin", async () => {
    const { h, calls } = await setup(blockAll);
    const send = (internal?: Parameters<typeof h.session.sendMessage>[2]) =>
      h.session.sendMessage("probe", options, internal);

    await send();
    await send({ acceptanceOrigin: "automatic", agentInitiated: true });
    await send({ acceptanceOrigin: "automatic", synthetic: true, taskTurnKind: "recovery" });
    await send({
      acceptanceOrigin: "automatic",
      synthetic: true,
      goalKind: GOAL_CONTINUATION_KIND,
      goalId: "goal-1",
    });
    await send({ acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true });

    expect(calls.map((call) => call.origin)).toEqual(["user", "task", "task", "goal", "system"]);
  });
});

describe("on-send compaction follow-up", () => {
  test("the diverted send carries the rewrite and its hooks-applied mark", async () => {
    const { h, calls } = await setup((input) => ({
      kind: "rewritten",
      text: `${input.text} (redacted)`,
      pluginName: "redactor",
    }));
    setOnSendCompaction(h, true);

    const result = await h.session.sendMessage("my token is abc", options);
    expect(result.success).toBe(true);

    // The user's message ran the hooks once; the generated compaction request is shown to them
    // as a compaction send, and its outcome (this fake rewrites everything) is ignored.
    const rows = await userRows(h);
    expect(rows).toHaveLength(1);
    expect(calls).toEqual([
      { text: "my token is abc", origin: "user" },
      { text: textOf(rows[0]), origin: "compaction" },
    ]);
    const muxMetadata = rows[0]?.metadata?.muxMetadata;
    assert(muxMetadata?.type === "compaction-request");
    expect(muxMetadata.parsed.followUpContent).toMatchObject({
      text: "my token is abc (redacted)",
      pluginSendHooksApplied: true,
      pluginRewrite: { plugin: "redactor", originalText: "my token is abc" },
    });
  });

  async function seedHandoff(
    h: AgentSessionHarness,
    pendingFollowUp: CompactionFollowUpRequest
  ): Promise<void> {
    for (const row of [
      createMuxMessage("u0", "user", "original question"),
      createMuxMessage("a0", "assistant", "original answer"),
      createMuxMessage("summary", "assistant", "compacted summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary", pendingFollowUp },
      }),
    ]) {
      assert((await h.historyService.appendToHistory(workspaceId, row)).success);
    }
  }

  test("dispatching it does not run the hooks again and keeps the rewrite", async () => {
    const { h, calls } = await setup(blockAll);
    setOnSendCompaction(h, false);
    await seedHandoff(h, {
      text: "my token is abc (redacted)",
      model: options.model,
      agentId: "exec",
      pluginSendHooksApplied: true,
      pluginRewrite: { plugin: "redactor", originalText: "my token is abc" },
    });

    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);

    expect(calls).toEqual([]);
    const followUp = (await userRows(h)).at(-1);
    expect(textOf(followUp)).toBe("my token is abc (redacted)");
    expect(followUp?.metadata?.pluginRewrite).toEqual({
      plugin: "redactor",
      originalText: "my token is abc",
    });
  });

  test("a blocked follow-up is dropped instead of retried on every recovery", async () => {
    const { h, calls } = await setup(blockAll);
    setOnSendCompaction(h, false);
    await seedHandoff(h, { text: "then deploy", model: options.model, agentId: "exec" });

    await h.session.dispatchPendingCompactionFollowUpIfNeeded().catch(() => false);
    expect(calls).toHaveLength(1);
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success);
    const summary = history.data.find((row) => row.id === "summary");
    const muxMetadata = summary?.metadata?.muxMetadata;
    assert(muxMetadata?.type === "compaction-summary");
    expect(muxMetadata.pendingFollowUp).toBeUndefined();

    await h.session.dispatchPendingCompactionFollowUpIfNeeded().catch(() => false);
    expect(calls).toHaveLength(1);
  });

  test("a follow-up the hooks never saw (manual /compact) runs them as a system send", async () => {
    const { h, calls } = await setup(() => ({ kind: "none" }));
    setOnSendCompaction(h, false);
    await seedHandoff(h, { text: "then fix the bug", model: options.model, agentId: "exec" });

    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);

    expect(calls).toEqual([{ text: "then fix the bug", origin: "system" }]);
  });
});
