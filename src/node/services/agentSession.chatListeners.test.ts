import { afterEach, describe, expect, test } from "bun:test";
import type { EventEmitter } from "node:events";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { ORPCContext } from "@/node/orpc/context";
import { subscribeWorkspaceChat } from "@/node/orpc/routerSubscriptions";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";
import { createWorkspaceServiceForTest } from "./workspaceService.testHarness";

// The per-session AgentSession emitter gets one chat-event listener from WorkspaceService, one
// per open onChat subscription (every client window or tab showing the workspace) and one per
// waitForIdleAndNoQueuedMessages caller (every sub-agent report deferred while the owner has
// queued or retrying turn work). The live server logged MaxListenersExceededWarning for 11 such
// listeners; this pins that ending each subscriber releases its listener and that many live
// subscribers alone never trip the warning.
const SUBSCRIBER_COUNT = 12;
const workspaceId = "chat-listeners";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const harness = await createAgentSessionHarness({ workspaceId });
  cleanups.push(async () => {
    await harness.session.dispose();
    await harness.cleanup();
  });
  const warnings: string[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message);
  };
  process.on("warning", onWarning);
  cleanups.push(() => {
    process.off("warning", onWarning);
    return Promise.resolve();
  });
  // The listener count is not observable through a public API.
  const emitter = Reflect.get(harness.session, "emitter") as EventEmitter;
  return { harness, warnings, chatListeners: () => emitter.listenerCount("chat-event") };
}

/** Opens one onChat subscription the way the router does and resolves once it is caught up. */
async function openSubscription(harness: AgentSessionHarness) {
  const controller = new AbortController();
  const context = {
    workspaceService: { getOrCreateSession: () => harness.session },
  } as unknown as ORPCContext;
  const caughtUp = Promise.withResolvers<void>();
  const consumed = (async () => {
    const events = subscribeWorkspaceChat(context, { workspaceId }, controller.signal);
    for await (const event of events as AsyncIterable<WorkspaceChatMessage>) {
      if (event.type === "caught-up") caughtUp.resolve();
    }
  })().catch(() => undefined);
  await caughtUp.promise;
  return { controller, consumed };
}

/** Node reports the warning on a later tick. */
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe("AgentSession chat-event listeners", () => {
  test("many onChat subscriptions trip no leak warning and a client abort releases each one", async () => {
    const { harness, warnings, chatListeners } = await setup();
    const baseline = chatListeners();

    const subscriptions = [];
    for (let index = 0; index < SUBSCRIBER_COUNT; index++) {
      subscriptions.push(await openSubscription(harness));
    }
    await nextTick();
    expect(chatListeners()).toBe(baseline + SUBSCRIBER_COUNT);
    expect(warnings).toEqual([]);

    for (const subscription of subscriptions) subscription.controller.abort();
    await Promise.all(subscriptions.map((subscription) => subscription.consumed));
    expect(chatListeners()).toBe(baseline);
  });

  test("many idle waiters trip no leak warning and each releases its listener when it finishes", async () => {
    const { harness, warnings, chatListeners } = await setup();
    const service = createWorkspaceServiceForTest({
      config: harness.config,
      historyService: harness.historyService,
    });
    service.registerSession(workspaceId, harness.session);
    cleanups.push(() => service.disposeSession(workspaceId));
    // An idle session with a queued message: the waiters' chat-event branch.
    harness.session.queueMessage("queued while idle");
    expect(harness.session.isBusy()).toBe(false);
    const baseline = chatListeners();

    const waiters = Array.from({ length: SUBSCRIBER_COUNT }, () =>
      service.waitForIdleAndNoQueuedMessages(workspaceId)
    );
    await nextTick();
    expect(chatListeners()).toBe(baseline + SUBSCRIBER_COUNT);
    expect(warnings).toEqual([]);

    // Clearing the queue emits queued-message-changed with no turn work left: every waiter finishes.
    harness.session.clearQueue();
    await Promise.all(waiters);
    expect(chatListeners()).toBe(baseline);
  });
});
