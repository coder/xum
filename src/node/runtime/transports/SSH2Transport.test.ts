import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough, Readable } from "stream";
import { isRuntimeTransportError } from "../Runtime";
import { ssh2ConnectionPool } from "../SSH2ConnectionPool";
import { SSH2Transport } from "./SSH2Transport";

class FakeClientChannel extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr?: PassThrough;
  destroyed = false;
  writableEnded = false;

  constructor(options?: { includeStderr?: boolean }) {
    super();
    if (options?.includeStderr) {
      this.stderr = new PassThrough();
    }
  }

  pipe<T extends NodeJS.WritableStream>(destination: T): T {
    this.stdout.pipe(destination);
    return destination;
  }

  write(_chunk: string | Buffer | Uint8Array): boolean {
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }

  close(): void {
    this.destroyed = true;
    this.writableEnded = true;
    this.stdout.end();
    this.stderr?.end();
  }

  signal(_signal: string): void {
    // No-op for tests.
  }

  emitStderr(text: string): void {
    this.stderr?.write(text);
  }

  finish(exitCode = 0): void {
    this.emit("exit", exitCode, null);
    this.close();
    this.emit("close", exitCode, null);
  }
}

function createFakeClient(channel: FakeClientChannel) {
  return Object.assign(new EventEmitter(), {
    exec(
      _command: string,
      optionsOrCallback:
        | ((err?: Error, stream?: FakeClientChannel) => void)
        | { pty: { term: string } },
      maybeCallback?: (err?: Error, stream?: FakeClientChannel) => void
    ) {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      callback?.(undefined, channel);
    },
  });
}

function rejectAfter(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
}

function toWebUint8Reader(stream: NodeJS.ReadableStream): ReadableStreamDefaultReader<Uint8Array> {
  return (Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>).getReader();
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const reader = toWebUint8Reader(stream);
  const decoder = new TextDecoder();
  let output = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        output += decoder.decode();
        return output;
      }
      output += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

describe("SSH2Transport.spawnRemoteProcess", () => {
  let acquireConnectionSpy: ReturnType<
    typeof spyOn<typeof ssh2ConnectionPool, "acquireConnection">
  >;

  beforeEach(() => {
    acquireConnectionSpy = spyOn(ssh2ConnectionPool, "acquireConnection");
  });

  afterEach(() => {
    acquireConnectionSpy.mockRestore();
  });

  test("aborts while waiting for ssh2 exec channel", async () => {
    acquireConnectionSpy.mockResolvedValue({
      client: Object.assign(new EventEmitter(), {
        exec() {
          // Simulate ssh2 never invoking the exec callback.
        },
      }),
      openChannels: 0,
    } as never);

    const reportFailureSpy = spyOn(ssh2ConnectionPool, "reportFailure");
    const transport = new SSH2Transport({ host: "remote.example.com" });
    const abortController = new AbortController();
    const spawnPromise = transport.spawnRemoteProcess("echo ok", {
      abortSignal: abortController.signal,
    });

    abortController.abort();

    try {
      await spawnPromise;
      throw new Error("Expected spawnRemoteProcess to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Operation aborted");
      expect(isRuntimeTransportError(error)).toBe(false);
    }
    expect(reportFailureSpy).not.toHaveBeenCalled();
    reportFailureSpy.mockRestore();
  });

  test("an abort while acquiring the connection is not a transport failure", async () => {
    // e.g. the user presses Stop while the pool waits out a backoff (#4835).
    const controller = new AbortController();
    acquireConnectionSpy.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("Operation aborted"));
    });
    const transport = new SSH2Transport({ host: "remote.example.com" });
    const aborted: unknown = await transport
      .spawnRemoteProcess("echo ok", { abortSignal: controller.signal })
      .catch((e: unknown) => e);
    expect(aborted).toBeInstanceOf(Error);
    expect(isRuntimeTransportError(aborted)).toBe(false);

    acquireConnectionSpy.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const refused: unknown = await transport
      .spawnRemoteProcess("echo ok", {})
      .catch((e: unknown) => e);
    expect(isRuntimeTransportError(refused)).toBe(true);
  });

  test("forcePTY closes the synthetic stderr stream when ssh2 omits channel.stderr", async () => {
    const channel = new FakeClientChannel();
    acquireConnectionSpy.mockResolvedValue({
      client: createFakeClient(channel),
      openChannels: 0,
    } as never);

    const transport = new SSH2Transport({ host: "remote.example.com" });
    const { process } = await transport.spawnRemoteProcess("echo ok", { forcePTY: true });

    const firstRead = await Promise.race([
      toWebUint8Reader(process.stderr!).read(),
      rejectAfter(500),
    ]);

    expect(firstRead.done).toBe(true);
  });

  test("preserves stderr output when ssh2 provides a dedicated stderr stream", async () => {
    const channel = new FakeClientChannel({ includeStderr: true });
    acquireConnectionSpy.mockResolvedValue({
      client: createFakeClient(channel),
      openChannels: 0,
    } as never);

    const transport = new SSH2Transport({ host: "remote.example.com" });
    const { process } = await transport.spawnRemoteProcess("echo ok", {});

    const stderrPromise = Promise.race([readAll(process.stderr!), rejectAfter(500)]);
    channel.emitStderr("err\n");
    channel.finish(7);

    expect(await stderrPromise).toBe("err\n");
  });
});

describe("SSH2Transport.acquireConnection failures (#4438)", () => {
  test("surface as transport failures, but aborts pass through", async () => {
    const transport = new SSH2Transport({ host: "example.test" });
    const backoff = new Error("SSH connection to example.test is in backoff for 2s.");
    const spy = spyOn(ssh2ConnectionPool, "acquireConnection").mockRejectedValue(backoff);
    try {
      const failure: unknown = await transport.acquireConnection().catch((e: unknown) => e);
      expect(failure).toMatchObject({ type: "network", message: backoff.message });

      const controller = new AbortController();
      controller.abort();
      const aborted: unknown = await transport
        .acquireConnection({ abortSignal: controller.signal })
        .catch((e: unknown) => e);
      expect(aborted).toBe(backoff);
    } finally {
      spy.mockRestore();
    }
  });
});
