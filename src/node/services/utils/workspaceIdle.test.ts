import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { waitForWorkspaceIdle } from "./workspaceIdle";

function fakeHost() {
  const events = new EventEmitter();
  let releaseSession: () => void = () => undefined;
  const subscribe = (event: string) => (listener: (workspaceId: string) => void) => {
    events.on(event, listener);
    return () => {
      events.off(event, listener);
    };
  };
  return {
    events,
    releaseSession: () => releaseSession(),
    // Typed against the helper's host; listeners here only need the workspace ID.
    host: {
      waitForIdleAndNoQueuedMessages: () =>
        new Promise<void>((resolve) => {
          releaseSession = resolve;
        }),
      onWorkspaceTurnSettled: subscribe("settled"),
      onQueuedMessageChanged: subscribe("queue"),
    } as unknown as Parameters<typeof waitForWorkspaceIdle>[0]["host"],
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("waitForWorkspaceIdle", () => {
  test("the session's own idle signal ends the wait without a settle or queue event", async () => {
    // e.g. a pending auto-retry is abandoned: no turn settles and the queue never changes.
    const { host, releaseSession } = fakeHost();
    let busy = true;
    let outcome = null as string | null;
    const waiting = waitForWorkspaceIdle({
      host,
      workspaceId: "ws",
      isBusy: () => busy,
      signal: new AbortController().signal,
    }).then((result) => (outcome = result));
    await tick();
    expect(outcome).toBeNull();
    busy = false;
    releaseSession();
    await waiting;
    expect(outcome).toBe("idle");
  });

  test("still busy after the session wait: the next event re-checks; other workspaces are ignored", async () => {
    const { host, events, releaseSession } = fakeHost();
    let busy = true;
    let outcome = null as string | null;
    const waiting = waitForWorkspaceIdle({
      host,
      workspaceId: "ws",
      isBusy: () => busy,
      signal: new AbortController().signal,
    }).then((result) => (outcome = result));
    releaseSession();
    await tick();
    expect(outcome).toBeNull();
    busy = false;
    events.emit("settled", "other");
    await tick();
    expect(outcome).toBeNull();
    events.emit("queue", "ws");
    await tick();
    releaseSession();
    await waiting;
    expect(outcome).toBe("idle");
  });

  test("waitForNextTurn ignores an idle workspace until a turn settles; abort ends any wait", async () => {
    const { host, events, releaseSession } = fakeHost();
    let outcome = null as string | null;
    const waiting = waitForWorkspaceIdle({
      host,
      workspaceId: "ws",
      isBusy: () => false,
      signal: new AbortController().signal,
      waitForNextTurn: true,
    }).then((result) => (outcome = result));
    events.emit("queue", "ws");
    await tick();
    expect(outcome).toBeNull();
    events.emit("settled", "ws");
    await tick();
    releaseSession();
    await waiting;
    expect(outcome).toBe("idle");

    const controller = new AbortController();
    const aborted = waitForWorkspaceIdle({
      host,
      workspaceId: "ws",
      isBusy: () => true,
      signal: controller.signal,
    });
    controller.abort();
    expect(await aborted).toBe("aborted");
  });
});
