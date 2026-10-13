import { describe, expect, test } from "bun:test";
import type { ClientContext, ClientLink, ClientOptions } from "@orpc/client";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { isAbortError } from "@/browser/utils/isAbortError";
import { ConnectionLink, isConnectionLostError } from "./connectionLink";

type Link = ClientLink<ClientContext>;
const NO_OPTIONS: ClientOptions<ClientContext> = { context: {} };

/** An inner link whose calls the test settles by hand. */
function controlledLink() {
  const calls: Array<{
    path: string[];
    input: unknown;
    signal: AbortSignal | undefined;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  const link: Link = {
    call: (path, input, options) =>
      new Promise((resolve, reject) => {
        calls.push({ path, input, signal: options.signal, resolve, reject });
      }),
  };
  return { link, calls };
}

/** A stream the test feeds by hand; records return(). */
function controlledStream() {
  const pulls: Array<{
    resolve: (r: IteratorResult<unknown>) => void;
    reject: (e: unknown) => void;
  }> = [];
  let returned = 0;
  const stream = {
    next: () =>
      new Promise<IteratorResult<unknown>>((resolve, reject) => {
        pulls.push({ resolve, reject });
      }),
    return: (value?: unknown) => {
      returned += 1;
      return Promise.resolve({ done: true as const, value });
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return { stream, pulls, returned: () => returned };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function settleState(promise: Promise<unknown>) {
  const state: { status: "pending" | "resolved" | "rejected"; value?: unknown } = {
    status: "pending",
  };
  promise.then(
    (value) => Object.assign(state, { status: "resolved", value }),
    (value: unknown) => Object.assign(state, { status: "rejected", value })
  );
  return state;
}

describe("ConnectionLink", () => {
  test("forwards calls to the attached link, and to the next one after a reconnect", async () => {
    const link = new ConnectionLink();
    const first = controlledLink();
    link.attach(first.link);
    const a = link.call(["general", "ping"], "one", NO_OPTIONS);
    expect(first.calls[0]?.path).toEqual(["general", "ping"]);
    first.calls[0]?.resolve("pong-1");
    expect(await a).toBe("pong-1");

    link.detach();
    const second = controlledLink();
    link.attach(second.link);
    const b = link.call(["general", "ping"], "two", NO_OPTIONS);
    expect(first.calls).toHaveLength(1);
    expect(second.calls[0]?.input).toBe("two");
    second.calls[0]?.resolve("pong-2");
    expect(await b).toBe("pong-2");
  });

  test("a call while nothing is attached rejects at once with ConnectionLostError", async () => {
    const link = new ConnectionLink();
    const error = await link
      .call(["general", "ping"], undefined, NO_OPTIONS)
      .catch((e: unknown) => e);
    expect(isConnectionLostError(error)).toBe(true);
    // Existing catch sites treat it like today's socket-close abort.
    expect(isAbortError(error)).toBe(true);
    expect(isConnectionLostError(new DOMException("aborted", "AbortError"))).toBe(false);
  });

  test("detach() rejects pending calls even while the inner link never settles", async () => {
    const link = new ConnectionLink();
    const inner = controlledLink();
    link.attach(inner.link);
    const state = settleState(link.call(["workspace", "list"], undefined, NO_OPTIONS));
    link.detach();
    await flush();
    expect(state.status).toBe("rejected");
    expect(isConnectionLostError(state.value)).toBe(true);

    // A result that arrives later is dropped: the caller already has its answer.
    inner.calls[0]?.resolve("late");
    await flush();
    expect(state.status).toBe("rejected");
  });

  test("a server cancel on an attached link passes through unchanged", async () => {
    const link = new ConnectionLink();
    const inner = controlledLink();
    link.attach(inner.link);
    const pending = link
      .call(["terminal", "onExit"], undefined, NO_OPTIONS)
      .catch((e: unknown) => e);
    const cancel = Object.assign(new Error("Server canceled the request"), { name: "AbortError" });
    inner.calls[0]?.reject(cancel);
    const error: unknown = await pending;
    expect(error).toBe(cancel);
    expect(isConnectionLostError(error)).toBe(false);
  });

  test("the caller's abort wins", async () => {
    const link = new ConnectionLink();
    link.attach(controlledLink().link);
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const error = await link
      .call(["general", "ping"], undefined, { context: {}, signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(isConnectionLostError(error)).toBe(false);
  });

  test("detach() aborts the inner call, so it settles without a close event", async () => {
    const link = new ConnectionLink();
    const inner = controlledLink();
    link.attach(inner.link);
    const pending = link.call(["workspace", "list"], undefined, NO_OPTIONS).catch(() => undefined);
    const innerSignal = inner.calls[0]?.signal;
    expect(innerSignal?.aborted).toBe(false);
    link.detach();
    await pending;
    expect(innerSignal?.aborted).toBe(true);
    expect(isConnectionLostError(innerSignal?.reason)).toBe(true);
  });

  test("a caller abort in the same task as detach() keeps the caller's reason", async () => {
    const link = new ConnectionLink();
    link.attach(controlledLink().link);
    const controller = new AbortController();
    const pending = link
      .call(["general", "ping"], undefined, { context: {}, signal: controller.signal })
      .catch((e: unknown) => e);
    const reason = new DOMException("user cancelled", "AbortError");
    controller.abort(reason);
    link.detach();
    const error: unknown = await pending;
    expect(error).toBe(reason);
    expect(isConnectionLostError(error)).toBe(false);
  });

  test("a late detach for an old generation leaves the new one attached", async () => {
    const link = new ConnectionLink();
    const oldId = link.attach(controlledLink().link);
    link.detach(oldId);
    const next = controlledLink();
    link.attach(next.link);
    // The old socket's close event arrives after the forced reconnect.
    link.detach(oldId);
    expect(link.isAttached).toBe(true);
    const pending = link.call(["general", "ping"], undefined, NO_OPTIONS);
    next.calls[0]?.resolve("pong");
    expect(await pending).toBe("pong");
  });

  test("attach() twice is a programmer error", () => {
    const link = new ConnectionLink();
    link.attach(controlledLink().link);
    expect(() => link.attach(controlledLink().link)).toThrow(/already attached/);
    link.detach();
    link.detach(); // idempotent
    expect(link.isAttached).toBe(false);
  });

  describe("streams", () => {
    async function openStream() {
      const link = new ConnectionLink();
      const inner = controlledLink();
      link.attach(inner.link);
      const source = controlledStream();
      const opened = link.call(["terminal", "attach"], undefined, NO_OPTIONS);
      inner.calls[0]?.resolve(source.stream);
      const iterator = (await opened) as AsyncIterableIterator<unknown> &
        AsyncIteratorObject<unknown>;
      return { link, source, iterator };
    }

    test("values pass through as the same objects, so event meta is kept", async () => {
      const { source, iterator } = await openStream();
      const event = { type: "screenState", data: "x" };
      const next = iterator.next();
      source.pulls[0]?.resolve({ done: false, value: event });
      expect((await next).value).toBe(event);
    });

    test("detach() rejects a waiting next() and every later one, and returns the stream", async () => {
      const { link, source, iterator } = await openStream();
      const waiting = settleState(iterator.next());
      link.detach();
      await flush();
      expect(waiting.status).toBe("rejected");
      expect(isConnectionLostError(waiting.value)).toBe(true);
      expect(source.returned()).toBe(1);

      const later: unknown = await iterator.next().catch((e: unknown) => e);
      expect(isConnectionLostError(later)).toBe(true);
      // An event from the old socket after the detach is not delivered.
      source.pulls[0]?.resolve({ done: false, value: "stale" });
      await flush();
      expect(waiting.status).toBe("rejected");
    });

    test("a for-await loop ends with ConnectionLostError on detach", async () => {
      const { link, source, iterator } = await openStream();
      const seen: unknown[] = [];
      const loop = (async () => {
        for await (const value of iterator) seen.push(value);
      })().catch((e: unknown) => e);
      await flush();
      source.pulls[0]?.resolve({ done: false, value: 1 });
      await flush();
      link.detach();
      expect(isConnectionLostError(await loop)).toBe(true);
      expect(seen).toEqual([1]);
    });

    test("a completed stream stays done after a later detach", async () => {
      const { link, source, iterator } = await openStream();
      const last = iterator.next();
      source.pulls[0]?.resolve({ done: true, value: undefined });
      expect((await last).done).toBe(true);
      link.detach();
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    });

    test("a pull after a caller abort and a detach keeps the caller's reason", async () => {
      const link = new ConnectionLink();
      const inner = controlledLink();
      link.attach(inner.link);
      const controller = new AbortController();
      const opened = link.call(["terminal", "attach"], undefined, {
        context: {},
        signal: controller.signal,
      });
      inner.calls[0]?.resolve(controlledStream().stream);
      const iterator = (await opened) as AsyncIteratorObject<unknown>;
      const reason = new DOMException("user closed the view", "AbortError");
      controller.abort(reason);
      link.detach();
      expect(await iterator.next().catch((e: unknown) => e)).toBe(reason);
    });

    test("return() reaches the inner stream once", async () => {
      const { source, iterator } = await openStream();
      await iterator.return?.();
      await iterator.return?.();
      expect(source.returned()).toBe(1);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    });

    // The missing-close case: the inner stream's own cleanup never settles.
    async function openHangingStream() {
      const link = new ConnectionLink();
      const inner = controlledLink();
      link.attach(inner.link);
      const hang = () => new Promise<IteratorResult<unknown>>(() => undefined);
      const stream = {
        next: hang,
        return: hang,
        throw: hang,
        [Symbol.asyncIterator]() {
          return stream;
        },
      };
      const opened = link.call(["terminal", "attach"], undefined, NO_OPTIONS);
      inner.calls[0]?.resolve(stream);
      return { link, iterator: (await opened) as AsyncIteratorObject<unknown> };
    }

    test("detach() settles a return() whose inner cleanup hangs", async () => {
      const { link, iterator } = await openHangingStream();
      const returned = settleState(iterator.return!());
      await flush();
      expect(returned.status).toBe("pending");
      link.detach();
      await flush();
      expect(returned).toEqual({ status: "resolved", value: { done: true, value: undefined } });
    });

    test("detach() settles a throw() whose inner cleanup hangs", async () => {
      const { link, iterator } = await openHangingStream();
      const thrown = settleState(iterator.throw!(new Error("consumer failed")));
      await flush();
      expect(thrown.status).toBe("pending");
      link.detach();
      await flush();
      expect(thrown.status).toBe("rejected");
      expect(isConnectionLostError(thrown.value)).toBe(true);
    });

    test("a stream that opens after detach() is returned, not leaked", async () => {
      const link = new ConnectionLink();
      const inner = controlledLink();
      link.attach(inner.link);
      const opened = settleState(link.call(["terminal", "attach"], undefined, NO_OPTIONS));
      link.detach();
      const source = controlledStream();
      inner.calls[0]?.resolve(source.stream);
      await flush();
      expect(opened.status).toBe("rejected");
      expect(source.returned()).toBe(1);
    });
  });
});

/** Just enough of a browser WebSocket for oRPC's WebSocket link. */
class FakeSocket {
  readyState = 1; // OPEN
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(data);
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(check()).toBe(true);
}

// Pins the oRPC transport facts the link relies on. An oRPC upgrade that changes them fails here.
describe("ConnectionLink over the real oRPC WebSocket link", () => {
  function connect() {
    const socket = new FakeSocket();
    const inner = new WebSocketLink({ connect: () => socket as unknown as WebSocket });
    const link = new ConnectionLink();
    link.attach(inner);
    return { socket, link };
  }

  test("the transport rejects a call with an AbortError when its socket closes", async () => {
    const { socket, link } = connect();
    const pending = link.call(["general", "ping"], "x", NO_OPTIONS).catch((e: unknown) => e);
    await waitFor(() => socket.sent.length > 0);
    socket.emit("close", { code: 1006, reason: "" });
    const error: unknown = await pending;
    // Without a detach the generation is live, so the transport's error passes through.
    expect(isAbortError(error)).toBe(true);
    expect(isConnectionLostError(error)).toBe(false);
  });

  test("detach() first, as the provider's close listener does, gives ConnectionLostError", async () => {
    const { socket, link } = connect();
    const pending = link.call(["general", "ping"], "x", NO_OPTIONS).catch((e: unknown) => e);
    await waitFor(() => socket.sent.length > 0);
    link.detach();
    socket.emit("close", { code: 1006, reason: "" });
    expect(isConnectionLostError(await pending)).toBe(true);
  });

  test("a server cancel on the open socket stays a plain abort", async () => {
    const { socket, link } = connect();
    const pending = link.call(["general", "ping"], "x", NO_OPTIONS).catch((e: unknown) => e);
    await waitFor(() => socket.sent.length > 0);
    const { id } = JSON.parse(socket.sent[0] ?? "{}") as { id: unknown };
    socket.emit("message", { data: JSON.stringify({ id, kind: "cancel" }) });
    const error: unknown = await pending;
    expect(isAbortError(error)).toBe(true);
    expect(isConnectionLostError(error)).toBe(false);
    expect((error as Error).message).toBe("Server canceled the request");
  });
});
