import { describe, expect, spyOn, test } from "bun:test";

import { Err, Ok } from "@/common/types/result";
import { log } from "@/node/services/log";
import {
  PeerSendParking,
  type ParkedPeerSend,
  type PeerSendParkingDeps,
} from "@/node/services/peerSendParking";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

/** Only its presence matters to the parking: a live registration holds the list. */
const LIVE_REGISTRATION: NonNullable<
  ReturnType<WorkspaceTurnManager["getLiveWorkspaceTurnRegistration"]>
> = { handleId: "handle", ownerWorkspaceId: "owner", accepted: true };

const TARGET = "target";

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function parkedSend(message: string, targetId = TARGET): ParkedPeerSend {
  return {
    relation: "peer",
    senderWorkspaceId: `sender-${message}`,
    targetId,
    message,
    targetRelation: "peer",
    awaitedDelegatedTurn: {
      unrelatedConsent: undefined,
      registrationEpoch: 0,
      stopEpochs: new Map([[TARGET, -1]]),
    },
  };
}

function createHarness() {
  const live = new Set<string>();
  const stopping = new Set<string>();
  const stopEpochs = new Map<string, number>();
  const flushes: Array<Promise<void>> = [];
  const delivered: string[] = [];
  const stopEpochReads: string[] = [];
  let send: PeerSendParkingDeps["sendTreeMessage"] = (spec) => {
    delivered.push(spec.message);
    return Promise.resolve(Ok(undefined));
  };
  const parking: PeerSendParking = new PeerSendParking({
    flush: (targetId) => {
      const flush = parking.flushParkedPeerSends(targetId);
      flushes.push(flush);
      return flush;
    },
    getWorkspaceTurnManager: () => ({
      getLiveWorkspaceTurnRegistration: (workspaceId: string) =>
        live.has(workspaceId) ? LIVE_REGISTRATION : undefined,
    }),
    isWorkspaceStopInProgress: (workspaceId) => stopping.has(workspaceId),
    getWorkspaceStopEpoch: (workspaceId) => {
      stopEpochReads.push(workspaceId);
      return stopEpochs.get(workspaceId) ?? 0;
    },
    sendTreeMessage: (spec) => send(spec),
  });
  return {
    parking,
    live,
    stopping,
    stopEpochs,
    delivered,
    stopEpochReads,
    flushes,
    setSend(next: PeerSendParkingDeps["sendTreeMessage"]) {
      send = next;
    },
    /**
     * Wait until every scheduled flush settled, also ones scheduled meanwhile. The lock starts a
     * flush after a microtask hop and the fake deps settle on microtasks, so one macrotask turn
     * lets every started chain run.
     */
    async settle() {
      let seen = -1;
      while (seen !== flushes.length) {
        seen = flushes.length;
        await macrotask();
        await Promise.all(flushes);
      }
    },
  };
}

describe("PeerSendParking", () => {
  test("registration epochs start at zero and count each registration per target", () => {
    const { parking } = createHarness();
    expect(parking.registrationEpoch(TARGET)).toBe(0);
    parking.onWorkspaceTurnRegistered(TARGET);
    parking.onWorkspaceTurnRegistered(TARGET);
    parking.onWorkspaceTurnRegistered("other");
    expect(parking.registrationEpoch(TARGET)).toBe(2);
    expect(parking.registrationEpoch("other")).toBe(1);
  });

  test("a scheduled flush with nothing parked never reaches the flush dep", () => {
    const h = createHarness();
    h.parking.scheduleParkedPeerSendFlush(TARGET);
    expect(h.flushes).toHaveLength(0);
  });

  test("parking schedules a flush through the dep that delivers in park order and unregisters", async () => {
    const h = createHarness();
    h.live.add(TARGET);
    h.parking.parkPeerSend(parkedSend("a"));
    h.parking.parkPeerSend(parkedSend("b"));
    await h.settle();
    // The live turn holds the list: nothing delivered, both still counted against the cap.
    expect(h.delivered).toEqual([]);
    expect(h.parking.countParked(TARGET)).toBe(2);
    expect(h.parking.hasParked(TARGET)).toBe(true);

    h.live.delete(TARGET);
    h.parking.scheduleParkedPeerSendFlush(TARGET);
    await h.settle();
    expect(h.delivered).toEqual(["a", "b"]);
    expect(h.parking.hasParked(TARGET)).toBe(false);
    expect(h.parking.countParked(TARGET)).toBe(0);
  });

  test("a stop in progress holds the list until a later flush", async () => {
    const h = createHarness();
    h.stopping.add(TARGET);
    h.parking.parkPeerSend(parkedSend("a"));
    await h.settle();
    expect(h.delivered).toEqual([]);
    expect(h.stopEpochReads).toEqual([]);

    h.stopping.delete(TARGET);
    h.parking.scheduleParkedPeerSendFlush(TARGET);
    await h.settle();
    expect(h.delivered).toEqual(["a"]);
  });

  test("the drain takes one new target stop baseline for every waiting message", async () => {
    const h = createHarness();
    h.live.add(TARGET);
    const first = parkedSend("a");
    const second = parkedSend("b");
    h.parking.parkPeerSend(first);
    h.parking.parkPeerSend(second);
    await h.settle();
    h.live.delete(TARGET);
    h.stopEpochs.set(TARGET, 7);
    h.parking.scheduleParkedPeerSendFlush(TARGET);
    await h.settle();
    expect(h.stopEpochReads).toEqual([TARGET]);
    expect(first.awaitedDelegatedTurn.stopEpochs.get(TARGET)).toBe(7);
    expect(second.awaitedDelegatedTurn.stopEpochs.get(TARGET)).toBe(7);
  });

  test("a refused or throwing retry is dropped once and the rest still deliver", async () => {
    const h = createHarness();
    const debug = spyOn(log, "debug").mockImplementation(() => undefined);
    const error = spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const attempts: string[] = [];
      h.setSend((spec) => {
        attempts.push(spec.message);
        if (spec.message === "refused") return Promise.resolve(Err({ code: "interrupted" }));
        if (spec.message === "throws") return Promise.reject(new Error("boom"));
        return Promise.resolve(Ok(undefined));
      });
      h.live.add(TARGET);
      h.parking.parkPeerSend(parkedSend("refused"));
      h.parking.parkPeerSend(parkedSend("throws"));
      h.parking.parkPeerSend(parkedSend("ok"));
      await h.settle();
      h.live.delete(TARGET);
      h.parking.scheduleParkedPeerSendFlush(TARGET);
      await h.settle();
      expect(attempts).toEqual(["refused", "throws", "ok"]);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(h.parking.hasParked(TARGET)).toBe(false);
    } finally {
      debug.mockRestore();
      error.mockRestore();
    }
  });

  test("a retry that removed itself is not shifted twice", async () => {
    const h = createHarness();
    h.setSend((spec) => {
      h.delivered.push(spec.message);
      // sendTreeMessage removes the retry under the admission lock.
      h.parking.removeRetry(spec.targetId, spec);
      return Promise.resolve(Ok(undefined));
    });
    h.live.add(TARGET);
    h.parking.parkPeerSend(parkedSend("a"));
    h.parking.parkPeerSend(parkedSend("b"));
    await h.settle();
    h.live.delete(TARGET);
    h.parking.scheduleParkedPeerSendFlush(TARGET);
    await h.settle();
    expect(h.delivered).toEqual(["a", "b"]);
  });

  test("removeRetry ignores a spec that is not the head", () => {
    const h = createHarness();
    h.live.add(TARGET);
    const head = parkedSend("a");
    h.parking.parkPeerSend(head);
    h.parking.parkPeerSend(parkedSend("b"));
    h.parking.removeRetry(TARGET, parkedSend("a"));
    expect(h.parking.countParked(TARGET)).toBe(2);
    h.parking.removeRetry(TARGET, head);
    expect(h.parking.countParked(TARGET)).toBe(1);
    h.parking.removeRetry("other", head);
    expect(h.parking.countParked(TARGET)).toBe(1);
  });

  test("dropping the list mid-drain ends the drain", async () => {
    const h = createHarness();
    h.setSend((spec) => {
      h.delivered.push(spec.message);
      expect(h.parking.dropParked(TARGET)).toBe(true);
      return Promise.resolve(Ok(undefined));
    });
    h.live.add(TARGET);
    h.parking.parkPeerSend(parkedSend("a"));
    h.parking.parkPeerSend(parkedSend("b"));
    await h.settle();
    h.live.delete(TARGET);
    h.parking.scheduleParkedPeerSendFlush(TARGET);
    await h.settle();
    expect(h.delivered).toEqual(["a"]);
    expect(h.parking.dropParked(TARGET)).toBe(false);
  });

  test("a send parked during a drain is delivered after the waiting ones, one at a time", async () => {
    const h = createHarness();
    let active = 0;
    let maxActive = 0;
    h.setSend(async (spec) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (spec.message === "a") h.parking.parkPeerSend(parkedSend("fresh"));
      await Promise.resolve();
      h.delivered.push(spec.message);
      active--;
      return Ok(undefined);
    });
    h.parking.parkPeerSend(parkedSend("a"));
    h.parking.parkPeerSend(parkedSend("b"));
    await h.settle();
    expect(h.delivered).toEqual(["a", "b", "fresh"]);
    expect(maxActive).toBe(1);
  });

  test("a failing scheduled flush is logged, not thrown", async () => {
    const error = spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const parking = new PeerSendParking({
        flush: () => Promise.reject(new Error("flush failed")),
        getWorkspaceTurnManager: () => ({ getLiveWorkspaceTurnRegistration: () => undefined }),
        isWorkspaceStopInProgress: () => false,
        getWorkspaceStopEpoch: () => 0,
        sendTreeMessage: () => Promise.resolve(Ok(undefined)),
      });
      parking.parkPeerSend(parkedSend("a"));
      await macrotask();
      expect(error).toHaveBeenCalledTimes(1);
      expect(parking.countParked(TARGET)).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
