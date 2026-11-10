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
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  __closeFileSinkForTests,
  __resetFileSinkForTests,
  MAX_PENDING_SINK_BYTES,
  clearLogFiles,
  closeLogFile,
  getLogFilePath,
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

  test("__closeFileSinkForTests also waits for a clear that is in flight", async () => {
    log.info("line before the clear");
    let cleared = false;
    // clearLogFiles takes the stream out of the open state at once and finishes in the sink queue.
    const clearing = clearLogFiles().then(() => {
      cleared = true;
    });

    await __closeFileSinkForTests();
    expect(cleared).toBe(true);
    await clearing;
  });

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

  // A rotation or clear waits for the sink's first stream to close. Here that stream ignores end()
  // until the test releases it, so the transition stays in flight while the test writes lines.
  function stickFirstStream() {
    const originalCreateWriteStream = fs.createWriteStream;
    const streams: fs.WriteStream[] = [];
    let releaseFirstStream = (): Promise<void> => Promise.resolve();
    let onSecondStream: (stream: fs.WriteStream) => void = () => undefined;
    const secondStream = new Promise<fs.WriteStream>((resolve) => {
      onSecondStream = resolve;
    });
    spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      if (streams.length === 0) {
        const endSpy = spyOn(stream, "end").mockImplementation(() => stream);
        releaseFirstStream = async () => {
          endSpy.mockRestore();
          await new Promise<void>((resolve) => {
            stream.once("close", () => resolve());
            stream.end();
          });
        };
      } else if (streams.length === 1) {
        onSecondStream(stream);
      }
      streams.push(stream);
      return stream;
    });
    return { streams, releaseFirstStream: () => releaseFirstStream(), secondStream };
  }

  // The sink starts from the size of the file that it finds, and it rotates at 10 MiB. A sparse file
  // of that size makes the next log line rotate, with no 10 MiB write.
  async function makeNextLineRotate(): Promise<void> {
    const logFile = getLogFilePath();
    await fsPromises.mkdir(path.dirname(logFile), { recursive: true });
    await fsPromises.writeFile(logFile, "");
    await fsPromises.truncate(logFile, 10 * 1024 * 1024);
  }

  async function readLog(): Promise<string> {
    return await fsPromises.readFile(getLogFilePath(), "utf8");
  }

  test("lines written while a rotation is in flight reach the new log, in order", async () => {
    const { releaseFirstStream, secondStream } = stickFirstStream();
    await makeNextLineRotate();
    log.info("line that rotates the log");
    log.info("held line one");
    log.info("held line two");

    await releaseFirstStream();
    const next = await secondStream;
    closeLogFile();
    await once(next, "close");

    const current = await readLog();
    expect(current.indexOf("held line one")).toBeGreaterThanOrEqual(0);
    expect(current.indexOf("held line two")).toBeGreaterThan(current.indexOf("held line one"));
    expect(current).not.toContain("line that rotates the log");
    const rotated = await fsPromises.readFile(
      path.join(path.dirname(getLogFilePath()), "mux.1.log")
    );
    expect(rotated.subarray(-4096).toString()).toContain("line that rotates the log");
  });

  test("a later transition does not write the held lines again", async () => {
    const { streams, releaseFirstStream, secondStream } = stickFirstStream();
    await makeNextLineRotate();
    log.info("line that rotates the log");
    log.info("held line");

    await releaseFirstStream();
    await secondStream;
    // The clear ends the second stream, which writes the held line, and opens a third one.
    await clearLogFiles();
    closeLogFile();
    await once(streams[2], "close");

    expect(await readLog()).not.toContain("held line");
  });

  test("lines written while a clear is in flight reach the cleared log", async () => {
    const { releaseFirstStream, secondStream } = stickFirstStream();
    log.info("line before the clear");
    const clearing = clearLogFiles();
    log.info("held during the clear");

    await releaseFirstStream();
    await clearing;
    const next = await secondStream;
    closeLogFile();
    await once(next, "close");

    const current = await readLog();
    expect(current).toContain("held during the clear");
    expect(current).not.toContain("line before the clear");
  });

  test("held lines are bounded, and the lines past the bound are the ones dropped", async () => {
    const { releaseFirstStream, secondStream } = stickFirstStream();
    spyOn(console, "log").mockImplementation(() => undefined);
    await makeNextLineRotate();
    log.info("line that rotates the log");
    const third = Math.ceil(MAX_PENDING_SINK_BYTES / 3) + 1;
    // Three lines that cannot all fit, then a short one that cannot fit either once the bound is hit.
    log.info(`first held line ${"a".repeat(third)}`);
    log.info(`second held line ${"b".repeat(third)}`);
    log.info(`third held line ${"c".repeat(third)}`);

    await releaseFirstStream();
    const next = await secondStream;
    closeLogFile();
    await once(next, "close");

    const current = await readLog();
    expect(current).toContain("first held line");
    expect(current).toContain("second held line");
    expect(current).not.toContain("third held line");
  });

  test("a reset drops held lines", async () => {
    const { streams, releaseFirstStream } = stickFirstStream();
    await makeNextLineRotate();
    log.info("line that rotates the log");
    log.info("line held, then dropped by the reset");

    __resetFileSinkForTests();
    // The file is still the 10 MiB one, and a sink that opens on it would rotate at once.
    await fsPromises.truncate(getLogFilePath(), 0);
    log.info("line after the reset");
    expect(streams).toHaveLength(2);
    closeLogFile();
    await once(streams[1], "close");
    const current = await readLog();
    // The rotation that the reset abandoned finishes now, and it finds the sink reset.
    await releaseFirstStream();

    expect(current).toContain("line after the reset");
    expect(current).not.toContain("line held, then dropped by the reset");
  });

  test("a closed sink never writes held lines, and a rotation that finishes later opens nothing", async () => {
    const { streams, releaseFirstStream } = stickFirstStream();
    await makeNextLineRotate();
    log.info("line that rotates the log");
    log.info("line held, then dropped by the close");

    closeLogFile();
    await releaseFirstStream();
    await __closeFileSinkForTests();

    expect(streams).toHaveLength(1);
    const rotated = await fsPromises.readFile(
      path.join(path.dirname(getLogFilePath()), "mux.1.log")
    );
    expect(rotated.toString()).not.toContain("line held, then dropped by the close");
  });
});
