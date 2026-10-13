import { finished, type Readable } from "node:stream";
import assert from "@/common/utils/assert";

/**
 * `Readable.toWeb` for a byte stream that ignores the source's late `data` events.
 *
 * Why not `Readable.toWeb`: on Bun 1.4.3 its adapter can still get a `data` event from a child's
 * pipe after the web stream was cancelled or closed. Its listener then calls `enqueue` on a closed
 * controller and throws "Invalid state: Controller is already closed" outside any caller: an
 * uncaught exception. The bash tool hits it when it cancels its readers on output overflow, and the
 * CLI (terminal-bench runs it on Bun) exits on an uncaught exception. Bun 1.3.12 and Node do not.
 *
 * Everything else follows Node's adapter (lib/internal/webstreams/adapters.js,
 * newReadableStreamFromStreamReadable), so Node behavior does not change: pull resumes the source,
 * the queue is byte-sized at the source's highWaterMark, each chunk is copied out of the pool,
 * cancel destroys the source, and the source's end or error settles the web stream (a premature
 * close as an AbortError).
 */
export function nodeReadableToWeb(source: Readable): ReadableStream<Uint8Array> {
  assert(
    !source.readableObjectMode && source.readableEncoding == null,
    "nodeReadableToWeb adapts Buffer streams only"
  );
  // Set by cancel or by the source's end/error: the controller then refuses enqueue.
  let settled = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        source.resume();
      },
      cancel(reason: unknown) {
        settled = true;
        source.destroy(reason instanceof Error ? reason : undefined);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: source.readableHighWaterMark })
  );
  assert(controller, "ReadableStream calls start synchronously");
  const ctrl = controller;

  finished(source, { writable: false }, (error) => {
    if (settled) return;
    settled = true;
    if (error == null) {
      ctrl.close();
      return;
    }
    // Node's adapter reports a premature close as an AbortError (handleKnownInternalErrors).
    ctrl.error(
      error.code === "ERR_STREAM_PREMATURE_CLOSE"
        ? Object.assign(new Error("The operation was aborted", { cause: error }), {
            name: "AbortError",
            code: "ABORT_ERR",
          })
        : error
    );
  });

  source.pause();
  source.on("data", (chunk: Buffer) => {
    if (settled) return;
    // Copy the Buffer to detach it from the pool, like Node's adapter.
    ctrl.enqueue(new Uint8Array(chunk));
    if ((ctrl.desiredSize ?? 0) <= 0) source.pause();
  });
  return stream;
}
