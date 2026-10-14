/**
 * The turn.stop prompt hook point (Codex Stop) at the session boundary. A fake consumer stands in
 * for the plugin hook runner: real middleware on the real event spine, reached through the
 * harness AI fake's runTurnStopHooks (the same runner AIService uses).
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import type { CompletedMessagePart } from "@/common/types/stream";
import { Ok } from "@/common/types/result";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";
import type { AgentSessionAIService } from "./agentSession";
import { eventSpine, type TurnStopContext } from "./events/eventSpine";
import type { TurnCompletion } from "./streamManager";
import {
  createAgentSessionHarness,
  type AgentSessionHarness,
  type AgentSessionHarnessOptions,
} from "./agentSession.testHarness";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { createTestHistoryService } from "./testHistoryService";
import { registerNoopContinuationBridgeForTest } from "./testDispatchHelpers";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";

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
    /** Routing record the prepared request streams with (stream-start). */
    streamRouting?: (turn: number) => AutoModelRoutingRecord | undefined;
    /** Runs while turn N streams, before it ends. */
    whileStreaming?: (turn: number, h: AgentSessionHarness) => void;
    session?: Omit<AgentSessionHarnessOptions, "workspaceId" | "aiEmitter" | "aiServiceOverrides">;
  } = {}
) {
  const emitter = new EventEmitter();
  let turns = 0;
  const requests: Array<Parameters<AgentSessionAIService["streamMessage"]>[0]> = [];
  const holder: { h?: AgentSessionHarness } = {};
  const h = await createAgentSessionHarness({
    ...input.session,
    workspaceId,
    aiEmitter: emitter,
    aiServiceOverrides: {
      streamMessage: mock<AgentSessionAIService["streamMessage"]>((request) => {
        requests.push(request);
        const messageId = `a${++turns}`;
        const routing = input.streamRouting?.(turns);
        emitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId,
          model: routing?.model ?? model,
          startTime: Date.now(),
          ...(routing != null ? { autoModelRouting: routing } : {}),
        });
        assert(holder.h != null);
        input.whileStreaming?.(turns, holder.h);
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
  holder.h = h;
  harnesses.push(h);
  return { h, streams: () => turns, requests };
}

/** Wait until no turn runs and nothing is queued (each continuation is its own turn). */
async function settle(h: AgentSessionHarness): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await h.session.waitForIdle();
    if (!h.session.isBusy() && !h.session.hasQueuedMessages()) return;
  }
  throw new Error("session never settled");
}

/** A session with a real goal service and an active goal (the goal loop's bridge is a no-op). */
async function setupWithGoal() {
  const history = await createTestHistoryService();
  const projectPath = "/tmp/turn-stop-hooks-project";
  await history.config.addWorkspace(projectPath, {
    id: workspaceId,
    name: workspaceId,
    projectName: "turn-stop-hooks-project",
    projectPath,
    runtimeConfig: { type: "local" },
  });
  const goalService = new WorkspaceGoalService(
    history.config,
    history.historyService,
    new ExtensionMetadataService(`${history.config.rootDir}/extension-metadata.json`)
  );
  registerNoopContinuationBridgeForTest(goalService);
  const goal = await goalService.setGoal({ workspaceId, objective: "Ship the release" });
  assert(goal.success);
  const session = await setup({
    session: {
      config: history.config,
      historyService: history.historyService,
      workspaceGoalService: goalService,
    },
  });
  unregisters.push(() => void history.cleanup());
  return { ...session, goalId: goal.data.goalId, goalService };
}

/** A goal-loop continuation send, as WorkspaceGoalService dispatches it. */
function sendGoalTurn(h: AgentSessionHarness, goalId: string) {
  return h.session.sendMessage("Continue the goal.", options, {
    acceptanceOrigin: "automatic",
    synthetic: true,
    agentInitiated: true,
    goalKind: GOAL_CONTINUATION_KIND,
    goalId,
  });
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

  test("a user send still in WorkspaceService's preflight wins over a continuation", async () => {
    // The send is not queued yet (pricing/settings preflight), so only the preflight probe sees it.
    let userSendInPreflight = false;
    addConsumer((ctx) => {
      userSendInPreflight = true;
      keepGoing(ctx);
    });
    const { h, streams } = await setup({
      session: { hasExternalManualSendPreflight: () => userSendInPreflight },
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(await userTexts(h)).toEqual(["fix the tests"]);
    expect(streams()).toBe(1);
  });

  for (const stop of ["finished", "still in progress"] as const) {
    test(`a hard Stop during a slow Stop hook queues no continuation (Stop ${stop})`, async () => {
      // The stream already ended, so the Stop finds no live stream to supersede: only the Stop
      // fence (its epoch and in-progress latch) can tell the hook's late outcome is stale.
      let stopEpoch = 0;
      let stopInProgress = false;
      unregisters.push(
        eventSpine.useBefore(
          "turn.stop",
          async (ctx) => {
            await Promise.resolve();
            // A finished Stop bumped the epoch and released its latch. A Stop still in progress
            // holds the latch (whether it bumped the epoch yet is the caller's order).
            if (stop === "finished") stopEpoch++;
            else stopInProgress = true;
            await Promise.resolve();
            keepGoing(ctx);
          },
          { workspaceId }
        )
      );
      const { h, streams } = await setup({
        session: { getStopEpoch: () => stopEpoch, isStopInProgress: () => stopInProgress },
      });

      await h.session.sendMessage("fix the tests", options);
      await h.session.waitForIdle();
      // A held Stop latch defers dispatch, so a wrongly queued continuation would wait here.
      expect(h.session.hasQueuedMessages()).toBe(false);
      await settle(h);

      expect(await userTexts(h)).toEqual(["fix the tests"]);
      expect(streams()).toBe(1);
    });
  }

  test("a goal turn's continuation stays a goal turn of the same goal", async () => {
    let continued = false;
    addConsumer((ctx) => {
      if (continued) return;
      continued = true;
      keepGoing(ctx);
    });
    const { h, streams, goalId } = await setupWithGoal();

    expect((await sendGoalTurn(h, goalId)).success).toBe(true);
    await settle(h);

    expect(streams()).toBe(2);
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success);
    const continuation = history.data.filter((row) => row.role === "user")[1];
    // The goal counts the continuation's turn and cost (goal_continuation stream origin).
    expect(continuation?.metadata?.kind).toBe(GOAL_CONTINUATION_KIND);
    expect(continuation?.metadata?.goalId).toBe(goalId);
  });

  test("a goal turn is not continued once its goal no longer admits a continuation", async () => {
    addConsumer(keepGoing);
    const { h, streams } = await setupWithGoal();

    // The ended turn belongs to a goal that is no longer the workspace's goal.
    expect((await sendGoalTurn(h, "replaced-goal")).success).toBe(true);
    await settle(h);

    expect(streams()).toBe(1);
  });

  test("a continuation refused before streaming leaves no stopHookActive for the next turn", async () => {
    const calls: StopCall[] = [];
    let continued = false;
    addConsumer((ctx) => {
      if (continued) return;
      continued = true;
      keepGoing(ctx);
    }, calls);
    const { h, streams } = await setup();
    // Refuse the continuation at its admission, as a context mutation or a goal gate would.
    const queueMessage = h.session.queueMessage.bind(h.session);
    spyOn(h.session, "queueMessage").mockImplementationOnce((message, queuedOptions, internal) =>
      queueMessage(message, queuedOptions, { ...internal, admissionStale: () => true })
    );

    await h.session.sendMessage("fix the tests", options);
    await settle(h);
    expect(streams()).toBe(1);

    // A later automatic turn (a wake, a heartbeat) is a new turn for Stop.
    await h.session.sendMessage("Background task finished.", options, {
      acceptanceOrigin: "automatic",
      synthetic: true,
    });
    await settle(h);

    expect(calls.map((call) => call.stopHookActive)).toEqual([false, false]);
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

  test("a delegated workspace turn runs no Stop hook and ends once (WorkspaceTurnManager owns it)", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rQfGf): its handle settles from this stream end, like a sub-agent.
    const calls: StopCall[] = [];
    addConsumer(keepGoing, calls);
    const { h, streams } = await setup({ session: { captureEvents: true } });

    const sent = await h.session.sendMessage("delegated work", {
      ...options,
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_delegated",
        ownerWorkspaceId: "owner-workspace",
        turnId: "turn-delegated",
      },
    });
    expect(sent.success).toBe(true);
    await settle(h);

    expect(calls).toEqual([]);
    expect(streams()).toBe(1);
    expect(await userTexts(h)).toEqual(["delegated work"]);
    // TaskService settles the handle from each stream end: one stream end, one settlement.
    expect(h.events.filter((event) => event.type === "stream-end")).toHaveLength(1);
  });

  test.each([
    { name: "an ACP prompt", session: {}, send: { acpPromptId: "acp-prompt-1" } },
    { name: "an xum run turn", session: { callerOwnsTurnEnd: true }, send: {} },
  ])(
    "$name runs its Stop hook but is not continued (its owner already saw the turn end)",
    async (owner) => {
      // Codex P1 (PRRT_kwDOPxxmWM6rxPMC): ACP resolves prompt() and xum run stops waiting on
      // this stream-end, so a continuation would run after them.
      const calls: StopCall[] = [];
      addConsumer(keepGoing, calls);
      const { h, streams } = await setup({ session: owner.session });

      expect(
        (await h.session.sendMessage("fix the tests", { ...options, ...owner.send })).success
      ).toBe(true);
      await settle(h);

      expect(calls).toHaveLength(1);
      expect(streams()).toBe(1);
      expect(await userTexts(h)).toEqual(["fix the tests"]);
    }
  );

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

  test("input queued during the turn skips the Stop hooks (the queue continues the turn)", async () => {
    const calls: StopCall[] = [];
    addConsumer(() => undefined, calls);
    const { h, streams } = await setup({
      whileStreaming: (turn, session) => {
        if (turn === 1) session.session.queueMessage("also lint", options);
      },
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(streams()).toBe(2);
    // Only the queued turn's end runs the hooks.
    expect(calls.map((call) => call.messageId)).toEqual(["a2"]);
  });

  test("a withdrawn queue entry does not cancel a Stop continuation", async () => {
    addConsumer((ctx) => {
      if (!ctx.stopHookActive) keepGoing(ctx);
    });
    const { h, streams } = await setup({
      whileStreaming: (turn, session) => {
        if (turn !== 1) return;
        const withdrawn = new AbortController();
        session.session.queueMessage("never mind", options, { cancelSignal: withdrawn.signal });
        withdrawn.abort();
      },
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(streams()).toBe(2);
    expect(await userTexts(h)).toEqual(["fix the tests", "Run the failing tests again."]);
  });

  test("a continuation keeps the stream's prepared routing and Chat Instructions state", async () => {
    addConsumer((ctx) => {
      if (!ctx.stopHookActive) keepGoing(ctx);
    });
    const requested: AutoModelRoutingRecord = {
      requestedFallbackModel: model,
      model: "anthropic:claude-sonnet-4-5",
      status: "routed",
    };
    // Request preparation could not build the tier model and fell back to the composer's.
    const prepared: AutoModelRoutingRecord = { ...requested, model, status: "fallback" };
    const { h, requests } = await setup({ streamRouting: () => prepared });

    await h.session.sendMessage("fix the tests", {
      ...options,
      model: requested.model,
      additionalSystemContext: "",
      autoModelRoutingRecord: requested,
    } as typeof options);
    await settle(h);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      modelString: model,
      autoModelRouting: prepared,
      additionalSystemContext: "",
    });
  });

  test("a goal admission that throws declines the continuation and still flushes the queue", async () => {
    const { h, streams, goalId, goalService } = await setupWithGoal();
    let typed = false;
    addConsumer((ctx) => {
      if (typed) return;
      typed = true;
      h.session.queueMessage("actually, stop", options);
      keepGoing(ctx);
    });
    // Only the continuation's admission (after the hook ran) fails; the goal turn's own works.
    const admit = goalService.buildGoalRedispatchAdmission.bind(goalService);
    spyOn(goalService, "buildGoalRedispatchAdmission").mockImplementation((...args) =>
      typed ? Promise.reject(new Error("goal store unreadable")) : admit(...args)
    );

    expect((await sendGoalTurn(h, goalId)).success).toBe(true);
    await settle(h);

    expect(streams()).toBe(2);
    expect(await userTexts(h)).toEqual(["Continue the goal.", "actually, stop"]);
  });

  test("a compaction turn whose summary the handler rejected runs no Stop hook", async () => {
    const calls: StopCall[] = [];
    addConsumer(keepGoing, calls);
    const { h, streams } = await setup();
    const session = h.session as unknown as {
      contextController: { compaction: { handleCompletion(...args: unknown[]): Promise<boolean> } };
    };
    spyOn(session.contextController.compaction, "handleCompletion").mockResolvedValue(false);

    await h.session.sendMessage(
      "Please compact",
      {
        ...options,
        agentId: "compact",
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      },
      { synthetic: true }
    );
    await settle(h);

    expect(calls).toEqual([]);
    expect(streams()).toBe(1);
  });
});
