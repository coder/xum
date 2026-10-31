/**
 * The turn.stop prompt hook point (Codex Stop) at the session boundary. A fake consumer stands in
 * for the plugin hook runner: real middleware on the real event spine, reached through the
 * harness AI fake's runTurnStopHooks (the same runner AIService uses).
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "events";
import type { CompletedMessagePart } from "@/common/types/stream";
import type { TodoItem } from "@/common/types/tools";
import { getTodoFilePath } from "@/node/services/todos/todoStorage";
import { TURN_STOP_PROMPT_MAX_CHARS } from "./agentPlugins/promptHooks";
import { TODO_TURN_END_NUDGE } from "@/node/services/agentNotifications/todoTurnEndNudge";
import { STATUS_PAGE_TURN_END_NUDGE } from "@/common/utils/machineTurnPrompts";
import { Ok } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";
import type { AgentSessionAIService } from "./agentSession";
import { eventSpine, type TurnStopContext, type TurnStopContinueReason } from "./events/eventSpine";
import { registerCodexPluginHooks } from "./agentPlugins/codexHookRunner";
import type { TurnCompletion } from "./streamManager";
import {
  createAgentSessionHarness,
  type AgentSessionHarness,
  type AgentSessionHarnessOptions,
} from "./agentSession.testHarness";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import { SessionFilesMemory } from "./sessionFiles/memorySessionFiles.testHarness";
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

type StopCall = Pick<
  TurnStopContext,
  "messageId" | "lastAssistantMessage" | "stopHookActive" | "model"
>;

function addConsumer(decide: (ctx: TurnStopContext) => void, calls?: StopCall[]): void {
  unregisters.push(
    eventSpine.useBefore(
      "turn.stop",
      (ctx) => {
        calls?.push({
          messageId: ctx.messageId,
          lastAssistantMessage: ctx.lastAssistantMessage,
          stopHookActive: ctx.stopHookActive,
          model: ctx.model,
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
    /** A refusal fallback answered turn N with this model (stream-end metadata). */
    fallbackModel?: (turn: number) => string | undefined;
    /** Runs while turn N streams, before it ends. */
    whileStreaming?: (turn: number, h: AgentSessionHarness) => void;
    /** Every turn's status page earns the Agent interface view's turn-end nudge. */
    statusPageNeedsNudge?: boolean;
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
      ...(input.statusPageNeedsNudge === true
        ? { statusPageTurnEndNudge: () => Promise.resolve(STATUS_PAGE_TURN_END_NUDGE) }
        : {}),
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
                  metadata: endMetadata(input.fallbackModel?.(turns)),
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

/** Stream-end metadata: the turn's model, or a refusal fallback that answered instead. */
function endMetadata(fallbackModel: string | undefined) {
  return fallbackModel === undefined
    ? { model }
    : { model: fallbackModel, modelFallback: { requestedModel: model, refusedModels: [model] } };
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

/** A reason from plugin `guard`'s first Stop hook, unless `hook` names another. */
function stopReason(
  text: string,
  hook: Partial<Omit<TurnStopContinueReason, "text">> = {}
): TurnStopContinueReason {
  return { text, pluginName: "guard", hookKey: "guard:hooks/hooks.json#Stop[0][0]", ...hook };
}

const keepGoing = (ctx: TurnStopContext) => {
  ctx.continueReasons.push(stopReason("Run the failing tests again."));
};

function pluginNotices(h: AgentSessionHarness) {
  return h.events.filter((event) => event.type === "plugin-hook-notice");
}

/**
 * A Codex plugin with one Stop hook at the default hooks file's first slot, through the real
 * runner. `reason(call)` is the block reason of its 1-based call, or null to let the turn end.
 */
function addCodexStopHook(
  plugin: { name: string; instanceId: string },
  reason: (call: number) => string | null
): void {
  let calls = 0;
  unregisters.push(
    registerCodexPluginHooks(eventSpine, {
      workspaceId,
      pluginName: plugin.name,
      pluginInstanceId: plugin.instanceId,
      order: 0,
      hooks: [
        {
          key: "hooks/hooks.json#Stop[0][0]",
          hash: "h".repeat(64),
          event: "Stop",
          handler: { type: "mcp_tool", server: plugin.name, tool: "check", input: {} },
          status: "runnable",
          source: "hooks/hooks.json",
        },
      ],
      deps: {
        isHookAllowed: () => Promise.resolve(true),
        canCallPluginTool: () => true,
        callPluginTool: () => {
          const text = reason(++calls);
          const output = text == null ? {} : { decision: "block", reason: text };
          return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(output) }] });
        },
        notifyUser: () => undefined,
      },
    })
  );
}

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
      // Codex `model` (PRRT_kwDOPxxmWM6rN7nt): the model the turn streamed with.
      model,
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

  for (const row of [
    { loopLimit: 2, continuations: 2 },
    // No per-hook limit: the ceiling of 50 per user turn ends the loop.
    { loopLimit: null, continuations: 50 },
  ]) {
    test(`a hook with loopLimit ${String(row.loopLimit)} continues ${row.continuations} times`, async () => {
      addConsumer((ctx) => {
        ctx.continueReasons.push(stopReason("Keep looping.", { loopLimit: row.loopLimit }));
      });
      const { h, streams } = await setup();

      await h.session.sendMessage("fix the tests", options);
      await settle(h);

      expect(streams()).toBe(row.continuations + 1);
    });
  }

  test("two hooks each continue 3 times per user turn, and each sees its own count first", async () => {
    const first = stopReason("First.");
    const second = stopReason("Second.", { hookKey: "guard:hooks/hooks.json#Stop[1][0]" });
    const seen: Array<{ turn: number; first: number; second: number }> = [];
    addConsumer((ctx) => {
      seen.push({
        turn: ctx.turnContinuations,
        first: ctx.hookContinuations.get(first.hookKey) ?? 0,
        second: ctx.hookContinuations.get(second.hookKey) ?? 0,
      });
      ctx.continueReasons.push({ ...first });
      // The second hook starts once the first used its 3: one shared count would end here.
      if (seen.length > 3) ctx.continueReasons.push({ ...second });
    });
    const { h } = await setup();

    await h.session.sendMessage("fix the tests", options);
    await settle(h);
    expect(await userTexts(h)).toEqual([
      "fix the tests",
      ...Array<string>(3).fill("First."),
      ...Array<string>(3).fill("Second."),
    ]);
    expect(seen).toEqual([
      { turn: 0, first: 0, second: 0 },
      { turn: 1, first: 1, second: 0 },
      { turn: 2, first: 2, second: 0 },
      { turn: 3, first: 3, second: 0 },
      { turn: 4, first: 3, second: 1 },
      { turn: 5, first: 3, second: 2 },
      { turn: 6, first: 3, second: 3 },
    ]);

    // A new user message resets both counts.
    await h.session.sendMessage("now lint", options);
    await settle(h);
    expect((await userTexts(h)).slice(7)).toEqual([
      "now lint",
      ...Array<string>(3).fill("First.\n\nSecond."),
    ]);
    expect(seen[7]).toEqual({ turn: 0, first: 0, second: 0 });
  });

  test("a user Stop during the loop adds no continuation", async () => {
    const calls: StopCall[] = [];
    addConsumer((ctx) => {
      ctx.continueReasons.push(stopReason("Keep looping.", { loopLimit: null }));
    }, calls);
    // The user stops the first continuation's turn.
    const { h, streams } = await setup({
      ending: (turn) => (turn === 2 ? "aborted" : "completed"),
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(streams()).toBe(2);
    expect(calls).toHaveLength(1);
  });

  test("a Codex Stop hook continues 3 times per user turn", async () => {
    addCodexStopHook({ name: "guard", instanceId: "1111111111111111" }, () => "Again.");
    const { h, streams } = await setup();

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(streams()).toBe(4);
    expect(await userTexts(h)).toEqual(["fix the tests", ...Array<string>(3).fill("Again.")]);
  });

  test("two Codex plugins with the same hook key count separately", async () => {
    addCodexStopHook({ name: "guard", instanceId: "1111111111111111" }, () => "Guard.");
    // The second plugin starts once the first used its 3: a shared count would refuse it.
    addCodexStopHook({ name: "tidy", instanceId: "2222222222222222" }, (call) =>
      call > 3 ? "Tidy." : null
    );
    const { h } = await setup();

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(await userTexts(h)).toEqual([
      "fix the tests",
      ...Array<string>(3).fill("Guard."),
      ...Array<string>(3).fill("Tidy."),
    ]);
  });

  test("each continuation shows the plugin's notice with the turn's continuation count", async () => {
    addConsumer(keepGoing);
    const { h } = await setup({ session: { captureEvents: true } });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(pluginNotices(h)).toEqual(
      [1, 2, 3].map((n) => ({
        type: "plugin-hook-notice",
        workspaceId,
        plugin: "guard",
        message: `plugin continued turn ${n} of 50`,
      }))
    );
  });

  test("the Stop hooks see the model that answered after a refusal fallback", async () => {
    // Codex PRRT_kwDOPxxmWM6sbewj: only the stream-end reports the fallback model.
    const calls: StopCall[] = [];
    addConsumer(() => undefined, calls);
    const { h } = await setup({
      fallbackModel: (turn) => (turn === 1 ? "anthropic:claude-haiku-4-5" : undefined),
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(calls.map((call) => call.model)).toEqual(["anthropic:claude-haiku-4-5"]);
  });

  test("without a fallback the Stop hooks see the raw model the turn streamed with", async () => {
    // Tool events send the raw provider-qualified string (gateway prefix kept): Stop matches it.
    const calls: StopCall[] = [];
    addConsumer(() => undefined, calls);
    const gateway = "openrouter:anthropic/claude-haiku-4-5";
    const { h } = await setup();

    await h.session.sendMessage("fix the tests", { ...options, model: gateway });
    await settle(h);

    expect(calls.map((call) => call.model)).toEqual([gateway]);
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

  test("a send still in preflight when the turn ends does not skip the Stop hooks", async () => {
    // Codex PRRT_kwDOPxxmWM6sT80F: the send can still fail before it starts a turn.
    const calls: StopCall[] = [];
    addConsumer(() => undefined, calls);
    const { h, streams } = await setup({
      session: { hasExternalManualSendPreflight: () => true },
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    expect(streams()).toBe(1);
    expect(calls.map((call) => call.messageId)).toEqual(["a1"]);
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

  test("a queued entry whose admission went stale does not skip the Stop hooks", async () => {
    const calls: StopCall[] = [];
    addConsumer(() => undefined, calls);
    const { h } = await setup({
      whileStreaming: (turn, session) => {
        if (turn === 1)
          session.session.queueMessage("stale work", options, {
            acceptanceOrigin: "automatic",
            synthetic: true,
            admissionStale: () => true,
          });
        if (turn === 1)
          session.session.queueMessage("stale capture", options, {
            acceptanceOrigin: "automatic",
            synthetic: true,
            compactionAdmissionStale: () => true,
          });
      },
    });

    await h.session.sendMessage("fix the tests", options);
    await settle(h);

    // The drain refuses the stale entry, so turn 1 is the last turn: its Stop must run.
    expect(calls.map((call) => call.messageId)).toEqual(["a1"]);
  });

  test("an ACP turn with queued input still runs its Stop hooks", async () => {
    const calls: StopCall[] = [];
    addConsumer(() => undefined, calls);
    const { h } = await setup({
      whileStreaming: (turn, session) => {
        if (turn === 1) session.session.queueMessage("also lint", options);
      },
    });

    await h.session.sendMessage("fix the tests", { ...options, acpPromptId: "acp-prompt-1" });
    await settle(h);

    expect(calls.map((call) => call.messageId)).toEqual(["a1", "a2"]);
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

describe("todo turn-end nudge", () => {
  const openTodos: TodoItem[] = [
    { content: "Fix the bug", status: "completed" },
    { content: "Verify the fix", status: "in_progress" },
  ];
  const doneTodos = openTodos.map((todo): TodoItem => ({ ...todo, status: "completed" }));
  const todoWrite = {
    toolCallId: "todo-1",
    toolName: "todo_write",
    input: { todos: openTodos },
    state: "output-available",
    output: { success: true },
  } as const;
  const todoWriteThenReply = (): CompletedMessagePart[] => [
    { type: "dynamic-tool", ...todoWrite },
    { type: "text", text: "Fixed." },
  ];
  // An agent that denies todo_write answers the call with a refusal.
  const refusedTodoWriteThenReply = (): CompletedMessagePart[] => [
    {
      type: "dynamic-tool",
      ...todoWrite,
      output: { success: false, error: "todo_write is disabled for this agent" },
    },
    { type: "text", text: "Fixed." },
  ];
  // Programmatic tool calling: todo_write runs inside code_execution.
  const nestedTodoWriteThenReply = (): CompletedMessagePart[] => [
    {
      type: "dynamic-tool",
      toolCallId: "code-1",
      toolName: "code_execution",
      input: { code: "" },
      state: "output-available",
      output: { success: true },
      nestedCalls: [todoWrite],
    },
    { type: "text", text: "Fixed." },
  ];

  async function writeTodos(h: AgentSessionHarness, todos: TodoItem[]): Promise<void> {
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(getTodoFilePath(sessionDir), JSON.stringify(todos));
  }

  test.each([
    { name: "todo_write", parts: todoWriteThenReply },
    { name: "a nested todo_write", parts: nestedTodoWriteThenReply },
  ])("a turn with $name that leaves open items gets exactly one nudge", async (row) => {
    // Every stream, the nudge's own included, calls todo_write and leaves the list open.
    const { h, streams, requests } = await setup({ parts: row.parts });
    await writeTodos(h, openTodos);

    // The turn's own policy (a caller deny) must carry over to the nudge turn unchanged.
    const toolPolicy = [{ regex_match: "file_edit_.*", action: "disable" as const }];
    await h.session.sendMessage("fix the bug", { ...options, toolPolicy });
    await settle(h);

    expect(streams()).toBe(2);
    expect(await userTexts(h)).toEqual(["fix the bug", TODO_TURN_END_NUDGE]);
    // The nudge turn keeps the turn's tools, so it can finish open items, not only update the
    // list, and it still gets no tool the turn denied.
    expect(requests[1].toolPolicy).toEqual(toolPolicy);

    // The next user turn may be nudged again.
    await h.session.sendMessage("now lint", options);
    await settle(h);
    expect(streams()).toBe(4);
  });

  test("the nudge reads the list in the session's SessionFiles", async () => {
    const history = await createTestHistoryService({ files: SessionFilesMemory });
    unregisters.push(() => void history.cleanup());
    const { h, streams } = await setup({
      parts: todoWriteThenReply,
      session: { config: history.config, historyService: history.historyService },
    });
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    await history.files.promises.mkdir(sessionDir, { recursive: true });
    await history.files.promises.writeFile(getTodoFilePath(sessionDir), JSON.stringify(openTodos));

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    expect(streams()).toBe(2);
    expect(await userTexts(h)).toEqual(["fix the bug", TODO_TURN_END_NUDGE]);
  });

  test("a continuation of the nudge alone shows no plugin notice", async () => {
    const { h, streams } = await setup({
      parts: todoWriteThenReply,
      session: { captureEvents: true },
    });
    await writeTodos(h, openTodos);

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    expect(streams()).toBe(2);
    expect(pluginNotices(h)).toEqual([]);
  });

  test("a plugin continuation and the nudge share one continuation prompt", async () => {
    addConsumer(keepGoing);
    const { h, requests } = await setup({ parts: todoWriteThenReply });
    await writeTodos(h, openTodos);

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    const nudged = (await userTexts(h)).filter((text) => text.endsWith(TODO_TURN_END_NUDGE));
    expect(nudged).toEqual([`Run the failing tests again.\n\n${TODO_TURN_END_NUDGE}`]);
    // The plugin's continuation keeps the turn's tools.
    expect(requests[1].toolPolicy).toBeUndefined();
  });

  test("the merged continuation prompt keeps the continuation size cap", async () => {
    const longReason = "x".repeat(TURN_STOP_PROMPT_MAX_CHARS);
    addConsumer((ctx) => void ctx.continueReasons.push(stopReason(longReason)));
    const { h } = await setup({ parts: todoWriteThenReply });
    await writeTodos(h, openTodos);

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    const [, continuation] = await userTexts(h);
    expect(continuation.length).toBe(TURN_STOP_PROMPT_MAX_CHARS);
    expect(continuation.endsWith(TODO_TURN_END_NUDGE)).toBe(true);
  });

  test.each([
    { name: "a turn whose list is complete", todos: doneTodos },
    { name: "a turn that never called todo_write", noTodoWrite: true },
    { name: "a turn whose todo_write was refused", refused: true },
    { name: "a Plan mode turn", agentId: "plan" },
    { name: "a turn a plugin halted", halt: true },
  ])("$name gets no nudge", async (row) => {
    if (row.halt === true) addConsumer((ctx) => (ctx.halted = { pluginName: "guard" }));
    const { h, streams } = await setup({
      parts:
        row.noTodoWrite === true
          ? undefined
          : row.refused === true
            ? refusedTodoWriteThenReply
            : todoWriteThenReply,
    });
    await writeTodos(h, row.todos ?? openTodos);

    await h.session.sendMessage("fix the bug", { ...options, agentId: row.agentId ?? "exec" });
    await settle(h);

    expect(streams()).toBe(1);
  });

  test.each([
    {
      name: "a background wake",
      text: "Background sub-agent task(s) have completed.",
      internal: { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true },
    },
    // Heartbeats carry no agentInitiated, so the gate must not rely on it.
    {
      name: "a heartbeat",
      text: "[Heartbeat] Check on the workspace.",
      internal: { acceptanceOrigin: "automatic", synthetic: true },
    },
    // A visible automatic send (a task brief) is not a message the user sent either.
    {
      name: "an automatic visible send",
      text: "Work on the task.",
      internal: { acceptanceOrigin: "automatic" },
    },
  ] as const)("a turn $name started gets no nudge", async (row) => {
    const { h, streams } = await setup({ parts: todoWriteThenReply });
    await writeTodos(h, openTodos);

    await h.session.sendMessage(row.text, options, row.internal);
    await settle(h);
    expect(streams()).toBe(1);

    // The next message the user sends is a user turn again and gets its nudge.
    await h.session.sendMessage("fix the bug", options);
    await settle(h);
    expect(streams()).toBe(3);
    expect((await userTexts(h)).slice(1)).toEqual(["fix the bug", TODO_TURN_END_NUDGE]);
  });

  // Compaction requests are automatic: after a user turn, neither a heartbeat's compaction
  // (idle-compaction) nor an auto-compaction passes the user origin on to its follow-up.
  test.each([
    { source: "idle-compaction", nudged: false },
    { source: "auto-compaction", nudged: false },
  ] as const)(
    "after a user turn, a compaction request with source $source starts a machine turn",
    async (row) => {
      // Only the follow-up (turn 3) writes todos.
      const { h, streams } = await setup({
        parts: (turn) => (turn === 3 ? todoWriteThenReply() : [{ type: "text", text: "ok" }]),
      });
      await writeTodos(h, openTodos);
      await h.session.sendMessage("first", options);
      await settle(h);
      // The compaction stream runs; its summary is seeded below instead of written by the handler.
      const session = h.session as unknown as {
        contextController: {
          compaction: { handleCompletion(...args: unknown[]): Promise<boolean> };
        };
      };
      spyOn(session.contextController.compaction, "handleCompletion").mockResolvedValue(false);
      await h.session.sendMessage(
        "Please compact",
        {
          ...options,
          agentId: "compact",
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: row.source,
          },
        },
        { acceptanceOrigin: "automatic", synthetic: true }
      );
      await settle(h);
      const summary = createMuxMessage("summary", "assistant", "compacted summary", {
        compactionBoundary: true,
        compacted: "user",
        compactionEpoch: 1,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: { text: "check the workspace", model, agentId: "exec" },
        },
      });
      assert((await h.historyService.appendToHistory(workspaceId, summary)).success);

      expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
      await settle(h);

      expect(streams()).toBe(row.nudged ? 4 : 3);
      expect((await userTexts(h)).includes(TODO_TURN_END_NUDGE)).toBe(row.nudged);
    }
  );

  // A resume starts a stream without a new message: an automatic one (the prompt-free resume after
  // a sub-agent report) is a machine wake, and a manual one continues the user's turn.
  test.each([
    { name: "an automatic resume", internal: { acceptanceOrigin: "automatic" }, nudged: false },
    { name: "a manual resume", internal: { acceptanceOrigin: "manual" }, nudged: true },
  ] as const)("$name after a user turn keeps the right origin", async (row) => {
    // Only the resumed stream (turn 2) writes todos, so turn 1 itself is never nudged.
    const { h, streams } = await setup({
      parts: (turn) => (turn === 2 ? todoWriteThenReply() : [{ type: "text", text: "ok" }]),
    });
    await writeTodos(h, openTodos);
    await h.session.sendMessage("first", options);
    await settle(h);

    const resumed = await h.session.resumeStream(options, {
      ...row.internal,
      agentInitiated: true,
    });
    assert(resumed.success);
    await settle(h);

    expect(streams()).toBe(row.nudged ? 3 : 2);
    expect((await userTexts(h)).includes(TODO_TURN_END_NUDGE)).toBe(row.nudged);
  });

  // A compaction follow-up is an automatic synthetic send: a machine turn, even after a user turn.
  test.each([
    { name: "a user turn", internal: undefined, nudged: false },
    {
      name: "a machine wake",
      internal: { acceptanceOrigin: "automatic", synthetic: true },
      nudged: false,
    },
  ] as const)("a compaction follow-up after $name gets no nudge", async (row) => {
    // Only the follow-up (turn 2) writes todos, so turn 1 itself is never nudged.
    const { h, streams } = await setup({
      parts: (turn) => (turn === 2 ? todoWriteThenReply() : [{ type: "text", text: "ok" }]),
    });
    await writeTodos(h, openTodos);
    await h.session.sendMessage("first", options, row.internal);
    await settle(h);
    const summary = createMuxMessage("summary", "assistant", "compacted summary", {
      compactionBoundary: true,
      compacted: "user",
      compactionEpoch: 1,
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: { text: "fix the bug", model, agentId: "exec" },
      },
    });
    assert((await h.historyService.appendToHistory(workspaceId, summary)).success);

    expect(await h.session.dispatchPendingCompactionFollowUpIfNeeded()).toBe(true);
    await settle(h);

    expect(streams()).toBe(row.nudged ? 3 : 2);
    expect((await userTexts(h)).includes(TODO_TURN_END_NUDGE)).toBe(row.nudged);
  });
});

describe("status page turn-end nudge", () => {
  test("a turn whose status page needs it gets exactly one nudge per user turn", async () => {
    // The nudge's own turn would earn it too: only the first stream of a user turn is nudged.
    const { h, streams } = await setup({ statusPageNeedsNudge: true });

    await h.session.sendMessage("fix the bug", options);
    await settle(h);
    expect(await userTexts(h)).toEqual(["fix the bug", STATUS_PAGE_TURN_END_NUDGE]);

    await h.session.sendMessage("now lint", options);
    await settle(h);
    expect(streams()).toBe(4);
  });

  test("a plugin continuation carries the nudge once, and its own turns get none", async () => {
    addConsumer(keepGoing);
    const { h } = await setup({ statusPageNeedsNudge: true });

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    expect(await userTexts(h)).toEqual([
      "fix the bug",
      `Run the failing tests again.\n\n${STATUS_PAGE_TURN_END_NUDGE}`,
      "Run the failing tests again.",
      "Run the failing tests again.",
    ]);
  });

  test("with the TODO nudge and a capped plugin prompt, both nudges arrive whole, TODO first", async () => {
    const todoWrite: CompletedMessagePart = {
      type: "dynamic-tool",
      toolCallId: "todo-1",
      toolName: "todo_write",
      input: { todos: [] },
      state: "output-available",
      output: { success: true },
    };
    addConsumer(
      (ctx) => void ctx.continueReasons.push(stopReason("x".repeat(TURN_STOP_PROMPT_MAX_CHARS)))
    );
    const { h } = await setup({ statusPageNeedsNudge: true, parts: () => [todoWrite] });
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    const openTodos: TodoItem[] = [{ content: "Verify the fix", status: "in_progress" }];
    await fs.writeFile(getTodoFilePath(sessionDir), JSON.stringify(openTodos));

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    const [, continuation] = await userTexts(h);
    expect(continuation.length).toBe(TURN_STOP_PROMPT_MAX_CHARS);
    expect(
      continuation.endsWith(`x\n\n${TODO_TURN_END_NUDGE}\n\n${STATUS_PAGE_TURN_END_NUDGE}`)
    ).toBe(true);
  });

  test("a Stop that finished while the turn's last event arrived ends the turn without a nudge", async () => {
    // The stream still ends normally, and the Stop is over before the stream-end work reaches
    // the nudge: only the epoch the turn was admitted under shows the turn was stopped.
    let stopEpoch = 0;
    const { h, streams } = await setup({
      statusPageNeedsNudge: true,
      whileStreaming: () => void stopEpoch++,
      session: { getStopEpoch: () => stopEpoch },
    });

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    expect(await userTexts(h)).toEqual(["fix the bug"]);
    expect(streams()).toBe(1);
  });

  test("a Stop while the nudge row is written rolls the row back", async () => {
    // Past dequeue, queue clearing no longer sees the continuation: its admission must.
    let stopEpoch = 0;
    const { h, streams } = await setup({
      statusPageNeedsNudge: true,
      session: { getStopEpoch: () => stopEpoch },
    });
    const accept = h.historyService.acceptCompactionReplacement.bind(h.historyService);
    spyOn(h.historyService, "acceptCompactionReplacement").mockImplementation(
      async (id, capture, operation, observer) => {
        const result = await accept(id, capture, operation, observer);
        const nudgeRow =
          operation.kind === "append" &&
          operation.messages.some((row) =>
            row.parts.some(
              (part) => part.type === "text" && part.text === STATUS_PAGE_TURN_END_NUDGE
            )
          );
        if (nudgeRow) stopEpoch++;
        return result;
      }
    );

    await h.session.sendMessage("fix the bug", options);
    await settle(h);

    expect(await userTexts(h)).toEqual(["fix the bug"]);
    expect(streams()).toBe(1);
  });

  test.each([
    { name: "a Plan mode turn", agentId: "plan" },
    { name: "a turn a plugin halted", halt: true },
  ])("$name gets no nudge", async (row) => {
    if (row.halt === true) addConsumer((ctx) => (ctx.halted = { pluginName: "guard" }));
    const { h, streams } = await setup({ statusPageNeedsNudge: true });

    await h.session.sendMessage("fix the bug", { ...options, agentId: row.agentId ?? "exec" });
    await settle(h);

    expect(streams()).toBe(1);
  });
});
