import type { TurnCoordinator } from "./turnCoordinator";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import { Ok } from "@/common/types/result";
import type { TurnCompletion } from "./streamManager";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import type { TurnAdmissionToken } from "./taskWorkspaceSeam";
import { SEND_ADMISSION_STALE_MESSAGE } from "@/constants/agentMessaging";

/**
 * TurnAdmissionToken at the real AgentSession seams: the token learns of admission inside the
 * coordinator's synchronous prepare callback (direct send, queue dispatch, resume), a stale
 * queued token is refused at the dequeue gate BEFORE any turn is claimed, and every admitted turn
 * eventually reports settlement (or supersession) so the obligation is discharged — never
 * inferred from a return value.
 */
const workspaceId = "session-turn-admission";
const model = "openai:gpt-4o";
const sendOptions = { model, agentId: "exec" };

interface RecordedToken extends TurnAdmissionToken {
  readonly events: string[];
  /** Distinct turns reported admitted (the contract is idempotent per turn). */
  readonly admittedTurns: symbol[];
  /** Every raw onAdmitted call, to prove a repeated report names the same turn. */
  readonly admittedCalls: symbol[];
  stale: boolean;
}

function recordingToken(): RecordedToken {
  const token: RecordedToken = {
    events: [],
    admittedTurns: [],
    admittedCalls: [],
    stale: false,
    admissionStale: () => token.stale,
    onEnqueued: () => {
      token.events.push("enqueued");
    },
    onAdmitted: (turnId) => {
      token.admittedCalls.push(turnId);
      if (token.admittedTurns.includes(turnId)) return;
      token.events.push("admitted");
      token.admittedTurns.push(turnId);
    },
    onDisposed: (kind) => {
      // Contract: ignored once admitted (the turn owns the obligation from then on).
      if (token.events.includes("admitted")) return;
      token.events.push(`disposed:${kind}`);
    },
  };
  return token;
}

const internal = (session: AgentSession) => session as unknown as { coordinator: TurnCoordinator };
const streamCalls = (aiService: unknown): number =>
  (aiService as { streamMessage: ReturnType<typeof mock> }).streamMessage.mock.calls.length;

describe("AgentSession turn admission tokens", () => {
  let h: AgentSessionHarness | undefined;
  const settled: symbol[] = [];
  const superseded: Array<[symbol, symbol]> = [];
  const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];

  const resolved = new Set<number>();
  function abortTurn(index: number, abortReason: "user" | "system"): void {
    if (resolved.has(index)) return;
    resolved.add(index);
    completions[index].resolve({ status: "aborted", abortReason });
  }

  async function harness() {
    // Reset here, not in afterEach: a disposed session can still publish a late idle transition.
    settled.length = 0;
    superseded.length = 0;
    completions.length = 0;
    resolved.clear();
    const emitter = new EventEmitter();
    let calls = 0;
    h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      onTurnSettled: (turn) => settled.push(turn),
      onTurnSuperseded: (previous, next) => superseded.push([previous, next]),
      aiServiceOverrides: {
        streamMessage: mock(() => {
          const messageId = `assistant-${++calls}`;
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          emitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model,
            startTime: Date.now(),
          });
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
        // A stop settles the live handle as aborted, like the real StreamManager.
        stopStream: mock((_workspaceId: string, options?: { abortReason?: "user" | "system" }) => {
          abortTurn(completions.length - 1, options?.abortReason ?? "user");
          return Promise.resolve(Ok(undefined));
        }),
      },
    });
    return h;
  }

  afterEach(async () => {
    for (let index = 0; index < completions.length; index += 1) abortTurn(index, "user");
    await h?.session.dispose();
    await h?.cleanup();
    h = undefined;
  });

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Complete the index-th stream; resolves once the coordinator published the outcome. */
  async function settleTurn(index: number, after: () => boolean): Promise<void> {
    resolved.add(index);
    completions[index].resolve({
      status: "completed",
      streamEnd: {
        type: "stream-end",
        workspaceId,
        metadata: { model },
        parts: [{ type: "text", text: "done" }],
      },
    });
    await waitFor(after, `turn ${index} outcome`);
  }

  test("a direct send reports admission once, under the turn the coordinator later settles", async () => {
    const { session } = await harness();
    const token = recordingToken();
    expect(await session.sendMessage("hello", sendOptions, { turnAdmission: token })).toEqual(
      Ok(undefined)
    );
    expect(token.events).toEqual(["admitted"]);
    expect(settled).toHaveLength(0);
    await settleTurn(0, () => settled.length > 0);
    // Exact turn correlation: the settled generation is the one the token was admitted under.
    expect(settled).toEqual([token.admittedTurns[0]]);
    expect(token.events).toEqual(["admitted"]);
  });

  test("an idle lifecycle listener cannot settle or overwrite a synchronously admitted successor", async () => {
    const { session } = await harness();
    const coordinator = internal(session).coordinator;
    const first = coordinator.prepare({
      kind: "fresh",
      intent: "direct",
      expectedTurnId: coordinator.turnId,
    });
    if (first.status !== "admitted") throw new Error("first preparation refused");
    const token = recordingToken();
    let successor: symbol | undefined;
    const unsubscribe = session.onChatEvent(({ message }) => {
      if (message.type !== "stream-lifecycle" || message.phase !== "idle" || successor != null)
        return;
      const admission = coordinator.prepare(
        { kind: "fresh", intent: "direct", expectedTurnId: coordinator.turnId },
        undefined,
        (turnId) => {
          successor = turnId;
          token.onAdmitted(turnId);
        }
      );
      expect(admission.status).toBe("admitted");
    });
    try {
      coordinator.finishPreparation(first.turnId);
      if (successor == null) throw new Error("idle listener did not admit a successor");
      expect(token.admittedTurns).toEqual([successor]);
      expect(coordinator.phase).toBe("preparing");
      expect(settled).toEqual([first.turnId]);
      expect(superseded).toEqual([]);
      // The nested successor must still be observed as live when another turn replaces it.
      const replacement = coordinator.prepare({
        kind: "fresh",
        intent: "handoff",
        expectedTurnId: coordinator.turnId,
      });
      if (replacement.status !== "admitted") throw new Error("replacement refused");
      expect(superseded).toEqual([[successor, replacement.turnId]]);
      coordinator.finishPreparation(replacement.turnId);
      expect(settled).toEqual([first.turnId, replacement.turnId]);
    } finally {
      unsubscribe();
    }
  });

  test("a supersession listener can settle the successor without losing that idle observation", async () => {
    const settlements: symbol[] = [];
    const replacements: Array<[symbol, symbol]> = [];
    h = await createAgentSessionHarness({
      workspaceId,
      onTurnSettled: (id) => settlements.push(id),
      onTurnSuperseded: (previous, next) => {
        replacements.push([previous, next]);
        // A Stop listener can synchronously retire the newly observed preparation.
        internal(h!.session).coordinator.finishPreparation(next);
      },
    });
    const coordinator = internal(h.session).coordinator;
    const first = coordinator.prepare({
      kind: "fresh",
      intent: "direct",
      expectedTurnId: coordinator.turnId,
    });
    if (first.status !== "admitted") throw new Error("first preparation refused");
    coordinator.prepare({ kind: "fresh", intent: "handoff", expectedTurnId: first.turnId });
    expect(coordinator.phase).toBe("idle");
    const stopped = coordinator.turnId;
    expect(settlements).toEqual([stopped]);
    expect(replacements).toEqual([[first.turnId, stopped]]);
    const next = coordinator.prepare({
      kind: "fresh",
      intent: "direct",
      expectedTurnId: stopped,
    });
    expect(next.status).toBe("admitted");
    expect(coordinator.phase).toBe("preparing");
    // A settled predecessor is not superseded again, so the listener must not stop this turn.
    expect(replacements).toEqual([[first.turnId, stopped]]);
    if (next.status === "admitted") coordinator.finishPreparation(next.turnId);
  });

  test("a stale token is refused at the PREPARING gate without admission or a stream", async () => {
    const { session, aiService } = await harness();
    const token = recordingToken();
    let accepted = false;
    const result = await session.sendMessage("hello", sendOptions, {
      turnAdmission: token,
      acceptanceOrigin: "automatic",
      synthetic: true,
      onAccepted: () => {
        accepted = true;
        // Goes stale after acceptance: models a Stop closing the attempt while the session
        // was persisting rows. The composed probe is what WorkspaceService threads through.
        token.stale = true;
      },
      admissionStale: () => token.admissionStale(),
    });
    expect(result.success).toBe(false);
    expect(accepted).toBe(true);
    expect(token.events).toEqual([]);
    expect(streamCalls(aiService)).toBe(0);
    // The refused preparation settled its own turn; nothing was admitted under this token.
    expect(internal(session).coordinator.phase).toBe("idle");
  });

  test("queued send: enqueued on insertion, admitted once at dispatch (adoption is idempotent), settled by its turn", async () => {
    const { session } = await harness();
    expect(await session.sendMessage("first", sendOptions)).toEqual(Ok(undefined));
    const firstTurn = internal(session).coordinator.turnId;
    const token = recordingToken();
    expect(
      session.queueMessage("second", sendOptions, {
        acceptanceOrigin: "automatic",
        turnAdmission: token,
      })
    ).not.toBeNull();
    expect(token.events).toEqual(["enqueued"]);

    // The completing first turn drains the queue: the coordinator prepares the dequeued turn
    // while the first is still completing, so the first generation is SUPERSEDED (never idle).
    await settleTurn(0, () => token.admittedTurns.length > 0 && completions.length >= 2);
    const dispatched = token.admittedTurns[0];
    expect(dispatched).not.toBe(firstTurn);
    expect(superseded).toEqual([[firstTurn, dispatched]]);
    expect(settled).toEqual([]);
    // The dequeue gate reported admission and the adopting sendMessage re-entry reported the
    // SAME turn — one admission, not two.
    expect(token.admittedTurns).toHaveLength(1);
    expect(new Set(token.admittedCalls).size).toBe(1);
    await settleTurn(1, () => settled.length > 0);
    expect(settled).toEqual([dispatched]);
    expect(token.events).toEqual(["enqueued", "admitted"]);
  });

  test("a queued token that went stale is refused before any turn is claimed and the drain continues", async () => {
    const { session, aiService } = await harness();
    expect(await session.sendMessage("first", sendOptions)).toEqual(Ok(undefined));
    const stale = recordingToken();
    const fresh = recordingToken();
    const canceled: string[] = [];
    session.queueMessage("stale follow-up", sendOptions, {
      acceptanceOrigin: "automatic",
      turnAdmission: stale,
      onCanceled: (reason) => {
        canceled.push(reason);
      },
    });
    session.queueMessage("fresh follow-up", sendOptions, {
      acceptanceOrigin: "automatic",
      turnAdmission: fresh,
    });
    // Closed while queued (a Stop settled the attempt, or a successor superseded it).
    stale.stale = true;
    const streamsBefore = streamCalls(aiService);

    await settleTurn(0, () => fresh.admittedTurns.length > 0 && completions.length >= 2);
    expect(stale.events).toEqual(["enqueued", "disposed:refused"]);
    expect(canceled).toEqual([SEND_ADMISSION_STALE_MESSAGE]);
    // The stale entry never became a turn: the only new stream is the fresh entry's, and the
    // only generation that replaced the first turn is the fresh entry's.
    expect(fresh.events).toEqual(["enqueued", "admitted"]);
    expect(streamCalls(aiService)).toBe(streamsBefore + 1);
    expect(superseded.map(([, next]) => next)).toEqual([fresh.admittedTurns[0]]);
    await settleTurn(1, () => settled.length > 0);
    expect(settled).toEqual([fresh.admittedTurns[0]]);
  });

  test("clearing the queue disposes enqueued tokens as canceled before admission", async () => {
    const { session } = await harness();
    expect(await session.sendMessage("first", sendOptions)).toEqual(Ok(undefined));
    const token = recordingToken();
    session.queueMessage("queued", sendOptions, {
      acceptanceOrigin: "automatic",
      turnAdmission: token,
    });
    session.clearQueue();
    expect(token.events).toEqual(["enqueued", "disposed:canceled-before-admission"]);
    await settleTurn(0, () => settled.length > 0);
    // No later drain can revive the removed entry.
    expect(token.events).toEqual(["enqueued", "disposed:canceled-before-admission"]);
  });

  test("resumeStream reports admission only when it starts a turn", async () => {
    const { session } = await harness();
    const busyToken = recordingToken();
    expect(await session.sendMessage("first", sendOptions)).toEqual(Ok(undefined));
    // Busy: no turn for this resume, and the session does not speak for the token (the host
    // disposes it as no-work).
    expect(await session.resumeStream(sendOptions, { turnAdmission: busyToken })).toEqual(
      Ok({ started: false })
    );
    expect(busyToken.events).toEqual([]);
    await settleTurn(0, () => settled.length > 0);

    const token = recordingToken();
    expect(
      await session.resumeStream(sendOptions, {
        acceptanceOrigin: "automatic",
        turnAdmission: token,
      })
    ).toEqual(Ok({ started: true }));
    expect(token.events).toEqual(["admitted"]);
    await settleTurn(1, () => settled.length > 1);
    expect(settled.at(-1)).toBe(token.admittedTurns[0]);
  });

  test("a queued entry dispatched at a step boundary supersedes the live turn instead of settling it", async () => {
    const { session } = await harness();
    expect(await session.sendMessage("first", sendOptions)).toEqual(Ok(undefined));
    const first = internal(session).coordinator.turnId;
    const token = recordingToken();
    session.queueMessage(
      "tool-end follow-up",
      { ...sendOptions, queueDispatchMode: "tool-end" },
      {
        acceptanceOrigin: "automatic",
        turnAdmission: token,
      }
    );
    // Provider-tool drain while the first turn is still streaming: the coordinator replaces the
    // generation without an idle transition for `first` (the cut stream settles as aborted).
    session.sendQueuedMessages("provider-tool");
    expect(token.events).toEqual(["enqueued", "admitted"]);
    const second = token.admittedTurns[0];
    expect(second).not.toBe(first);
    expect(superseded).toEqual([[first, second]]);
    expect(settled).not.toContain(first);
    // Whatever waited on `first` now waits on `second`, which settles normally.
    await waitFor(() => completions.length >= 2, "second stream");
    await settleTurn(1, () => settled.length > 0);
    expect(settled).toEqual([second]);
  });
});
