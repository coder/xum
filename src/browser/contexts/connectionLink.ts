import type { ClientContext, ClientLink, ClientOptions } from "@orpc/client";
import { isAsyncIteratorObject } from "@orpc/shared";

const CONNECTION_LOST_CODE = "XUM_CONNECTION_LOST";

/**
 * The connection to the Xum server was lost: the call or stream ran on a socket that closed, or
 * no socket was attached when it started.
 *
 * Named "AbortError" on purpose. It replaces exactly the AbortError that the WebSocket transport
 * raises when its socket closes, and every catch site that treats that one as "stop quietly"
 * keeps that behavior. Use isConnectionLostError() to tell it apart from a caller abort or a
 * server-side cancel, which carry the same name.
 */
export class ConnectionLostError extends Error {
  override readonly name = "AbortError" as const;
  readonly code = CONNECTION_LOST_CODE;

  constructor(options?: { cause?: unknown }) {
    super("Not connected to the Xum server. Reconnecting…", options);
  }
}

export function isConnectionLostError(error: unknown): error is ConnectionLostError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === CONNECTION_LOST_CODE &&
    error.name === "AbortError"
  );
}

type Link = ClientLink<ClientContext>;

/** A stream that detach() can end at once, even while its consumer waits on next(). */
interface LiveIterator {
  end(): void;
}

/** One attached inner link: the calls and streams that started on it. */
interface Generation {
  readonly id: number;
  readonly inner: Link;
  detached: boolean;
  readonly pending: Set<(error: ConnectionLostError) => void>;
  readonly iterators: Set<LiveIterator>;
}

/**
 * A ClientLink that forwards each call to the inner link (one per socket) attached now.
 *
 * The provider owns one ConnectionLink and attaches a new inner link on each successful connect.
 * Clients built on it (`createClient(link)`) resolve the link at call time, so a client held in a
 * closure keeps working after a reconnect instead of calling into a closed socket, where a new
 * call never settles.
 *
 * Rules:
 * - A call made while nothing is attached rejects at once with ConnectionLostError. Calls are
 *   never queued: a queued write would run later with outdated intent.
 * - A rejection becomes ConnectionLostError only when the call's own generation was detached and
 *   the caller did not abort. A server cancel on an open socket has the same AbortError name, so
 *   the error name alone cannot tell the two apart.
 * - detach() rejects the generation's pending calls and ends its streams itself. A late or
 *   missing socket `close` event (a forced reconnect, a MessagePort) cannot leave work hanging.
 *   A result that arrives after detach() is dropped: its caller already got the error.
 */
export class ConnectionLink implements Link {
  private current: Generation | null = null;
  private nextId = 1;

  get isAttached(): boolean {
    return this.current != null;
  }

  /** Attach a connected inner link. Returns the new generation number. */
  attach(inner: Link): number {
    if (this.current != null) {
      throw new Error("ConnectionLink.attach: a link is already attached; detach it first");
    }
    const generation: Generation = {
      id: this.nextId++,
      inner,
      detached: false,
      pending: new Set(),
      iterators: new Set(),
    };
    this.current = generation;
    return generation.id;
  }

  /** Synchronous and idempotent. */
  detach(): void {
    const generation = this.current;
    if (generation == null) return;
    this.current = null;
    generation.detached = true;
    const lost = new ConnectionLostError();
    for (const reject of generation.pending) reject(lost);
    generation.pending.clear();
    for (const iterator of generation.iterators) iterator.end();
    generation.iterators.clear();
  }

  call(path: string[], input: unknown, options: ClientOptions<ClientContext>): Promise<unknown> {
    if (path.length === 0) {
      throw new Error("ConnectionLink.call: empty procedure path");
    }
    const signal = options.signal;
    // The caller's abort always wins, as with a direct link.
    if (signal?.aborted) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the caller's own reason, unchanged
      return Promise.reject(signal.reason);
    }
    const generation = this.current;
    if (generation == null) {
      return Promise.reject(new ConnectionLostError());
    }
    return settleUnlessLost(generation.inner.call(path, input, options), {
      waiters: generation.pending,
      mapValue: (output) =>
        isAsyncIteratorObject(output) ? new GenerationIterator(output, generation, signal) : output,
      mapError: (error) => toLinkError(error, generation, signal),
      // detach() already rejected the caller. A stream that opened late must not leak.
      dropLateValue: closeIfStream,
    });
  }
}

/** A rejection from a detached generation, unless the caller aborted, means the connection is gone. */
function toLinkError(error: unknown, generation: Generation, signal: AbortSignal | undefined) {
  return generation.detached && !signal?.aborted
    ? new ConnectionLostError({ cause: error })
    : error;
}

function closeIfStream(value: unknown): void {
  if (isAsyncIteratorObject(value)) void returnQuietly(value);
}

/** The inner stream may already be closed: returning it is best effort. */
async function returnQuietly(
  stream: AsyncIteratorObject<unknown, unknown, unknown>,
  value?: unknown
) {
  try {
    await stream.return?.(value);
  } catch {
    // Nothing to do: the stream is gone either way.
  }
}

/**
 * Settles with `work`, unless a connection loss is reported first through `waiters` (detach()
 * calls every waiter). Used for one-shot calls and for each next() of a stream: in both, the
 * caller must get ConnectionLostError at once, even when the inner link never settles.
 */
function settleUnlessLost<T, R>(
  work: Promise<T>,
  hooks: {
    waiters: Set<(error: ConnectionLostError) => void>;
    mapValue: (value: T) => R;
    mapError: (error: unknown) => unknown;
    dropLateValue?: (value: T) => void;
  }
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let settled = false;
    const lose = (error: ConnectionLostError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    hooks.waiters.add(lose);
    work.then(
      (value) => {
        hooks.waiters.delete(lose);
        if (settled) {
          hooks.dropLateValue?.(value);
          return;
        }
        settled = true;
        resolve(hooks.mapValue(value));
      },
      (error: unknown) => {
        hooks.waiters.delete(lose);
        if (settled) return;
        settled = true;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the inner error, or ConnectionLostError
        reject(hooks.mapError(error));
      }
    );
  });
}

/**
 * A stream of one generation. Values pass through unchanged, so oRPC event meta (attached to the
 * value objects) is kept. Once the generation is detached, a waiting next() rejects with
 * ConnectionLostError at once, every later next() does too, and the inner stream is returned.
 */
class GenerationIterator implements AsyncIteratorObject<unknown, unknown, unknown>, LiveIterator {
  private finished = false;
  private readonly waiting = new Set<(error: ConnectionLostError) => void>();

  constructor(
    private readonly inner: AsyncIteratorObject<unknown, unknown, unknown>,
    private readonly generation: Generation,
    private readonly signal: AbortSignal | undefined
  ) {
    generation.iterators.add(this);
  }

  /** Called by detach(). */
  end(): void {
    if (this.finished) return;
    this.finish();
    const lost = new ConnectionLostError();
    for (const lose of this.waiting) lose(lost);
    this.waiting.clear();
    void returnQuietly(this.inner);
  }

  next(): Promise<IteratorResult<unknown, unknown>> {
    if (this.generation.detached) return Promise.reject(new ConnectionLostError());
    if (this.finished) return Promise.resolve({ done: true, value: undefined });
    return settleUnlessLost(this.inner.next(), {
      waiters: this.waiting,
      mapValue: (result) => {
        if (result.done) this.finish();
        return result;
      },
      mapError: (error) => {
        this.finish();
        return toLinkError(error, this.generation, this.signal);
      },
    });
  }

  async return(value?: unknown): Promise<IteratorResult<unknown, unknown>> {
    const wasFinished = this.finished;
    this.finish();
    if (!wasFinished) await returnQuietly(this.inner, value);
    return { done: true, value };
  }

  async throw(error?: unknown): Promise<IteratorResult<unknown, unknown>> {
    this.finish();
    if (this.inner.throw != null) return this.inner.throw(error);
    throw error;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.return();
  }

  private finish(): void {
    this.finished = true;
    this.generation.iterators.delete(this);
  }
}
