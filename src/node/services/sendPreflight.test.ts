import { describe, expect, test } from "bun:test";
import { SendPreflight } from "@/node/services/sendPreflight";

function createPreflight() {
  const drained: string[] = [];
  const preflight = new SendPreflight({
    drainQueuedMessagesIfIdle: (workspaceId) => drained.push(workspaceId),
  });
  return { preflight, drained };
}

describe("SendPreflight send count", () => {
  test("a workspace is in preflight while any send admission is held", () => {
    const { preflight } = createPreflight();
    const first = preflight.sends.acquire("ws");
    const second = preflight.sends.acquire("ws");
    expect(preflight.hasSendInPreflight("ws")).toBe(true);
    expect(preflight.hasSendInPreflight("ws-other")).toBe(false);
    first[Symbol.dispose]();
    expect(preflight.hasSendInPreflight("ws")).toBe(true);
    second[Symbol.dispose]();
    expect(preflight.hasSendInPreflight("ws")).toBe(false);
  });
});

describe("SendPreflight send ids", () => {
  test("an id stays in flight until its last tracking is disposed", () => {
    const { preflight } = createPreflight();
    const first = preflight.trackInFlightSendIds("ws", ["a", "b"]);
    const retry = preflight.trackInFlightSendIds("ws", ["a"]);
    expect([...preflight.inFlightSendIdsOf("ws")].sort()).toEqual(["a", "b"]);

    first[Symbol.dispose]();
    expect([...preflight.inFlightSendIdsOf("ws")]).toEqual(["a"]);
    retry[Symbol.dispose]();
    expect([...preflight.inFlightSendIdsOf("ws")]).toEqual([]);
  });

  test("a disposed tracking does not drop a later tracking of the workspace", () => {
    const { preflight } = createPreflight();
    const first = preflight.trackInFlightSendIds("ws", ["a"]);
    first[Symbol.dispose]();
    const later = preflight.trackInFlightSendIds("ws", ["b"]);
    // A second dispose of the old tracking must not delete the new map.
    first[Symbol.dispose]();
    expect([...preflight.inFlightSendIdsOf("ws")]).toEqual(["b"]);
    later[Symbol.dispose]();
  });

  test("refuses only the ids answered not accepted, per workspace", () => {
    const { preflight } = createPreflight();
    preflight.refuseSendId("ws", "a");
    expect(preflight.isSendIdRefused("ws", ["b", "a"])).toBe(true);
    expect(preflight.isSendIdRefused("ws", ["b"])).toBe(false);
    expect(preflight.isSendIdRefused("ws-other", ["a"])).toBe(false);
  });
});

describe("SendPreflight session-invisible tickets", () => {
  test("a later send sees an earlier blocking ticket, not a supersedable one", () => {
    const { preflight } = createPreflight();
    const maintenance = preflight.armSessionInvisiblePreflight("ws", { supersedable: true });
    const first = preflight.armSessionInvisiblePreflight("ws");
    const second = preflight.armSessionInvisiblePreflight("ws");

    expect(maintenance.hasEarlierPreflight()).toBe(false);
    expect(first.hasEarlierPreflight()).toBe(false);
    expect(second.hasEarlierPreflight()).toBe(true);
    first.release();
    expect(second.hasEarlierPreflight()).toBe(false);
    expect(preflight.hasSessionInvisiblePreflight("ws")).toBe(true);

    // A released ticket has nothing before it any more.
    expect(first.hasEarlierPreflight()).toBe(false);

    maintenance.release();
    expect(preflight.hasSessionInvisiblePreflight("ws")).toBe(true);
    second.release();
    expect(preflight.hasSessionInvisiblePreflight("ws")).toBe(false);
  });

  test("only a manual, non-supersedable ticket counts as a manual preflight", () => {
    const { preflight } = createPreflight();
    const yielding = preflight.armSessionInvisiblePreflight("ws", {
      supersedable: true,
      manual: true,
    });
    const automatic = preflight.armSessionInvisiblePreflight("ws");
    expect(preflight.hasManualSessionInvisiblePreflight("ws")).toBe(false);

    const manual = preflight.armSessionInvisiblePreflight("ws", { manual: true });
    expect(preflight.hasManualSessionInvisiblePreflight("ws")).toBe(true);
    manual.release();
    expect(preflight.hasManualSessionInvisiblePreflight("ws")).toBe(false);
    yielding.release();
    automatic.release();
  });

  test("a later send waits until each earlier blocking send decides", async () => {
    const { preflight } = createPreflight();
    const first = preflight.armSessionInvisiblePreflight("ws");
    const second = preflight.armSessionInvisiblePreflight("ws");

    let waited = false;
    const wait = second.awaitEarlierDecisions().then(() => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);
    first.markDecided();
    await wait;
    expect(waited).toBe(true);
    first.release();
    second.release();
  });

  test("a send that leaves before deciding releases the sends behind it", async () => {
    const { preflight } = createPreflight();
    const first = preflight.armSessionInvisiblePreflight("ws");
    const second = preflight.armSessionInvisiblePreflight("ws");
    // Waiting starts while the first send is live, so only its release can end the wait.
    const wait = second.awaitEarlierDecisions();
    first.release();
    await wait;
    second.release();
  });

  test("only the head of the line drains the queue when disposed", () => {
    const { preflight, drained } = createPreflight();
    const head = preflight.armSessionInvisiblePreflight("ws");
    const younger = preflight.armSessionInvisiblePreflight("ws");
    const maintenance = preflight.armSessionInvisiblePreflight("ws", { supersedable: true });

    younger[Symbol.dispose]();
    maintenance[Symbol.dispose]();
    expect(drained).toEqual([]);
    head[Symbol.dispose]();
    expect(drained).toEqual(["ws"]);
  });

  test("a supersedable ticket never drains, even alone", () => {
    const { preflight, drained } = createPreflight();
    const maintenance = preflight.armSessionInvisiblePreflight("ws", { supersedable: true });
    maintenance[Symbol.dispose]();
    expect(drained).toEqual([]);
  });

  test("a ticket released early drains as the head it was at release", () => {
    const { preflight, drained } = createPreflight();
    const older = preflight.armSessionInvisiblePreflight("ws");
    const younger = preflight.armSessionInvisiblePreflight("ws");
    // Released while the older ticket still lived: not the head, so no drain at dispose.
    younger.release();
    older.release();
    younger[Symbol.dispose]();
    expect(drained).toEqual([]);
    older[Symbol.dispose]();
    expect(drained).toEqual(["ws"]);
  });
});
