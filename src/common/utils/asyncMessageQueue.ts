/**
 * Creates a queue-based async message stream.
 *
 * Messages pushed to the queue are yielded in batches (all queued messages
 * at once without async boundaries). This prevents premature React renders
 * when loading many messages quickly (e.g., history replay).
 *
 * Usage:
 * ```ts
 * const { push, iterate, end } = createAsyncMessageQueue<MyMessage>();
 *
 * // Push messages from any source
 * eventEmitter.on('message', push);
 *
 * // Consume as async generator
 * for await (const msg of iterate()) {
 *   handleMessage(msg);
 * }
 *
 * // Clean up
 * end();
 * ```
 */
export function createAsyncMessageQueue<T>(): {
  push: (msg: T) => void;
  iterate: () => AsyncGenerator<T>;
  end: () => void;
} {
  const queue: T[] = [];
  let resolveNext: (() => void) | null = null;
  let ended = false;

  const push = (msg: T) => {
    if (ended) return;
    queue.push(msg);
    // Signal that new messages are available
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve();
    }
  };

  async function* iterate(): AsyncGenerator<T> {
    while (!ended) {
      // Yield all queued messages synchronously (no async boundaries)
      // This ensures all messages from a batch are processed in the same
      // event loop tick, preventing premature renders
      while (queue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        yield queue.shift()!;
      }
      // Wait for more messages
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
    // Yield any remaining messages after end() is called
    while (queue.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      yield queue.shift()!;
    }
  }

  const end = () => {
    ended = true;
    // Wake up the iterator so it can exit
    if (resolveNext) {
      resolveNext();
    }
  };

  return { push, iterate, end };
}
