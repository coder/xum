import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  __closeFileSinkForTests,
  __resetFileSinkForTests,
  clearLogFiles,
  closeLogFile,
  log,
} from "./log";
import { subscribeLogFeed, type LogEntry } from "./logBuffer";

describe("log file sink state machine", () => {
  let tempMuxRoot: string;
  let originalMuxRoot: string | undefined;

  beforeAll(async () => {
    originalMuxRoot = process.env.MUX_ROOT;
    tempMuxRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-log-test-"));
    process.env.MUX_ROOT = tempMuxRoot;
  });

  beforeEach(() => {
    __resetFileSinkForTests();
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(async () => {
    closeLogFile();

    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }

    await fsPromises.rm(tempMuxRoot, { recursive: true, force: true });
  });

  test("transitions to degraded after stream error and suppresses immediate retries", async () => {
    const originalCreateWriteStream = fs.createWriteStream;
    let streamCreations = 0;

    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      streamCreations += 1;

      if (streamCreations === 1) {
        queueMicrotask(() => {
          stream.emit("error", new Error("forced log stream failure"));
        });
      }

      return stream;
    });

    expect(() => log.info("first log line")).not.toThrow();
    await Promise.resolve();

    expect(() => log.info("second log line should no-op while degraded")).not.toThrow();
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);
  });

  test("clearLogFiles closes and reopens the active sink stream", async () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createdStreams: fs.WriteStream[] = [];

    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      createdStreams.push(stream);
      return stream;
    });

    const nowSpy = spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    log.info("line before clear");
    nowSpy.mockRestore();

    expect(createdStreams).toHaveLength(1);

    const firstStream = createdStreams[0];
    if (!firstStream) {
      throw new Error("expected an initial log stream");
    }

    const firstStreamEndSpy = spyOn(firstStream, "end");

    await clearLogFiles();

    expect(firstStreamEndSpy).toHaveBeenCalledTimes(1);
    expect(createdStreams).toHaveLength(2);
    expect(createdStreams[1]).not.toBe(firstStream);

    log.info("line after clear");
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(2);
  });

  test("__closeFileSinkForTests resolves only after the descriptor is closed and keeps the sink closed", async () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createdStreams: fs.WriteStream[] = [];
    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      createdStreams.push(stream);
      return stream;
    });

    log.info("line before the sink is closed");
    const stream = createdStreams[0];
    if (!stream) {
      throw new Error("expected a log stream");
    }
    expect(stream.closed).toBe(false);

    await __closeFileSinkForTests();
    expect(stream.closed).toBe(true);

    // A line that arrives while the caller deletes the log folder must not reopen the sink.
    log.info("line after the sink is closed");
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);

    // With no sink open there is nothing to wait for.
    await __closeFileSinkForTests();

    __resetFileSinkForTests();
    log.info("line after the sink is reset");
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(2);
  });

  // Records every stream that the sink opens.
  function recordCreatedStreams(): fs.WriteStream[] {
    const originalCreateWriteStream = fs.createWriteStream;
    const createdStreams: fs.WriteStream[] = [];
    spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      createdStreams.push(stream);
      return stream;
    });
    return createdStreams;
  }

  test("__closeFileSinkForTests also waits for a clear that is in flight, and for its stream to close", async () => {
    const createdStreams = recordCreatedStreams();
    log.info("line before the clear");
    let cleared = false;
    // clearLogFiles takes the stream out of the open state at once and finishes in the sink queue.
    const clearing = clearLogFiles().then(() => {
      cleared = true;
    });

    await __closeFileSinkForTests();
    expect(cleared).toBe(true);
    expect(createdStreams.length).toBe(1);
    expect(createdStreams.every((stream) => stream.closed)).toBe(true);
    await clearing;
  });

  test("a clear does not wait for a stream that is already closed", async () => {
    const createdStreams = recordCreatedStreams();
    log.info("line before the stream is closed behind the sink's back");
    const stream = createdStreams[0];
    if (!stream) {
      throw new Error("expected a log stream");
    }
    // The sink still holds the stream as its open sink, but 'close' will not fire again.
    await new Promise<void>((resolve) => {
      stream.once("close", () => resolve());
      stream.end();
    });
    expect(stream.closed).toBe(true);

    await clearLogFiles();
  }, 2000);

  test("a clear waits for a failed stream to close, and does not wait forever for it", async () => {
    const createdStreams = recordCreatedStreams();
    log.info("line before the stream fails");
    const stream = createdStreams[0];
    if (!stream) {
      throw new Error("expected a log stream");
    }
    // A stream that fails before it flushes never finishes or closes by itself.
    const endSpy = spyOn(stream, "end").mockImplementation(() => stream);

    const clearing = clearLogFiles();
    // The clear starts in the sink queue, and the stream fails while it waits for the close.
    await new Promise((resolve) => setImmediate(resolve));
    stream.emit("error", new Error("forced log stream failure"));
    await clearing;

    // The clear waited until the failed stream was destroyed and its descriptor closed.
    expect(stream.closed).toBe(true);
    endSpy.mockRestore();
  }, 2000);

  test("clearLogFiles rejects when truncate fails", async () => {
    const openSyncSpy = spyOn(fs, "openSync").mockImplementation(() => {
      throw new Error("truncate failed");
    });

    let clearError: unknown;
    try {
      await clearLogFiles();
    } catch (error) {
      clearError = error;
    }

    expect(openSyncSpy).toHaveBeenCalled();
    expect(clearError).toBeInstanceOf(Error);
    if (!(clearError instanceof Error)) {
      throw new Error("expected clearLogFiles to reject with Error");
    }
    expect(clearError.message).toContain("truncate failed");
  });

  test("queued clear cannot reopen after closeLogFile", async () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createdStreams: fs.WriteStream[] = [];

    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      createdStreams.push(stream);
      return stream;
    });

    log.info("line before clear and close");
    expect(createdStreams).toHaveLength(1);

    const clearPromise = clearLogFiles();
    closeLogFile();
    await clearPromise.catch(() => undefined);

    expect(createdStreams).toHaveLength(1);

    log.info("line after close should be dropped");
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);
  });

  test("a log line names its caller without running the global stack formatter", () => {
    // Stands in for source-map-support's hook, which maps (and parses source maps for) every
    // frame of every formatted stack (#6556).
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored as is in finally
    const previous = Error.prepareStackTrace;
    let formattedStacks = 0;
    Error.prepareStackTrace = (error, callSites): unknown => {
      formattedStacks++;
      return previous ? (previous(error, callSites) as unknown) : String(error);
    };
    const entries: LogEntry[] = [];
    const feed = subscribeLogFeed((event) => {
      if (event.type === "append") entries.push(event.entry);
    });
    try {
      log.info("caller location probe");
    } finally {
      feed.unsubscribe();
      Error.prepareStackTrace = previous;
    }
    expect(formattedStacks).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].location).toMatch(/^src\/node\/services\/log\.test\.ts:\d+$/);
  });

  test("closeLogFile transitions sink to closed and blocks reopen attempts", () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) =>
      originalCreateWriteStream(...args)
    );
    const writeSpy = spyOn(fs.WriteStream.prototype, "write");

    log.info("line before close");
    const createCallsBeforeClose = createWriteStreamSpy.mock.calls.length;
    const writeCallsBeforeClose = writeSpy.mock.calls.length;
    expect(writeCallsBeforeClose).toBeGreaterThan(0);

    closeLogFile();

    expect(() => log.info("line after close should be dropped")).not.toThrow();
    expect(createWriteStreamSpy.mock.calls.length).toBe(createCallsBeforeClose);
    expect(writeSpy.mock.calls.length).toBe(writeCallsBeforeClose);
  });
});
