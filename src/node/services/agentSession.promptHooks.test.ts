/**
 * The message.send prompt hook point at the session boundary: what AgentSession saves, refuses
 * and sends for each hook outcome. A fake consumer stands in for the plugin hook runner: it is
 * real middleware on the real event spine, reached through the harness AI fake's
 * runMessageSendHooks (the same runner AIService uses).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import assert from "node:assert";
import {
  createMuxMessage,
  prepareUserMessageForSend,
  type MuxMessage,
} from "@/common/types/message";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { computeSendDigest } from "./sendIds";
import { waitForCondition } from "./testDispatchHelpers";
import { eventSpine, type MessageSendContext } from "./events/eventSpine";
import type { CompactionMonitor } from "./compactionMonitor";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import type { AgentSessionAIService } from "./agentSession";
import type { StreamMessageOptions } from "./turnRequestBuilder";

const workspaceId = "prompt-hooks";
const options = { model: "openai:gpt-4o", agentId: "exec" };
const harnesses: AgentSessionHarness[] = [];
const unregisters: Array<() => void> = [];

afterEach(async () => {
  for (const unregister of unregisters.splice(0)) unregister();
  for (const h of harnesses.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

type Decide = (ctx: MessageSendContext) => void;

/** A session plus a fake prompt-hook consumer that records each call and applies `decide`. */
async function setup(decide: Decide) {
  const calls: Array<Pick<MessageSendContext, "text" | "origin">> = [];
  unregisters.push(
    eventSpine.useBefore(
      "message.send",
      (ctx) => {
        calls.push({ text: ctx.text, origin: ctx.origin });
        decide(ctx);
      },
      { workspaceId }
    )
  );
  const streamed: StreamMessageOptions[] = [];
  const h = await createAgentSessionHarness({ workspaceId, captureEvents: true });
  harnesses.push(h);
  const baseStream = h.aiService.streamMessage.bind(h.aiService);
  h.aiService.streamMessage = mock<AgentSessionAIService["streamMessage"]>((request) => {
    streamed.push(request);
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

const blockAll: Decide = (ctx) => {
  ctx.blocked = { pluginName: "guard", reason: "not today" };
};
const addContext: Decide = (ctx) => {
  ctx.additionalContext.push({ pluginId: "fake", text: "Ask for a reproduction first." });
};

describe("message.send outcomes", () => {
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

  test("added context is saved on its user row and leaves the system prompt alone", async () => {
    let addHookContext = true;
    const { h, calls, streamed } = await setup((ctx) => {
      if (addHookContext) addContext(ctx);
    });
    setOnSendCompaction(h, false);
    const send = (text: string) =>
      h.session.sendMessage(text, { ...options, additionalSystemInstructions: "Scratchpad." });

    expect((await send("fix the bug")).success).toBe(true);
    await h.session.waitForIdle();
    addHookContext = false;
    expect((await send("now lint")).success).toBe(true);

    expect(calls.map((call) => call.text)).toEqual(["fix the bug", "now lint"]);
    const [first, second] = await userRows(h);
    // The typed text is unchanged; the context rides on the row, not in the bubble.
    expect(textOf(first)).toBe("fix the bug");
    expect(first?.metadata?.pluginHookContext).toEqual([
      { pluginId: "fake", text: "Ask for a reproduction first." },
    ]);
    expect(second?.metadata?.pluginHookContext).toBeUndefined();
    // Every system-prompt input of the request is byte-equal with and without hook context
    // (the cached prefix stays stable). Only the messages differ.
    const withoutMessages = (request: StreamMessageOptions | undefined) =>
      JSON.stringify({ ...request, messages: undefined });
    expect(streamed).toHaveLength(2);
    expect(withoutMessages(streamed[1])).toBe(withoutMessages(streamed[0]));
    expect(streamed[0]?.additionalSystemInstructions).toBe("Scratchpad.");
    // A later turn still carries the earlier message's context.
    const earlier = streamed[1]?.messages.find((message) => message.id === first?.id);
    expect(earlier?.metadata?.pluginHookContext).toEqual(first?.metadata?.pluginHookContext);
  });

  test("an admission that goes stale while the hook runs wins over the hook's block", async () => {
    let stale = false;
    const { h } = await setup((ctx) => {
      stale = true;
      blockAll(ctx);
    });
    const result = await h.session.sendMessage("fix the bug", options, {
      admissionStale: () => stale,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).not.toBe("plugin_blocked");
    expect(await userRows(h)).toEqual([]);
  });

  test("a retried send whose ids history already holds succeeds despite a block", async () => {
    const { h, calls, streamed } = await setup(blockAll);
    const sendId = "client-send-1";
    const digest = computeSendDigest({ message: "deploy to prod" });
    // The first try was accepted (its row holds the id), but its response was lost.
    const accepted = createMuxMessage("u1", "user", "deploy to prod", {
      sendIds: [sendId],
      sendDigests: { [sendId]: digest },
    });
    assert((await h.historyService.appendToHistory(workspaceId, accepted)).success);

    const result = await h.session.sendMessage("deploy to prod", options, {
      sendIdentities: [{ id: sendId, digest }],
    });

    expect(result.success).toBe(true);
    expect((await userRows(h)).map((row) => row.id)).toEqual(["u1"]);
    expect(streamed).toEqual([]);
    // Codex P2 (PRRT_kwDOPxxmWM6rOvE1): the retry adds nothing, so the hooks (and their side
    // effects) do not run a second time.
    expect(calls).toEqual([]);
  });

  test("an automatic send ignores a block, so its sender cannot loop on it", async () => {
    const { h } = await setup(blockAll);
    setOnSendCompaction(h, false);

    const result = await h.session.sendMessage("wake up", options, {
      acceptanceOrigin: "automatic",
      synthetic: true,
    });

    expect(result.success).toBe(true);
    expect((await userRows(h)).map(textOf)).toEqual(["wake up"]);
  });

  test("a compaction request never reaches the hooks", async () => {
    const { h, calls } = await setup(blockAll);

    const result = await h.session.sendMessage("Summarize this conversation.", {
      ...options,
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual([]);
  });

  test("user text queued behind a /compact still reaches the hooks", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rNISe): the queue joins later texts into the open compaction
    // entry and keeps its compaction metadata, so skipping compaction requests skipped them too.
    const { h, calls, streamed } = await setup(blockAll);
    const compaction = { type: "compaction-request", rawCommand: "/compact", parsed: {} };
    h.session.queueMessage("Summarize this conversation.", { ...options, muxMetadata: compaction });
    h.session.queueMessage("deploy to prod", options);

    h.session.drainQueuedMessagesIfIdle();
    await waitForCondition(
      () => streamed.length > 0 || h.events.some((event) => event.type === "restore-to-input")
    );

    // Only the separately sent text reaches the hook: the compaction prompt never does.
    expect(calls).toEqual([{ text: "deploy to prod", origin: "user" }]);
    expect(await userRows(h)).toEqual([]);
    expect(streamed).toEqual([]);
    // Codex P2 (PRRT_kwDOPxxmWM6rN7od): the composer gets the command and the draft back, never
    // the model-facing summarization prompt.
    const restored = h.events.find((event) => event.type === "restore-to-input");
    expect(restored?.type === "restore-to-input" ? restored.text : undefined).toBe(
      "/compact\ndeploy to prod"
    );
  });

  test("a /compact with inline follow-up text runs the hooks on that text first", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rN7of): the follow-up later dispatches as an automatic send,
    // which no plugin may block, so the block must stop the /compact itself.
    const { h, calls, streamed } = await setup(blockAll);
    const followUpContent = { text: "deploy to prod", model: options.model, agentId: "exec" };

    const result = await h.session.sendMessage("Summarize this conversation.", {
      ...options,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact\ndeploy to prod",
        parsed: { followUpContent },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("plugin_blocked");
    expect(calls).toEqual([{ text: "deploy to prod", origin: "user" }]);
    expect(await userRows(h)).toEqual([]);
    expect(streamed).toEqual([]);
  });

  test("a /compact follow-up's review notes reach the hooks as the prompt formats them", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rOvEs): the redispatch formats reviews into the prompt, and a
    // review-only follow-up is a real prompt, so the hooks must check it at admission.
    const { h, calls } = await setup(blockAll);
    const reviews = [
      {
        filePath: "src/app.ts",
        lineRange: "4",
        selectedCode: "deploy()",
        userNote: "ship it to prod",
      },
    ];
    const prompt = (text: string) => prepareUserMessageForSend({ text, reviews }).finalText;
    const send = (text: string) =>
      h.session.sendMessage("Summarize this conversation.", {
        ...options,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: { followUpContent: { text, reviews, model: options.model, agentId: "exec" } },
        },
      });

    const reviewOnly = await send("");
    const withText = await send("and then lint");

    expect(reviewOnly.success).toBe(false);
    expect(withText.success).toBe(false);
    expect(calls).toEqual([
      { text: prompt(""), origin: "user" },
      { text: prompt("and then lint"), origin: "user" },
    ]);
    expect(calls[0]?.text).toContain("ship it to prod");
  });

  test("an automatic compaction request's follow-up does not reach the hooks", async () => {
    // Its follow-up (here the resume sentinel) is not user text; it reaches them when it is sent.
    const { h, calls } = await setup(blockAll);

    await h.session.sendMessage(
      "Summarize this conversation.",
      {
        ...options,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: { followUpContent: { text: "Continue", model: options.model, agentId: "exec" } },
        },
      },
      { acceptanceOrigin: "automatic", synthetic: true }
    );

    expect(calls).toEqual([]);
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
