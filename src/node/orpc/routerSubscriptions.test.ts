import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { TestClock } from "effect/testing";
import { SUBSCRIPTION_HEARTBEAT_INTERVAL_MS } from "@/common/utils/withQueueHeartbeat";
import { disposeAppRuntime, makeAppRuntime } from "@/node/services/di/appRuntime";
import type { ORPCContext } from "./context";
import { subscribeWorkspaceActivity } from "./routerSubscriptions";

test("subscription handlers forward the oRPC runtime Clock", async () => {
  const app = makeAppRuntime(TestClock.layer());
  const workspaceService = new EventEmitter();
  const controller = new AbortController();
  const context = { "effect/context": app.context, workspaceService } as unknown as ORPCContext;
  const events: unknown[] = [];
  const consumed = (async () => {
    for await (const event of subscribeWorkspaceActivity(context, controller.signal)) {
      events.push(event);
    }
  })();
  try {
    await app.managed.runPromise(TestClock.adjust(SUBSCRIPTION_HEARTBEAT_INTERVAL_MS));
    expect(events).toEqual([{ type: "heartbeat" }]);
  } finally {
    controller.abort();
    await consumed;
    await disposeAppRuntime(app.managed);
  }
  expect(workspaceService.listenerCount("activity")).toBe(0);
});
