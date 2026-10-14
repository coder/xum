import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { nodeReadableToWeb } from "./nodeReadableToWeb";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += Buffer.from(value).toString();
  }
}

describe("nodeReadableToWeb", () => {
  test("delivers every byte, then closes when the source ends", async () => {
    const source = new PassThrough();
    const web = nodeReadableToWeb(source);
    source.write("hello ");
    source.end("world");
    expect(await readAll(web)).toBe("hello world");
  });

  // The Bun 1.4.3 race: a source `data` event after cancel. Readable.toWeb enqueues it on the
  // closed controller and throws from the emitter, on every runtime.
  test("cancel destroys the source and drops its late data without throwing", async () => {
    const source = new PassThrough();
    const reader = nodeReadableToWeb(source).getReader();
    source.write("first");
    expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("first");
    await reader.cancel();
    expect(source.destroyed).toBe(true);
    expect(() => source.emit("data", Buffer.from("late"))).not.toThrow();
  });

  test("drops data that arrives after the source ended", async () => {
    const source = new PassThrough();
    const web = nodeReadableToWeb(source);
    source.end("done");
    expect(await readAll(web)).toBe("done");
    expect(() => source.emit("data", Buffer.from("late"))).not.toThrow();
  });

  test("errors the web stream with the source's error, and a premature close as an AbortError", async () => {
    const failing = new PassThrough();
    const failed = readAll(nodeReadableToWeb(failing));
    failing.destroy(new Error("pipe broke"));
    expect(await failed.catch((error: unknown) => error)).toMatchObject({ message: "pipe broke" });

    const closed = new PassThrough();
    const aborted = readAll(nodeReadableToWeb(closed));
    closed.destroy();
    expect(await aborted.catch((error: unknown) => error)).toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
    });
  });

  test("pauses the source while the web queue is full", async () => {
    const source = new PassThrough({ highWaterMark: 4 });
    const reader = nodeReadableToWeb(source).getReader();
    source.write("abcdefgh");
    // The first read pulls; the 8-byte chunk fills the 4-byte queue, so the source pauses.
    await reader.read();
    source.write("ijklmnop");
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.isPaused()).toBe(true);
    await reader.cancel();
  });
});
