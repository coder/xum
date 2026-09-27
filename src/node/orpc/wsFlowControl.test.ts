import { describe, expect, test } from "bun:test";
import {
  WS_FLOW_CONTROL_HIGH_WATER_BYTES,
  WS_FLOW_CONTROL_LOW_WATER_BYTES,
  createFlowControlledWebSocket,
  type FlowControlSocket,
} from "@/node/orpc/wsFlowControl";

const KiB = 1024;

/**
 * Models the parts of a `ws` WebSocket the wrapper relies on: `bufferedAmount`
 * counts frames accepted by send() whose write callback has not fired, the
 * test decides when the client reads (flush), and sends on a closing or
 * closed socket are dropped with a next-tick error callback like `ws` does.
 */
class FakeSocket extends EventTarget implements FlowControlSocket {
  bufferedAmount = 0;
  readyState = 1; // OPEN
  readonly written: string[] = [];
  readonly droppedAfterClose: string[] = [];
  throwOnNextSend = false;
  private readonly unflushed: Array<{ data: string; cb: (err?: Error) => void }> = [];

  send(data: string | Uint8Array<ArrayBuffer>, cb: (err?: Error) => void): void {
    if (typeof data !== "string") {
      throw new Error("FakeSocket only models string frames");
    }
    if (this.throwOnNextSend) {
      this.throwOnNextSend = false;
      throw new Error("send failed");
    }
    if (this.readyState !== 1) {
      this.droppedAfterClose.push(data);
      process.nextTick(cb, new Error("WebSocket is not open"));
      return;
    }
    this.written.push(data);
    this.bufferedAmount += data.length;
    this.unflushed.push({ data, cb });
  }

  /** The client reads the oldest buffered frame; its write callback fires. */
  flushOne(): void {
    const frame = this.unflushed.shift();
    if (!frame) throw new Error("nothing to flush");
    this.bufferedAmount -= frame.data.length;
    frame.cb();
  }

  /**
   * The peer went away (e.g. a browser reload): the socket is CLOSING, pending
   * writes fail, and "close" is only dispatched later by close().
   */
  beginClose(): void {
    this.readyState = 2; // CLOSING
    for (const pending of this.unflushed.splice(0)) {
      process.nextTick(pending.cb, new Error("socket destroyed"));
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.dispatchEvent(new Event("close"));
  }
}

function frame(label: string, bytes: number): string {
  return label.padEnd(bytes, ".");
}

function labels(frames: string[]): string[] {
  return frames.map((f) => f.replace(/\.+$/, ""));
}

/** Lets resolved sends run their continuations (sender loops, `.then` flags). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function track(promise: Promise<void>): { settled: boolean; rejected: boolean } {
  const state = { settled: false, rejected: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
      state.rejected = true;
    }
  );
  return state;
}

describe("createFlowControlledWebSocket", () => {
  test("passes sends through in order while the socket is under the high-water mark", async () => {
    const socket = new FakeSocket();
    const ws = createFlowControlledWebSocket(socket);

    const sends = ["a", "b", "c"].map((label) => track(ws.send(frame(label, 100 * KiB))));
    await settle();

    expect(sends.every((s) => s.settled && !s.rejected)).toBe(true);
    expect(labels(socket.written)).toEqual(["a", "b", "c"]);
  });

  test("pauses above the high-water mark and resumes in call order only below the low-water mark", async () => {
    const socket = new FakeSocket();
    const ws = createFlowControlledWebSocket(socket);

    // A+B+C fill the socket past HIGH; D and E must wait.
    void ws.send(frame("A", 600 * KiB));
    void ws.send(frame("B", 400 * KiB));
    void ws.send(frame("C", 100 * KiB));
    expect(socket.bufferedAmount).toBeGreaterThan(WS_FLOW_CONTROL_HIGH_WATER_BYTES);
    const d = track(ws.send(frame("D", 50 * KiB)));
    const e = track(ws.send(frame("E", 50 * KiB)));
    await settle();
    expect(labels(socket.written)).toEqual(["A", "B", "C"]);
    expect(d.settled || e.settled).toBe(false);

    // Back under HIGH but still above LOW: hysteresis keeps the gate closed.
    socket.flushOne();
    expect(socket.bufferedAmount).toBeLessThanOrEqual(WS_FLOW_CONTROL_HIGH_WATER_BYTES);
    expect(socket.bufferedAmount).toBeGreaterThanOrEqual(WS_FLOW_CONTROL_LOW_WATER_BYTES);
    await settle();
    expect(labels(socket.written)).toEqual(["A", "B", "C"]);
    expect(d.settled || e.settled).toBe(false);

    // Below LOW (C still unflushed): the queue drains in call order.
    socket.flushOne();
    expect(socket.bufferedAmount).toBeLessThan(WS_FLOW_CONTROL_LOW_WATER_BYTES);
    await settle();
    expect(labels(socket.written)).toEqual(["A", "B", "C", "D", "E"]);
    expect(d.settled && e.settled).toBe(true);
    expect(d.rejected || e.rejected).toBe(false);
  });

  test("a heartbeat waits behind at most one window, not a flooding subscription's backlog", async () => {
    const socket = new FakeSocket();
    const ws = createFlowControlledWebSocket(socket);
    const rowBytes = 64 * KiB;

    // Like oRPC's replay transmitter: always exactly one send outstanding.
    let floodDone = false;
    const flood = (async () => {
      for (let i = 0; i < 200; i++) {
        await ws.send(frame(`row${i}`, rowBytes));
      }
      floodDone = true;
    })();
    await settle();

    // The client reads a few frames, then the heartbeat is issued mid-flood.
    for (let i = 0; i < 5; i++) {
      socket.flushOne();
      await settle();
    }
    const writtenBeforeHeartbeat = socket.written.length;
    const bufferedAtHeartbeatWrite: number[] = [];
    const heartbeat = ws.send("heartbeat").then(() => {
      bufferedAtHeartbeatWrite.push(socket.bufferedAmount);
    });

    // Keep the client reading until the heartbeat has gone out.
    while (!socket.written.includes("heartbeat")) {
      socket.flushOne();
      await settle();
    }
    await heartbeat;

    // Only the flood frame already queued ahead of it may be written first,
    // and the bytes ahead of the heartbeat in the socket stay within a window.
    const heartbeatIndex = socket.written.indexOf("heartbeat");
    expect(heartbeatIndex - writtenBeforeHeartbeat).toBeLessThanOrEqual(1);
    const bytesAheadOfHeartbeat = bufferedAtHeartbeatWrite[0] - "heartbeat".length;
    expect(bytesAheadOfHeartbeat).toBeLessThanOrEqual(WS_FLOW_CONTROL_HIGH_WATER_BYTES + rowBytes);

    // The flood keeps going afterwards; nothing was lost or reordered.
    while (!floodDone) {
      socket.flushOne();
      await settle();
    }
    await flood;
    const rows = labels(socket.written.filter((f) => f !== "heartbeat"));
    expect(rows).toEqual(Array.from({ length: 200 }, (_, i) => `row${i}`));
  });

  test("a client that stops reading bounds the backlog, and close settles every sender", async () => {
    const socket = new FakeSocket();
    const ws = createFlowControlledWebSocket(socket);
    const frameBytes = 100 * KiB;

    const senders = [0, 1, 2].map((id) =>
      (async () => {
        for (let i = 0; i < 50; i++) {
          await ws.send(frame(`s${id}-${i}`, frameBytes));
        }
      })()
    );
    await settle();

    // Never flushed: the socket holds at most one window plus one frame, and
    // every sender is parked on a queued send instead of finishing.
    expect(socket.bufferedAmount).toBeLessThanOrEqual(
      WS_FLOW_CONTROL_HIGH_WATER_BYTES + frameBytes
    );
    const writtenBeforeClose = socket.written.length;
    const parked = senders.map(track);
    await settle();
    expect(parked.some((p) => p.settled)).toBe(false);

    socket.close();
    await Promise.all(senders);

    // Nothing reached the closed socket as a write; later sends were dropped
    // by the socket itself instead of throwing.
    expect(socket.written).toHaveLength(writtenBeforeClose);
    expect(socket.droppedAfterClose.length).toBeGreaterThan(0);

    // A reconnect gets a fresh wrapper: it starts empty and writes at once.
    const nextSocket = new FakeSocket();
    const nextWs = createFlowControlledWebSocket(nextSocket);
    await nextWs.send("hello");
    expect(nextSocket.written).toEqual(["hello"]);
  });

  test("a closing socket parks senders until close instead of draining their backlog", async () => {
    const socket = new FakeSocket();
    const ws = createFlowControlledWebSocket(socket);

    // Like oRPC: a transmitter pulls from a large backlog with one send
    // outstanding, and oRPC's own "close" listener (registered after the
    // wrapper) marks it done so it stops at its next send.
    let transmitterDone = false;
    socket.addEventListener("close", () => {
      transmitterDone = true;
    });
    const backlog = 10_000;
    let sent = 0;
    const transmitter = (async () => {
      while (!transmitterDone && sent < backlog) {
        await ws.send(frame(`row${sent}`, 64 * KiB));
        sent++;
      }
    })();
    // Let it fill the window and park (the client is not reading).
    await new Promise((resolve) => setImmediate(resolve));
    const sentBeforeClosing = sent;
    expect(sentBeforeClosing).toBeLessThan(backlog);

    // The client disconnects. A macrotask must get to run before "close"
    // (the real close event and other requests arrive as I/O), and by then
    // the transmitter must still be parked, not have drained its backlog.
    socket.beginClose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toBe(sentBeforeClosing);
    expect(socket.droppedAfterClose).toHaveLength(0);

    socket.close();
    await transmitter;
    expect(sent).toBeLessThanOrEqual(sentBeforeClosing + 1);
  });

  test("a synchronous send failure rejects only that send", async () => {
    const socket = new FakeSocket();
    const ws = createFlowControlledWebSocket(socket);

    // Immediate path.
    socket.throwOnNextSend = true;
    let immediateError: unknown;
    await ws.send("boom").catch((error: unknown) => {
      immediateError = error;
    });
    expect(immediateError).toBeInstanceOf(Error);
    await ws.send("after");

    // Queued path: the failure must not stall frames queued behind it.
    void ws.send(frame("big", WS_FLOW_CONTROL_HIGH_WATER_BYTES + 1));
    const failing = track(ws.send("queued-boom"));
    const next = track(ws.send("queued-ok"));
    socket.throwOnNextSend = true;
    socket.flushOne(); // "after"
    socket.flushOne(); // "big"
    await settle();

    expect(failing).toEqual({ settled: true, rejected: true });
    expect(next).toEqual({ settled: true, rejected: false });
    expect(labels(socket.written)).toEqual(["after", "big", "queued-ok"]);
  });
});
