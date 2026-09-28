import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import {
  createAgentSessionHarness,
  seedAutoCompactionThreshold,
  type AgentSessionHarness,
} from "../agentSession.testHarness";
import type { CompactionHandler } from "../compactionHandler";
import type { CompactionMonitor } from "../compactionMonitor";
import type { ContinuousCompactor } from "../continuousCompactor";
import type { SessionContextController } from "./sessionContextController";
import type { SessionContextHost } from "./sessionContextHost";
import type { TokenBudgetStrategy } from "./strategies/tokenBudget";
import type { ContextResetReason } from "./types";

let harness: AgentSessionHarness | undefined;
afterEach(async () => {
  await harness?.session.dispose();
  await harness?.cleanup();
  harness = undefined;
});

function controllerOf(h: AgentSessionHarness): SessionContextController {
  return Reflect.get(h.session, "contextController") as SessionContextController;
}

/**
 * The harness session's real host with the test-owned identity fields shadowed. Inherited
 * members (coordinator, stream adapters, state getters) stay live instead of being stubbed.
 */
function host(
  h: AgentSessionHarness,
  workspaceId: string,
  overrides: Partial<SessionContextHost> = {}
): SessionContextHost {
  const real = Reflect.get(controllerOf(h), "host") as SessionContextHost;
  const derived = Object.create(real) as SessionContextHost;
  const shadowed: Partial<SessionContextHost> = {
    workspaceId,
    sessionDir: path.join(h.config.sessionsDir, workspaceId),
    emitter: new EventEmitter(),
    emitChatEvent: () => undefined,
    ...overrides,
  };
  for (const [key, value] of Object.entries(shadowed)) {
    Object.defineProperty(derived, key, { value, configurable: true, enumerable: true });
  }
  return derived;
}

/** The controller-private monitor: latch/threshold state must never leak between sessions. */
function monitorOf(controller: SessionContextController): CompactionMonitor {
  return Reflect.get(controller, "compactionMonitor") as CompactionMonitor;
}

/** The controller-private handler that owns durable compaction publication for one session. */
function handlerOf(controller: SessionContextController): CompactionHandler {
  return Reflect.get(controller, "compactionHandler") as CompactionHandler;
}

/** The controller-private token-budget strategy; its generation is the preparation fence. */
function tokenBudgetOf(controller: SessionContextController): TokenBudgetStrategy {
  return Reflect.get(controller, "tokenBudget") as TokenBudgetStrategy;
}

test("one factory gives each controller independent pressure latches over one persisted threshold", async () => {
  const h = (harness = await createAgentSessionHarness({ workspaceId: "factory" }));
  const model = "openai:gpt-4o";
  await seedAutoCompactionThreshold(h.config, model, 70);
  const events: WorkspaceChatMessage[] = [];
  const first = h.contextManagement.openSession(
    host(h, "first", { emitChatEvent: (event) => events.push(event) })
  );
  const second = h.contextManagement.openSession(host(h, "second"));
  // The threshold is per model in config.json, so both controllers resolve the same value.
  expect(first.autoCompactionThreshold(model)).toBe(0.7);
  expect(second.autoCompactionThreshold(model)).toBe(0.7);
  const pressure = {
    model,
    threshold: first.autoCompactionThreshold(model),
    usage: { inputTokens: 120_000, outputTokens: 1, totalTokens: 120_001 },
    use1MContext: false,
    providersConfig: null,
  };
  expect(monitorOf(first).checkMidStream(pressure)).toBe(true);
  expect(monitorOf(first).checkMidStream(pressure)).toBe(false);
  // A disabled threshold never interrupts, whatever the latch state.
  expect(monitorOf(second).checkMidStream({ ...pressure, threshold: 1 })).toBe(false);
  expect(first.onStreamStarting()).toBeUndefined();
  expect(monitorOf(first).checkMidStream(pressure)).toBe(true);
  expect(events).toHaveLength(2);
  // A different session's start must not re-arm the first session's pressure latch.
  second.onStreamStarting();
  expect(monitorOf(first).checkMidStream(pressure)).toBe(false);
  // A slider change lands in config and is visible to every controller on its next decision.
  await seedAutoCompactionThreshold(h.config, model, 100);
  expect(first.autoCompactionThreshold(model)).toBe(1);
  expect(second.autoCompactionThreshold(model)).toBe(1);
});

test("durable completion records the tail summary before notifying the external observer", async () => {
  const h = (harness = await createAgentSessionHarness({ workspaceId: "factory" }));
  const workspaceId = "completion";
  let recorded: string | null = null;
  const observed: Array<string | null> = [];
  const sessionHost = host(h, workspaceId, {
    onCompactionComplete: (metadata) => {
      expect(recorded).toBe(
        (metadata.preservedTailMessageCount ?? 0) > 0 ? metadata.summaryMessageId : null
      );
      observed.push(recorded);
    },
  });
  spyOn(sessionHost.coordinator, "recordCompactionSummary").mockImplementation((id) => {
    recorded = id;
  });
  const controller = h.contextManagement.openSession(sessionHost);
  const handler = handlerOf(controller);
  expect(
    (
      await h.historyService.appendManyToHistory(workspaceId, [
        createMuxMessage("old", "user", "Investigate the failure"),
        createMuxMessage("recent", "assistant", "The fix is ready"),
      ])
    ).success
  ).toBe(true);

  for (const retainTail of [true, false]) {
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success);
    expect(
      await handler.persistContinuousCompaction({
        messages: history.data,
        tail: retainTail ? history.data.slice(-1) : [],
        text: "The investigation and fix are complete",
        model: "openai:gpt-4o",
        systemMessageTokens: 0,
        attachmentTokens: 0,
        attachmentMessages: [],
        preparation: handler.beginPreparation(() => true),
        publication: {
          generation: await h.historyService
            .getContinuousCompactionJournal(workspaceId)
            .captureGeneration(),
        },
        shouldPersist: () => true,
      })
    ).toBe(true);
    const published = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(published.success);
    expect(published.data[0].metadata?.compactionBoundary).toBe(true);
    expect(published.data).toHaveLength(retainTail ? 2 : 1);
  }
  expect(observed).toHaveLength(2);
  expect(observed[0]).toBeString();
  expect(observed[1]).toBeNull();
});

test("controller transitions latch synchronously and map settings resets onto the compactor", async () => {
  const h = (harness = await createAgentSessionHarness({ workspaceId: "transitions" }));
  const controller = controllerOf(h);
  // Strategies are controller-private; reach the engine through the same names the session uses.
  const compactor = Reflect.get(
    Reflect.get(controller, "continuous") as object,
    "continuousCompactor"
  ) as ContinuousCompactor;
  const reset = spyOn(compactor, "reset");
  // A void signature alone cannot prove latching. The real engine must invalidate old work
  // before this caller can yield, not merely receive a deferred reset request.
  const generation = () => Reflect.get(compactor, "generation") as number;
  let before = generation();
  expect(controller.reset("settings-changed")).toBeUndefined();
  expect(generation()).toBeGreaterThan(before);
  expect(reset).toHaveBeenLastCalledWith("context-changed");
  before = generation();
  expect(controller.reset("context-refresh")).toBeUndefined();
  expect(generation()).toBeGreaterThan(before);
  expect(reset).toHaveBeenLastCalledWith("context-mutation");
  expect(reset).toHaveBeenCalledTimes(2);

  before = generation();
  expect(controller.onUserInterrupt({ abandonPartial: false })).toBeUndefined();
  expect(generation()).toBe(before);
  expect(controller.onUserInterrupt({ abandonPartial: true })).toBeUndefined();
  expect(generation()).toBeGreaterThan(before);

  before = generation();
  expect(controller.beginShutdown()).toBeUndefined();
  expect(generation()).toBeGreaterThan(before);
  before = generation();
  expect(controller.dispose()).toBeUndefined();
  expect(generation()).toBeGreaterThan(before);
  expect(controller.isApplying()).toBe(false);
});

test("preparation receipts are owner-bound and only context resets invalidate them", async () => {
  const h = (harness = await createAgentSessionHarness({ workspaceId: "receipts" }));
  const controller = controllerOf(h);
  const sibling = h.contextManagement.openSession(host(h, "sibling"));
  const budget = tokenBudgetOf(controller);
  const claimed = () => ({
    warning: Reflect.get(budget, "contextBudgetWarningClaimed") as boolean,
    flush: Reflect.get(budget, "contextBudgetFlushClaimed") as boolean,
  });
  const arm = () => {
    Reflect.set(budget, "contextBudgetWarningClaimed", true);
    Reflect.set(budget, "contextBudgetFlushClaimed", true);
  };

  // A receipt proves the issuing strategy has not been reset; another session's controller
  // cannot validate it even when both generations happen to agree.
  const receipt = controller.capturePreparation();
  expect(controller.validatePreparation(receipt)).toBe(true);
  expect(sibling.validatePreparation(receipt)).toBe(false);
  expect(controller.validatePreparation(sibling.capturePreparation())).toBe(false);
  expect(receipt.generation).toBe(sibling.capturePreparation().generation);

  // Every reset reason must be classified: only the reasons that change the request context
  // clear budget state. Compactor-only resets (edits, deletes, cancellation) leave a prepared
  // rollover valid so its synchronous publication fence stays with the issuing checkpoint.
  const clearing = new Set<ContextResetReason>([
    "context-changed",
    "context-mutation",
    "compaction-request",
  ]);
  const reasons: ContextResetReason[] = [
    "delete-messages",
    "edit",
    "context-changed",
    "settings-changed",
    "user-interrupt",
    "delete-message",
    "context-mutation",
    "context-refresh",
    "compaction-request",
    "disabled",
    "legacy-fallback",
  ];
  for (const reason of reasons) {
    arm();
    const before = controller.capturePreparation();
    controller.reset(reason);
    expect({ reason, valid: controller.validatePreparation(before) }).toEqual({
      reason,
      valid: !clearing.has(reason),
    });
    expect({ reason, ...claimed() }).toEqual({
      reason,
      warning: !clearing.has(reason),
      flush: !clearing.has(reason),
    });
    // Resets never cross session boundaries.
    expect(sibling.validatePreparation(sibling.capturePreparation())).toBe(true);
  }

  // Cancellation clears the budget itself, ahead of its own user-interrupt reset, whether or
  // not it also abandons a partial compaction.
  for (const abandonPartial of [false, true]) {
    arm();
    const before = controller.capturePreparation();
    controller.onUserInterrupt({ abandonPartial });
    expect(controller.validatePreparation(before)).toBe(false);
    expect(claimed()).toEqual({ warning: false, flush: false });
  }
  expect(sibling.validatePreparation(receipt)).toBe(false);
});
