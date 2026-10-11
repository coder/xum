/**
 * The turn.stop prompt hook point (Codex Stop) at the session boundary. A fake consumer stands in
 * for the plugin hook runner: real middleware on the real event spine, reached through the
 * harness AI fake's runTurnStopHooks (the same runner AIService uses).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import type { CompletedMessagePart } from "@/common/types/stream";
import { Ok } from "@/common/types/result";
import { eventSpine, type TurnStopContext } from "./events/eventSpine";
import type { TurnCompletion } from "./streamManager";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "turn-stop-hooks";
const model = "openai:gpt-4o";
const options = { model, agentId: "exec" };
const harnesses: AgentSessionHarness[] = [];
const unregisters: Array<() => void> = [];

afterEach(async () => {
  for (const unregister of unregisters.splice(0)) unregister();
  for (const h of harnesses.splice(0).reverse()) {
    await h.session.dispose();
    await h.cleanup();
  }
});

type StopCall = Pick<TurnStopContext, "messageId" | "lastAssistantMessage" | "stopHookActive">;

function addConsumer(decide: (ctx: TurnStopContext) => void, calls?: StopCall[]): void {
  unregisters.push(
    eventSpine.useBefore(
      "turn.stop",
      (ctx) => {
        calls?.push({
          messageId: ctx.messageId,
          lastAssistantMessage: ctx.lastAssistantMessage,
          stopHookActive: ctx.stopHookActive,
        });
        decide(ctx);
      },
      { workspaceId }
    )
  );
}

/**
 * A session whose every stream starts and then ends with `parts` (or the `ending` outcome).
 * Turn N streams with message id `a<N>`.
 */
async function setup(
  input: {
    parts?: (turn: number) => CompletedMessagePart[];
    ending?: (turn: number) => "completed" | "aborted";
  } = {}
) {
  const emitter = new EventEmitter();
  let turns = 0;
  const h = await createAgentSessionHarness({
    workspaceId,
    aiEmitter: emitter,
    aiServiceOverrides: {
      streamMessage: mock(() => {
        const messageId = `a${++turns}`;
        emitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId,
          model,
          startTime: Date.now(),
        });
        const completion: TurnCompletion =
          input.ending?.(turns) === "aborted"
            ? {
                status: "aborted",
                abortReason: "user",
                streamAbort: { type: "stream-abort", workspaceId },
              }
            : {
                status: "completed",
                streamEnd: {
                  type: "stream-end",
                  workspaceId,
                  metadata: { model },
                  parts: input.parts?.(turns) ?? [{ type: "text", text: `reply ${turns}` }],
                },
              };
        return Promise.resolve(Ok({ messageId, completion: Promise.resolve(completion) }));
      }),
    },
  });
  harnesses.push(h);
  return { h, streams: () => turns };
}

/** Wait until no turn runs and nothing is queued (each continuation is its own turn). */
async function settle(h: AgentSessionHarness): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await h.session.waitForIdle();
    if (!h.session.isBusy() && !h.session.hasQueuedMessages()) return;
  }
  throw new Error("session never settled");
}

async function userTexts(h: AgentSessionHarness): Promise<string[]> {
  const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
  assert(history.success);
  return history.data
    .filter((row) => row.role === "user")
    .map((row) => row.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));
}

const keepGoing = (ctx: TurnStopContext) => {
  ctx.continueReasons.push("Run the failing tests again.");
};

describe("turn.stop", () => {
  test("a continuation sends its reason as the next prompt, at most 3 times per turn", async () => {
    const calls: StopCall[] = [];
    addConsumer(keepGoing, calls);
    const { h, streams } = await setup();

    expect((await h.session.sendMessage("fix the tests", options)).success).toBe(true);
    await settle(h);

    expect(streams()).toBe(4);
    expect(await userTexts(h)).toEqual([
      "fix the tests",
      ...Array<string>(3).fill("Run the failing tests again."),
    ]);
    expect(calls.map((call) => call.stopHookActive)).toEqual([false, true, true, true]);
    expect(calls[0]).toEqual({
      messageId: "a1",
      lastAssistantMessage: "reply 1",
      stopHookActive: false,
    });

    // A new message from the user starts a new turn: Stop may continue it again.
    expect((await h.session.sendMessage("now lint", options)).success).toBe(true);
    await settle(h);
    expect(calls.map((call) => call.stopHookActive)).toEqual([
      ...[false, true, true, true],
      ...[false, true, true, true],
    ]);
    expect(streams()).toBe(8);
  });

  test("one consumer's halt overrides every continuation", async () => {
    addConsumer(keepGoing);
    addConsumer((ctx) => {
      ctx.halted = { pluginName: "guard" };
    });
    const { h, streams } = await setup();

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(streams()).toBe(1);
  });

  test("input the user queued while the hooks ran wins over a continuation", async () => {
    const { h, streams } = await setup();
    let typed = false;
    addConsumer((ctx) => {
      if (typed) return;
      typed = true;
      h.session.queueMessage("actually, stop", options);
      keepGoing(ctx);
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(await userTexts(h)).toEqual(["fix the tests", "actually, stop"]);
    expect(streams()).toBe(2);
  });

  test("the reply text is the trailing text run, and null when the turn ends on a tool", async () => {
    const calls: StopCall[] = [];
    addConsumer(() => undefined, calls);
    const tool: CompletedMessagePart = {
      type: "dynamic-tool",
      toolCallId: "t1",
      toolName: "bash",
      state: "output-available",
      input: {},
      output: {},
    };
    const { h } = await setup({
      parts: (turn) =>
        turn === 1
          ? [
              { type: "text", text: "Let me check." },
              tool,
              { type: "text", text: "All " },
              { type: "reasoning", text: "done thinking" },
              { type: "text", text: "green." },
            ]
          : [{ type: "text", text: "Let me check." }, tool],
    });

    await h.session.sendMessage("one", options);
    await settle(h);
    await h.session.sendMessage("two", options);
    await settle(h);

    expect(calls.map((call) => call.lastAssistantMessage)).toEqual(["All green.", null]);
  });

  test("an interrupted turn does not run the hooks", async () => {
    const calls: StopCall[] = [];
    addConsumer(keepGoing, calls);
    const { h, streams } = await setup({ ending: () => "aborted" });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(calls).toEqual([]);
    expect(streams()).toBe(1);
  });

  test("a user turn after an interrupted continuation starts a fresh Stop count", async () => {
    const calls: StopCall[] = [];
    addConsumer(keepGoing, calls);
    // The continuation (turn 2) is interrupted, so no Stop runs to end the count.
    const { h } = await setup({ ending: (turn) => (turn === 2 ? "aborted" : "completed") });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);
    await h.session.sendMessage("try again", options);
    await settle(h);

    expect(calls.map((call) => call.stopHookActive).slice(0, 2)).toEqual([false, false]);
  });

  test("a Stop continuation does not run the UserPromptSubmit (message.send) hooks", async () => {
    // Codex records a Stop continuation directly and runs UserPromptSubmit only for submitted
    // input (codex-rs session/turn.rs, hook_runtime.rs inspect_pending_input).
    addConsumer(keepGoing);
    const promptHookTexts: string[] = [];
    unregisters.push(
      eventSpine.useBefore(
        "message.send",
        (ctx) => {
          promptHookTexts.push(ctx.text);
        },
        { workspaceId }
      )
    );
    const { h, streams } = await setup();

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(streams()).toBe(4);
    expect(promptHookTexts).toEqual(["fix the tests"]);
  });
});
