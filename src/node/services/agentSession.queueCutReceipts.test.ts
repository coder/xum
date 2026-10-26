import { describe, expect, mock, spyOn, test } from "bun:test";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { StreamEndEvent } from "@/common/types/stream";
import { Err, Ok } from "@/common/types/result";
import { taskRecoveryPromptDedupeKey } from "@/constants/agentMessaging";
import {
  CONTEXT_CONTINUE_DEDUPE_KEY,
  CONTEXT_WARNING_DEDUPE_KEY,
} from "@/common/constants/contextBudget";
import { CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE, type AgentSessionAIService } from "./agentSession";
import {
  createAgentSessionHarness,
  seedAutoCompactionThreshold,
  type AgentSessionHarness,
} from "./agentSession.testHarness";
import type { MessageQueue } from "./messageQueue";
import { createTurnCompletionController, type SettledStepBudget } from "./streamManager";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";
/** Known context limit for exercising advisory and hard-ceiling queue cuts. */
const BUDGET_MODEL = "openai:gpt-4o";
const workspaceId = "queue-cut-receipts";

type Request = Parameters<AgentSessionAIService["streamMessage"]>[0];

function step(inputTokens: number, overrides?: Partial<SettledStepBudget>): SettledStepBudget {
  return {
    model: BUDGET_MODEL,
    usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
    toolResultChars: 0,
    imageParts: 0,
    sessionHistoryAvailable: true,
    newContextAvailable: true,
    ...overrides,
  };
}

function queueOf(h: AgentSessionHarness): MessageQueue {
  return (h.session as unknown as { messageQueue: MessageQueue }).messageQueue;
}

/** Controlled provider in the token-budget test style: stream-start is emitted on delivery. */
async function setup(args?: { failure?: boolean }) {
  const requests: Request[] = [];
  const completions: Array<ReturnType<typeof createTurnCompletionController>> = [];
  const firstRequest = Promise.withResolvers<Request>();
  const secondRequest = Promise.withResolvers<Request>();
  const streamMessage = mock<AgentSessionAIService["streamMessage"]>((request) => {
    requests.push(request);
    firstRequest.resolve(request);
    if (requests.length === 2) secondRequest.resolve(request);
    if (args?.failure) {
      return Promise.resolve(Err({ type: "unknown" as const, raw: "provider unavailable" }));
    }
    h.aiEmitter.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: `assistant-${requests.length}`,
      model: request.modelString,
      startTime: Date.now(),
    });
    const completion = createTurnCompletionController();
    completions.push(completion);
    const close = () => completion.settle({ status: "aborted", abortReason: "system" });
    const signal = h.session.closingSignal;
    if (signal.aborted) close();
    else signal.addEventListener("abort", close, { once: true });
    return Promise.resolve(
      Ok({
        messageId: `assistant-${requests.length}`,
        completion: completion.promise.finally(() => signal.removeEventListener("abort", close)),
      })
    );
  });
  const h = await createAgentSessionHarness({
    workspaceId,
    captureEvents: true,
    aiServiceOverrides: {
      streamMessage,
      buildMemorySessionContext: mock(() => Promise.resolve(null)),
      isExperimentEnabled: mock(
        (id) => id === EXPERIMENT_IDS.TOKEN_BUDGET || id === EXPERIMENT_IDS.MEMORY
      ),
    },
  });
  spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
    Ok({
      id: workspaceId,
      name: "receipts",
      projectName: "project",
      projectPath: h.config.rootDir,
      namedWorkspacePath: h.config.rootDir,
      runtimeConfig: { type: "local" },
    } as FrontendWorkspaceMetadata)
  );
  await seedAutoCompactionThreshold(h.config, BUDGET_MODEL, 70);
  /** Start a token-budget turn so requests[0].onStepSettled evaluates the real budget policy. */
  const startBudgetTurn = async () => {
    const sent = await h.session.sendMessage("Work through the task", {
      model: BUDGET_MODEL,
      agentId: "exec",
    });
    expect(sent.success).toBe(true);
    return firstRequest.promise;
  };
  const settleStream = (index: number, finishReason = "tool-calls") => {
    const streamEnd: StreamEndEvent = {
      type: "stream-end",
      workspaceId,
      messageId: `assistant-${index + 1}`,
      metadata: { model: BUDGET_MODEL, agentId: "exec", finishReason },
      parts: [],
    };
    completions[index].settle({ status: "completed", streamEnd });
  };
  return {
    ...h,
    requests,
    completions,
    firstRequest: firstRequest.promise,
    secondRequest: secondRequest.promise,
    streamMessage,
    startBudgetTurn,
    settleStream,
  };
}

async function teardown(h: AgentSessionHarness) {
  await h.session.dispose();
  await h.cleanup();
}

function queuedChanges(events: WorkspaceChatMessage[]): number {
  return events.filter((event) => event.type === "queued-message-changed").length;
}

describe("AgentSession queue-cut receipts", () => {
  test("a selected tool-end cut registers one pending receipt keyed by the entry", async () => {
    const h = await setup();
    try {
      expect(h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" })).toBe(
        "tool-end"
      );
      const first = h.session.getQueuedInputStopCause();
      const second = h.session.getQueuedInputStopCause();
      expect(first?.entryId).toBeDefined();
      expect(second?.entryId).toBe(first!.entryId);
      const receipt = h.session.getQueueCutReceipt(first!.entryId);
      expect(receipt).toMatchObject({
        successor: "pending",
        sourceHandled: false,
        disposed: false,
      });
      expect(typeof receipt?.sourceTurnGeneration).toBe("symbol");
      // Idempotent: the second selection did not replace the receipt.
      expect(h.session.getQueueCutReceipt(first!.entryId)).toBe(receipt);
    } finally {
      await teardown(h);
    }
  });

  test("turn-end entries (recovery prompts) never cut and leave no receipt", async () => {
    const h = await setup();
    try {
      h.session.queueMessage(
        "Your stream ended without a final assistant response.",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          dedupeKey: taskRecoveryPromptDedupeKey(workspaceId, "completion"),
          removableDedupeKey: true,
        }
      );
      const candidate = queueOf(h).getNextQueueCutCandidate();
      expect(candidate?.dispatchMode).toBe("turn-end");
      expect(h.session.getQueuedInputStopCause()).toBeUndefined();
      expect(h.session.getQueueCutReceipt(candidate!.entryId)).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test.each([
    { usage: 90_000, decision: "warn", dedupeKey: CONTEXT_WARNING_DEDUPE_KEY },
    { usage: 120_000, decision: "rollover", dedupeKey: CONTEXT_CONTINUE_DEDUPE_KEY },
  ])("a budget stop at $usage designates only its single continuation", async (fixture) => {
    const h = await setup();
    try {
      await h.startBudgetTurn();
      const outcome = await h.requests[0].onStepSettled!(step(fixture.usage));
      const entryId = queueOf(h).getEntryIdByDedupeKey(fixture.dedupeKey);
      expect(entryId).toBeDefined();
      expect(outcome).toEqual({ decision: fixture.decision, continuationEntryId: entryId });
      expect(h.session.getQueueCutReceipt(entryId!)?.successor).toBe("pending");
      const unusedKey =
        fixture.dedupeKey === CONTEXT_WARNING_DEDUPE_KEY
          ? CONTEXT_CONTINUE_DEDUPE_KEY
          : CONTEXT_WARNING_DEDUPE_KEY;
      expect(queueOf(h).getEntryIdByDedupeKey(unusedKey)).toBeUndefined();

      h.settleStream(0);
      await h.secondRequest;
      expect(h.session.getQueueCutReceipt(entryId!)?.successor).toBe("streaming");
      expect(await h.requests[1].onStepSettled!(step(5_000))).toEqual({ decision: "continue" });
    } finally {
      await teardown(h);
    }
  });

  test("the captured successor survives a head reorder or removal after the decision", async () => {
    const h = await setup();
    try {
      await h.startBudgetTurn();
      const outcome = await h.requests[0].onStepSettled!(step(90_000));
      const continueEntryId = queueOf(h).getEntryIdByDedupeKey(CONTEXT_WARNING_DEDUPE_KEY);
      expect(outcome).toEqual({ decision: "warn", continuationEntryId: continueEntryId });

      // A user "Send now" moves a manual entry ahead before StreamManager consumes the decision.
      h.session.queueMessage("Actually, do this first", { model: TEST_MODEL, agentId: "exec" });
      expect(queueOf(h).prioritizeNextUserEntry()).toBe(true);
      const head = queueOf(h).getNextQueueCutCandidate();
      expect(head?.entryId).not.toBe(continueEntryId);
      expect(h.session.getQueueCutReceipt(head!.entryId)).toBeUndefined();
      expect(h.session.getQueueCutReceipt(continueEntryId!)?.successor).toBe("pending");

      // Removal of the designated entry is recorded against it, not re-attributed to the head.
      h.session.clearQueue();
      expect(h.session.getQueueCutReceipt(continueEntryId!)?.successor).toBe("canceled");
      expect(h.session.getQueueCutReceipt(head!.entryId)).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test("a budget stop with unrelated input already queued designates no successor", async () => {
    const h = await setup();
    try {
      await h.startBudgetTurn();
      h.session.queueMessage("Unrelated follow-up", { model: TEST_MODEL, agentId: "exec" });
      const unrelatedEntryId = queueOf(h).getNextQueueCutCandidate()!.entryId;
      const outcome = await h.requests[0].onStepSettled!(step(90_000));
      expect(outcome).toEqual({ decision: "warn" });
      expect(h.session.getQueueCutReceipt(unrelatedEntryId)).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test("the enqueuer's pre-stream failure callback already observes prestream-failed", async () => {
    const h = await setup({ failure: true });
    try {
      let observedInCallback: unknown = "callback did not run";
      h.session.queueMessage(
        "continue",
        { model: TEST_MODEL, agentId: "exec" },
        {
          onAcceptedPreStreamFailure: () => {
            observedInCallback = h.session.getQueueCutReceipt(entryId)?.successor;
          },
        }
      );
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      h.session.sendQueuedMessages();
      await h.firstRequest;
      await h.session.waitForIdle();
      expect(observedInCallback).toBe("prestream-failed");
    } finally {
      await teardown(h);
    }
  });

  test("clearing a cut entry records canceled and notifies; dispose is consume-once", async () => {
    const h = await setup();
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      const before = queuedChanges(h.events);
      h.session.clearQueue();
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("canceled");
      expect(queuedChanges(h.events)).toBeGreaterThan(before);

      expect(h.session.disposeQueueCut(entryId)).toBe(true);
      expect(h.session.disposeQueueCut(entryId)).toBe(false);
      // Retained until the source handler also arrives, so it cannot recover a second time.
      expect(h.session.getQueueCutReceipt(entryId)?.disposed).toBe(true);
      h.session.markQueueCutSourceHandled(entryId);
      expect(h.session.getQueueCutReceipt(entryId)).toBeUndefined();
      expect(h.session.disposeQueueCut(entryId)).toBe(false);
    } finally {
      await teardown(h);
    }
  });

  test("dispatch records admitted, then streaming; release waits for the source handler", async () => {
    const h = await setup();
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      const observed: string[] = [];
      h.session.onChatEvent(({ message }) => {
        if (message.type !== "queued-message-changed") return;
        const successor = h.session.getQueueCutReceipt(entryId)?.successor;
        observed.push(typeof successor === "object" ? successor.kind : String(successor));
      });
      h.session.sendQueuedMessages();
      await h.firstRequest;
      expect(observed).toEqual(["admitted", "streaming"]);
      // Streaming alone does not release: the source handler may still consult the transfer.
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("streaming");
      h.session.markQueueCutSourceHandled(entryId);
      expect(h.session.getQueueCutReceipt(entryId)).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test("an admitted entry whose turn fails before streaming records prestream-failed before idle", async () => {
    const h = await setup({ failure: true });
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      const observed: Array<{ type: string; successor: unknown }> = [];
      h.session.onChatEvent(({ message }) => {
        observed.push({
          type: message.type === "stream-lifecycle" ? `lifecycle:${message.phase}` : message.type,
          successor: h.session.getQueueCutReceipt(entryId)?.successor,
        });
      });
      h.session.sendQueuedMessages();
      await h.firstRequest;
      await h.session.waitForIdle();
      // The failure is recorded (and published) before the turn's terminal lifecycle lands.
      const recorded = observed.findIndex((event) => event.successor === "prestream-failed");
      const terminal = observed.findIndex((event) => event.type === "lifecycle:failed");
      expect(observed[recorded]?.type).toBe("queued-message-changed");
      expect(terminal).toBeGreaterThan(recorded);
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("prestream-failed");
      // Not released by failure alone: the source handler may still arrive.
      h.session.markQueueCutSourceHandled(entryId);
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("prestream-failed");
      expect(h.session.disposeQueueCut(entryId)).toBe(true);
      expect(h.session.getQueueCutReceipt(entryId)).toBeUndefined();
    } finally {
      await teardown(h);
    }
  });

  test("a dequeued entry whose turn goes idle without any stream records prestream-failed", async () => {
    const h = await setup();
    try {
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      // The send resolves without ever admitting a stream (withdrawn-style outcome).
      const sendMessage = spyOn(h.session, "sendMessage").mockResolvedValue(Ok(undefined));
      h.session.sendQueuedMessages();
      await h.session.waitForIdle();
      sendMessage.mockRestore();
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("prestream-failed");
    } finally {
      await teardown(h);
    }
  });
});

type SkipReason = "entry-stale" | "compaction-stale" | "canceled";
type HeadKind = "automatic" | "manual";

interface HeadOutcome {
  canceled: string[];
  failures: string[];
  canceledBeforeAcceptance: boolean;
}

/** Queue a head the tool-end cut skips (isEntryDispatchable false); returns its outcome so far. */
function queueSkippedHead(h: AgentSessionHarness, reason: SkipReason, kind: HeadKind) {
  const canceled: string[] = [];
  const failures: string[] = [];
  const cancelState = { canceledBeforeAcceptance: false };
  const controller = new AbortController();
  if (reason === "canceled") controller.abort();
  h.session.queueMessage(
    "skipped head",
    { model: TEST_MODEL, agentId: "exec" },
    {
      ...(kind === "automatic" ? { acceptanceOrigin: "automatic" as const, synthetic: true } : {}),
      ...(reason === "entry-stale" ? { admissionStale: () => true } : {}),
      ...(reason === "compaction-stale" ? { compactionAdmissionStale: () => true } : {}),
      cancelSignal: controller.signal,
      cancelState,
      onCanceled: (why) => {
        canceled.push(why);
      },
      onAcceptedPreStreamFailure: (error) => {
        failures.push(error.type === "unknown" ? error.raw : error.type);
      },
    }
  );
  return (): HeadOutcome => ({ canceled, failures, ...cancelState });
}

interface SuccessorOutcome {
  phases: string[];
  afterDrain: unknown;
  final: unknown;
  restored: string[];
  held: string[];
}
const STALE: HeadOutcome = {
  canceled: [],
  failures: [CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE],
  canceledBeforeAcceptance: false,
};
const CANCELED: HeadOutcome = {
  canceled: ["Queued message canceled before acceptance."],
  failures: [],
  canceledBeforeAcceptance: true,
};
/** The cut's successor dispatches in the drain that settles the skipped head (#7553). */
const SAME_DRAIN: SuccessorOutcome = {
  phases: ["preparing", "streaming"],
  afterDrain: "admitted",
  final: "streaming",
  restored: [],
  held: [],
};

describe("AgentSession queue-cut receipts with a skipped head", () => {
  test.each<[SkipReason, HeadKind, HeadOutcome, SuccessorOutcome]>([
    ["entry-stale", "automatic", STALE, SAME_DRAIN],
    ["entry-stale", "manual", STALE, SAME_DRAIN],
    ["compaction-stale", "automatic", STALE, SAME_DRAIN],
    // Restorable manual input keeps the full path: its failed dispatch restores it with the
    // queue, so the successor is restored too, never dispatched.
    [
      "compaction-stale",
      "manual",
      STALE,
      {
        phases: ["preparing", "idle"],
        afterDrain: "pending",
        final: "canceled",
        restored: ["skipped head\ncontinue"],
        held: ["skipped head", "continue"],
      },
    ],
    ["canceled", "automatic", CANCELED, SAME_DRAIN],
    ["canceled", "manual", CANCELED, SAME_DRAIN],
  ])(
    "a %s %s head the cut skips keeps its outcome and does not delay the cut entry",
    async (reason, kind, head, successor) => {
      const h = await setup();
      try {
        const headOutcome = queueSkippedHead(h, reason, kind);
        h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
        const entryId = h.session.getQueuedInputStopCause()!.entryId;
        const phases: string[] = [];
        const restored: string[] = [];
        h.session.onChatEvent(({ message }) => {
          if (message.type === "stream-lifecycle") phases.push(message.phase);
          if (message.type === "restore-to-input") restored.push(message.text);
        });
        const kindOf = (value: unknown) =>
          typeof value === "object" && value !== null ? (value as { kind: string }).kind : value;

        h.session.sendQueuedMessages();
        const afterDrain = kindOf(h.session.getQueueCutReceipt(entryId)?.successor);
        if (successor.final === "streaming") await h.firstRequest;
        else await h.session.waitForIdle();

        expect(headOutcome()).toEqual(head);
        expect({
          phases,
          afterDrain,
          final: kindOf(h.session.getQueueCutReceipt(entryId)?.successor),
          restored,
          held: h.session.getHeldInputs().map((input) => input.send.displayText),
        }).toEqual(successor);
      } finally {
        await teardown(h);
      }
    }
  );

  // Codex PRRT_kwDOPxxmWM6wQZq3: the refused send's settlement (one retry) used to finish before
  // the idle re-drain started the successor; it must still finish before the successor's send.
  test("the cut entry's send waits for the skipped head's settlement, retried once", async () => {
    const h = await setup();
    const release = Promise.withResolvers<void>();
    try {
      let calls = 0;
      h.session.queueMessage(
        "skipped head",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          admissionStale: () => true,
          onAcceptedPreStreamFailure: async () => {
            if (++calls === 1) throw new Error("transient");
            await release.promise;
          },
        }
      );
      h.session.queueMessage("continue", { model: TEST_MODEL, agentId: "exec" });
      const entryId = h.session.getQueuedInputStopCause()!.entryId;
      const sends = spyOn(h.session, "sendMessage");
      h.session.sendQueuedMessages();
      // The retry ran and the second call now waits on `release`; nothing else can advance.
      for (let tick = 0; calls < 2 && tick < 200; tick++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect({ calls, sends: sends.mock.calls.length }).toEqual({ calls: 2, sends: 0 });
      release.resolve();
      await h.firstRequest;
      sends.mockRestore();
      expect(h.session.getQueueCutReceipt(entryId)?.successor).toBe("streaming");
    } finally {
      release.resolve();
      await teardown(h);
    }
  });
});
