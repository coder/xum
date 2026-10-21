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
import { __resetFileSinkForTests, clearLogFiles, closeLogFile, log } from "./log";
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
    const previous = Error.prepareStackTrace;
    let formattedStacks = 0;
    Error.prepareStackTrace = (error, callSites) => {
      formattedStacks++;
      return previous ? previous(error, callSites) : String(error);
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
    expect(entries.map((entry) => entry.location)).toEqual([
      expect.stringMatching(/^src\/node\/services\/log\.test\.ts:\d+$/),
    ]);
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
