import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createAgentSessionHarness, type AgentSessionHarness } from "../agentSession.testHarness";
import type { CompactionMonitor } from "../compactionMonitor";
import type { ContinuousCompactor } from "../continuousCompactor";
import type { SessionContextController } from "./sessionContextController";
import type { SessionContextHost } from "./sessionContextHost";

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

test("one factory gives each controller independent pressure latches and thresholds", async () => {
  const h = (harness = await createAgentSessionHarness({ workspaceId: "factory" }));
  const events: WorkspaceChatMessage[] = [];
  const first = h.contextManagement.openSession(
    host(h, "first", { emitChatEvent: (event) => events.push(event) })
  );
  const second = h.contextManagement.openSession(host(h, "second"));
  expect(first.setAutoCompactionThreshold(0.7)).toBeUndefined();
  second.setAutoCompactionThreshold(1);
  const pressure = {
    model: "openai:gpt-4o",
    usage: { inputTokens: 120_000, outputTokens: 1, totalTokens: 120_001 },
    use1MContext: false,
    providersConfig: null,
  };
  expect(monitorOf(first).checkMidStream(pressure)).toBe(true);
  expect(monitorOf(first).checkMidStream(pressure)).toBe(false);
  expect(monitorOf(second).checkMidStream(pressure)).toBe(false);
  expect(second.autoCompactionThreshold).toBe(1);
  expect(first.onStreamStarting()).toBeUndefined();
  expect(monitorOf(first).checkMidStream(pressure)).toBe(true);
  expect(events).toHaveLength(2);
  // A different session's start must not re-arm the first session's pressure latch.
  second.onStreamStarting();
  expect(monitorOf(first).checkMidStream(pressure)).toBe(false);
  expect(first.autoCompactionThreshold).toBe(0.7);
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
  const handler = controller.transitionalCompactionHandler;
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
  const compactor = Reflect.get(
    controller.continuous,
    "continuousCompactor"
  ) as ContinuousCompactor;
  const reset = spyOn(compactor, "reset");
  // Reasons that used to be session-local names reach the engine under its existing vocabulary,
  // and a `(): void` signature alone does not prove synchronous latching: assert no Promise.
  expect(controller.reset("settings-changed")).toBeUndefined();
  expect(reset).toHaveBeenLastCalledWith("context-changed");
  expect(controller.reset("context-refresh")).toBeUndefined();
  expect(reset).toHaveBeenLastCalledWith("context-mutation");
  expect(reset).toHaveBeenCalledTimes(2);
  expect(controller.isApplying()).toBe(false);
});
