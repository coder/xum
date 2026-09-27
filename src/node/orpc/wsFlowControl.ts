/**
 * Bounded send-side flow control for the oRPC WebSocket transport.
 *
 * Why: oRPC's websocket adapter does `await ws.send(encoded)` for every
 * outgoing frame, but the `ws` library's `send()` returns immediately and
 * buffers in userland. A large subscription replay (one frame per chat row)
 * therefore landed entirely in the socket's send buffer (~500 MB at 1.24M
 * rows). Every other frame on the connection queued behind that backlog:
 * subscription heartbeats reached the browser tens of seconds late (tripping
 * the renderer's stall watchdog), and the keepalive pong could not come back
 * in time, so the server terminated the socket and the client reconnected
 * into another full replay (#4655).
 *
 * This wrapper makes `send()` return a promise that only settles once the
 * frame has been handed to the socket under a bounded window. oRPC's
 * per-subscription transmitter awaits each send, so a flooding subscription
 * pauses instead of pushing its whole replay into the socket.
 *
 * The module is self-contained so other transports that host the oRPC
 * websocket handler (e.g. desktop "connect to running server") can reuse it:
 * pass the wrapper to `handler.upgrade()` and keep using the raw socket for
 * everything else (ping/pong keepalive, terminate).
 */
import type { WebSocketLike } from "@orpc/server/websocket";
import { assert } from "@/common/utils/assert";

/**
 * Window sizes. Measured browser drain is ~1.7-4 MB/s, so one 1 MiB window
 * delays a heartbeat, an RPC response, or the keepalive pong by < 1 s instead
 * of tens of seconds. Sends are awaited, so the transport holds at most one
 * window plus one queued frame per active sender. The low-water mark adds
 * hysteresis so a draining socket is refilled in batches, not frame by frame.
 *
 * Note: this bounds the socket and the transport, not the whole server heap.
 * A producer that pushes into an unbounded subscription queue (the onChat
 * replay) still holds its not-yet-sent values in that queue; bounding the
 * producer is a separate change.
 */
export const WS_FLOW_CONTROL_HIGH_WATER_BYTES = 1024 * 1024;
export const WS_FLOW_CONTROL_LOW_WATER_BYTES = 256 * 1024;

/** `readyState` of an open socket (WHATWG WebSocket and `ws` share the value). */
const WS_READY_STATE_OPEN = 1;

type FlowControlledFrame = Parameters<WebSocketLike["send"]>[0];

/**
 * The subset of a `ws` WebSocket the wrapper needs. Typed structurally so the
 * listener methods stay exactly what oRPC's `upgrade()` expects.
 */
export interface FlowControlSocket extends Pick<
  WebSocket,
  "addEventListener" | "removeEventListener"
> {
  /** Bytes accepted by `send()` but not yet written to the OS socket. */
  readonly bufferedAmount: number;
  /** Anything but OPEN means `send()` drops frames and fails their callbacks. */
  readonly readyState: number;
  /** `cb` fires once the frame is written (or with an error if it never will be). */
  send(data: FlowControlledFrame, cb: (err?: Error) => void): void;
}

export interface FlowControlledWebSocket extends Pick<
  WebSocket,
  "addEventListener" | "removeEventListener"
> {
  /** Resolves once the frame is handed to the socket (or dropped because it closed). */
  send(data: FlowControlledFrame): Promise<void>;
}

interface QueuedFrame {
  data: FlowControlledFrame;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Wrap one connection's socket. Create exactly one wrapper per connection and
 * pass that same instance to `upgrade()`: oRPC keys its peer state by the
 * object it receives.
 */
export function createFlowControlledWebSocket(ws: FlowControlSocket): FlowControlledWebSocket {
  const queue: QueuedFrame[] = [];
  let blocked = false;
  let closed = false;
  // Frames handed to ws.send whose write callback has not fired yet. Each
  // callback is the wake-up signal to re-check the window and pump the queue.
  let pendingWrites = 0;
  // A write callback reported an error: the socket is failing and its "close"
  // event follows, so writing more would only produce more failures.
  let writeFailed = false;

  const canWrite = (): boolean => {
    // Closing (or failing) sockets drop frames and fail each callback on the
    // next tick. Writing there would let senders drain their whole backlog
    // (e.g. a 1M-row replay) through nextTicks and microtasks, starving the
    // event loop so "close" (and every other request) waits until the backlog
    // is gone (#4655 UAT: 18-63 s server freeze on reload). Park senders
    // instead; the "close" listener below settles them, and ws guarantees
    // "close" follows a closing handshake or a failed socket.
    if (writeFailed || ws.readyState !== WS_READY_STATE_OPEN) {
      return false;
    }
    if (pendingWrites === 0) {
      // No write callback is left to wake us, so waiting could hang forever.
      // Whatever is still buffered is not ours (e.g. keepalive control
      // frames), so it cannot grow the backlog meaningfully.
      blocked = false;
      return true;
    }
    if (blocked) {
      blocked = ws.bufferedAmount >= WS_FLOW_CONTROL_LOW_WATER_BYTES;
    } else {
      blocked = ws.bufferedAmount > WS_FLOW_CONTROL_HIGH_WATER_BYTES;
    }
    return !blocked;
  };

  const onWritten = (err?: Error): void => {
    pendingWrites--;
    if (err != null) writeFailed = true;
    pump();
  };

  const write = (data: FlowControlledFrame): void => {
    pendingWrites++;
    try {
      ws.send(data, onWritten);
    } catch (error) {
      // A synchronous throw means ws.send never scheduled the callback.
      pendingWrites--;
      throw error;
    }
  };

  const pump = (): void => {
    // FIFO: stop at the first frame that does not fit so later frames can
    // never overtake earlier ones.
    while (!closed && queue.length > 0 && canWrite()) {
      const frame = queue.shift();
      assert(frame != null, "queue.length > 0 guarantees a frame");
      try {
        write(frame.data);
        frame.resolve();
      } catch (error) {
        frame.reject(error);
      }
    }
  };

  ws.addEventListener("close", () => {
    closed = true;
    // Queued frames are never written after close. Settle them as no-ops,
    // matching ws.send after close (which does not throw), so no sender hangs.
    // Their continuations run as microtasks after every "close" listener,
    // including oRPC's, which marks its transmitters done first; they then
    // stop instead of pulling the rest of their backlog.
    for (const frame of queue.splice(0)) {
      frame.resolve();
    }
  });

  return {
    addEventListener: ws.addEventListener.bind(ws),
    removeEventListener: ws.removeEventListener.bind(ws),
    // async so a synchronous ws.send throw becomes this send's rejection.
    async send(data) {
      // Queue behind earlier frames (ordering) or while the window is full.
      // After close, frames pass straight to ws.send, which drops them.
      if (!closed && (queue.length > 0 || !canWrite())) {
        return new Promise<void>((resolve, reject) => {
          queue.push({ data, resolve, reject });
        });
      }
      if (closed) {
        ws.send(data, () => undefined);
      } else {
        write(data);
      }
    },
  };
}
